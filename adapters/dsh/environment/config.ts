/** Host-only native Settings declaration, composed into the Ensemble plugin's Config. */
import z from "@deepseek-ai/schemastery";

const label = () => z.string().min(1).max(256).required();
const list = () => z.array(label()).max(64).default([]);
const effort = z.union([
  z.object({ mode: z.union([z.const("default"), z.const("inherit")]).required() }),
  z.object({ mode: z.const("explicit").required(), value: label() }),
]).required();
/** This field never controls native allowlists or trusted child AgentOptions. */
export const rolePreferencesConfig = z.object({
  roles: z.array(z.object({
    role: z.string().min(1).max(128).required(),
    candidates: z.array(z.object({
      provider: label(), model: label(), effort,
      preset: z.string().min(1).max(256),
      applicability: z.object({ task_types: list(), interface_versions: list(), required_capabilities: list() }).required(),
      reason: z.string().min(1).max(4096).required(),
    })).min(1).max(32).required(),
  })).max(32).default([]),
}).default({ roles: [] }).volatile();
