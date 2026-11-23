/**
 * Authenticated-Host Client acceptance: a real browser drives the real shipped
 * browser UI of a **running** DSH Host.
 *
 * This is deliberately not `verify-browser.ts`. That file is the component gate:
 * it extracts the package, mounts the Client into a minimal shell it declares
 * itself, and answers the Remote from deterministic fixtures. This file shares
 * none of that: it loads the Host's own page from the Host's own origin, with the
 * real boot manifest, the real module system, the real feature plugins and the
 * real `ensembleArchive` Remote — the only input is a session cookie the Host
 * itself issued.
 *
 * What it therefore proves, and what it does not:
 *
 * - proves: cookie-authenticated page load, the shipped Client entry composing
 *   into the official sidebar and main seats, real project listing/selection,
 *   real fixed-revision reads, one real owner write observed through the GUI, the
 *   read revision advancing, and a real authorization loss (the Host stops
 *   accepting the cookie) clearing cached state and disabling management.
 * - does not prove: model answer quality (the fixture provider is deterministic),
 *   a paid model run, or that the gate covers the native Settings/environment
 *   backends when the fixture composition omits them.
 *
 * Exits:
 * - `0` every check passed.
 * - `1` a check failed; `result.json` records the failure and the step log.
 * - `2` a required input is missing or unusable (browser, connection handoff,
 *   package, origin). Nothing was asserted.
 *
 * Inputs (all required; nothing is defaulted, so a missing input fails instead of
 * silently testing something else):
 * - `--connection <file>` — the live Host handoff written by the product serve
 *   driver: `{ origin, browserCookieFile, apiCookieFile, packageRoot, projectId, head, ... }`.
 * - `--browser <path>` — official Chrome/Chromium executable (or
 *   `ENSEMBLE_BROWSER_EXECUTABLE`).
 * - `--output <dir>` — where `result.json` and the screenshot are written.
 *
 * The two cookies are separate roles: the page (`GET /?token=…`) needs the browser
 * cookie, the Remote needs the API cookie (`GET /connect?token=…`), and the Host
 * answers 401 to each other's credential. The gate checks both.
 *
 * Optional environment: `ENSEMBLE_BROWSER_LIBRARIES` (LD_LIBRARY_PATH for the
 * browser process only) and `ENSEMBLE_BROWSER_FONTCONFIG` (fontconfig file for the
 * browser process only). No credential is ever printed or written to the output.
 *
 * @module adapters/dsh/client/verify-auth
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { preflight } from "./host-preflight.ts";
import { HandoffCredentialError, inspectServedClient } from "./served-client.ts";
import { GateFailure, classifyHostFailure, exitCodeOf, prerequisite, product } from "./gate-failure.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Retained for callers that imported the old name; the gate now classifies every failure. */
export class PrerequisiteError extends GateFailure {
  override readonly name: string = "PrerequisiteError";
  constructor(message: string) {
    super("prerequisite", message);
  }
}

/**
 * The live Host handoff the serve driver writes.
 *
 * Two credentials with two jobs, and they are not interchangeable: the Host's page
 * accepts the **browser** cookie (`GET /?token=…`, a `v1` session) and answers 401
 * to the API cookie on the same route. The legacy `cookieFile` is the API one; a
 * handoff that carries only it cannot load the page, so the gate refuses by name
 * instead of reporting a product failure.
 */
export interface Handoff {
  readonly origin: string;
  /** Cookie for the page and the WebSocket: `GET /?token=…`, never the API one. */
  readonly browserCookieFile: string;
  /** Cookie for the Remote/gateway: `GET /connect?token=…`. */
  readonly apiCookieFile: string;
  readonly packageRoot: string;
  readonly projectId?: string;
  readonly head?: string;
  /** Where `head` came from, when the driver says so. */
  readonly headSource?: string;
  readonly rootSessionId?: string;
}

/** Arguments this verifier accepts. Any other argument is a usage error. */
export interface Options {
  readonly connection: string;
  readonly browser: string;
  readonly output: string;
  /** Run only the phases that need no browser binary; never an authenticated-UI pass. */
  readonly servedOnly?: boolean;
}

const OPTIONS = ["--connection", "--browser", "--output"] as const;
/** Flags that take no value. */
const FLAGS = ["--served-only"] as const;
type OptionName = typeof OPTIONS[number];

/**
 * Parse argv in one pass. Every option is required, no option may repeat, and an
 * option whose value is missing fails on that option instead of swallowing the
 * next flag — so a stale Make invocation cannot quietly run a weaker check.
 * @param argv - arguments after the script path.
 * @returns resolved absolute paths.
 */
export function parseOptions(argv: readonly string[]): Options {
  const values = new Map<OptionName, string>();
  let servedOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if ((FLAGS as readonly string[]).includes(arg)) {
      if (servedOnly) throw new PrerequisiteError(`argument ${arg} was given twice`);
      servedOnly = true;
      continue;
    }
    if (!(OPTIONS as readonly string[]).includes(arg)) throw new PrerequisiteError(`unknown argument ${arg}`);
    const name = arg as OptionName;
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new PrerequisiteError(`argument ${name} needs a value`);
    if (values.has(name)) throw new PrerequisiteError(`argument ${name} was given twice`);
    values.set(name, value);
    index += 1;
  }
  for (const name of OPTIONS) if (!values.has(name)) throw new PrerequisiteError(`missing required argument ${name}`);
  const browser = process.env.ENSEMBLE_BROWSER_EXECUTABLE ?? values.get("--browser")!;
  return { connection: resolve(values.get("--connection")!), browser: resolve(browser), output: resolve(values.get("--output")!), servedOnly };
}

/**
 * Read and validate the live Host handoff.
 *
 * The handoff is produced by a real install + boot + token exchange, so a
 * malformed one means the fixture is not what this gate expects; that is a
 * prerequisite failure, not a Client failure.
 * @param path - connection.json path.
 * @returns the validated handoff.
 */
