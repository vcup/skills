import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";
const PACKAGE_NAME = "dsh-ensemble";
import { json, record } from "./protocol.ts";
/** The public Client mount protocol. Request fields are validated by the shared Host decoder.
 * Descriptors intentionally own no Host services or dependency instances. */
export const archiveRemote: TypertRemoteContribution = {
  package: PACKAGE_NAME,
  descriptors: ["projects", "query", "manage", "watch", "choose", "approve", "environment", "destinations"].map(method => ({
    id: `${PACKAGE_NAME}#ensembleArchive/${method}`, service: "ensembleArchive", namespace: "ensembleArchive", method,
    invocation: { kind: "direct" as const },
    ...(method === "watch" ? { mode: "stream" as const, cancellation: { parameter: "signal" as const } } : {}),
    parameters: [{ name: "request", wire: "request", source: "json" as const, codec: {
      mode: "strict" as const, typeSymbol: `${PACKAGE_NAME}#${method}:request`,
      create: () => ({ parse: (value: unknown) => { if (!record(value)) throw new TypeError("Expected a request object"); return json(value); } }),
    } }],
    result: { mode: "strict" as const, typeSymbol: `${PACKAGE_NAME}#${method}:result`, create: () => ({ parse: json }) },
  })),
};
