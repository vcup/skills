# Ensemble Client workspace

The browser entry contributes an `ensemble` keyed `main` page and a matching `sidebar.panellist` navigation entry to the native DSH Client. It exports only `inject` and `apply`. It does not replace the native root or serve a separate debug application.

## Opening it as a user

Install the package into a profile that has an app row (`dsh plugin --profile web add <tgz>`), start the Host (`dsh --profile web`), and open the URL it prints. The left sidebar then has an **Ensemble** panel icon; it opens the keyed `main` page.

Two Host facts a reader hits immediately, both measured on a real Host rather than inferred:

- **A native Workspace must exist first.** The archive refuses to initialize until the Host has a Workspace, because a source descriptor names a Workspace id and its directory. Create one the ordinary way (New session → choose a folder); the Client's source picker then lists the registry's own rows, so binding never asks a person to type an internal id. If the registry is not composed at all, the Client says so instead of offering an empty box.
- **The two credentials are not interchangeable.** The page and WebSocket need the cookie from `GET /?token=…`; the Remote needs the cookie from `GET /connect?token=…`. The Host answers 401 to each other's credential on the page route. Anything that drives this UI takes the browser cookie for the page and the API cookie for Remote calls, and the gate asserts the distinction.

## What the workspace does

Seven tabs: **Current work**, **Materials**, **Reading**, **Lessons**, **History**, **Projects & access**, **Maintenance**.

Work and learning records are read-only here; they are created through the Ensemble model tools. Owner changes are explicit forms with a revision-bound review and a separate submit: project binding/authorization (`initialize`, `bind`, `rebind`, `grant`, `revoke`, `takeover`, `assign_reviewer`, `pause`, `resume`), import/export/backup/restore membership, location moves, upgrade, diagnostics, maintenance plans and replicas. **Current grants** reads the archive's own grant list (from `diagnose`) so `revoke` can name an exact opaque grant id; no other owner surface names one.

Materials shows original bytes versus an inert text preview. Environment advice lives inside Maintenance and has its own read/desired revisions and native-target preview; saving preferences is never displayed as applied.

## State protection

`controller.ts` owns wire-derived state: fixed query snapshots and cursors, authorization epochs, connection generations and pending operation keys. The renderer turns its observable into `useWorkspace` through the supported hook compartment; components receive plain actions, not a Cordis Context.

- Scope change, connection loss, authorization stream change, revocation and disposal invalidate obsolete responses; a late reply cannot restore cleared content.
- A changed head is a refresh notice, never a silently mixed snapshot.
- An ambiguous write keeps its operation key and requires a receipt read before another write.
- Material preview is text and headings only: HTML, scripts, event handlers and remote images are never executed or fetched. Downloads are `application/octet-stream` Blob URLs, never rendered in the origin.
- Partial pages show their reason and keep continuation visible instead of claiming completeness.

## Bundle shape

The browser bundle must be CJS inside the official lazy `window.__ModuleLoader__.load({id, factory})` wrapper, with `react` and `react/jsx-runtime` external to the platform seed. Set Bun `jsx: { runtime: "automatic", development: false }`: the native platform does not seed `react/jsx-dev-runtime`. The package's `./client` export and `dsh.client.platform: "web"` are owned by the packer.

## Two gates, and what each proves

**`verify-browser.ts` — component gate.** `--package --runtime --slots --browser --output`, all required. It extracts the supplied installable package, loads its real `./client` export into the published renderer, module system and slots, and answers the Remote from deterministic fixtures. It proves native rendering and UI behaviour; it proves nothing about an authenticated Host. There is no skip and no source-bundle fallback.

**`verify-auth.ts` — authenticated gate.** `--connection <connection.json> --browser <chrome> --output <dir>`; optional `--served-only`.

- `connection.json` is written by the product serve driver: `{ origin, browserCookieFile, apiCookieFile, packageRoot, projectId, head, headSource }`. The gate reads cookies with the installed package's own `lib/cookie-jar.mjs`, so it accepts exactly the shapes the shipped CLI accepts.
- Phases: (1) authenticated Remote over the installed transport — owner catalogue and a pinned read; (2) credential-role check — the API cookie must be rejected by the page; (3) served Client — the Host's own page, its boot manifest composing `dsh-ensemble`, and the bundle it serves, whose delivered code must equal the installed `client.js`; (4) the browser phase — real rendering, project selection, a GUI owner write that advances the revision, a refresh, and cookie revocation dropping cached state and management submission.
- Exit codes are a contract: `0` every phase passed; `1` **product failure** (a real check failed, or `--served-only` ran — served-only always exits non-zero and says `PARTIAL`); `2` **prerequisite** (no handoff, no cookie, no browser, Host unreachable). `gate-failure.ts` is the classifier, so a provisioning gap is never reported as a product bug and a product bug is never excused as a provisioning gap.

Environment for the browser process only: `ENSEMBLE_BROWSER_LIBRARIES` (LD_LIBRARY_PATH), `ENSEMBLE_BROWSER_FONTCONFIG`; `ENSEMBLE_BROWSER_EXECUTABLE` may replace `--browser`. No credential is printed or written to the output.

## Tests

`bun test adapters/dsh/client/` — controller behaviour, wire decoding, the argv/handoff/cookie refusals of the authenticated gate, the gate's failure classification, the served-manifest/bundle reader (including the exact delivery trailer it must and must not strip), and the Workspace-choice reader. The gate's pass path is not unit-tested: without a live Host and a browser the only honest outcomes are "prerequisite missing" and "check failed", and a test that faked a pass would be the mock-as-evidence this gate exists to replace.