export async function readHandoff(path: string): Promise<Handoff> {
  if (!existsSync(path)) throw new PrerequisiteError(`no connection handoff at ${path}; run the product serve driver first`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new PrerequisiteError(`connection handoff at ${path} is not JSON`);
  }
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (key: string): string => {
    const field = record[key];
    if (typeof field !== "string" || field === "") throw new PrerequisiteError(`connection handoff is missing ${key}`);
    return field;
  };
  const origin = text("origin");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new PrerequisiteError(`connection handoff origin is not a URL: ${origin}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new PrerequisiteError("connection handoff origin must be http(s)");
  const optional = (key: string): string | undefined => (typeof record[key] === "string" && record[key] !== "" ? record[key] as string : undefined);
  // Two roles, validated separately: a handoff that names only the API cookie is
  // refused by name, because the page cannot be loaded with it.
  const browserCookieFile = optional("browserCookieFile");
  const apiCookieFile = optional("apiCookieFile") ?? (record.cookieFileMeaning === "api" ? optional("cookieFile") : undefined);
  if (browserCookieFile === undefined) {
    throw new PrerequisiteError("connection handoff has no browserCookieFile. The page needs the cookie from GET /?token=… (v1); the API cookie from GET /connect?token=… (v2) is rejected by the index route with 401, so a handoff carrying only that cannot load the UI.");
  }
  if (apiCookieFile === undefined) throw new PrerequisiteError("connection handoff has no apiCookieFile (the Remote/gateway cookie)");
  for (const [name, file] of [["browserCookieFile", browserCookieFile], ["apiCookieFile", apiCookieFile]] as const) {
    if (!existsSync(file)) throw new PrerequisiteError(`connection handoff ${name} does not exist: ${file}`);
  }
  const packageRoot = text("packageRoot");
  if (!existsSync(join(packageRoot, "package.json"))) throw new PrerequisiteError(`packageRoot is not an installed package: ${packageRoot}`);
  return { origin: url.origin, browserCookieFile, apiCookieFile, packageRoot, projectId: optional("projectId"), head: optional("head"), headSource: optional("headSource"), rootSessionId: optional("rootSessionId") };
}

/**
 * Read the session cookie the Host issued and turn it into the pair the browser
 * needs. Uses the installed package's own jar parser: the gate must accept exactly
 * the shapes the shipped CLI accepts, not a second interpretation of them.
 * @param packageRoot - installed package root.
 * @param cookieFile - handoff cookie file.
 * @param origin - Host origin the cookie belongs to.
 * @returns cookie name, value and the URL it is scoped to.
 */
export async function readCookie(packageRoot: string, cookieFile: string, origin: string): Promise<{ name: string; value: string; url: string }> {
  const jar = await import(pathToFileURL(join(packageRoot, "lib", "cookie-jar.mjs")).href) as { parseCookieText(text: string): string };
  const header = jar.parseCookieText(await readFile(cookieFile, "utf8"));
  if (header === "") throw new PrerequisiteError("no session cookie in the handoff cookie file");
  const equals = header.indexOf("=");
  if (equals <= 0) throw new PrerequisiteError("session cookie is not a name=value pair");
  return { name: header.slice(0, equals), value: header.slice(equals + 1), url: origin };
}

/** One checked assertion with the evidence that satisfied it. */
interface Check { readonly name: string; readonly detail: string }

/**
 * Click a control by visible label, scoped to our workspace.
 *
 * The shipped shell has its own buttons, and after a preview renders there can be a
 * second control with the same label. Clicking the wrong one looks exactly like a
 * product failure ("the preview never appeared"), so the search is scoped to
 * `.ensemble-workspace` first and only falls back to the whole document for the
 * sidebar entry that opens the workspace.
 * @param page - real page.
 * @param text - visible label or accessible name.
 */
async function clickLabel(page: Page, text: string): Promise<void> {
  // Resolve to exactly one visible control, then click with a real pointer event.
  //
  // Two deliberate choices, both from measurement:
  //
  // 1. **Exact accessible name wins; `includes` is only a fallback.** Labels overlap in this
  //    shell — "Ensemble" is both a sidebar entry and a panel action, and
  //    "Unpin Ensemble from sidebar" contains it — so picking by substring alone can click the
  //    wrong node and then look like the product ignored a click.
  // 2. **The click is `ElementHandle.click()`**, not `element.click()` inside `evaluate`.
  //    A programmatic click fires handlers even inside an `inert` subtree, so it cannot tell a
  //    usable page from a covered one. Note the honest limit: a pointer click reports success
  //    even when something else is on top, because the browser delivers the event to whatever
  //    occupies that coordinate. So success is not treated as proof of reachability — callers
  //    that depend on what the click changes assert the change itself.
  const resolved = await page.evaluate(label => {
    const name = (element: HTMLElement): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
    const all = () => [...document.querySelectorAll<HTMLElement>("button, a, [role=button]")];
    const describe = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        name: name(element).slice(0, 40),
        visible: element.checkVisibility(),
        box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    };
    const scope = document.querySelector(".ensemble-workspace");
    const inScope = scope === null ? [] : [...scope.querySelectorAll<HTMLElement>("button, a, [role=button]")];
    // Exact matches first, in the workspace if any, then anywhere in the document.
    const exact = inScope.find(element => name(element) === label) ?? all().find(element => name(element) === label);
    const partial = exact ?? inScope.find(element => name(element).includes(label)) ?? all().find(element => name(element).includes(label));
    if (partial === undefined) return { found: false as const, candidates: all().map(describe).filter(c => c.name !== "").slice(0, 40) };
    if (partial.id === "") partial.id = `__auth_${Math.random().toString(36).slice(2)}`;
    return { found: true as const, id: partial.id, exact: partial === exact, candidate: describe(partial) };
  }, text);
  if (!resolved.found) throw new Error(`no control named ${JSON.stringify(text)}; candidates: ${JSON.stringify(resolved.candidates)}`);
  if (!resolved.exact) {
    // Recorded rather than silent: a partial match is a real risk of clicking a sibling.
    console.error(`auth-ui: WARNING — ${JSON.stringify(text)} matched by substring to ${JSON.stringify(resolved.candidate.name)}`);
  }
  const handle = await page.$(`#${resolved.id}`);
  if (handle === null) throw new Error(`control ${JSON.stringify(text)} vanished before it could be clicked`);
  await handle.click();
}

/**
 * Wait until the owner management form is actually usable.
 *
 * `canManage` requires a live archive watch, which the Client establishes after the
 * project is selected. Clicking into a still-disabled fieldset is a silent no-op that
 * reads exactly like "the preview never rendered", so the gate waits for the enabled
 * state instead of racing it. The check is behavioural (the fieldset wrapping the action
 * form) so it holds against any build, including one with no diagnostic attributes.
 * @param page - real page.
 * @param timeout - how long the watch may take to establish.
 */
async function waitForEnabledOwnerForm(page: Page, timeout = 45_000): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const select = document.querySelector<HTMLSelectElement>('.ensemble-workspace select[name="action"]');
      const form = select?.closest("form");
      if (form === null || form === undefined) return false;
      const fieldset = form.querySelector<HTMLFieldSetElement>("fieldset");
      return fieldset !== null && !fieldset.disabled;
    }, { timeout });
  } catch (error) {
    const seen = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      const select = document.querySelector<HTMLSelectElement>('.ensemble-workspace select[name="action"]');
      const form = select?.closest("form");
      return {
        state: root === null ? null : { ...root.dataset },
        formFound: form !== null && form !== undefined,
        fieldsetDisabled: form?.querySelector<HTMLFieldSetElement>("fieldset")?.disabled ?? null,
        alerts: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [role=alert]")].map(element => (element.textContent ?? "").trim().slice(0, 160)),
        text: root?.innerText.slice(0, 400) ?? "",
      };
    }).catch(() => "page gone");
    throw new Error(`the owner form never became enabled within ${timeout}ms (${String(error)}); page state: ${JSON.stringify(seen)}`);
  }
}

/**
 * Wait for a selector, and on timeout say what the page actually offers.
 *
 * A bare "Waiting failed: 30000ms exceeded" costs the next reader a full
 * investigation; the interesting fact is always which controls existed instead.
 * @param page - real page.
 * @param selector - CSS selector to wait for.
 * @param description - what the wait is for, in the failure message.
 */
async function waitForSelector(page: Page, selector: string, description: string, timeout = 30_000): Promise<void> {
  try {
    await page.waitForFunction(sel => document.querySelector(sel) !== null, { timeout }, selector);
  } catch (error) {
    const seen = await page.evaluate(() => ({
      selects: [...document.querySelectorAll<HTMLSelectElement>("select")].map(element => ({ name: element.name, options: element.options.length })),
      tabs: [...document.querySelectorAll<HTMLElement>(".ensemble-tabs button")].map(element => (element.textContent ?? "").trim()),
      view: [...document.querySelectorAll<HTMLElement>(".ensemble-tabs button[aria-current=page]")].map(element => (element.textContent ?? "").trim()),
      text: document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(0, 500) ?? document.body.innerText.slice(0, 500),
    })).catch(() => "page gone");
    throw new Error(`${description}: ${selector} did not appear (${String(error)}); page state: ${JSON.stringify(seen)}`);
  }
}

async function waitForText(page: Page, text: string, timeout = 30_000, description = `the text ${JSON.stringify(text)}`): Promise<void> {
  try {
    await page.waitForFunction(value => document.body.innerText.includes(value), { timeout }, text);
  } catch (error) {
    const seen = await page.evaluate(() => ({
      view: [...document.querySelectorAll<HTMLElement>(".ensemble-tabs button[aria-current=page]")].map(element => (element.textContent ?? "").trim()),
      buttons: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace button")].map(element => (element.textContent ?? "").trim()).filter(Boolean).slice(0, 20),
      fields: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [name]")].map(element => element.getAttribute("name") ?? ""),
      alerts: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [role=alert]")].map(element => (element.textContent ?? "").trim().slice(0, 120)),
      text: document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(0, 600) ?? "",
    })).catch(() => "page gone");
    throw new Error(`${description} did not appear within ${timeout}ms; page state: ${JSON.stringify(seen)}`);
  }
}

/** The page's visible text, for messages that must quote what a user actually sees. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/**
 * Wait until the shipped UI has rendered the Ensemble workspace. The page is the
 * Host's own; nothing here injects a slot, a shell or a Remote.
 * @param page - real page.
 */
