/** Model tools use the shared decoder and archive executor with native authority. */
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { decodeWorkEnvelope, decodeLearnEnvelope, decodeQuery, decodeUpload, WORK_TOOL_SCHEMA, LEARN_TOOL_SCHEMA, READ_TOOL_SCHEMA, UPLOAD_TOOL_SCHEMA } from "../../../modules/ensemble/codec.ts";
import { failure, type Actor, type ArchiveInterface, type BoundTarget, type Query, type ReadPage, type Result, type UploadCommand } from "../../../modules/ensemble/contracts.ts";
import { NativeIdentityError, type NativeIdentity } from "../native/identity.ts";
import { dshSchema } from "./schema.ts";

export interface ToolAuthority { readonly actor: Extract<Actor, { kind: "session" }>; readonly identity: NativeIdentity }
export interface EnsembleToolsDeps {
  authority(exec: ToolRunContext): ToolAuthority;
  assertCurrent(exec: ToolRunContext, call: ToolAuthority): void;
  resolve(call: ToolAuthority, projectId: string | undefined, signal: AbortSignal): Promise<Result<BoundTarget>>;
  readonly archive: ArchiveInterface;
  environment(call: ToolAuthority, query: Extract<Query, { kind: "environment_preferences" }>, exec: ToolRunContext): Promise<unknown>;
  projects(call: ToolAuthority, query: Query, signal: AbortSignal): Promise<Result<ReadPage>>;
  upload(actor: Actor, archiveId: string, command: UploadCommand, signal: AbortSignal): Promise<unknown>;
}

/** Register complete command families; no path, project, role or owner field authorizes a write. */
export function registerEnsembleTools(ctx: Context, deps: EnsembleToolsDeps): void {
  const definitions = [
    { name: "ensemble_work", description: "Record the full work lifecycle: goals and coverage, native attempts, artifacts, contributions, decisions, candidate checks and completion. Read context first for the current revision; keep operation_id unchanged only for an identical retry. Native agents/tasks remain managed by their original tools.", schema: WORK_TOOL_SCHEMA, kind: "work" },
    { name: "ensemble_learn", description: "Record coaching, reflection and independent review, publish or correct reading, propose lessons and record applications or counterexamples. Publication and lesson support require their separate checks. Read exact object revisions before writing.", schema: LEARN_TOOL_SCHEMA, kind: "learn" },
    { name: "ensemble_read", description: "Read authorized projects, current context, checkpoint, objects and original bytes, fixed-revision lists/history/reading, lessons with limitations, receipts and environment preferences. Continue partial pages with the returned cursor and fixed revision.", schema: READ_TOOL_SCHEMA, kind: "read" },
    { name: "ensemble_upload", description: "Upload complete artifact bytes to the bound project: begin with digest and invocation, send canonical base64 chunks with offsets/digests, inspect status, seal/commit, or cancel. A sealed upload is referenced by put_artifact; uploading alone does not publish an artifact.", schema: UPLOAD_TOOL_SCHEMA, kind: "upload" },
  ] as const;
  for (const definition of definitions) {
    const tool: ToolDefinition = {
      name: definition.name,
      description: definition.description,
      parameters: dshSchema(definition.schema),
      output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      isConcurrencySafe: () => definition.kind === "read",
      async execute(input, exec) {
        exec.signal.throwIfAborted();
        let call: ToolAuthority;
        try { call = deps.authority(exec); }
        catch (error) { if (error instanceof NativeIdentityError) return failure("not_authorized", error.message); throw error; }
        if (definition.kind === "read") {
          const decoded = decodeQuery(input);
          if (!decoded.ok) return decoded;
          if (decoded.value.kind === "environment_preferences") return deps.environment(call, decoded.value, exec);
          if (decoded.value.kind === "projects") return deps.projects(call, decoded.value, exec.signal);
          const target = await deps.resolve(call, decoded.value.project_id, exec.signal);
          if (!target.ok) return target;
          deps.assertCurrent(exec, call);
          return deps.archive.query(call.actor, target.value, decoded.value, exec.signal);
        }
        if (definition.kind === "upload") {
          const decoded = decodeUpload(input);
          if (!decoded.ok) return decoded;
          const target = await deps.resolve(call, undefined, exec.signal);
          if (!target.ok) return target;
          deps.assertCurrent(exec, call);
          return deps.upload(call.actor, target.value.archiveId, decoded.value, exec.signal);
        }
        const decoded = definition.kind === "work" ? decodeWorkEnvelope(input) : decodeLearnEnvelope(input);
        if (!decoded.ok) return decoded;
        const target = await deps.resolve(call, undefined, exec.signal);
        if (!target.ok) return target;
        deps.assertCurrent(exec, call);
        const { expected_revision, operation_id, ...command } = decoded.value;
        return deps.archive.execute(call.actor, { archiveId: target.value.archiveId, expectedRevision: expected_revision, operationId: operation_id, command }, exec.signal);
      },
    };
    ctx.tools.register(tool);
  }
}
