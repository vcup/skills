/** Explicit single-primary replication. Only store-issued destinations reach fixed Git methods. */
import { randomUUID } from "node:crypto";
import { failure, success, type Actor, type Result } from "../../../modules/ensemble/contracts.ts";
import type { LocationHandles } from "./handles.ts";
export interface Replica {
    id: string;
    archiveId: string;
    destinationHandle: string;
    expectedIdentity: string;
    credentialHandle: string;
    expectedRevision: string | null;
    state: "configured" | "pushed" | "unknown";
    lastLocalRevision?: string;
}
/**
 * Per-transfer facts the engine owns and the transport cannot derive.
 *
 * The repository a push must read is the archive's *current* location, which only
 * the held lease knows (a relocated archive is no longer under the registry's
 * default path). The engine therefore passes it in, so the transport never
 * re-derives storage layout and never re-enters the archive lock.
 */
export interface ReplicaTransferContext {
    /** Canonical Host-local path of the primary repository, from the held lease. */
    readonly primaryRoot: string;
    /**
     * Deployment-declared destination key for this transfer.
     *
     * Taken from the *location capability* the owner just used, never from the persisted
     * replica record, a request field or a model argument. A network transfer is refused
     * when the capability carries no key rather than falling back to the runtime handle,
     * so a `choose` handle can never be mistaken for a deployment name.
     */
    readonly destinationKey: string;
}
export interface ReplicaLease {
    destinationAllowed(path: string): boolean;
    head(): Promise<string>;
    remoteHead(destination: string): Promise<string | null>;
    push(destination: string, revision: string, expected: string | null): Promise<void>;
    fetch(destination: string, expected: string): Promise<{
        candidateId: string;
        head: string;
        readOnly: true;
    }>;
    isAncestor(older: string, newer: string): Promise<boolean>;
    /** Canonical primary repository path of the locked archive (honours relocation). */
    readonly repository: string;
    /** Registry owns durable non-secret destination configuration and operation results. */
    get(id: string): Promise<Replica | undefined>;
    save(replica: Replica): Promise<void>;
}
export interface ReplicaAccess {
    withOwner<T>(actor: Actor, archiveId: string, signal: AbortSignal, run: (lease: ReplicaLease) => Promise<Result<T>>): Promise<Result<T>>;
}
/**
 * Closed failure vocabulary a transport may report.
 *
 * A transport failure is turned into one of these fixed, human-readable messages.
 * The transport's own error text is never forwarded: it can contain a remote URL,
 * a Git command line or a credential-provider message, and none of that belongs in
 * an archive receipt, a response or a log line derived from them.
 */
export type ReplicaTransportFailure =
    | "not_authorized"
    | "credential_unavailable"
    | "invalid_destination"
    | "remote_unreachable"
    | "remote_conflict"
    | "quarantine_failed"
    | "unclassified_transport_failure";
const SAFE_TRANSPORT_MESSAGES: Readonly<Record<ReplicaTransportFailure, string>> = {
    not_authorized: "the native network capability refused this transfer",
    credential_unavailable: "the native credential for this remote is unavailable or unusable",
    invalid_destination: "this deployment does not permit the configured remote destination",
    remote_unreachable: "the remote could not be reached",
    remote_conflict: "the remote refused the update; re-read the remote before retrying",
    quarantine_failed: "the remote content could not be verified in isolation",
    unclassified_transport_failure: "the native transport failed without a classified reason",
};
/** A transport error that already carries a safe, closed reason. */
export class ReplicaTransportError extends Error {
    override readonly name = "ReplicaTransportError";
    constructor(readonly reason: ReplicaTransportFailure, message: string) {
        super(message);
    }
}
/**
 * Reduce any transport error to a fixed safe sentence.
 *
 * Unknown error classes are deliberately collapsed: a leak-proof default is worth
 * more than a helpful one, and the operator still gets the closed reason token.
 * @param error - whatever the transport threw.
 * @returns a fixed message containing no transport-authored text.
 */
export function describeReplicaFailure(error: unknown): string {
    const reason: ReplicaTransportFailure = error instanceof ReplicaTransportError ? error.reason : "unclassified_transport_failure";
    return `${SAFE_TRANSPORT_MESSAGES[reason]} (reason: ${reason})`;
}
/**
 * What one authorized transfer is allowed to do.
 *
 * This is a **per-call** value: created by `authorize` for exactly one transfer and
 * meaningless afterwards. It exists so identity cannot be read from shared mutable state -
 * a "remember the last authorized destination" field would let two concurrent archives on
 * different destinations observe each other's identity. Callers pass the capability they
 * were just handed; an implementation must not keep it.
 */