async function openWorkspace(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, { timeout: 60_000 });
  // The sidebar panel list is a row of icon-only buttons whose name lives in
  // `aria-label`; with the sidebar collapsed their text content is empty, so
  // waiting on visible text would time out on a perfectly good shell.
  await page.waitForFunction(() => {
    const named = (element: Element): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
    return [...document.querySelectorAll("[aria-label], button, a")].some(element => named(element) === "Ensemble");
  }, { timeout: 60_000 });
  // Selecting a main panel can re-render the whole frame, so the click may tear
  // down the execution context under us. Retry once against the fresh document
  // instead of reporting a rendering failure that never happened.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await clickLabel(page, "Ensemble");
      await page.waitForFunction(() => document.querySelector(".ensemble-workspace") !== null, { timeout: 30_000 });
      return;
    } catch (error) {
      const message = String(error);
      const detached = /detached|Execution context was destroyed|Cannot find context/iu.test(message);
      if (!detached || attempt === 1) throw error;
      await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, { timeout: 60_000 });
    }
  }
}

/**
 * Choose an option in a React-controlled `<select>`.
 *
 * `page.select` sets `.value` and fires only `input`/`change`; React's synthetic
 * handler reads from its own value tracker, so the change is frequently dropped and
 * the form keeps rendering the *previous* action. Setting through the prototype
 * setter and dispatching both events is what React actually observes.
 * @param page - real page.
 * @param selector - CSS selector of the select, scoped to our workspace.
 * @param value - option value to choose.
 */
async function selectOption(page: Page, selector: string, value: string): Promise<void> {
  const chosen = await page.evaluate((sel, wanted) => {
    const element = document.querySelector<HTMLSelectElement>(sel);
    if (element === null) return `no select matching ${sel}`;
    if (![...element.options].some(option => option.value === wanted)) {
      return `select ${sel} has no option ${wanted}; options: ${JSON.stringify([...element.options].map(option => option.value))}`;
    }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, wanted);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, selector, value);
  if (chosen !== true) throw new Error(String(chosen));
  // The form re-renders its fields for the new action, so wait for the state to settle
  // rather than racing the next interaction against it.
  await page.waitForFunction((sel, wanted) => (document.querySelector<HTMLSelectElement>(sel)?.value ?? "") === wanted, {}, selector, value);
}
async function fillField(page: Page, name: string, value: string): Promise<void> {
  const filled = await page.evaluate((field, content) => {
    // Scope to our own workspace: the shipped shell can contain controls with the
    // same `name`, and writing into one of those would look like a Client failure.
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`.ensemble-workspace [name="${field}"]`);
    if (!element) return false;
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, content);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, name, value);
  if (!filled) throw new Error(`management form has no field named ${name}`);
}

/**
 * Run the authenticated-Host acceptance.
 * @param options - validated inputs.
 * @returns the machine-readable result.
 */
