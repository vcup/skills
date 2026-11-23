/**
 * Which failure is whose: the authenticated-UI gate has to tell "this fixture is
 * not serving what the gate needs" apart from "the shipped Client is wrong".
 *
 * The distinction is the whole value of the gate. If a missing Workspace, an
 * uncomposed Client entry or a refused Remote answer all reported the same red,
 * a reader would go and re-provision the fixture instead of fixing the product —
 * and the opposite mistake (calling a real product bug "a fixture gap") is the one
 * that ships broken software.
 *
 * So this module names two kinds of failure:
 *
 * - **prerequisite** — nothing was asserted about the product. No handoff, no
 *   cookie, no browser binary, a Host that is not listening, a handoff naming a
 *   package that is not installed. The fix is provisioning.
 * - **product** — the Host answered and something the product owns is wrong: the
 *   page is not served, its boot manifest does not compose the Client, the served
 *   bundle lacks the workspace, the installed Client is refused, a read is refused
 *   by the archive, the UI does not behave. The fix is code.
 *
 * @module adapters/dsh/client/gate-failure
 */

/** A failure with the only thing the gate owes a reader: who must fix it. */
export class GateFailure extends Error {
  override readonly name: string = "GateFailure";
  constructor(readonly kind: "prerequisite" | "product", message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The process exit code a failure maps to. */
export function exitCodeOf(kind: "prerequisite" | "product"): number {
  return kind === "prerequisite" ? 2 : 1;
}

/** Nothing was asserted: a required input or fixture state is missing. */
export function prerequisite(message: string, cause?: unknown): never {
  throw new GateFailure("prerequisite", message, cause === undefined ? undefined : { cause });
}

/** The product failed a check. */
export function product(message: string, cause?: unknown): never {
  throw new GateFailure("product", message, cause === undefined ? undefined : { cause });
}

/** Message fragments that mean the Host was never reached (transport), not refusal. */
const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|network|connection refused|could not reach/iu;
/** Message fragments that mean the credential is not accepted. */
const UNAUTHORIZED = /HTTP 401|unauthorized|unauthenticated|dsh web authentication required/iu;
/** A Host that answered and simply has nothing yet: a starting state, not a defect. */
const EMPTY_STATE = /catalogue is empty/iu;

/** What one failed Remote answer means for the gate. */
export interface Classified {
  readonly kind: "prerequisite" | "product";
  readonly message: string;
}

/**
 * Classify a failure from the live Host transport.
 *
 * A refused credential is a product/data question — the Host is up and rejecting
 * the session the fixture issued, which no amount of re-provisioning explains. An
 * unreachable Host is a prerequisite. Everything else that came back *from* the
 * Host is the product's own answer and therefore a product failure.
 * @param error - the thrown transport or domain error.
 * @returns the kind and a message that names the right remedy.
 */
export function classifyHostFailure(error: unknown): Classified {
  const message = error instanceof Error ? error.message : String(error);
  if (UNAUTHORIZED.test(message)) return { kind: "product", message: `the live Host rejected the session the fixture issued (${message}); this is an authentication/product failure, not a provisioning gap` };
  if (UNREACHABLE.test(message)) return { kind: "prerequisite", message: `the live Host could not be reached (${message}); start the serve fixture and re-read connection.json` };
  return { kind: "product", message: `the live Host refused the gate's authenticated request (${message})` };
}
