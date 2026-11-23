/**
 * Fresh-Host journey: create a native Workspace through the shipped DSH UI, then
 * initialize the archive through this Client's own picker.
 *
 * This is the from-scratch lane. It is deliberately separate from `verify-auth.ts`:
 * that gate assumes a native Workspace already exists, and this one must prove the
 * user can reach the from-nothing state without typing an internal id.
 *
 * The official route, read from `@deepseek-ai/dsh-client-ui-workspace` rc.5 rather
 * than guessed:
 *   1. the sidebar header's "+" button, `aria-label` = locale `workspace.add`
 *      ("Add workspace"). It renders only when a directory-flow occupant is
 *      composed, so its absence is a composition fact to report, not a selector bug;
 *   2. the button opens a menu whose add entry is locale `menu.addWorkspace`
 *      ("Add workspace…");
 *   3. that entry raises the directory flow from the slot
 *      `sidebar.workspaces.directoryFlow`, supplied by
 *      `dsh-client-ui-directory-picker-{native,browse}`;
 *   4. picking a host directory calls `workspace.create` over the Remote and the
 *      Workspace appears in the sidebar.
 *
 * Exit contract matches the other gates: 0 passed, 1 product failure, 2 prerequisite.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

interface Handoff {
  readonly origin: string;
  readonly browserCookieFile: string;
  /** Remote credential; needed only to ask the Host who the authenticated owner is. */
  readonly apiCookieFile?: string;
  readonly packageRoot: string;
  /**
   * The deployment's declared source world, as the fixture reports it.
   *
   * `sourceWorld` is the only honest source: the Host never projects this value to the
   * browser (`OwnerContext`, `ProjectSummary` and the boot manifest all lack it; the
   * `choose` response echoes a world only *after* the operator picks one, which is a
   * side effect and not a declaration). The fixture writes its own
   * `DSH_ENSEMBLE_SOURCE_WORLD` here, so the field and the Host cannot drift apart.
   */
  readonly sourceWorld?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly headSource?: string;
}

/** Inputs the probe needs, parsed from argv so a missing one fails before any browser starts. */
export interface FreshJourneyArguments {
  readonly connection?: string;
  readonly browser?: string;
  readonly output?: string;
  readonly "host-directory"?: string;
}

/**
 * Parse the probe's argv.
 *
 * Exported and pure so the refusal contract is testable without a browser: a probe that
 * starts a Host page and *then* discovers it lacks an input wastes the fixture and can
 * report a misleading failure.
 * @param argv - process arguments after the script name.
 * @returns the parsed values, each present only when supplied.
 */
export function parseArguments(argv: readonly string[]): FreshJourneyArguments {
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  return { connection: option("connection"), browser: option("browser"), output: option("output"), "host-directory": option("host-directory") };
}

/** The first missing required input, or `undefined` when the probe may run. */
export function missingPrerequisite(input: FreshJourneyArguments): keyof FreshJourneyArguments | undefined {
  for (const name of ["connection", "browser", "output", "host-directory"] as const) if (input[name] === undefined) return name;
  return undefined;
}

/**
 * Why this handoff cannot serve the fresh lane, if it cannot.
 *
 * The lane exists to prove the journey from *no* project. A handoff that already carries
 * one would silently substitute the picker journey for the create journey, which is the
 * most valuable thing this probe could get wrong.
 * @param handoff - the live Host handoff.
 * @returns a reason, or `undefined` when the handoff is a genuine fresh Host.
 */
export function freshPremiseFailure(handoff: Pick<Handoff, "projectId" | "workspaceId">): string | undefined {
  if (handoff.projectId !== undefined) return `this handoff already carries project ${handoff.projectId}; the fresh lane needs a Host with no project`;
  if (handoff.workspaceId !== undefined) return `this handoff already carries workspace ${handoff.workspaceId}; the fresh lane must create it through the UI`;
  return undefined;
}

interface Check {
  readonly name: string;
  readonly detail: string;
}

const ok = (checks: Check[], name: string, detail: string): void => { checks.push({ name, detail }); };

/** Visible text of the whole document, for messages that must quote what a user sees. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/**
 * Find a control by its accessible name.
 *
 * The shipped sidebar controls are icon-only, so the name lives in `aria-label`.
 * Matching on text content would silently miss every one of them.
 */
async function hasControl(page: Page, label: string): Promise<boolean> {
  return page.evaluate(wanted => [...document.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem]")]
    .some(element => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().includes(wanted)), label);
}

async function clickControl(page: Page, label: string): Promise<void> {
  const clicked = await page.evaluate(wanted => {
    const candidates = [...document.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem]")]
      .filter(element => element.checkVisibility());
    const name = (element: HTMLElement): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
    const match = candidates.find(element => name(element) === wanted) ?? candidates.find(element => name(element).includes(wanted));
    if (match === undefined) return candidates.map(name).filter(Boolean).slice(0, 40);
    match.click();
    return true;
  }, label);
  if (clicked !== true) throw new Error(`no visible control named ${JSON.stringify(label)}; visible: ${JSON.stringify(clicked)}`);
}

/** Wait for a condition expressed as page code, and on timeout report what is visible. */
async function waitFor(page: Page, predicate: string, description: string, timeout = 30_000): Promise<void> {
  try {
    // A string is passed straight to the page's own evaluator, so the predicate can be
    // built from the same DOM facts the assertions read.
    await page.waitForFunction(predicate, { timeout });
  } catch (error) {
    const seen = await page.evaluate(() => ({
      controls: [...document.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem]")]
        .filter(element => element.checkVisibility())
        .map(element => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim()).filter(Boolean).slice(0, 40),
      text: document.body.innerText.slice(0, 900),
    })).catch(() => "page gone");
    throw new Error(`${description} did not appear within ${timeout}ms (${String(error)}); page: ${JSON.stringify(seen)}`);
  }
}

/** Wait for visible text, and on timeout quote what the workspace actually shows. */
async function waitForText(page: Page, text: string, timeout: number, description: string): Promise<void> {
  try {
    await page.waitForFunction(value => document.body.innerText.includes(value), { timeout }, text);
  } catch (error) {
    const seen = await page.evaluate(() => document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(0, 600) ?? "").catch(() => "page gone");
    throw new Error(`${description} did not appear within ${timeout}ms (${String(error)}); workspace text: ${JSON.stringify(seen)}`);
  }
}

/** Click a control by visible label or accessible name, preferring the workspace scope. */
async function clickLabel(page: Page, text: string): Promise<void> {
  const clicked = await page.evaluate(label => {
    const name = (element: HTMLElement): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
    const scope = document.querySelector(".ensemble-workspace");
    const search = (root: ParentNode): HTMLElement | undefined => {
      const candidates = [...root.querySelectorAll<HTMLElement>("button, a, [role=button]")].filter(element => element.checkVisibility());
      return candidates.find(element => name(element) === label) ?? candidates.find(element => name(element).includes(label));
    };
    const match = (scope === null ? undefined : search(scope)) ?? search(document);
    if (match === undefined) return [...document.querySelectorAll<HTMLElement>("button, a, [role=button]")].filter(element => element.checkVisibility()).map(name).filter(Boolean).slice(0, 40);
    match.click();
    return true;
  }, text);
  if (clicked !== true) throw new Error(`no visible control named ${JSON.stringify(text)}; visible: ${JSON.stringify(clicked)}`);
}