export interface ReplicaTransferCapability {
    /** Canonical identity of the remote this capability is for. */
    readonly identity: string;
    /** Deployment-declared destination key this capability is for. */
    readonly destinationKey: string;
}
export interface NativeReplicaTransport {
    /** Credential values never enter the archive or caller response. */
    /**
     * Authorize one transfer, or refuse.
     *
     * Returning the capability, rather than a boolean plus a separate `identity()` lookup,
     * makes the authority travel with the answer: there is no window in which a second call
     * could observe a different destination's identity, and no cached "latest" state to go
     * stale when a selection expires or the Host restarts.
     */
    authorize(actor: Actor, replica: Replica, signal: AbortSignal, context?: ReplicaTransferContext): Promise<ReplicaTransferCapability | undefined>;
    head(replica: Replica, signal: AbortSignal, context: ReplicaTransferContext, capability: ReplicaTransferCapability): Promise<string | null>;
    push(replica: Replica, revision: string, expected: string | null, signal: AbortSignal, context: ReplicaTransferContext, capability: ReplicaTransferCapability): Promise<void>;
    fetch(replica: Replica, expected: string, signal: AbortSignal, context: ReplicaTransferContext, capability: ReplicaTransferCapability): Promise<{
        candidateId: string;
        head: string;
        readOnly: true;
    }>;
}
export function createReplicaMaintenance(deps: {
    access: ReplicaAccess;
    handles: LocationHandles;
    hostWorld: string;
    network?: NativeReplicaTransport;
}) {
    async function configure(actor: Actor, archiveId: string, request: {
        destinationHandle: string;
        credentialHandle: string;
        expectedIdentity: string;
    }, signal: AbortSignal): Promise<Result<Replica>> {
        return deps.access.withOwner(actor, archiveId, signal, async (lease) => {
            const cap = await deps.handles.use(actor, request.destinationHandle, "replica", signal);
            if (!cap.ok)
                return cap;
            if (!request.expectedIdentity || request.expectedIdentity.length > 512 || request.credentialHandle.length > 512)
                return failure("invalid_input", "replica requires bounded native identity and credential handles");
            const replica: Replica = { id: `replica_${randomUUID()}`, archiveId, destinationHandle: request.destinationHandle, expectedIdentity: request.expectedIdentity, credentialHandle: request.credentialHandle, expectedRevision: null, state: "configured" };
            if (cap.value.world !== deps.hostWorld) {
                // The deployment key comes from the native authorization that issued this
                // capability. Without it the transport cannot resolve a URL, and guessing
                // from `destinationHandle` would let a runtime id masquerade as a
                // deployment name; refuse instead of falling back.
                if (!cap.value.deploymentKey)
                    return failure("not_authorized", "this destination is not a declared replica destination of the deployment");
                const context: ReplicaTransferContext = { primaryRoot: lease.repository, destinationKey: cap.value.deploymentKey };
                // Every network call goes through one classifier so a provider
                // message can never surface as an archive refusal.
                try {
                    const capability = await deps.network?.authorize(actor, replica, signal, context);
                    if (!capability)
                        return failure("not_authorized", "replication requires a separately approved native network capability");
                    // Identity comes from the capability just issued for this transfer, never
                    // from shared state; the selection is what the owner approved.
                    if (capability.identity !== replica.expectedIdentity)
                        return failure("remote_conflict", "native remote identity differs from owner selection");
                    replica.expectedRevision = await deps.network!.head(replica, signal, context, capability);
                }
                catch (error) {
                    return failure("storage_unavailable", describeReplicaFailure(error));
                }
            }
            else {
                if (cap.value.path === undefined)
                    return failure("invalid_input", "a Host-local replica destination requires a filesystem path");
                if (replica.credentialHandle !== "none")
                    return failure("invalid_input", "file replicas use the literal credential handle none; secrets belong to the native credential owner");
                if (!lease.destinationAllowed(cap.value.path))
                    return failure("invalid_input", "replica overlaps a primary archive or bound source");
                if (replica.expectedIdentity !== cap.value.world)
                    return failure("remote_conflict", "replica world identity differs from the approved location");
                replica.expectedRevision = await lease.remoteHead(cap.value.path);
            }
            await lease.save(replica);
            return success(replica);
        });
    }
    async function push(actor: Actor, archiveId: string, replicaId: string, localRevision: string, signal: AbortSignal): Promise<Result<{
        state: "pushed";
        revision: string;
    }>> {
        return deps.access.withOwner(actor, archiveId, signal, async (lease) => {
            const replica = await lease.get(replicaId);
            if (!replica || replica.archiveId !== archiveId)
                return failure("not_found", "replica is not configured for this archive");
            const cap = await deps.handles.use(actor, replica.destinationHandle, "replica", signal);
            if (!cap.ok)
                return cap;
            const network = cap.value.world !== deps.hostWorld;
            if (network && !cap.value.deploymentKey)
                return failure("not_authorized", "this destination is not a declared replica destination of the deployment");
            const context: ReplicaTransferContext = { primaryRoot: lease.repository, destinationKey: cap.value.deploymentKey ?? "" };
            if (!network && (cap.value.path === undefined || !lease.destinationAllowed(cap.value.path)))
                return failure("invalid_input", "replica overlaps a primary archive or bound source");
            try {
                // One authorization per operation, with its capability threaded through every
                // call this push makes. Nothing is remembered between operations.
                const capability = network ? await deps.network?.authorize(actor, replica, signal, context) : undefined;
                if (network && !capability)
                    return failure("not_authorized", "native network permission is unavailable");
                if (await lease.head() !== localRevision)
                    return failure("revision_conflict", "push requires the current exact local revision");
                const remote = await (network ? deps.network!.head(replica, signal, context, capability!) : lease.remoteHead(cap.value.path!));
                if (replica.state === "unknown") {
                    if (remote === replica.lastLocalRevision) {
                        await lease.save({ ...replica, state: "pushed", expectedRevision: remote });
                        return remote === localRevision ? success({ state: "pushed", revision: remote }) : failure("revision_conflict", "prior push reconciled; re-read before pushing a new revision");
                    }
                    if (remote !== replica.expectedRevision)
                        return failure("remote_conflict", "unknown push reconciled to a conflicting remote; no force or merge performed");
                }
                if (remote !== replica.expectedRevision)
                    return failure("remote_conflict", "remote CAS failed before transfer; preview remote again");
                if (remote) {
                    // Ancestry is a *conflict* judgement, not a transfer outcome. When the
                    // remote revision is absent from the local object database the check
                    // cannot be answered at all, and the safe reading is "this remote is not
                    // known to be our ancestor" — a conflict to resolve by reading the
                    // remote, never a push and never an indeterminate transfer.
                    let ancestor: boolean;
                    try {
                        ancestor = await lease.isAncestor(remote, localRevision);
                    }
                    catch {
                        return failure("remote_conflict", "remote history cannot be proven an ancestor of the single primary; re-read the remote before retrying");
                    }
                    if (!ancestor)
                        return failure("remote_conflict", "remote history is not an ancestor of the single primary");
                }
                // Persist intention before sending. A process/transport failure cannot falsely report completion.
                await lease.save({ ...replica, state: "unknown", lastLocalRevision: localRevision });
                if (!(await cap.value.check(signal)))
                    return failure("not_authorized", "replica location permission changed");
                if (network)
                    await deps.network!.push(replica, localRevision, remote, signal, context, capability!);
                else
                    await lease.push(cap.value.path!, localRevision, remote);
                const observed = await (network ? deps.network!.head(replica, signal, context, capability!) : lease.remoteHead(cap.value.path!));
                if (observed !== localRevision)
                    return failure("outcome_unknown", "push sent but remote acknowledgement is uncertain; reconcile before retry");
                await lease.save({ ...replica, state: "pushed", expectedRevision: observed, lastLocalRevision: localRevision });
                return success({ state: "pushed", revision: observed });
            }
            catch (error) {
                // The outcome really is unknown, but the reason is a fixed sentence:
                // transport-authored text (URLs, argv, provider messages) never enters
                // a refusal, a receipt or a log derived from one.
                return failure("outcome_unknown", `replica transfer outcome is unknown; re-read remote before retrying. ${describeReplicaFailure(error)}`);
            }
        });
    }
    async function fetch(actor: Actor, archiveId: string, replicaId: string, expected: string, signal: AbortSignal): Promise<Result<{
        candidateId: string;
        head: string;
        readOnly: true;
    }>> {
        return deps.access.withOwner(actor, archiveId, signal, async (lease) => {
            const replica = await lease.get(replicaId);
            if (!replica || replica.archiveId !== archiveId)
                return failure("not_found", "replica not found");
            const cap = await deps.handles.use(actor, replica.destinationHandle, "replica", signal);
            if (!cap.ok)
                return cap;
            if (cap.value.world === deps.hostWorld && (cap.value.path === undefined || !lease.destinationAllowed(cap.value.path)))
                return failure("invalid_input", "replica overlaps a primary archive or bound source");
            if (cap.value.world !== deps.hostWorld && !cap.value.deploymentKey)
                return failure("not_authorized", "this destination is not a declared replica destination of the deployment");
            const context: ReplicaTransferContext = { primaryRoot: lease.repository, destinationKey: cap.value.deploymentKey ?? "" };
            try {
                const before = await lease.head();
                let result: {
                    candidateId: string;
                    head: string;
                    readOnly: true;
                };
                if (cap.value.world !== deps.hostWorld) {
                    // Same discipline as push: one authorization, capability threaded, nothing
                    // remembered across operations.
                    const capability = await deps.network?.authorize(actor, replica, signal, context);
                    if (!capability)
                        return failure("not_authorized", "native network permission unavailable");
                    if (await deps.network!.head(replica, signal, context, capability) !== expected)
                        return failure("remote_conflict", "remote changed before fetch");
                    result = await deps.network!.fetch(replica, expected, signal, context, capability);
                }
                else {
                    if (await lease.remoteHead(cap.value.path!) !== expected)
                        return failure("remote_conflict", "remote changed before fetch");
                    result = await lease.fetch(cap.value.path!, expected);
                }
                if (await lease.head() !== before)
                    return failure("archive_corrupt", "quarantine fetch unexpectedly changed authoritative ref");
                if (result.head !== expected || !result.readOnly)
                    return failure("remote_conflict", "fetched candidate differs from requested remote revision");
                return success(result);
            }
            catch (error) {
                return failure("storage_unavailable", `fetch did not publish a verified quarantine candidate. ${describeReplicaFailure(error)}`);
            }
        });
    }
    return { configure, push, fetch };
}
