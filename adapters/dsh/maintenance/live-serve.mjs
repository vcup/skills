/**
 * Serve a real installed Host for the maintenance live acceptance.
 *
 * The native profile gate boots the product, proves it, and exits. This script does
 * the same boot through the **published** `runProfile` entry, initializes the
 * archive through the authenticated owner Remote, then keeps the Host running and
 * writes a handoff (origin, cookie file, project, workspace, source) so an
 * out-of-process driver can exercise `ensembleArchive/*` exactly as a Client or the
 * packaged CLI does.
 *
 * It belongs to the maintenance acceptance line, not to the product: it composes no
 * product service of its own and imports only the released profile boot plus the
 * package's own client transport.
 *
 * Environment: DSH_HOME, ENSEMBLE_LIVE_PACKAGE_ROOT, ENSEMBLE_LIVE_RUNTIME,
 * ENSEMBLE_LIVE_HANDOFF, ENSEMBLE_LIVE_SOURCE.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(process.env.ENSEMBLE_LIVE_PACKAGE_ROOT ?? "");
const handoffPath = resolve(process.env.ENSEMBLE_LIVE_HANDOFF ?? "");
const source = resolve(process.env.ENSEMBLE_LIVE_SOURCE ?? "");
const runtime = resolve(process.env.ENSEMBLE_LIVE_RUNTIME ?? "");
if (!process.env.ENSEMBLE_LIVE_PACKAGE_ROOT || !process.env.ENSEMBLE_LIVE_HANDOFF || !process.env.ENSEMBLE_LIVE_SOURCE || !process.env.ENSEMBLE_LIVE_RUNTIME) {
    console.error("usage: set ENSEMBLE_LIVE_PACKAGE_ROOT, ENSEMBLE_LIVE_HANDOFF, ENSEMBLE_LIVE_SOURCE, ENSEMBLE_LIVE_RUNTIME");
    process.exit(2);
}

const require_ = createRequire(join(runtime, "package.json"));
const load = async name => import(pathToFileURL(require_.resolve(name)).href);

// The same two entries `dsh --profile web` uses: layered environment plus the
// published profile boot. Nothing here composes a Host of its own.
const { loadLayeredEnv } = await load("@deepseek-ai/dsh-app-boot");
const { runProfile } = await load("@deepseek-ai/dsh/profile-boot");
const { ctx } = await runProfile({
    environment: loadLayeredEnv("dsh"),
    profile: "web",
    patchFiles: [],
    args: ["--port", "0", "--no-open"],
});

const { LlmAdapter, isAgentLoopRequest } = await load("@deepseek-ai/dsh-llm");

/**
 * Deterministic provider.
 *
 * It must be a real `LlmAdapter`: the registry asks it for `providerInfo`, so a
 * duck-typed object breaks routing at boot. It never invents an assistant turn with
 * a tool call; the maintenance driver calls the Remote, not the model.
 */
class Deterministic extends LlmAdapter {
    async *stream(options) {
        options.signal?.throwIfAborted();
        const value = isAgentLoopRequest(options) ? "done" : "title";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: value };
        yield { type: "block-end", index: 0, block: { type: "text", text: value } };
        yield { type: "finish", reason: { kind: "stop" } };
    }
}
ctx.llm.registerAdapter(["maintenance-live"], new Deterministic());

try {
    mkdirSync(source, { recursive: true });
    const rootSessionId = "maintenance-live-root";
    const handle = await ctx.agents.create({
        sessionId: rootSessionId,
        meta: { cwd: source, agentPreset: "standard" },
        agentOptions: { provider: "maintenance-live", model: "deterministic" },
    });
    const agent = handle.agent;
    const workspace = await ctx.workspaceRegistry.create(source);
    await workspace.attachSession(agent.id);

    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    const launch = new URL(ctx.connection.authenticatedUrl(`${origin}/`));
    launch.pathname = "/connect";
    const authorized = await fetch(launch, { redirect: "manual" });
    if (authorized.status !== 302) throw new Error(`authenticated connect returned ${authorized.status}`);
    const cookie = authorized.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("the authenticated connect did not issue a session cookie");
    const cookieFile = join(resolve(handoffPath, ".."), "owner-cookie");
    writeFileSync(cookieFile, cookie, { mode: 0o600 });

    const { connect } = await import(pathToFileURL(join(packageRoot, "lib/transport.bundle.mjs")).href);
    const connection = await connect({ url: origin, cookie });
    let projectId;
    try {
        const initialized = await connection.call("ensembleArchive/manage", {
            request: {
                action: "initialize",
                expected_revision: "absent",
                operation_id: "maintenance-live-initialize",
                payload: {
                    root_handle: "default",
                    source_descriptor: { worldIdentity: process.env.DSH_ENSEMBLE_SOURCE_WORLD, canonicalAddress: source, nativeWorkspaceRef: workspace.id },
                    initial_grants: [{ subject: { kind: "session", sessionId: agent.id, rootSessionId: agent.id }, rights: ["read", "open"], scope: { kind: "project" } }],
                    limits: { inline_input_bytes: 262144, response_bytes: 32768, artifact_bytes: 67108864, upload_chunk_bytes: 1048576, upload_total_bytes: 268435456, concurrent_uploads: 4, page_items: 50 },
                },
            },
        });
        if (!initialized || initialized.ok !== true) throw new Error(`initialize failed: ${JSON.stringify(initialized)}`);
        projectId = initialized.value.id ?? initialized.value.project_id;
    } finally {
        await connection.close?.().catch(() => {});
    }
    writeFileSync(handoffPath, JSON.stringify({
        origin, cookieFile, packageRoot, projectId,
        rootSessionId: agent.id, workspaceId: workspace.id, source,
    }, null, 2), { mode: 0o600 });
    console.log("READY " + handoffPath);
    // Keep serving until the driver's parent terminates this process.
    await new Promise(resolvePromise => { process.once("SIGTERM", resolvePromise); process.once("SIGINT", resolvePromise); });
} finally {
    await ctx.fiber.dispose().catch(() => {});
}