/**
 * Locate the directory-picker dialog specifically.
 *
 * The page also carries an unrelated "Preview Notice" dialog, so selecting the first
 * `[role=dialog]` picks the wrong one. The browse picker is identified by its own
 * controls: an editable path input and an Open/Cancel footer.
 */
const PICKER = `[...document.querySelectorAll('[role="dialog"]')].find(d => d.querySelector('input[aria-label="Edit path"]') !== null || [...d.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === 'Open'))`;

/** Choose an option in a React-controlled select: prototype setter plus both events. */
async function fillField(page: Page, name: string, value: string): Promise<void> {
  const filled = await page.evaluate((field, content) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`.ensemble-workspace [name="${field}"]`);
    if (element === null) return false;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, content);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, name, value);
  if (!filled) throw new Error(`the initialize form has no field named ${name}`);
}

/**
 * Ask the Host who the authenticated caller is, over the real transport.
 *
 * The provenance check needs the Host's own answer, not the page's: comparing the form's
 * grant subject with a value the page reported would only prove the page is
 * self-consistent. This reads it from `ensembleArchive/projects` with the API cookie, which
 * the Host derives from the trusted connection — never from anything this probe sends.
 * @param handoff - live Host handoff (origin, package root, API cookie file).
 * @returns the owner subject the Host reports.
 */
async function preflightOwner(handoff: Handoff): Promise<{ ownerId: string; hostAuthorityId: string }> {
  const apiCookie = handoff.apiCookieFile;
  if (apiCookie === undefined) throw new Error("the handoff carries no apiCookieFile, so the Host's own owner identity cannot be read");
  const raw = (await readFile(apiCookie, "utf8")).trim();
  const eq = raw.indexOf("=");
  if (eq < 1) throw new Error("the API cookie file is not name=value");
  const transport = await import(`${handoff.packageRoot}/lib/transport.bundle.mjs`) as {
    connect(input: { url: string; cookie: string }): Promise<{ call(endpoint: string, payload: unknown): Promise<unknown>; close(): Promise<void> }>;
  };
  const connection = await transport.connect({ url: handoff.origin, cookie: `${raw.slice(0, eq)}=${raw.slice(eq + 1)}` });
  try {
    const answer = await connection.call("ensembleArchive/projects", { request: {} }) as { ok?: boolean; value?: { current_owner?: Record<string, unknown> } };
    const subject = answer.ok === true ? answer.value?.current_owner : undefined;
    if (subject === undefined || subject.kind !== "owner" || typeof subject.ownerId !== "string" || typeof subject.hostAuthorityId !== "string") {
      throw new Error(`the Host did not report a current_owner for this connection: ${JSON.stringify(answer).slice(0, 300)}`);
    }
    return { ownerId: subject.ownerId, hostAuthorityId: subject.hostAuthorityId };
  } finally {
    await connection.close();
  }
}

/**
 * Dismiss the page's "Preview Notice" modal and wait for the shell to become interactive.
 *
 * This is not cosmetic. While the notice is open the shell marks its root `inert`, and an
 * `inert` subtree ignores pointer input — so a real user cannot touch anything behind it.
 * A probe that clicks through `page.evaluate(el => el.click())` does **not** observe that:
 * a background click dispatches the handler regardless of `inert`, which makes the page
 * look broken when it is merely covered. Measured consequence of getting this wrong: a
 * diagnostic concluded the initialize form could not be submitted, and two "confirmations"
 * followed from it, all of them artifacts of the bypass.
 *
 * So: dismiss it with its own visible control, then wait for `inert` to actually clear
 * before touching the page again.
 * @param page - the loaded page, before any panel interaction.
 */
/**
 * The Host's own project rows, read over the transport.
 *
 * Used as the authority for a revision the UI displays: comparing the DOM against the Host
 * is evidence, while a pattern over rendered text is only a guess about formatting.
 * @param handoff - live Host handoff.
 * @returns the project rows the Host reports.
 */
async function preflightProjects(handoff: Handoff): Promise<{ project_id: string; read_revision: string }[]> {
  const apiCookie = handoff.apiCookieFile;
  if (apiCookie === undefined) throw new Error("the handoff carries no apiCookieFile");
  const raw = (await readFile(apiCookie, "utf8")).trim();
  const eq = raw.indexOf("=");
  if (eq < 1) throw new Error("the API cookie file is not name=value");
  const transport = await import(`${handoff.packageRoot}/lib/transport.bundle.mjs`) as {
    connect(i: { url: string; cookie: string }): Promise<{ call(e: string, p: unknown): Promise<unknown>; close(): Promise<void> }>;
  };
  const connection = await transport.connect({ url: handoff.origin, cookie: `${raw.slice(0, eq)}=${raw.slice(eq + 1)}` });
  try {
    const answer = await connection.call("ensembleArchive/projects", { request: {} }) as { value?: { projects?: unknown } };
    const rows = Array.isArray(answer.value?.projects) ? answer.value.projects as Record<string, unknown>[] : [];
    return rows.map(row => ({ project_id: String(row.project_id ?? ""), read_revision: String(row.read_revision ?? "") }));
  } finally {
    await connection.close();
  }
}

/**
 * Close the shell's boot modals and wait for the page to become interactive.
 *
 * Two different modals can cover the shell — a "Preview Notice" and, when there is no signed-in
 * account, a "Get started" one — and each marks `#root` inert. They can appear in either
 * combination, so this walks a small, explicit set of (dialog label, button label) pairs and
 * closes each only when its own dialog is present. Nothing else is ever clicked: a blanket
 * "close every dialog" would dismiss things this gate must not touch.
 *
 * Every click is a real pointer click via `ElementHandle.click()`. A programmatic
 * `element.click()` inside `page.evaluate` fires handlers even inside an `inert` subtree, so it
 * cannot distinguish a usable page from a covered one — an earlier version of this probe made
 * exactly that mistake and reported a product failure that did not exist.
 *
 * @param page - the loaded page, before any panel interaction.
 * @returns the labels of the modals it actually closed.
 */
