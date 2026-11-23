/**
 * What a real Host actually serves to a browser, checked over the real transport.
 *
 * The browser phase needs a browser; this phase needs only the cookie. It is the
 * part that catches the failure a component fixture cannot: the package installed
 * into the profile, composed by the Host's own module registry, and served from
 * the Host's own `/plugins/...` route as the shipped lazy-CJS factory. A green
 * component gate says nothing about any of that, and a stale or unroutable artifact
 * shows up here as a product failure rather than as a mysterious blank page.
 *
 * It is a mandatory phase of the authenticated gate, never a substitute for it: it
 * proves the bytes and the boot manifest, not that the UI renders or that an owner
 * write survives.
 *
 * @module adapters/dsh/client/served-client
 */

import { createHash } from "node:crypto";

/** One fact read from the served page and bundle. */
export interface ServedClient {
  /** HTTP status of the authenticated page. */
  readonly pageStatus: number;
  /** Module ids the Host's boot manifest composes. */
  readonly modules: readonly string[];
  /** The `dsh-ensemble` row's document-relative bundle URL. */
  readonly clientUrl: string;
  /** Size of the served bundle bytes. */
  readonly clientBytes: number;
  /** Hash of the served bundle's code, with the Host's own delivery trailer removed. */
  readonly clientSha256: string;
  /** Hash of the bytes exactly as served, for byte-level reporting. */
  readonly servedSha256: string;
  /** Client exports the served factory registered. */
  readonly exports: readonly string[];
  /** The keyed main page and sidebar panel the bundle registers. */
  readonly seats: readonly string[];
}

/** A served-response fact is wrong; the caller decides whether that is product or fixture. */
export class ServedClientError extends Error {
  override readonly name: string = "ServedClientError";
}

/**
 * The handoff's credential is not a browser session.
 *
 * Measured on a real Host: the browser entry `GET /?token=…` sets a `v1` cookie that
 * the index route accepts, while the API exchange `GET /connect?token=…` sets a `v2`
 * cookie that the *index* route rejects with 401. A handoff carrying the API cookie
 * therefore cannot load the page, and no Client code is involved. This is a
 * fixture-contract failure with a specific remedy, so it is its own error rather
 * than a generic 401.
 */
export class HandoffCredentialError extends ServedClientError {
  override readonly name: string = "HandoffCredentialError";
}

const fail = (message: string): never => { throw new ServedClientError(message); };

/**
 * The one delivery trailer the Host's `/plugins/??` combo route appends, spelled
 * out instead of approximated.
 *
 * Measured bytes: `<installed client.js>\n;\n//# sourceMappingURL=??<id>/client.js.map&rev=<hex>\n`.
 * The pattern is end-anchored and requires every part of that shape — the `;`
 * line, the `sourceMappingURL` comment, the `??` combo form, a `client.js.map`
 * target and a hex revision. Anything else is left untouched, so a bundle whose
 * real code merely ends near a comment is never truncated into a match: a false
 * negative is a loud product failure, while a false positive would hide a
 * genuinely stale artifact.
 */
const DELIVERY_TRAILER = /\n;\n\/\/# sourceMappingURL=\?\?[^/\n]+\/client\.js\.map&rev=[0-9a-f]{6,64}\n?$/u;

/**
 * The delivered bundle's code, without the trailer the Host's `/plugins/??` route
 * appends.
 *
 * Measured on a real Host: the served combo script is the installed `client.js`
 * followed by `;` and a `//# sourceMappingURL=??<package>/client.js.map&rev=…`
 * line. Those bytes are the route's own delivery detail, not the shipped code, so
 * comparing them byte-for-byte with the installed file reports a false "stale
 * artifact". Removing exactly that trailer keeps the check meaningful: any other
 * difference is still a real mismatch.
 * @param source - served bundle text.
 * @returns the code with the delivery trailer removed.
 */
export function deliveredCode(source: string): string {
  const match = DELIVERY_TRAILER.exec(source);
  return match === null ? source : `${source.slice(0, match.index)}\n`;
}

/** Fetch with the Host-issued cookie only: no bearer, no token, no query credential. */
async function fetchWith(origin: string, path: string, cookie: string): Promise<Response> {
  const target = path.startsWith("http") ? path : new URL(path, `${origin}/`).href;
  return fetch(target, { headers: { cookie }, redirect: "manual" });
}

/**
 * One row of the wire graph.
 *
 * The Host's wire field is `entries` (that is what `parseBootManifest` reads and
 * what a served page carries); `modules` is accepted too so the same reader works
 * against the parsed form. Reading only one of them is how a gate can look at a
 * real manifest and wrongly report "no Client composed".
 */
export interface BootRow { readonly id?: string; readonly url?: string }