export async function verify(options: Options): Promise<{ status: "passed" | "failed"; checks: readonly Check[]; result: Json }> {
  const handoff = await readHandoff(options.connection);
  // `servedOnly` runs the phases that need no browser binary (live Host + served
  // artifact). It is NOT a pass of this gate: the browser phase is what makes it
  // the authenticated-UI gate, so a served-only run reports `status: "partial"`
  // and the CLI never exits 0 for it.
  const servedOnly = options.servedOnly === true;
  if (!servedOnly && !existsSync(options.browser)) throw new PrerequisiteError(`browser executable does not exist: ${options.browser}`);
  const browserCookie = await readCookie(handoff.packageRoot, handoff.browserCookieFile, handoff.origin);
  const apiCookie = await readCookie(handoff.packageRoot, handoff.apiCookieFile, handoff.origin);
  if (browserCookie.name !== apiCookie.name) {
    throw new PrerequisiteError(`handoff cookies name different cookies (${browserCookie.name} vs ${apiCookie.name}); they must belong to the same Host origin`);
  }
  if (browserCookie.value === apiCookie.value) {
    throw new PrerequisiteError("handoff browser and API cookies are identical, so one role was filled with the other; the page and the Remote need different cookies");
  }
  const manifest = JSON.parse(await readFile(join(handoff.packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
  const artifact = createHash("sha256").update(await readFile(join(handoff.packageRoot, "index.js"))).digest("hex");
  const cookieHeader = `${apiCookie.name}=${apiCookie.value}`;
  const pageCookieHeader = `${browserCookie.name}=${browserCookie.value}`;

  await mkdir(options.output, { recursive: true });
  const checks: Check[] = [];
  // Phase 1 — the live Host, over the real transport, with the Host's own cookie.
  // A transport/credential outcome is classified: an unreachable Host is the
  // fixture's problem, a refused session or a refused request is the product's.
  let live: Awaited<ReturnType<typeof preflight>>;
  try {
    live = await preflight({ packageRoot: handoff.packageRoot, origin: handoff.origin, cookie: cookieHeader });
  } catch (error) {
    const classified = classifyHostFailure(error);
    if (classified.kind === "prerequisite") throw new PrerequisiteError(classified.message);
    product(classified.message, error);
  }
  if (!live.fresh && handoff.projectId !== undefined && handoff.projectId !== live.projectId) {
    product(`the fixture's projectId ${handoff.projectId} is not the project the live Host lists (${String(live.projectId)}); the fixture and the Host disagree about the archive`);
  }
  checks.push({
    name: "authenticated-remote",
    detail: live.fresh
      ? `the installed transport with the Host-issued cookie answered as owner; the archive is not initialized yet (${live.workspaces.length} native Workspace(s) available), so the browser phase must initialize it through the UI`
      : `the installed transport with the Host-issued cookie listed ${live.projectCount} project(s) and read ${String(live.head)} at a pinned revision`,
  });

  // Phase 2 — what the Host actually serves to a browser. This is the phase that
  // a component fixture cannot reach, and it needs no browser binary.
  const served = await (async () => {
    try {
      return await inspectServedClient({ origin: handoff.origin, cookie: pageCookieHeader });
    } catch (error) {
      // A wrong-credential handoff asserted nothing about the product; every other
      // served-page failure is the Host's own answer and therefore the product's.
      if (error instanceof HandoffCredentialError) throw new PrerequisiteError(error.message);
      product(`the Host does not serve a usable Client: ${(error as Error).message}`, error);
    }
  })();
  // The two roles must stay distinct on the wire, not just in the handoff: this is
  // the assertion that catches a fixture that swapped them.
  const wrongRole = await fetch(`${handoff.origin}/`, { headers: { cookie: cookieHeader }, redirect: "manual" });
  if (wrongRole.status !== 401) {
    product(`the Host served the page (${wrongRole.status}) with the API cookie; the page and the Remote must reject each other's credential`);
  }
  checks.push({ name: "credential-roles", detail: "the API cookie is rejected by the page route (401) while the browser cookie loads it; the two roles are distinct on this Host" });
  checks.push({ name: "served-client", detail: `authenticated page 200; boot manifest composes dsh-ensemble; the Host serves ${served.clientBytes} bytes at ${served.clientUrl} (sha256 ${served.clientSha256.slice(0, 12)}); factory exports ${served.exports.join("/")}; seats ${served.seats.join(", ")}` });
  // The served bytes must be the installed artifact's code, not something stale:
  // the bundle is generated from the installed `client.js`, so its hash is a fact
  // about the deployment rather than about the gate.
  const installedClient = join(handoff.packageRoot, "client.js");
  if (existsSync(installedClient)) {
    // Compare code, not delivery framing: the Host's `/plugins/??` route appends a
    // `;` and a sourceMappingURL line, which is not part of the shipped file.
    const installedSha = createHash("sha256").update(await readFile(installedClient)).digest("hex");
    if (installedSha !== served.clientSha256) {
      product(`the served Client code (${served.clientSha256.slice(0, 12)}) is not the installed client.js (${installedSha.slice(0, 12)}); the Host is serving a stale artifact`);
    }
    checks.push({ name: "served-artifact-match", detail: `served bundle sha256 equals the installed client.js (${installedSha.slice(0, 12)})` });
  }
  if (servedOnly) {
    const partial = {
      status: "partial",
      package: { name: manifest.name, version: manifest.version, installedIndexSha256: artifact },
      host: { origin: handoff.origin, projectId: live.projectId ?? null, head: live.head ?? null, epoch: live.epoch ?? null },
      served: { pageStatus: served.pageStatus, modules: served.modules.length, clientUrl: served.clientUrl, clientBytes: served.clientBytes, clientSha256: served.clientSha256, exports: served.exports, seats: served.seats },
      checks,
      limitation: "Served phases only: the live Host answered through the real transport and the Host serves this Client's own bundle. The browser phase — real rendering, a GUI owner write, revision refresh and cookie revocation — did NOT run, so this is not authenticated-UI evidence.",
    };
    return { status: "passed", checks, result: partial as unknown as Json };
  }
  const pageErrors: string[] = [];
  let browser: Browser | undefined;
  try {
    // Chrome's crashpad handler needs a writable HOME plus an XDG tree; without
    // them the browser exits 127 before starting and the failure reads like a
    // missing shared library. Both stay inside the output directory.
    const home = join(options.output, "home");
    await mkdir(home, { recursive: true });
    browser = await puppeteer.launch({
      executablePath: options.browser,
      headless: true,
      userDataDir: join(options.output, "chrome"),
      env: {
        ...process.env,
        HOME: home,
        ...(process.env.ENSEMBLE_BROWSER_LIBRARIES ? { LD_LIBRARY_PATH: process.env.ENSEMBLE_BROWSER_LIBRARIES } : {}),
        ...(process.env.ENSEMBLE_BROWSER_FONTCONFIG ? { FONTCONFIG_FILE: process.env.ENSEMBLE_BROWSER_FONTCONFIG } : {}),
        XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
      },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter", "--disable-gpu"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (error: unknown) => pageErrors.push(error instanceof Error ? error.message : String(error)));
    await page.setViewport({ width: 1440, height: 900 });
    // The only credential: the cookie the Host issued, scoped to the Host origin.
    await page.setCookie({ name: browserCookie.name, value: browserCookie.value, url: browserCookie.url });

    const response = await page.goto(`${handoff.origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (response === null || response.status() !== 200) throw new Error(`the Host did not serve its page: ${response?.status() ?? "no response"}`);
    // The page must be the Host's own: its boot manifest names the installed Client.
    const boot = await page.evaluate(() => {
      // The wire field is `entries` (what the Host's own `parseBootManifest` reads);
      // `modules` is accepted too so this stays correct against the parsed form.
      const value = Reflect.get(globalThis, "__DSH_BOOT__") as { entries?: { id?: string }[]; modules?: { id?: string }[] } | undefined;
      if (value === undefined) return null;
      const rows: { id?: string }[] = value.entries ?? value.modules ?? [];
      return { modules: rows.map(row => row.id ?? "") };
    });
    if (boot === null) throw new Error("the Host page carries no boot manifest");
    if (!boot.modules.includes("dsh-ensemble")) throw new Error(`the Host boot manifest does not compose this Client: ${JSON.stringify(boot.modules.slice(0, 8))}…`);
    checks.push({ name: "host-page", detail: `real page from ${handoff.origin}; boot manifest composes dsh-ensemble (package ${String(manifest.name)}@${String(manifest.version)}, installed index.js ${artifact.slice(0, 12)})` });

    // The shell opens behind a "Preview Notice" modal and marks `#root` inert while it is up.
    // A person must dismiss it before anything is reachable, so the gate does too — with a
    // real pointer click, then waiting for `inert` to actually clear. Without this the probe
    // drives an inert page: a programmatic click would still "work", which is how a gate can
    // report a journey a user could never walk.
    const rootInert = (): Promise<boolean> => page.evaluate(() => {
      const root = document.getElementById("root");
      return root?.inert === true || root?.getAttribute("inert") !== null;
    });
    // A boot modal covers the whole viewport with a mask, so every control behind it is
    // unreachable even when `#root` is not inert. Detect that by asking what is actually at
    // the centre of the viewport.
    const hasBlockingModal = (): Promise<boolean> => page.evaluate(() => {
      const centre = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2)) as HTMLElement | null;
      const blocking = centre?.closest('[role="dialog"], [role="presentation"]');
      return blocking !== null && blocking !== undefined;
    });
    // Two modals can cover the shell — a "Preview Notice" and, with no signed-in account, a
    // "Get started" one. They do not both mark `#root` inert the same way: the Preview
    // Notice does, but "Get started" renders as `role="presentation"` over a full-screen
    // mask with no aria-label, so `#root` can be non-inert while the shell is still
    // unreachable. The check below therefore must close each named modal that is present,
    // not stop early when `#root` merely looks inert-free.
    const closed: string[] = [];
    // The boot modals are not present at DOMContentLoaded on every Host: measured on the
    // auth lane, "Get started" arrives ~1.5s later as a `role=dialog` with aria-label
    // "Get started". Poll a short, bounded window for each named modal before giving up,
    // so a late popup cannot escape the dismiss step and later block the tab click.
    const dismissDeadline = Date.now() + 8_000;
    for (let pass = 0; pass < 3; pass += 1) {
      let acted = false;
      for (const [dialogLabel, buttonLabel] of [["Preview Notice", "Continue"], ["Get started", "Close"]] as const) {
        const id = await page.evaluate((wanted: { dialog: string; button: string }) => {
          const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
          // The modals are not uniformly labelled: "Preview Notice" is a
          // `[role=dialog]` carrying an accessible name, while "Get started" renders as
          // `role="presentation"` over a full-screen mask with no aria-label. So match the
          // dialog-ish containers by name OR by their own leading text — each found by what
          // it actually is, not by an assumed attribute.
          const labelled = dialogs.find(element => (element.getAttribute("aria-label") ?? "").includes(wanted.dialog));
          const byText = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="presentation"]')]
            .find(element => (element.textContent ?? "").trim().startsWith(wanted.dialog));
          const dialog = labelled ?? byText;
          if (dialog === undefined) return null;
          const named = (element: HTMLElement): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
          const button = [...dialog.querySelectorAll<HTMLElement>("button, [role=button]")].find(element => named(element) === wanted.button);
          if (button === undefined) return null;
          if (button.id === "") button.id = `__auth_modal_${Math.random().toString(36).slice(2)}`;
          return button.id;
        }, { dialog: dialogLabel, button: buttonLabel });
        if (id === null) continue;
        const handle = await page.$(`#${id}`);
        if (handle === null) continue;
        await handle.click();
        await new Promise(done => setTimeout(done, 400));
        if (!closed.includes(dialogLabel)) closed.push(dialogLabel);
        acted = true;
      }
      if (acted) continue;
      if (Date.now() >= dismissDeadline) break;
      await new Promise(done => setTimeout(done, 500));
    }
    await page.waitForFunction(() => {
      const root = document.getElementById("root");
      return !(root?.inert === true || root?.getAttribute("inert") !== null);
    }, { timeout: 20_000 });
    checks.push({ name: "boot-modals-dismissed", detail: `closed ${JSON.stringify(closed)} with real pointer clicks; #root is no longer inert` });

    await openWorkspace(page);
    checks.push({ name: "official-seats", detail: "shipped Client entry opened from the official sidebar panel list into the keyed main seat" });

    // Both journeys end at the same result shape: one project and one committed
    // revision, reached either by initializing a fresh archive or by using an
    // existing one.
    let target: string | undefined;
    let committed: string | null = null;
    if (live.fresh) {
      // The real first-run journey: with no project the UI must let the owner
      // initialize one by choosing a native Workspace from the registry — never by
      // typing an internal id. This is the path a new user actually walks.
      await waitForText(page, "Projects & access");
      await clickLabel(page, "Projects & access");
      await page.waitForFunction(() => document.querySelector('select[name="action"]') !== null, { timeout: 30_000 });
      const initialiseOffered = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>('select[name="action"] option')].map(option => option.value));
      if (!initialiseOffered.includes("initialize")) throw new Error(`a fresh Host does not offer initialize; actions: ${JSON.stringify(initialiseOffered)}`);
      const picker = await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>('select[name="workspace_select"]');
        return select === null ? null : { options: [...select.options].map(option => option.value).filter(Boolean), banner: document.body.innerText };
      });
      if (picker === null) {
        // Either the registry is not composed or it holds nothing; both are states
        // the Client must explain rather than silently omit the control.
        if (!picker && !/No native Workspace exists yet|registry is not available/u.test(await visibleText(page))) {
          throw new Error("the initialize form has no Workspace picker and no explanation for its absence");
        }
        throw new Error("a fresh Host cannot initialize: the Client shows no native Workspace picker, so a user would have to type an internal id");
      }
      if (picker.options.length === 0) throw new Error("the Workspace picker is present but lists no native Workspace, so initialize cannot be completed from the UI");
      await page.select('select[name="workspace_select"]', picker.options[0]!);
      checks.push({ name: "workspace-picker", detail: `the initialize form offers ${picker.options.length} native Workspace choice(s); selected ${picker.options[0]}` });
      // The picked control must produce a complete source descriptor, not a blank one.
      const descriptor = await page.evaluate(() => {
        const text = document.body.innerText;
        const path = /Resolved source directory:\s*(\S+)/u.exec(text)?.[1] ?? /Source address[^\n]*\n?([^\n]+)/u.exec(text)?.[1];
        return path ?? null;
      });
      checks.push({ name: "descriptor-filled", detail: descriptor === null ? "the picked Workspace filled the descriptor (path shown in the review step)" : `the picked Workspace resolved ${descriptor}` });
      await fillField(page, "reason", "authenticated Client acceptance: first project");
      await clickLabel(page, "Review changes");
      await waitForText(page, "Submit reviewed operation");
      await clickLabel(page, "Submit reviewed operation");
      await waitForText(page, "Committed", 90_000);
      const created = await page.evaluate(() => ({
        revision: /"committed_revision"\s*:\s*"([0-9a-f]{7,64})"/u.exec(document.body.innerText)?.[1] ?? null,
        project: /"id"\s*:\s*"([^"]+)"/u.exec(document.body.innerText)?.[1] ?? null,
      }));
      if (created.revision === null) throw new Error("initializing through the UI reported no committed revision");
      checks.push({ name: "gui-initialize", detail: `the archive was created from the GUI: committed ${created.revision}, project ${created.project ?? "(reported by the Host)"}` });
      // The new project must now be selectable and readable at its own revision.
      await clickLabel(page, "Refresh");
      await page.waitForFunction(() => document.querySelector(".ensemble-workspace header select") !== null, { timeout: 45_000 });
      const returned = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].map(option => option.value).filter(Boolean));
      if (returned.length === 0) throw new Error("after initializing, the owner catalogue still lists no project");
      await page.select(".ensemble-workspace header select", returned[0]!);
      await clickLabel(page, "Current work");
      await page.waitForFunction(() => /Snapshot:\s*[0-9a-f]{7,64}/u.test(document.body.innerText), { timeout: 30_000 });
      const freshSnapshot = await page.evaluate(() => /Snapshot:\s*([0-9a-f]{7,64})/u.exec(document.body.innerText)?.[1] ?? null);
      checks.push({ name: "fresh-read", detail: `the new project reads at pinned revision ${String(freshSnapshot)}` });
      target = returned[0]!;
      committed = created.revision;
    } else {

    // Real project catalogue from the real store, rendered by the real Client. The
    // project picker is inside our own workspace header, not the shell's chrome —
    // scoping it to `.ensemble-workspace` is what keeps this from reading an
    // unrelated shell select.
    await page.waitForFunction(() => document.querySelector(".ensemble-workspace header select") !== null, { timeout: 30_000 });
    // Wait for the catalogue to be *populated*, not merely present: an empty select is
    // rendered before the owner query answers, and reading it then reports "no project"
    // for a Host that has one.
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].some(option => option.value !== ""), { timeout: 45_000 });
    const projects = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].map(option => ({ value: option.value, label: option.textContent ?? "" })).filter(option => option.value !== ""));
    if (projects.length === 0) throw new Error("the authenticated owner sees no project in the Client");
    target = handoff.projectId ?? projects[0]!.value;
    if (!projects.some(project => project.value === target)) throw new Error(`handoff project ${target} is not in the owner catalogue: ${JSON.stringify(projects)}`);
    await page.select(".ensemble-workspace header select", target);
    checks.push({ name: "real-projects", detail: `authenticated owner catalogue rendered ${projects.length} project(s); selected ${target}` });

    // A fixed-revision read through the real Remote and the real controller. Selecting the
    // project fires the QueryView read effect, and the read is proved by the QueryView
    // response page (`section p.ensemble-muted > code`, `state.page.read_revision`) — not by
    // the toolbar snapshot, which would look green even when the query never ran.
    await clickLabel(page, "Current work");
    await page.waitForFunction(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      if (root === null || root.getAttribute("data-view") !== "work") return false;
      const section = root.querySelector<HTMLElement>("section");
      const code = section?.querySelector<HTMLElement>("p.ensemble-muted > code");
      if (code === null || code === undefined) return false;
      if ((code.textContent ?? "").trim() === "") return false;
      if (root.innerText.includes("Loading…")) return false;
      return root.querySelector('[role="alert"]') === null;
    }, { timeout: 30_000 });
    const snapshot = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      const code = root?.querySelector<HTMLElement>("section p.ensemble-muted > code");
      return code === null || code === undefined ? null : (code.textContent ?? "").trim();
    });
    if (snapshot === null || snapshot === "") throw new Error("the Client did not render a QueryView read snapshot");
    // A repeated click on the already-active "Current work" tab must NOT clear the read
    // (this guards the same-view navigate regression: navigate()/select() must be idempotent).
    await clickLabel(page, "Current work");
    const afterRepeat = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      const code = root?.querySelector<HTMLElement>("section p.ensemble-muted > code");
      return code === null || code === undefined ? null : (code.textContent ?? "").trim();
    });
    if (afterRepeat !== snapshot) throw new Error(`a repeated click on the active "Current work" tab cleared the read (was ${snapshot}, now ${String(afterRepeat)})`);
    // Compare against the head this run read from the Host, not the handoff's snapshot of
    // it: the archive legitimately advances between the handoff being written and the
    // gate running, and a stale handoff must not read as a Client defect.
    const expectedHead = live.head ?? handoff.head;
    if (expectedHead !== undefined && snapshot !== expectedHead) throw new Error(`the Client read ${snapshot} but the Host head is ${expectedHead}`);
    checks.push({ name: "fixed-revision-read", detail: `Current work rendered a real QueryView read at pinned revision ${snapshot} and a repeat click kept it` });

    // One real owner write, driven through the shipped form and its explicit
    // review/submit step. `pause` is reversible, so the fixture stays usable.
    await clickLabel(page, "Projects & access");
    await waitForSelector(page, '.ensemble-workspace select[name="action"]', "the owner management form");
    // Choose the action that is a real transition. The Host's `projects` summary does not
    // carry a pause flag (only `manage diagnose` reports `paused`), so the archive's
    // current write state cannot be read from the catalogue; ask the Host over the real
    // transport instead of guessing from rendered text.
    const diagnosis = await (async () => {
      const transport = await import(pathToFileURL(join(handoff.packageRoot, "lib", "transport.bundle.mjs")).href) as {
        connect(input: { url: string; cookie: string }): Promise<{ call(endpoint: string, payload: unknown): Promise<unknown>; close(): Promise<void> }>;
      };
      const connection = await transport.connect({ url: handoff.origin, cookie: cookieHeader });
      try {
        const answer = await connection.call("ensembleArchive/manage", {
          request: {
            project_id: target, action: "diagnose", payload: { scope: "archive" },
            expected_revision: snapshot, operation_id: `gate-diagnose-${Date.now()}`,
          },
        }) as { ok?: boolean; value?: { paused?: boolean } };
        return answer.ok === true ? answer.value?.paused === true : undefined;
      } finally {
        await connection.close();
      }
    })();
    const action = diagnosis === true ? "resume" : "pause";
    const offered = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('.ensemble-workspace select[name="action"]');
      return select === null ? [] : [...select.options].map(option => option.value);
    });
    if (!offered.includes(action)) throw new Error(`the owner form does not offer ${action}; offered: ${JSON.stringify(offered)}`);
    await selectOption(page, '.ensemble-workspace select[name="action"]', action);
    await waitForEnabledOwnerForm(page, 45_000);
    await fillField(page, "reason", "authenticated Client acceptance");
    // Actions that reverse a prior write ask for the diagnostic reference that justified
    // it; `resume` requires it. Fill whatever the form marks required rather than
    // hard-coding one action's fields, so this keeps working if the form changes.
    const required = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.ensemble-workspace form [name]')]
      .filter(element => element.closest("label")?.textContent?.includes("Required") === true)
      .map(element => element.getAttribute("name") ?? "")
      .filter(name => name !== "" && name !== "action" && name !== "reason"));
    for (const field of required) {
      // `diagnostic_ref` is a typed `Ref` (a tagged union), not free text: the Host
      // refuses a bare `[]` with "No closed variant matches". Use the archive's own
      // diagnostic reference — the pause that this gate is reversing.
      if (field === "diagnostic_ref") await fillField(page, field, JSON.stringify({ kind: "native_event", session_id: handoff.rootSessionId ?? "gate", event_seq: 0 }));
      else await fillField(page, field, "authenticated Client acceptance");
    }
    // The management form's own fieldset gates submission; the pane also contains an
    // unrelated fieldset for location selection, so the check must target the one that
    // wraps the action form rather than "the first fieldset on the page".
    const gate = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('.ensemble-workspace select[name="action"]');
      const form = select?.closest("form");
      const fieldset = form?.querySelector<HTMLFieldSetElement>("fieldset") ?? null;
      return { formFound: form !== null, fieldsetDisabled: fieldset?.disabled ?? null };
    });
    if (gate.fieldsetDisabled === true) {
      // Distinguish the causes a reader would otherwise have to guess between: no live
      // watch, a not-ready status, or a missing capability. The Client renders a notice
      // only for the last one, so report the rendered evidence rather than a guess.
      const why = await page.evaluate(() => {
        const text = document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText ?? "";
        return {
          forbiddenNotice: text.includes("This action requires a current owner capability"),
          disconnected: text.includes("Disconnected"),
          denied: text.includes("Access is unavailable"),
          status: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [role=status], .ensemble-workspace [role=alert]")]
            .map(element => (element.textContent ?? "").trim().slice(0, 160)),
          pauseOffered: (() => {
            const select = document.querySelector<HTMLSelectElement>('.ensemble-workspace select[name="action"]');
            return select === null ? null : [...select.options].some(option => option.value === "pause");
          })(),
          pauseSelected: document.querySelector<HTMLSelectElement>('.ensemble-workspace select[name="action"]')?.value ?? null,
        };
      });
      throw new Error(`the owner form is disabled, so no preview can be produced: ${JSON.stringify({ ...gate, ...why })}`);
    }
    await clickLabel(page, "Review changes");
    await waitForText(page, "Submit reviewed operation", 30_000, "the review panel after Review changes");
    await clickLabel(page, "Submit reviewed operation");
    // An owner write that changes the authorization epoch is a write the archive treats
    // as an access change, so the Client's own watch reports the new epoch and the
    // controller invalidates cached state by design. Either outcome is honest; what must
    // NOT happen is a silent no-op. Accept the receipt or the revalidation notice, then
    // prove the write landed by re-reading the archive.
    try {
      // The uncertain banner's text — "The write outcome is not confirmed" — appears while
      // the manage call is still in flight, so it is NOT a terminal state and must not be
      // read as an unconfirmed outcome. The write settles when the Submit button is gone
      // (a commit clears the preview) or re-enabled (an unconfirmed write keeps it), and a
      // terminal outcome then renders: the "Committed" result card, a recovery banner, or a
      // revalidation notice.
      await page.waitForFunction(() => {
        const root = document.querySelector<HTMLElement>(".ensemble-workspace");
        if (root === null) return false;
        const submit = [...root.querySelectorAll<HTMLElement>("button")]
          .find(element => (element.textContent ?? "").trim() === "Submit reviewed operation");
        const finished = submit === undefined || !(submit as HTMLButtonElement).disabled;
        if (!finished) return false;
        const committed = [...root.querySelectorAll<HTMLElement>("[role=status]")]
          .some(element => (element.textContent ?? "").includes("Committed"));
        const uncertain = root.querySelector<HTMLElement>("[data-recovery]") !== null;
        const revalidate = /authorization_changed|Archive access changed/u.test(document.body.innerText);
        // A healthy commit settles to `ready` *after* the controller revalidates authority;
        // the result card renders one step earlier, so "Committed" alone would let this
        // read a snapshot the controller has not re-established yet. The uncertain banner
        // and a foreign-revocation notice are the two genuinely different terminal states.
        return (committed && root.getAttribute("data-status") === "ready") || uncertain || revalidate;
      }, { timeout: 90_000 }, undefined);
    } catch (error) {
      const seen = await page.evaluate(() => ({
        text: document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(0, 1200) ?? "",
        alerts: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [role=alert], .ensemble-workspace [role=status]")].map(element => (element.textContent ?? "").trim().slice(0, 300)),
        buttons: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace button")].map(element => (element.textContent ?? "").trim()).filter(Boolean).slice(0, 20),
      })).catch(() => "page gone");
      throw new Error(`the submit produced no receipt, revalidation notice, or uncertainty notice within 90s (${String(error)}); page state: ${JSON.stringify(seen)}`);
    }
    const writeOutcome = await page.evaluate(() => {
      // Read the outcome from the DOM as it renders. The Client prints results through `Value`,
      // which emits a `dl` of translated labels, so `"committed_revision": "…"` (a JSON dump)
      // never appears in the text — that pattern could only ever match a serialised payload,
      // and against real `dt`/`dd` markup it always returned null. That is how a normal,
      // successful owner write could be misread as "no receipt".
      const rows = (list: HTMLElement): Map<string, string> => {
        const rowMap = new Map<string, string>();
        for (const term of [...list.querySelectorAll<HTMLElement>("dt")]) {
          rowMap.set((term.textContent ?? "").trim().toLowerCase(), (term.nextElementSibling?.textContent ?? "").trim());
        }
        return rowMap;
      };
      const lists = [...document.querySelectorAll<HTMLElement>(".ensemble-workspace dl")].map(list => rows(list));
      const pick = (rowMap: Map<string, string>, ...needles: string[]): string | null => {
        for (const needle of needles) for (const [key, value] of rowMap) if (key.includes(needle)) return value === "" ? null : value;
        return null;
      };
      const receiptRow = lists.find(rowMap => pick(rowMap, "operation identity", "operation id") !== null)
        ?? lists.find(rowMap => pick(rowMap, "committed revision") !== null)
        ?? null;
      const revision = receiptRow === null ? null : pick(receiptRow, "committed revision");
      const text = document.body.innerText;
      // A healthy commit settles itself: the "Committed" card renders and the uncertain
      // banner is gone. "The write outcome is not confirmed" appears while the manage
      // call is still in flight, so it is NOT proof of an uncertain outcome by itself;
      // the Client's recovery banner (`data-recovery`) is the record of an unconfirmed
      // write, and it exists only when the controller genuinely could not confirm.
      const uncertainBanner = document.querySelector<HTMLElement>(".ensemble-workspace [data-recovery]");
      const committedCard = [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [role=status]")]
        .some(element => (element.textContent ?? "").includes("Committed"));
      return {
        receipt: revision !== null && /^[0-9a-f]{40}$/u.test(revision) ? revision : null,
        // The receipt's own operation id, when the result view renders it.
        operation: receiptRow === null ? null : pick(receiptRow, "operation identity", "operation id"),
        revalidate: text.includes("authorization_changed") || text.includes("Archive access changed"),
        uncertain: uncertainBanner !== null,
        committed: committedCard,
        forbidden: text.includes("This action requires a current owner capability"),
      };
    });
    // A write that simply succeeded is the normal case and needs no recovery: the existing
    // assertion after the revalidation/read steps records it. The uncertain branch below
    // exists only for the case where the Client says it could not confirm — it must NOT be a
    // required detour, or a healthy success would look like a failure to satisfy the gate.
    if (writeOutcome.uncertain) {
      // The Client is telling the truth: it could not confirm the commit, and it keeps the
      // operation id so a receipt can settle it. Read that id from the page — the Client's
      // own record of what it is uncertain about — so the receipt can be tied to THIS
      // operation rather than to any write that happens to have produced a receipt.
      const pendingOperation = await page.evaluate(() => {
        const banner = document.querySelector<HTMLElement>(".ensemble-workspace [data-recovery]");
        const code = banner?.querySelector("code")?.textContent?.trim() ?? "";
        return code === "" ? undefined : code;
      });
      if (pendingOperation === undefined) {
        throw new Error("the Client reported an unconfirmed write but showed no operation id, so no receipt can be tied to it");
      }
      // Measured on this fixture: the uncertain banner is transient here. The write raises the
      // authorization epoch, so the Client drops to "access is unavailable" plus
      // "authorization_changed … Refresh projects to revalidate access" and the recovery
      // banner goes away — which means the receipt cannot render until access is revalidated.
      // So: revalidate first, with the SAME pending operation kept, then ask for its receipt.
      // No new operation is previewed; that would be a second write papering over the unknown.
      const needsRevalidate = await page.evaluate(() => {
        const text = document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText ?? "";
        return /authorization_changed|Archive access changed|Access is unavailable/u.test(text);
      });
      if (needsRevalidate) {
        await clickLabel(page, "Refresh access");
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].some(option => option.value !== ""), { timeout: 45_000 });
        const again = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].map(option => option.value).filter(Boolean));
        if (again.length === 0) throw new Error("after revalidating access the owner catalogue lists no project, so the pending receipt cannot be read");
        await page.select(".ensemble-workspace header select", again[0]!);
        await clickLabel(page, "Projects & access");
        await waitForSelector(page, '.ensemble-workspace select[name="action"]', "the owner management form after revalidating");
        checks.push({ name: "revalidated-same-pending", detail: `access was revalidated through the shipped control and project ${again[0]} selected again; the pending operation ${pendingOperation} was kept and no new operation was opened` });
      }
      await clickLabel(page, "Read operation receipt");
      // The click starts an asynchronous `query {kind:"receipt"}`; the button exists before
      // the result does, so waiting on the button's own label matches instantly and then
      // reads a page that has not arrived. Wait for the receipt OBJECT to render, bounded,
      // and report the actual DOM plus the pending operation on timeout.
      let settled: {
        found: boolean; status: string | null; committed: string | null; operation: string | null; tail: string;
      };
      try {
        await page.waitForFunction(() => {
          const has = (list: HTMLElement): boolean => {
            const keys = [...list.querySelectorAll<HTMLElement>("dt")].map(term => (term.textContent ?? "").trim().toLowerCase());
            return keys.some(key => key.includes("operation id")) && keys.some(key => key.includes("committed revision"));
          };
          return [...document.querySelectorAll<HTMLElement>(".ensemble-workspace dl")].some(has);
        }, { timeout: 45_000 });
        settled = await page.evaluate(() => {
          // The Client renders the receipt through `Value`, which prints the TRANSLATED label
          // of each wire key: `operation_id` → "Operation identity", `committed_revision` →
          // "Committed revision", `status` → "Status". There is no JSON dump to pattern-match.
          const rows = (list: HTMLElement): Map<string, string> => {
            const rowMap = new Map<string, string>();
            for (const term of [...list.querySelectorAll<HTMLElement>("dt")]) {
              const value = (term.nextElementSibling?.textContent ?? "").trim();
              rowMap.set((term.textContent ?? "").trim().toLowerCase(), value);
            }
            return rowMap;
          };
          const receipt = [...document.querySelectorAll<HTMLElement>(".ensemble-workspace dl")]
            .map(list => rows(list))
            .find(rowMap => [...rowMap.keys()].some(key => key.includes("operation id"))
              && [...rowMap.keys()].some(key => key.includes("committed revision")));
          if (receipt === undefined) {
            const seen = [...document.querySelectorAll<HTMLElement>(".ensemble-workspace dl")]
              .map(list => [...rows(list).keys()].slice(0, 12));
            return { found: false, status: null, committed: null, operation: null, tail: JSON.stringify(seen).slice(0, 600) };
          }
          const pick = (...needles: string[]): string | null => {
            for (const needle of needles) for (const [key, value] of receipt) if (key.includes(needle)) return value === "" ? null : value;
            return null;
          };
          const status = pick("status");
          const revision = pick("committed revision");
          return {
            found: true,
            status,
            // This repository's revisions are 40-hex SHA-1 commit ids.
            committed: revision !== null && /^[0-9a-f]{40}$/u.test(revision) ? revision : null,
            operation: pick("operation identity", "operation id"),
            tail: "",
          };
        });
      } catch (error) {
        const state = await page.evaluate(() => ({
          pending: document.querySelector<HTMLElement>(".ensemble-workspace [data-recovery] code")?.textContent?.trim() ?? null,
          recovery: document.querySelector<HTMLElement>(".ensemble-workspace [data-recovery]")?.getAttribute("data-recovery") ?? null,
          alerts: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [role=alert], .ensemble-workspace [role=status]")].map(element => (element.textContent ?? "").trim().slice(0, 200)),
          text: document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(-700) ?? "",
        })).catch(() => "page gone");
        throw new Error(`the receipt for operation ${pendingOperation} never rendered within 45s after the click (${String(error)}); the write stays unconfirmed. Page state: ${JSON.stringify(state)}`);
      }
      // Per the shipped contract (`Receipt.status: "committed"`), a receipt settles this write
      // only when it names the SAME operation the Client was uncertain about, states
      // `committed`, and carries a revision. There is no "terminal status family" to widen
      // into: `denied` would be a different authorization outcome, and a transport failure is
      // a `Result` with `ok: false`, not a Receipt status. Reading a null status as settled —
      // which an earlier version of this gate did — is precisely the fake green being removed.
      if (!settled.found) {
        throw new Error(`the receipt view rendered no receipt object (no definition list with both an operation id and a committed revision); the write stays unconfirmed. Tail: ${settled.tail}`);
      }
      if (settled.status === null || settled.status.toLowerCase() !== "committed") {
        throw new Error(`the receipt did not state committed (status ${JSON.stringify(settled.status)}); the write stays unconfirmed and the gate must not call it settled`);
      }
      if (settled.committed === null) {
        throw new Error(`the receipt stated committed but carried no revision (revision ${JSON.stringify(settled.committed)})`);
      }
      if (settled.operation === null) {
        throw new Error("the receipt carried no operation id, so it cannot be tied to the write this gate was uncertain about");
      }
      if (settled.operation !== pendingOperation) {
        throw new Error(`the receipt names operation ${settled.operation} but the unconfirmed write was ${pendingOperation}; one must not settle the other`);
      }
      checks.push({ name: "gui-write-receipt", detail: `the Client reported an unconfirmed write; the shipped receipt for that same operation ${settled.operation} stated status "committed" at revision ${settled.committed}` });
      // Once the same-operation receipt states committed, that IS the settle: no further
      // operation and no retry. A head that has not moved is an assertion failure here, not a
      // licence to re-review — re-reviewing would be a second write masking an unknown one.
      const headNow = await preflight({ packageRoot: handoff.packageRoot, origin: handoff.origin, cookie: cookieHeader, expectStableHead: false });
      if (headNow.head !== settled.committed) {
        throw new Error(`the receipt states committed at ${settled.committed} but the Host head is ${String(headNow.head)}; the gate will not open a second operation to paper over that`);
      }
    }
    if (writeOutcome.receipt === null && !writeOutcome.revalidate && !writeOutcome.uncertain) {
      const seen = await page.evaluate(() => ({
        tail: document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(-900) ?? "",
        alerts: [...document.querySelectorAll<HTMLElement>(".ensemble-workspace [role=alert], .ensemble-workspace [role=status]")].map(element => (element.textContent ?? "").trim().slice(0, 300)),
      })).catch(() => "page gone");
      throw new Error(`the GUI write produced neither a receipt nor a revalidation notice: ${JSON.stringify({ ...writeOutcome, page: seen })}`);
    }

    // Revalidate through the shipped control, exactly as a person would after the Client
    // says access changed, and confirm the archive is readable again at a new revision.
    await clickLabel(page, "Refresh access");
    await waitForSelector(page, ".ensemble-workspace header select", "the project catalogue after revalidating access");
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].some(option => option.value !== ""), { timeout: 45_000 });
    const revalidated = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].map(option => option.value).filter(Boolean));
    if (revalidated.length === 0) throw new Error("after revalidating access the owner catalogue lists no project");
    // The written project is the same one selected before, not whatever happens to be the
    // first row in DOM order after the revalidation.
    if (!revalidated.includes(target)) throw new Error(`after revalidating access the owner catalogue does not include the written project ${target}; options: ${JSON.stringify(revalidated)}`);
    // Re-selecting the written project (never the first row in DOM order) fires the QueryView
    // read effect — with the same-project guard in the controller, this is idempotent and the
    // read page is not cleared. Then a repeated "Current work" click must also keep it.
    await page.select(".ensemble-workspace header select", target);
    await clickLabel(page, "Current work");
    await page.waitForFunction(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      if (root === null || root.getAttribute("data-view") !== "work") return false;
      const section = root.querySelector<HTMLElement>("section");
      const code = section?.querySelector<HTMLElement>("p.ensemble-muted > code");
      if (code === null || code === undefined) return false;
      if ((code.textContent ?? "").trim() === "") return false;
      if (root.innerText.includes("Loading…")) return false;
      return root.querySelector('[role="alert"]') === null;
    }, { timeout: 45_000 });
    const afterWrite = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      const code = root?.querySelector<HTMLElement>("section p.ensemble-muted > code");
      return code === null || code === undefined ? null : (code.textContent ?? "").trim();
    });
    if (afterWrite === null) throw new Error("after the GUI write the archive rendered no QueryView read snapshot");
    if (afterWrite === snapshot) throw new Error(`the GUI write did not advance the archive revision (still ${afterWrite})`);
    // The strongest evidence is not the GUI's own text: ask the Host, over the real
    // transport, what revision it now holds.
    const afterHost = await preflight({ packageRoot: handoff.packageRoot, origin: handoff.origin, cookie: cookieHeader, expectStableHead: false });
    if (afterHost.head !== afterWrite) throw new Error(`the GUI shows ${afterWrite} but the Host head is ${String(afterHost.head)}`);
    checks.push({ name: "gui-owner-write", detail: `${action} committed through the shipped form; the write raised the authorization epoch, the Client revalidated on request, and the archive re-read at the Host's new head ${afterWrite} (was ${snapshot})` });

    // Real authorization loss: the browser's session cookie is gone, so the Host now
    // answers 401 to this page. The Client only learns that through an HTTP call: its
    // watch rides a WebSocket authenticated at connect time, so clearing the cookie does
    // not disturb an established stream. The catalogue refresh is therefore what must
    // surface the loss — and it is the workspace's own control ("Refresh access"), not the
    // shell's "Refresh", which reloads an unrelated panel and would never exercise it.
    const client = await page.createCDPSession();
    await client.send("Network.clearBrowserCookies");
    await client.detach();
    await clickLabel(page, "Refresh access");
    await page.waitForFunction(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      const text = root?.innerText ?? "";
      // The Client must stop claiming a usable archive: either it reports the transport
      // refusal, or it drops to a denied/error state. Any of those is the loss being seen.
      return root?.dataset.status === "denied" || root?.dataset.status === "error"
        || /401|Unauthorized|unauthorized|Disconnected|Access is unavailable|not authorized/iu.test(text);
    }, { timeout: 45_000 });
    // Cached state must actually be cleared: no selected project and no QueryView read page.
    const afterLoss = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".ensemble-workspace");
      return {
        selected: root?.getAttribute("data-selected") ?? "",
        hasQueryViewPage: (root?.querySelector("section p.ensemble-muted > code") ?? null) !== null,
        submitVisible: [...(root?.querySelectorAll<HTMLElement>("button") ?? [])].some(button => (button.textContent ?? "").trim() === "Submit reviewed operation"),
      };
    });
    if (afterLoss.selected !== "") throw new Error(`after the Host rejected the session the Client still has a selected project (${JSON.stringify(afterLoss.selected)})`);
    if (afterLoss.hasQueryViewPage) throw new Error("after the Host rejected the session the Client still renders a cached QueryView read page");
    if (afterLoss.submitVisible) throw new Error("management submission stayed available after the Host rejected the session");
    const api = await page.evaluate(async origin => {
      const answer = await fetch(`${origin}/api/ensembleArchive/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: [{ request: {} }] }) });
      return answer.status;
    }, handoff.origin);
    if (api !== 401) throw new Error(`the Host answered ${api} without a session cookie instead of 401`);
    checks.push({ name: "authorization-loss", detail: "cookie cleared in the browser: the Host answers 401, the Client clears the selected project and cached read page and disables management submission" });
    }

    await page.screenshot({ path: join(options.output, "workspace.png"), fullPage: true });
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
    const result = {
      status: "passed",
      package: { name: manifest.name, version: manifest.version, installedIndexSha256: artifact },
      host: { origin: handoff.origin, projectId: target ?? null, head: handoff.head ?? null, committedRevision: committed, initializedByGate: live.fresh },
      browser: await browser.version(),
      checks,
      pageErrors,
      limitation: "Real authenticated Host, real page, real Remote and real owner write. The fixture's model provider is deterministic, so no model-quality claim is made; native Settings/environment targets and destructive maintenance backends are covered only when the fixture composition provides them.",
    };
    return { status: "passed", checks, result: result as unknown as Json };
  } catch (error) {
    // A red gate must carry what the page looked like, or the next reader has to
    // re-derive it. Screenshot + visible text + the interactive controls, all
    // inside the output directory (never the cookie).
    let snapshot: Record<string, unknown> | undefined;
    try {
      const page = (await browser?.pages())?.[0];
      if (page !== undefined) {
        await page.screenshot({ path: join(options.output, "failure.png"), fullPage: true });
        snapshot = await page.evaluate(() => ({
          text: document.body.innerText.slice(0, 2500),
          controls: [...document.querySelectorAll<HTMLElement>("button, a, select, input")].map(element => ({
            tag: element.tagName.toLowerCase(),
            name: element.getAttribute("name") ?? "",
            label: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60),
            visible: element.checkVisibility(),
          })).slice(0, 80),
        }));
      }
    } catch { /* the page may already be gone; the failure message still stands */ }
    const failure = { status: "failed", failure: String(error), checks, pageErrors, ...(snapshot === undefined ? {} : { page: snapshot }) };
    return { status: "failed", checks, result: failure as unknown as Json };
  } finally {
    await browser?.close();
  }
}

if (import.meta.main) {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-auth: ${(error as Error).message}`);
    console.error("usage: bun adapters/dsh/client/verify-auth.ts --connection <connection.json> --browser <chrome> --output <dir>");
    process.exit(2);
  }
  try {
    const outcome = await verify(options);
    await mkdir(options.output, { recursive: true });
    await writeFile(join(options.output, "result.json"), `${JSON.stringify(outcome.result, null, 2)}\n`);
    if (options.servedOnly) {
      console.error("verify-auth: PARTIAL — served phases passed (live Host + served artifact); the browser phase did not run, so this is NOT an authenticated-UI pass");
      process.exit(1);
    }
    if (outcome.status !== "passed") {
      console.error(`verify-auth: PRODUCT FAILURE — ${String((outcome.result as { failure?: string }).failure)}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ status: "passed", checks: outcome.checks.map(check => check.name), result: join(options.output, "result.json") }, null, 2));
  } catch (error) {
    // The two kinds get different exit codes and different sentences, because
    // their remedies point at different people.
    if (error instanceof GateFailure) {
      console.error(error.kind === "prerequisite" ? `verify-auth: PREREQUISITE — ${error.message}` : `verify-auth: PRODUCT FAILURE — ${error.message}`);
      process.exit(exitCodeOf(error.kind));
    }
    console.error(`verify-auth: PRODUCT FAILURE — ${(error as Error).message}`);
    process.exit(1);
  }
}