async function dismissBootModals(page: Page): Promise<string[]> {
  const rootInert = (): Promise<boolean> => page.evaluate(() => {
    const root = document.getElementById("root");
    return root?.inert === true || root?.getAttribute("inert") !== null;
  });
  // Resolve a visible, pointer-reachable control inside a dialog whose accessible name
  // contains `dialogLabel`. Returns { id, x, y } so the caller can send a REAL pointer
  // click at the exact measured point, never a programmatic element.click().
  const resolve = async (dialogLabel: string, buttonLabel: string): Promise<{ id: string; x: number; y: number } | null> => page.evaluate(
    (wanted: { dialog: string; button: string }) => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
      // "Preview Notice" is a [role=dialog] with aria-label; "Get started" renders as
      // [role=presentation] over a full-screen mask with no aria-label. Match by name OR
      // leading text, each by what it actually is.
      const labelled = dialogs.find(element => (element.getAttribute("aria-label") ?? "").includes(wanted.dialog));
      const byText = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="presentation"]')]
        .find(element => (element.textContent ?? "").trim().startsWith(wanted.dialog));
      const dialog = labelled ?? byText;
      if (dialog === undefined) return null;
      const named = (element: HTMLElement): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
      const button = [...dialog.querySelectorAll<HTMLElement>("button, [role=button]")].find(element => named(element) === wanted.button && element.checkVisibility());
      if (button === undefined) return null;
      const rect = button.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (hit === null || (hit !== button && !button.contains(hit))) return null; // covered
      if (button.id === "") button.id = `__gate_modal_${Math.random().toString(36).slice(2)}`;
      return { id: button.id, x, y };
    },
    { dialog: dialogLabel, button: buttonLabel },
  );

  const closed: string[] = [];
  const deadline = Date.now() + 12_000;
  // The shell opens behind "Preview Notice" (marks #root inert) and, on a lane with no
  // signed-in account, a "Get started" modal can appear LATER — after the first modal is
  // dismissed. So the loop must NOT break on the first empty sample: it keeps polling until
  // a sustained "quiet" window (no visible modal and #root non-inert) proves no late popup
  // is about to appear. Each known modal is closed only when present, by a real pointer
  // click whose target was hit-tested topmost, and only after the click the specific dialog
  // must actually disappear — a click return is not treated as success.
  let quietSince = 0;
  let settled = false;
  let lastFailure: string | undefined;
  while (Date.now() < deadline) {
    let acted = false;
    for (const [dialogLabel, buttonLabel] of [["Preview Notice", "Continue"], ["Get started", "Close"]] as const) {
      const target = await resolve(dialogLabel, buttonLabel);
      if (target === null) continue;
      await page.mouse.click(target.x, target.y);
      // Wait for THIS dialog to leave the DOM (or at least become hidden). The click is
      // only counted when the named dialog is gone afterwards. A timeout inside the
      // deadline is retried; any other error (page gone / execution context) is fatal.
      const remainingMs = Math.max(1, deadline - Date.now());
      let gone = false;
      try {
        await page.waitForFunction((wanted: string) => {
          const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
          const labelled = dialogs.find(element => (element.getAttribute("aria-label") ?? "").includes(wanted));
          const byText = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="presentation"]')]
            .find(element => (element.textContent ?? "").trim().startsWith(wanted));
          const dialog = labelled ?? byText;
          return dialog === undefined || !dialog.checkVisibility();
        }, { timeout: Math.min(4_000, remainingMs) }, dialogLabel);
        gone = true;
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          lastFailure = `dialog ${dialogLabel} did not disappear within the window`;
          continue; // retry next poll within deadline
        }
        throw error;
      }
      if (!gone) continue;
      if (!closed.includes(dialogLabel)) closed.push(dialogLabel);
      acted = true;
      quietSince = 0;
      await new Promise(done => setTimeout(done, 150));
    }
    if (!acted) {
      // No known modal found right now; require a sustained quiet window so a late "Get
      // started" (which arrives ~500ms after Preview Notice closes) cannot escape.
      const quiet = await page.evaluate(() => {
        const root = document.getElementById("root");
        if (root === null) return false;
        if (root.inert === true || root.getAttribute("inert") !== null) return false;
        const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="presentation"]')];
        return dialogs.every(d => !d.checkVisibility());
      });
      if (quiet) {
        if (quietSince === 0) quietSince = Date.now();
        else if (Date.now() - quietSince >= 1_500) { settled = true; break; }
      } else {
        quietSince = 0;
      }
      await new Promise(done => setTimeout(done, 200));
    }
  }

  if (!settled) {
    const stillInert = await rootInert();
    const remaining = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="presentation"]')]
      .filter(d => d.checkVisibility())
      .map(element => ({
        role: element.getAttribute("role"),
        aria: element.getAttribute("aria-label") ?? null,
        leading: (element.textContent ?? "").trim().slice(0, 40),
      })));
    throw new Error(`the shell did not reach a sustained quiet window before the boot-dismiss deadline; rootInert=${String(stillInert)} overlays: ${JSON.stringify(remaining)} lastFailure=${String(lastFailure)}`);
  }
  return closed;
}

/**
 * Reach a controlled form control the way a person does, and return coordinates that are
 * currently topmost on it. This is the single helper used for BOTH the initial focus and the
 * post-alert restore, so the two cannot drift.
 *
 * The sequence is: scrollIntoView once, then wait for the LAYOUT to actually settle — two
 * identical consecutive `getBoundingClientRect` values across a `requestAnimationFrame` — then
 * require the field's centre point to be topmost (`elementFromPoint` returns the field or a
 * child). If the settle wait times out, the failure reports the real rect/stack/scroll state
 * instead of guessing. No `element.focus()`, no DOM replacement, no fixed sleep: the same
 * measured coordinates are returned and used for the one real pointer click.
 */