/** Read `globalThis["__DSH_BOOT__"] = {...}` out of the served HTML. */
export function bootManifest(html: string): { modules: BootRow[] } {
  const marker = html.indexOf("__DSH_BOOT__");
  if (marker < 0) fail("the served page carries no __DSH_BOOT__ manifest");
  const start = html.indexOf("{", marker);
  if (start < 0) fail("the boot manifest assignment has no object literal");
  // Brace matching, because the manifest contains nested objects and strings.
  let depth = 0, quote: string | undefined, escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, index + 1)) as { entries?: BootRow[]; modules?: BootRow[] };
          return { modules: parsed.entries ?? parsed.modules ?? [] };
        } catch (error) {
          fail(`the boot manifest is not JSON: ${(error as Error).message}`);
        }
      }
    }
  }
  return fail("the boot manifest object is unterminated");
}

/**
 * The exports and slot registrations a served lazy-CJS factory declares.
 *
 * Read from the bundle text rather than by executing it: the bundle is the Host's
 * artifact and this module only answers "does the served code export apply/inject
 * and register the seats the UI needs". Execution is the browser phase's job.
 * @param source - served client bundle text.
 */
export function factoryFacts(source: string): { exports: readonly string[]; seats: readonly string[]; inject: readonly string[]; optionalScopes: readonly string[] } {
  if (!source.includes("__ModuleLoader__")) fail("the served client bundle is not a page module factory");
  const exports = ["apply", "inject"].filter(name => new RegExp(`\\b${name}\\b`, "u").test(source)).sort();
  const seats: string[] = [];
  if (/["']main["']/u.test(source) && /key:\s*["']ensemble["']/u.test(source)) seats.push("main:keyed(ensemble)");
  if (/sidebar\.panellist/u.test(source)) seats.push("sidebar.panellist");
  if (!seats.includes("main:keyed(ensemble)")) fail("the served client bundle does not register the keyed main page");

  // Three different things in this bundle are spelled `inject`, and confusing them is a
  // real trap: the module-level export (services this plugin needs *before* it applies),
  // a slot contribution's `inject` callback, and the deferred `inject([...], …)` child
  // scopes used for optional services. Reading the module-level list out separately lets a
  // gate assert the property that actually matters — see below.
  const moduleInject = /inject\s*=\s*\[([^\]]*)\]/u.exec(source)?.[1] ?? "";
  const inject = [...moduleInject.matchAll(/["']([^"']+)["']/gu)].map(match => match[1]!).sort();
  const optionalScopes = [...source.matchAll(/inject\(\s*\[([^\]]*)\]/gu)]
    .flatMap(match => [...(match[1] ?? "").matchAll(/["']([^"']+)["']/gu)].map(inner => inner[1] ?? ""))
    .filter(name => name !== "");

  // The native Workspace registry must NOT be a module-level dependency. On a Host that
  // composes no workspace registry the service never exists, and a required dependency
  // would stop this plugin from activating at all instead of showing its explanation. It
  // is reached through a child scope so a late arrival is still picked up.
  //
  // Stated as a *negative* assertion on purpose: a later reader adding "inject contains
  // workspaces" would be asserting the defect this bundle was fixed to remove.
  if (inject.includes("workspaces")) fail("the served client lists workspaces as a required service; it must reach the registry through an optional child scope so a Host without one still activates");
  return { exports, seats, inject, optionalScopes };
}

/**
 * Inspect the authenticated page and the client bundle the Host serves for it.
 * @param options - Host origin and the session cookie header.
 * @returns the served facts.
 */
export async function inspectServedClient(options: { origin: string; cookie: string }): Promise<ServedClient> {
  const page = await fetchWith(options.origin, "/", options.cookie);
  if (page.status === 401) {
    throw new HandoffCredentialError(
      "the Host answered 401 for the page with the handoff's cookie. The browser entry is GET /?token=… (which sets a v1 session cookie the index route accepts); GET /connect?token=… sets a v2 API cookie that the index route rejects. The handoff must carry the browser cookie, or this run cannot say anything about the page.",
    );
  }
  if (page.status !== 200) fail(`the Host served ${page.status} for the authenticated page instead of 200`);
  const html = await page.text();
  const manifest = bootManifest(html);
  const modules = (manifest.modules ?? []).map(row => row.id ?? "");
  if (!modules.includes("dsh-ensemble")) fail(`the Host's boot manifest does not compose dsh-ensemble (modules: ${modules.slice(0, 12).join(", ")})`);
  const row = (manifest.modules ?? []).find(item => item.id === "dsh-ensemble");
  const candidate = row?.url;
  const url = typeof candidate === "string" && candidate !== "" ? candidate : fail("the dsh-ensemble boot row names no bundle URL");
  const bundle = await fetchWith(options.origin, url, options.cookie);
  if (bundle.status !== 200) fail(`the Host served ${bundle.status} for the dsh-ensemble bundle at ${url}`);
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  const source = new TextDecoder().decode(bytes);
  const { exports, seats } = factoryFacts(source);
  return {
    pageStatus: page.status,
    modules,
    clientUrl: url,
    clientBytes: bytes.byteLength,
    clientSha256: createHash("sha256").update(deliveredCode(source)).digest("hex"),
    servedSha256: createHash("sha256").update(bytes).digest("hex"),
    exports,
    seats,
  };
}