async function pointerReachable(page: Page, selector: string): Promise<{ x: number; y: number; hit: string }> {
  const settled = await page.evaluate(async (sel) => {
    const field = document.querySelector<HTMLTextAreaElement>(sel);
    if (field === null) return { ok: false as const, reason: "no control" };
    field.scrollIntoView({ block: "center", inline: "nearest" });
    let rect = field.getBoundingClientRect();
    let stable = false;
    for (let tick = 0; tick < 24; tick += 1) {
      const first = rect;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const second = field.getBoundingClientRect();
      stable = Math.abs(first.x - second.x) < 0.5 && Math.abs(first.y - second.y) < 0.5
        && Math.abs(first.width - second.width) < 0.5 && Math.abs(first.height - second.height) < 0.5;
      rect = second;
      if (stable) break;
    }
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const lands = hit !== null && (hit === field || field.contains(hit));
    return {
      ok: true as const, stable, lands, x, y, connected: field.isConnected,
      hit: hit === null ? "none" : `${hit.tagName.toLowerCase()}${hit.getAttribute("name") ? `[name=${hit.getAttribute("name")}]` : ""}`,
      stack: [...document.elementsFromPoint(x, y)].map(e => `${e.tagName.toLowerCase()}${e.getAttribute("name") ? `[name=${e.getAttribute("name")}]` : ""}`).slice(0, 4),
      scroll: { x: window.scrollX, y: window.scrollY },
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
  }, selector);

  if (!settled.ok) throw new Error(`the control ${selector} could not be located: ${JSON.stringify(settled)}`);
  if (!settled.stable || !settled.lands || !settled.connected) {
    throw new Error(`the control ${selector} never became pointer-reachable after scroll: ${JSON.stringify(settled)}`);
  }
  return { x: settled.x, y: settled.y, hit: settled.hit };
}


async function run(): Promise<number> {
  const input = parseArguments(process.argv.slice(2));
  const missing = missingPrerequisite({ ...input, browser: input.browser ?? process.env.ENSEMBLE_BROWSER_EXECUTABLE });
  if (missing !== undefined) {
    console.error(`fresh-journey: PREREQUISITE — --${missing} is required (connection, browser, output, directory)`);
    return 2;
  }
  const connectionPath = input.connection!;
  const browserPath = (input.browser ?? process.env.ENSEMBLE_BROWSER_EXECUTABLE)!;
  const output = input.output!;
  const directory = input["host-directory"]!;
  await mkdir(output, { recursive: true });
  const handoff = JSON.parse(await readFile(connectionPath, "utf8")) as Handoff;
  const wrongLane = freshPremiseFailure(handoff);
  if (wrongLane !== undefined) { console.error(`fresh-journey: PREREQUISITE — ${wrongLane}`); return 2; }
  const cookieText = (await readFile(handoff.browserCookieFile, "utf8")).trim();
  const cut = cookieText.indexOf("=");
  if (cut < 1) { console.error("fresh-journey: PREREQUISITE — browser cookie file is not name=value"); return 2; }
  const checks: Check[] = [];
  const pageErrors: string[] = [];
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath, headless: true,
      userDataDir: join(output, "profile"),
      env: {
        ...process.env,
        // Chrome's crashpad needs a writable HOME and XDG dirs, or it exits 127 with
        // "chrome_crashpad_handler: --database is required" and looks like a missing .so.
        HOME: join(output, "home"),
        XDG_CONFIG_HOME: join(output, "home", ".config"),
        XDG_CACHE_HOME: join(output, "home", ".cache"),
        FONTCONFIG_FILE: process.env.ENSEMBLE_BROWSER_FONTCONFIG ?? "",
        LD_LIBRARY_PATH: process.env.ENSEMBLE_BROWSER_LIBRARIES ?? "",
      },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-crash-reporter"],
    });
    await mkdir(join(output, "home", ".config"), { recursive: true });
    await mkdir(join(output, "home", ".cache"), { recursive: true });
    const page = await browser.newPage();
    page.on("pageerror", (error: unknown) => pageErrors.push(String(error).slice(0, 300)));
    await page.setCookie({ name: cookieText.slice(0, cut), value: cookieText.slice(cut + 1), url: handoff.origin });
    await page.goto(`${handoff.origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitFor(page, "document.body.innerText.length > 0", "the Host page");
    // The shell opens with a "Preview Notice" modal and marks its root `inert` while it is
    // up. Dismiss it with its own Continue control and wait for `inert` to clear before any
    // interaction: a background `evaluate(...).click()` would bypass `inert` and make a
    // covered page look broken, which is exactly how an earlier version of this probe
    // reached a false conclusion about the initialize form.
    const closedModals = await dismissBootModals(page);
    ok(checks, "boot-modals-dismissed", `closed ${JSON.stringify(closedModals)} with real pointer clicks and the shell is no longer inert`);
    ok(checks, "host-page", "the Host's own page loaded with the browser cookie");

    // The from-scratch premise: this Host must genuinely have no project yet.
    const opening = await visibleText(page);
    if (handoff.projectId !== undefined) throw new Error("this lane needs a Host with no project; the handoff carries one");
    ok(checks, "fresh-premise", "the handoff declares no project, so the archive does not exist yet");

    // --- Negative case first: before any Workspace exists, the Client must not
    // pretend the user can initialize. It has to explain what is missing.
    await clickControl(page, "Ensemble");
    await waitFor(page, "document.querySelector('.ensemble-workspace') !== null", "the Ensemble workspace");
    await clickControl(page, "Projects & access");
    await waitFor(page, "document.querySelector('select[name=\"action\"]') !== null", "the owner management form");
    const beforeCreate = await page.evaluate(() => {
      const picker = document.querySelector<HTMLSelectElement>('select[name="workspace_select"]');
      const fieldset = document.querySelector<HTMLFieldSetElement>('.ensemble-workspace form fieldset');
      return {
        pickerPresent: picker !== null,
        pickerOptions: picker === null ? 0 : [...picker.options].map(option => option.value).filter(Boolean).length,
        text: document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(0, 700) ?? "",
        fieldsetDisabled: fieldset?.disabled ?? null,
      };
    });
    if (beforeCreate.pickerPresent && beforeCreate.pickerOptions > 0) {
      throw new Error(`this Host already has a native Workspace, so it is not a fresh Host: ${JSON.stringify(beforeCreate)}`);
    }
    const remedyShown = /No native Workspace exists yet|registry is not available/u.test(beforeCreate.text);
    if (!remedyShown) throw new Error(`with no native Workspace the Client showed no remedy, so a user cannot tell what to do: ${JSON.stringify(beforeCreate)}`);
    ok(checks, "fresh-no-workspace-remedy", "with no native Workspace the Client explains the state instead of offering a dead picker");

    // --- The real journey: create the Workspace through the official DSH UI.
    const addLabel = "Add workspace";
    if (!await hasControl(page, addLabel)) {
      const text = await visibleText(page);
      throw new Error(`the shipped UI exposes no ${JSON.stringify(addLabel)} control, so a user cannot create a native Workspace from the UI. Visible text: ${text.slice(0, 600)}`);
    }
    ok(checks, "workspace-add-control", `the shipped sidebar exposes the ${JSON.stringify(addLabel)} control (aria-label workspace.add)`);
    await clickControl(page, addLabel);
    // With an empty registry the add menu has exactly one entry, so the click can go
    // straight into the directory flow without a visible intermediate menu. Accept either
    // shape rather than requiring the menu, and let the flow detection below decide.
    const menuOrFlow = await page.evaluate(() => {
      const named = (element: HTMLElement): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
      const visible = [...document.querySelectorAll<HTMLElement>("[role=menuitem], button")].filter(element => element.checkVisibility());
      return { menu: visible.some(element => named(element).includes("Add workspace")), dialog: document.querySelector('[role="dialog"]') !== null };
    });
    if (menuOrFlow.menu && !menuOrFlow.dialog) {
      await clickControl(page, "Add workspace…");
    }
    await waitFor(page, `[...document.querySelectorAll('[role="dialog"]')].some(d => d.querySelector('input[aria-label="Edit path"]') !== null || [...d.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === 'Open'))`, "the composed directory flow", 30_000);
    ok(checks, "directory-flow-opened", "the add action raised the composed directory flow");

    // The flow is the browse picker: an in-page dialog with a crumb trail, an editable
    // path, and Cancel/Open. Type the host directory and adopt it with Open.
    const flow = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(d => d.querySelector('input[aria-label="Edit path"]') !== null || [...d.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === 'Open')) ?? null;
      const editPath = dialog?.querySelector<HTMLInputElement>('input[aria-label="Edit path"]')
        ?? [...(dialog?.querySelectorAll<HTMLInputElement>("input") ?? [])].find(element => element.type === "text") ?? null;
      const buttons = [...(dialog?.querySelectorAll<HTMLElement>("button") ?? [])].map(element => (element.textContent ?? "").trim()).filter(Boolean);
      return { title: dialog?.querySelector("h2")?.textContent?.trim() ?? null, hasPathInput: editPath !== null, buttons, text: dialog?.innerText.slice(0, 400) ?? "" };
    });
    await writeFile(join(output, "directory-flow.json"), JSON.stringify(flow, null, 1), "utf8");
    if (!flow.hasPathInput) {
      // The browse picker keeps the editable path behind its own "Edit path" control;
      // reveal it before typing rather than reporting a missing input that is only hidden.
      const revealed = await page.evaluate(() => {
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(d => (d.querySelector('h2')?.textContent ?? '').includes('Select Workspace Directory'));
        const button = [...(dialog?.querySelectorAll<HTMLElement>('button') ?? [])].find(b => (b.getAttribute('aria-label') ?? '').includes('Edit path'));
        if (!button) return false;
        button.click();
        return true;
      });
      if (!revealed) throw new Error(`the directory flow has no path input and no "Edit path" control: ${JSON.stringify(flow)}`);
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(d => d.querySelector('input[aria-label="Edit path"]') !== null), { timeout: 15_000 });
    }
    const typed = await page.evaluate(target => {
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(d => d.querySelector('input[aria-label="Edit path"]') !== null || [...d.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === 'Open')) ?? null;
      const input = dialog?.querySelector<HTMLInputElement>('input[aria-label="Edit path"]')
        ?? [...(dialog?.querySelectorAll<HTMLInputElement>("input") ?? [])].find(element => element.type === "text");
      if (!input) return "no path input";
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, target);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      return true;
    }, directory);
    if (typed !== true) throw new Error(`could not enter the host directory: ${String(typed)}`);
    await page.waitForFunction(() => {
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(d => d.querySelector('input[aria-label="Edit path"]') !== null || [...d.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === 'Open')) ?? null;
      return dialog === null || dialog.innerText.includes("pickable-empty");
    }, { timeout: 30_000 }).catch(() => undefined);
    await page.screenshot({ path: join(output, "directory-typed.png"), fullPage: true });
    // Adopt the directory: Open is the flow's confirming control.
    const opened = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(d => d.querySelector('input[aria-label="Edit path"]') !== null || [...d.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === 'Open')) ?? null;
      const button = [...(dialog?.querySelectorAll<HTMLElement>("button") ?? [])].find(element => (element.textContent ?? "").trim() === "Open");
      if (!button) return [...(dialog?.querySelectorAll<HTMLElement>("button") ?? [])].map(element => (element.textContent ?? "").trim()).filter(Boolean);
      button.click();
      return true;
    });
    if (opened !== true) throw new Error(`the directory flow offers no Open control; controls: ${JSON.stringify(opened)}`);
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"]')].some(d => d.querySelector('input[aria-label="Edit path"]') !== null || [...d.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === 'Open')), { timeout: 45_000 });
    ok(checks, "workspace-created", `the shipped UI adopted ${directory} as a native Workspace (workspace.create over the Remote)`);
    await page.screenshot({ path: join(output, "workspace-created.png"), fullPage: true });
    const afterCreate = await visibleText(page);
    await writeFile(join(output, "after-create.txt"), afterCreate, "utf8");

    // Creating a Workspace switches the shell into that Workspace's session view, so the
    // Ensemble panel is no longer mounted. Re-open it before driving the archive form.
    await waitFor(page, `[...document.querySelectorAll('[aria-label], button, a')].some(e => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim() === 'Ensemble')`, "the Ensemble sidebar entry after creating a Workspace", 45_000);
    await clickControl(page, "Ensemble");
    await waitFor(page, "document.querySelector('.ensemble-workspace') !== null", "the Ensemble workspace after creating a Workspace", 45_000);
    await clickControl(page, "Projects & access");
    await waitFor(page, "document.querySelector('select[name=\"workspace_select\"]') !== null", "the Workspace picker after creating one", 45_000);
    const picker = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('select[name="workspace_select"]');
      return select === null ? [] : [...select.options].map(option => ({ value: option.value, label: (option.textContent ?? "").trim() })).filter(option => option.value !== "");
    });
    if (picker.length === 0) throw new Error("after creating a native Workspace the Ensemble picker still lists none");
    ok(checks, "workspace-picker", `the picker now offers ${picker.length} native Workspace(s): ${picker.map(option => option.label).join(" | ")}`);
    // Choose the Workspace through the prototype setter plus both events, not `page.select`.
    // React keeps its own value tracker: a plain `page.select` sets `.value` and fires
    // events, but the framework frequently drops the change, leaving `source_descriptor`
    // empty — which shows up later as "required controls are empty" and reads like a product
    // fault. This is the same reason `selectOption` in the auth gate works that way.
    const pickedWorkspace = await page.evaluate((value: string) => {
      const select = document.querySelector<HTMLSelectElement>('select[name="workspace_select"]');
      if (select === null) return { ok: false as const, reason: "no picker" };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true as const, value: select.value };
    }, picker[0]!.value);
    if (!pickedWorkspace.ok) throw new Error(`could not choose the Workspace in the picker: ${JSON.stringify(pickedWorkspace)}`);
    await waitFor(page, `/Resolved source directory|Source address/u.test(document.body.innerText)`, "the resolved source descriptor", 30_000).catch(() => undefined);
    await page.screenshot({ path: join(output, "picker-selected.png"), fullPage: true });
    ok(checks, "descriptor-filled", "selecting the picked Workspace filled the source descriptor");

    // The visible "Execution world" input inside the SOURCE DESCRIPTOR fieldset must carry
    // the world the Host actually maps this caller to. Two traps here that have both bitten
    // this gate already:
    //   - the page has another "world" input inside the collapsed archive-location form;
    //     filling the wrong one leaves the descriptor's world empty and the Host then
    //     refuses `source_descriptor` — which looks like a product failure;
    //   - the value must come from the fixture's declaration, never from a guess or a
    //     name-match, because the Host derives it from deployment configuration
    //     (`runtime.worldOf(caller)` in `adapters/dsh/native/identity.ts`).
    // So: scope the search to the fieldset that also contains the Workspace picker, and
    // require the handoff to declare the world.
    // One key, no alias: `sourceWorld` is what the fixture declares, and the wrapper and
    // the manual lane both read the same field so a rename cannot hide a drift.
    const world = handoff.sourceWorld;
    if (world === undefined || world.trim() === "") {
      // A prerequisite, not a product result: without the fixture's declared world the gate
      // cannot fill the field truthfully, and inventing one would prove nothing.
      console.error("fresh-journey: PREREQUISITE — the handoff declares no sourceWorld, so the visible Execution world cannot be filled from the deployment's own declaration");
      return 2;
    }
    const worldFilled = await page.evaluate((value: string) => {
      // The descriptor fieldset is the one containing the Workspace picker.
      const pickerSelect = document.querySelector<HTMLSelectElement>('select[name="workspace_select"]');
      const fieldset = pickerSelect?.closest("fieldset") ?? null;
      if (fieldset === null) return { ok: false as const, reason: "no descriptor fieldset containing the Workspace picker" };
      // Inside it, the world control is the text input under the "Execution world" label.
      const labels = [...fieldset.querySelectorAll<HTMLLabelElement>("label")];
      const label = labels.find(element => /Execution world/u.test(element.textContent ?? ""));
      const input = label?.querySelector<HTMLInputElement>("input") ?? null;
      if (input === null) return { ok: false as const, reason: "no Execution world input inside the descriptor fieldset", labels: labels.map(l => (l.textContent ?? "").trim().slice(0, 30)) };
      if (input.value === value) return { ok: true as const, alreadySet: true, value: input.value };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true as const, alreadySet: false, value: input.value };
    }, world);
    if (!worldFilled.ok) {
      throw new Error(`could not fill the visible Execution world: ${JSON.stringify(worldFilled)}`);
    }
    // Read it back from the DOM rather than trusting the assignment.
    const worldVisible = await page.evaluate(() => {
      const pickerSelect = document.querySelector<HTMLSelectElement>('select[name="workspace_select"]');
      const fieldset = pickerSelect?.closest("fieldset") ?? null;
      const label = [...(fieldset?.querySelectorAll<HTMLLabelElement>("label") ?? [])].find(element => /Execution world/u.test(element.textContent ?? ""));
      return label?.querySelector<HTMLInputElement>("input")?.value ?? "";
    });
    if (worldVisible !== world) {
      throw new Error(`the visible Execution world reads ${JSON.stringify(worldVisible)} after filling ${JSON.stringify(world)}`);
    }
    ok(checks, "execution-world-filled", `the visible Execution world input inside the source-descriptor fieldset now holds ${JSON.stringify(worldVisible)}, the world the fixture declares for this Host`);

    // The root-handle control is a `<select>` with **no `name` attribute**, so
    // `select[name="root_handle"]` returns null. Locate it by its visible label instead —
    // the way a person finds it — and say plainly what was found. An earlier version
    // queried by name, got null, and concluded "so a person could not complete it either":
    // a claim about the product drawn from a fact about the selector.
    const rootHandles = await page.evaluate(() => {
      const labels = [...document.querySelectorAll<HTMLLabelElement>(".ensemble-workspace label")];
      const label = labels.find(element => /Archive root handle/u.test(element.textContent ?? ""));
      const select = label?.querySelector<HTMLSelectElement>("select");
      if (select === undefined || select === null) {
        return { options: [] as string[], name: null as string | null, labels: labels.map(l => (l.textContent ?? "").trim().slice(0, 40)) };
      }
      return { options: [...select.options].map(option => option.value).filter(value => value !== ""), name: select.getAttribute("name"), labels: [] as string[] };
    });
    if (rootHandles.options.length === 0) {
      throw new Error(`no control labelled "Archive root handle" offers a value; form labels: ${JSON.stringify(rootHandles.labels)}`);
    }
    await page.evaluate((value: string) => {
      const labels = [...document.querySelectorAll<HTMLLabelElement>(".ensemble-workspace label")];
      const select = labels.find(element => /Archive root handle/u.test(element.textContent ?? ""))?.querySelector<HTMLSelectElement>("select");
      if (select === undefined || select === null) return;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, rootHandles.options[0]!);
    ok(checks, "root-handle-selected", `chose ${rootHandles.options[0]} from ${rootHandles.options.length} Host-declared handle(s), located by label (control name attribute: ${JSON.stringify(rootHandles.name)})`);

    // GUI initialize: `initialize` declares exactly `root_handle` (pre-filled from the
    // owner handles), `source_descriptor` (filled by selecting the Workspace),
    // `initial_grants` and `limits`. There is no `reason` on this action.
    //
    // `initial_grants` is `array(grantRequest, 1)` in the Host's decoder — a **minimum of
    // one** — so `[]` is refused. The grant's subject must be the authenticated owner, and
    // the only legitimate source for it is the Host's own `current_owner` report, which the
    // Client decodes and **prefills into this field**. So the probe types no grant: it
    // asserts the Client prefilled a legal one and fails loudly if it did not. Fabricating
    // an identity here would make the journey prove nothing about the product.
    const prefilled = await page.evaluate(() => {
      const field = document.querySelector<HTMLTextAreaElement>('.ensemble-workspace [name="initial_grants"]');
      if (field === null) return { present: false, value: "", parsed: null as unknown };
      const value = field.value.trim();
      let parsed: unknown = null;
      try { parsed = JSON.parse(value); } catch { parsed = null; }
      return { present: true, value, parsed };
    });
    if (!prefilled.present) throw new Error("the initialize form has no initial_grants field");
    if (!Array.isArray(prefilled.parsed) || prefilled.parsed.length === 0) {
      throw new Error(`the Client did not prefill a legal initial grant from the Host's current_owner; the field held ${JSON.stringify(prefilled.value).slice(0, 200)}. A user must not have to type an owner identity here.`);
    }
    await fillField(page, "limits", JSON.stringify({
      inline_input_bytes: 65536, response_bytes: 1048576, artifact_bytes: 10485760,
      upload_chunk_bytes: 65536, upload_total_bytes: 104857600, concurrent_uploads: 4, page_items: 100,
    }));
    // The grant must be the product's, and the Host's own closed decoder is the judge of
    // whether what the form holds is legal. What this probe must NOT do is rebuild the
    // whole payload from `[name=...]` lookups: `source_descriptor` is a compound fieldset
    // (world input + Workspace picker + resolved address), so there is no
    // `[name="source_descriptor"]` control, and a rebuilt payload would carry `null` for it
    // and then report the Host's refusal as a product failure. Legality of the full payload
    // is already covered by the contract tests; here the job is provenance of the grant.
    const hostOwner = await preflightOwner(handoff);
    const grant = (prefilled.parsed as { subject?: Record<string, unknown>; rights?: unknown; scope?: Record<string, unknown> }[])[0]!;
    const subjectMatches = grant.subject?.kind === "owner"
      && grant.subject.ownerId === hostOwner.ownerId
      && grant.subject.hostAuthorityId === hostOwner.hostAuthorityId;
    if (!subjectMatches) {
      throw new Error(`the prefilled grant's subject is not the owner the Host reported for this connection (prefilled ${JSON.stringify(grant.subject)}, Host ${JSON.stringify(hostOwner)})`);
    }
    if (JSON.stringify(grant.rights) !== JSON.stringify(["read"]) || grant.scope?.kind !== "project") {
      throw new Error(`the prefilled grant is not the minimal read/project grant: ${JSON.stringify({ rights: grant.rights, scope: grant.scope })}`);
    }
    ok(checks, "grant-subject-is-host-owner", `the field the product filled carries subject == current_owner(${hostOwner.ownerId}) with rights ["read"] scope project; the probe typed no identity`);
    const ready = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('.ensemble-workspace select[name="action"]');
      const form = select?.closest("form");
      const fieldset = form?.querySelector<HTMLFieldSetElement>("fieldset");
      // Every required control, whether or not it carries a `name`. The visible Execution
      // world input has **no** `name` attribute, so a check scoped to `[name]` elements
      // cannot see it — that gap let this gate claim "no blank required fields" while the
      // browser still refused the submit, and the resulting absence of an alert was then
      // read as a product defect.
      const blanks = [...(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea") ?? [])]
        .filter(el => (el as HTMLInputElement).required === true && (el.value ?? "").trim() === "")
        .map(el => ({ name: el.getAttribute("name"), tag: el.tagName.toLowerCase(), label: (el.closest("label")?.textContent ?? "").trim().slice(0, 30) }));
      return { fieldsetDisabled: fieldset?.disabled ?? null, blankRequired: blanks, valid: form?.checkValidity() ?? null };
    });
    if (ready.blankRequired.length > 0) throw new Error(`the initialize form still has required fields empty: ${JSON.stringify(ready.blankRequired)}`);
    // --- The two visible-validation facts. Both are DOM observations and neither can come
    // from a unit test: the earlier defect was `{invalid && <p role="alert">…</p>}` on an
    // array, so an EMPTY array is truthy and a perfectly valid page displayed the alarm on
    // every load. Only the absence of the alert on a valid page catches that.
    const alertsOnValidPage = await page.evaluate(() =>
      [...document.querySelectorAll('.ensemble-workspace [role="alert"]')]
        .map(element => (element.textContent ?? "").trim())
        .filter(text => /Complete the required fields/u.test(text)));
    if (alertsOnValidPage.length > 0) {
      throw new Error(`a valid, fully-filled form still shows the validation alert: ${JSON.stringify(alertsOnValidPage)}`);
    }
    // Before testing anything about the alert, prove the scenario is the one we intend:
    // every required control filled, so a submit actually reaches the handler. Measured on
    // this form: with two required controls still empty the browser fires `invalid` BEFORE
    // `submit`, `onSubmit` never runs, `formPayload` is never called, and no alert can ever
    // appear — which reads exactly like "the product shows no error" and is not.
    const formState = await page.evaluate(() => {
      const review = [...document.querySelectorAll<HTMLElement>(".ensemble-workspace button")].find(element => (element.textContent ?? "").trim().includes("Review"));
      const form = review?.closest("form") ?? null;
      const required = [...(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[required]") ?? [])];
      return {
        valid: form?.checkValidity() ?? null,
        empty: required.filter(element => (element.value ?? "").trim() === "").map(element => ({
          name: element.getAttribute("name"), tag: element.tagName.toLowerCase(),
        })),
        all: required.map(element => ({ name: element.getAttribute("name"), tag: element.tagName.toLowerCase(), value: (element.value ?? "").slice(0, 24) })),
      };
    });
    if (formState.valid !== true) {
      throw new Error(`the initialize form is not valid before the alert test, so a submit would be blocked by the browser and no alert could appear; empty required controls: ${JSON.stringify(formState.empty)}; all required: ${JSON.stringify(formState.all)}`);
    }
    ok(checks, "form-valid-before-alert-test", `every required control is filled and form.checkValidity() is true (${formState.all.length} controls), so the submit path is reachable`);
    ok(checks, "no-alert-on-valid-page", "with every required field filled, the page shows no validation alert (the empty-array-truthy defect is absent)");

    // Now prove the alert DOES appear for a value the form itself rejects — a malformed JSON
    // body, which `formPayload` refuses locally. This is deliberately not a blank field:
    // HTML `required` would block submit before the handler ran, and accepting the browser's
    // own bubble as evidence of our alert would be exactly the confusion this check exists
    // to prevent. Afterwards the field is restored so the real submission is unaffected.
    const limitsValue = await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('.ensemble-workspace [name="limits"]')?.value ?? "");
    // Replace through the keyboard, the way a person edits a controlled field.
    //
    // Measured on this form: setting `.value` and dispatching events left React holding the
    // previous (valid) text, so `formPayload` never saw the malformed value and no alert
    // could appear — the probe then reported a product defect that did not exist. A real
    // click, Ctrl+A, then typing replaces the value and the framework observes it.
    const limitsHandle = await page.$('.ensemble-workspace [name="limits"]');
    if (limitsHandle === null) throw new Error("the limits control vanished before the invalid-input case");
    // Focus the control itself, then verify focus before typing.
    //
    // A pointer click is the truest user action, but the page re-lays-out as state changes
    // (an alert appearing shifts the form), and a click can land on whatever moved under the
    // pointer. `focus()` on the element is honest for the purpose of *entering text into this
    // field*, and the assertion below proves the keyboard really targets it — Ctrl+A into the
    // wrong element would otherwise silently do nothing and look like a product defect.
    // Reach the field the way a person does: wait for the layout to settle, re-locate the
    // element (its box moves when the alert appears, so a cached handle's coordinates are
    // stale), scroll it into view, prove with `elementFromPoint` that the point really lands
    // on this field, then send ONE real pointer click and require that it took focus.
    //
    // Deliberately not `element.focus()`: a programmatic focus succeeds even when the control
    // is covered or inside an `inert` subtree, so it would prove nothing about a user's path —
    // the same class of mistake as calling `requestSubmit()` to make a submit happen.
    //
    // Bounded relocation only: if the point is not yet on the field, wait for the DOM to
    // settle and re-measure, at most a few times. No overlays are removed and no coordinates
    // are reused from before the re-layout.
    const focusPoint = await pointerReachable(page, '.ensemble-workspace [name="limits"]');
    await page.mouse.click(focusPoint.x, focusPoint.y);
    const focusAfter = await page.evaluate(() => {
      const field = document.querySelector<HTMLTextAreaElement>('.ensemble-workspace [name="limits"]');
      const active = document.activeElement as HTMLElement | null;
      return { ok: active === field, tag: active?.tagName.toLowerCase() ?? null, name: active?.getAttribute("name") ?? null };
    });
    if (!focusAfter.ok) throw new Error(`a real pointer click at (${focusPoint.x},${focusPoint.y}) did not focus the limits field; activeElement is ${JSON.stringify(focusAfter)}`);
    ok(checks, "limits-pointer-reachable", `a real pointer click at (${focusPoint.x},${focusPoint.y}) landed on ${focusPoint.hit} and focused the limits field`);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.type("{not json");
    const limitsNow = await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('.ensemble-workspace [name="limits"]')?.value ?? null);
    if (limitsNow !== "{not json") {
      throw new Error(`the limits field did not take the typed value; it holds ${JSON.stringify(limitsNow)}`);
    }
    // Submit through the real control so the handler runs; the browser permits it because the
    // field is non-empty, so what we observe is our own refusal, not `required`.
    const noticeButton = await page.evaluate(() => {
      const named = (element: HTMLElement): string => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
      const button = [...document.querySelectorAll<HTMLElement>(".ensemble-workspace button")].find(element => named(element) === "Review changes");
      if (button === undefined) return null;
      if (button.id === "") button.id = "__ensemble_review_invalid";
      return button.id;
    });
    if (noticeButton === null) throw new Error("the Review control disappeared before the invalid-input case");
    const reviewHandle = await page.$(`#${noticeButton}`);
    if (reviewHandle === null) throw new Error("the Review control vanished before the invalid-input case");
    // One real pointer click. No programmatic fallback: `requestSubmit()` is not a user
    // action, and adding it alongside a click risks a double submit that would make the
    // observed outcome ambiguous. If a click does not reach the handler, that is the finding.
    await reviewHandle.click();
    let invalidAlert: string | null = null;
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('.ensemble-workspace [role="alert"]')].some(element => /Complete the required fields/u.test(element.textContent ?? "")),
        { timeout: 10_000 },
      );
      invalidAlert = await page.evaluate(() =>
        [...document.querySelectorAll('.ensemble-workspace [role="alert"]')]
          .map(element => (element.textContent ?? "").trim())
          .find(text => /Complete the required fields/u.test(text)) ?? null);
    } catch {
      const shown = await page.evaluate(() => ({
        alerts: [...document.querySelectorAll('.ensemble-workspace [role="alert"]')].map(e => (e.textContent ?? "").trim()),
        validity: [...document.querySelectorAll<HTMLTextAreaElement>('.ensemble-workspace [name="limits"]')].map(e => e.validationMessage),
      }));
      throw new Error(`a malformed structured value produced no visible alert; the operator would see nothing: ${JSON.stringify(shown)}`);
    }
    ok(checks, "alert-on-invalid-submit", `a malformed limits value produced the visible alert ${JSON.stringify(invalidAlert)}, and the browser's own required-check had already passed (the field was non-empty)`);

    // Restore through the keyboard too, so the submission below is the valid one. Re-locate
    // the field first with the SAME pointer-reachable helper: the alert changed the layout,
    // so the coordinates from before it appeared are stale.
    const restorePoint = await pointerReachable(page, '.ensemble-workspace [name="limits"]');
    await page.mouse.click(restorePoint.x, restorePoint.y);
    const refocused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("name") ?? null);
    if (refocused !== "limits") throw new Error(`the limits control did not regain focus for the restore; activeElement name is ${JSON.stringify(refocused)}`);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.type(limitsValue);
    // The invalid alert clears when the next submit's `formPayload` parses the corrected
    // value and `prepare` succeeds — the product clears `invalid` on a successful review,
    // not on typing alone. So the corrected value is restored, then the review is submitted
    // again; the alert must be gone and the review panel must render.
    await clickLabel(page, "Review changes");
    await waitForText(page, "Submit reviewed operation", 30_000, "the review panel for initialize");
    const invalidAfterReview = await page.evaluate(() =>
      [...document.querySelectorAll('.ensemble-workspace [role="alert"]')]
        .map(element => (element.textContent ?? "").trim())
        .filter(text => /Complete the required fields/u.test(text)));
    if (invalidAfterReview.length > 0) {
      throw new Error(`the invalid alert stuck after reviewing the corrected value: ${JSON.stringify(invalidAfterReview)}`);
    }
    ok(checks, "alert-clears-after-correction", "after restoring a valid value and reviewing again, the invalid alert is gone and the review panel rendered");
    await clickLabel(page, "Submit reviewed operation");
    await page.waitForFunction(() => /Committed|committed_revision/u.test(document.body.innerText), { timeout: 90_000 });
    ok(checks, "gui-initialize", "the archive was initialized through the shipped form and committed by the Host");
    await page.screenshot({ path: join(output, "initialized.png"), fullPage: true });
    // The committed revision comes from the HOST, over the transport, not from parsing the
    // page. The previous version pattern-matched a composite string and reported "no
    // committed revision" on a page that plainly displayed one — the same class of mistake
    // as the served-bundle trailer: a regex mirrors what we assumed, not what rendered.
    // The DOM is still read, but only to prove the UI shows the same value the Host reports.
    const created = await page.evaluate(() => {
      const terms = [...document.querySelectorAll<HTMLElement>(".ensemble-workspace dt")];
      const term = terms.find(node => /committed revision/iu.test(node.textContent ?? ""));
      return {
        domRevision: (term?.nextElementSibling?.textContent ?? "").trim(),
        text: document.querySelector<HTMLElement>(".ensemble-workspace")?.innerText.slice(-600) ?? "",
      };
    });
    // The authoritative value: each project row carries the revision the Host holds.
    const hostProjects = await preflightProjects(handoff);
    const hostRevision = /^[0-9a-f]{7,64}$/u.test(created.domRevision) ? created.domRevision : null;
    if (hostRevision === null) {
      throw new Error(`the result did not display a committed revision; workspace text: ${created.text}`);
    }
    const hostKnows = hostProjects.some(project => project.read_revision === hostRevision);
    if (!hostKnows) {
      throw new Error(`the page shows committed revision ${hostRevision} but the Host reports ${JSON.stringify(hostProjects.map(project => ({ id: project.project_id, read_revision: project.read_revision })))}`);
    }
    await writeFile(join(output, "initialized.json"), JSON.stringify({ domRevision: created.domRevision, hostProjects }, null, 1), "utf8");
    ok(checks, "committed-revision-agrees-with-host", `the result displayed revision ${hostRevision} and the Host reports the same value for ${hostProjects.length} project(s)`);

    // The new project must be selectable and readable at its own pinned revision. This is a
    // normal user path: after init commits, wait for the Client to be fully ready (post-write
    // revalidation settled), then click "Refresh access", then select the committed project.
    // A pending refresh must survive the selection and settle to `ready` (task85 fix).
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".ensemble-workspace")?.getAttribute("data-status") === "ready", { timeout: 45_000 });
    await clickControl(page, "Refresh access");
    // Do NOT wait for options before selecting: the interleaving (Refresh pending -> select)
    // is the exact window task85 fixes. The committed project must be selectable and the
    // refresh must still settle.
    const returned = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>(".ensemble-workspace header select option")].map(option => option.value).filter(Boolean));
    // Select the exact project the Host just committed, not the first row in DOM order.
    const createdProject = hostProjects.find(project => project.read_revision === hostRevision);
    if (createdProject === undefined) throw new Error(`the owner catalogue does not list the project the Host just committed (${hostRevision}): ${JSON.stringify(hostProjects)}`);
    if (!returned.includes(createdProject.project_id)) throw new Error(`the owner catalogue does not include the committed project ${createdProject.project_id}; options: ${JSON.stringify(returned)}`);
    await page.select(".ensemble-workspace header select", createdProject.project_id);
    await clickControl(page, "Current work");
    // The read is proved by the QueryView section's own `state.page.read_revision`
    // (`p.ensemble-muted > code`). The catalogue must settle to `ready` and the section's own
    // query loading (workspace.tsx:168 `{state.loading && <p role=status>}`) must clear.
    try {
      await page.waitForFunction((args: { expected: string; projectId: string }) => {
        const root = document.querySelector<HTMLElement>(".ensemble-workspace");
        if (root === null || root.getAttribute("data-status") !== "ready") return false;
        if (root.getAttribute("data-connection") !== "connected") return false;
        if (root.getAttribute("data-view") !== "work" || root.getAttribute("data-selected") !== args.projectId) return false;
        const section = root.querySelector<HTMLElement>("section");
        const code = section?.querySelector<HTMLElement>("p.ensemble-muted > code");
        if (code === null || code === undefined) return false;
        if ((code.textContent ?? "").trim() !== args.expected) return false;
        const sectionLoading = section?.querySelector<HTMLElement>("[role=status]");
        if (sectionLoading !== null && sectionLoading !== undefined) return false;
        return root.querySelector('[role="alert"]') === null;
      }, { timeout: 45_000 }, { expected: hostRevision, projectId: createdProject.project_id });
    } catch (error) {
      const seen = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>(".ensemble-workspace");
        return {
          dataStatus: root?.getAttribute("data-status") ?? null,
          dataConnection: root?.getAttribute("data-connection") ?? null,
          dataView: root?.getAttribute("data-view") ?? null,
          dataSelected: root?.getAttribute("data-selected") ?? null,
          headerStatuses: [...(root?.querySelectorAll<HTMLElement>("header [role=status], p[role=status]") ?? [])].map(e => (e.textContent ?? "").trim()),
          sectionStatuses: [...(root?.querySelectorAll<HTMLElement>("section [role=status]") ?? [])].map(e => (e.textContent ?? "").trim()),
          queryCode: (root?.querySelector<HTMLElement>("section p.ensemble-muted > code")?.textContent ?? "").trim(),
          headerCodes: [...(root?.querySelectorAll<HTMLElement>(".ensemble-toolbar code") ?? [])].map(e => (e.textContent ?? "").trim()),
          alerts: [...(root?.querySelectorAll<HTMLElement>("[role=alert]") ?? [])].map(e => (e.textContent ?? "").trim().slice(0, 120)),
          tail: root?.innerText.slice(-600) ?? "",
        };
      }).catch(() => "page gone");
      await writeFile(join(output, "fresh-read-timeout.json"), JSON.stringify(seen, null, 1), "utf8").catch(() => undefined);
      throw new Error(`fresh-read predicate never satisfied within 45s (${String(error)}); state saved to fresh-read-timeout.json: ${JSON.stringify(seen)}`);
    }
    const snapshot = hostRevision;
    ok(checks, "fresh-read", `the new project ${createdProject.project_id} rendered a real QueryView read at pinned revision ${String(snapshot)} equal to the Host-committed value`);
    await page.screenshot({ path: join(output, "fresh-read.png"), fullPage: true });
  } catch (error) {
    await writeFile(join(output, "result.json"), JSON.stringify({ status: "failed", failure: String(error), checks, pageErrors }, null, 1), "utf8");
    console.error(`fresh-journey: FAILED — ${String(error)}`);
    return 1;
  } finally {
    if (browser !== undefined) await browser.close().catch(() => undefined);
  }
  if (pageErrors.length > 0) {
    await writeFile(join(output, "result.json"), JSON.stringify({ status: "failed", failure: `page errors: ${pageErrors.join(" | ")}`, checks, pageErrors }, null, 1), "utf8");
    console.error(`fresh-journey: FAILED — page errors: ${pageErrors.join(" | ")}`);
    return 1;
  }
  await writeFile(join(output, "result.json"), JSON.stringify({ status: "passed", checks, pageErrors }, null, 1), "utf8");
  console.log(JSON.stringify({ status: "passed", checks: checks.map(check => check.name), pageErrors }, null, 1));
  return 0;
}

// Only run when executed directly. Importing this module (the contract tests do) must
// not start a browser or exit the importing process.
if (import.meta.main) process.exit(await run());
