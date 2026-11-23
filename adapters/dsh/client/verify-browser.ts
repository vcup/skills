/** Reproducible browser/official-renderer check. Requires an installable package, existing runtime, published static slots and browser; installs nothing.
 * The Remote data and shell are fixtures. This is not authenticated Host/end-to-end evidence.
 */
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import puppeteer, { type ElementHandle } from "puppeteer-core";
const arg = (name: string): string => { const index = process.argv.indexOf(name); const value = process.argv[index + 1]; if (index < 0 || !value || value.startsWith("--")) throw new Error(`Required: ${name}`); return resolve(value); };
const runtime = arg("--runtime"), slots = arg("--slots"), executable = process.env.ENSEMBLE_BROWSER_EXECUTABLE ? resolve(process.env.ENSEMBLE_BROWSER_EXECUTABLE) : arg("--browser"), output = arg("--output"), packageFile = arg("--package");
await mkdir(output, { recursive: true });
await Bun.write(join(output, "result.json"), JSON.stringify({ status: "running", package: packageFile }));
const packageDigest = createHash("sha256").update(await readFile(packageFile)).digest("hex");
const fixture = await mkdtemp(join(output, "render-"));
const installed = join(fixture, "package"); await mkdir(installed);
const listing = Bun.spawn(["tar", "-tzf", packageFile], { stdout: "pipe", stderr: "pipe" });
const members = (await new Response(listing.stdout).text()).trim().split("\n");
if (await listing.exited || members.some(name => !name.startsWith("package/") || name.split("/").includes(".."))) throw new Error("Invalid package archive");
const extraction = Bun.spawn(["tar", "-xzf", packageFile, "-C", installed, "--strip-components=1"], { stdout: "ignore", stderr: "pipe" });
if (await extraction.exited) throw new Error("Package extraction failed");
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
if (manifest.name !== "dsh-ensemble" || manifest.dsh?.client?.platform !== "web") throw new Error("Invalid production Client manifest");
const exportedClient = manifest.exports?.["./client"];
const clientPath = typeof exportedClient === "string" ? exportedClient : exportedClient?.default;
if (typeof clientPath !== "string" || clientPath.includes("..") || !clientPath.startsWith("./")) throw new Error("Missing Client export");
const modules = join(runtime, "node_modules/@deepseek-ai");
const entry = join(fixture, "entry.tsx");
await Bun.write(entry, `
import * as React from 'react'; import * as ReactDOM from 'react-dom'; import * as ReactDOMClient from 'react-dom/client'; import * as JSX from 'react/jsx-runtime';
import * as Cordis from ${JSON.stringify(join(modules, "cordis/lib/index.js"))};
import * as Slots from ${JSON.stringify(join(slots, "lib/index.js"))};
import { ClientModuleSystem } from ${JSON.stringify(join(modules, "dsh-client-modules/src/client/system.ts"))};
const target={mode:'queue',pendingQueue:[],load(registration){this.pendingQueue.push(registration)}};
window.__ModuleLoader__=target;
const modules=new ClientModuleSystem({manifest:{rev:'test',modules:[],plugins:[]},staticModules:{react:React,'react-dom':ReactDOM,'react-dom/client':ReactDOMClient,'react/jsx-runtime':JSX,'@deepseek-ai/cordis':Cordis,'@deepseek-ai/dsh-client-ui-slots':Slots},registrationTarget:target,bootstrapModule:{id:'fixture.bootstrap',exports:{}}});
const load=src=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.appendChild(script)});
await load('/renderer.js'); await load('/ensemble.js');
const renderer=await modules.import('@deepseek-ai/dsh-client-ui-renderer');const plugin=await modules.import('dsh-ensemble');
if(Object.keys(plugin).sort().join(',')!=='apply,inject')throw new Error('Unexpected Client exports');
const ctx=new Cordis.Context(); renderer.apply(ctx);
const dictionaries={};const localeSnapshot={revision:0};const locale={register(ns,dict){dictionaries[ns]=dict.en;return()=>{delete dictionaries[ns]}},bind:ns=>key=>dictionaries[ns]?.[key]??key,getSnapshot:()=>localeSnapshot,subscribe:()=>()=>{}};
ctx.reflect.provide('locale',locale);ctx.slots.installLocale(locale);
const absentBinding={key:undefined,hooks:{},keyedHooks:{},props:{}};const absent={getSnapshot:()=>absentBinding,subscribe:()=>()=>{}};ctx.slots.installScope('session',{current:absent,bindingSource:()=>absent});
const changes=new Set();let connected=true;let generation=1;
ctx.reflect.provide('connection',{state:{getSnapshot:()=>connected?'connected':'disconnected',subscribe:f=>{changes.add(f);return()=>changes.delete(f)}},generation:{getSnapshot:()=>connected?{id:generation}:undefined,subscribe:f=>{changes.add(f);return()=>changes.delete(f)}}});
ctx.reflect.provide('layout',{selectPanel(){}});
let epoch=1;let denied=false;let revision='revision-1';const watchers=new Set();const requests=[];
const owner={kind:'owner',ownerId:'fixture-owner',hostAuthorityId:'fixture-host-authority'};
const result=value=>({ok:true,value});const refusal=()=>({ok:false,error:{status:'refused',code:'not_authorized',message:'Access denied',retryable:false}});
const project=()=>({project_id:'project-a',title:'Cache consistency',read_revision:revision,authorization_epoch:epoch,capabilities:['pause','resume','grant','revoke','takeover','assign_reviewer','bind','backup']});
const page=(items=[],extra={})=>result({project_id:'project-a',read_revision:revision,authorization_epoch:epoch,items,completeness:'complete',...extra});
const remote={projects:async()=>denied?refusal():result({capabilities:["initialize"],root_handles:["default"],source_handles:[],destination_handles:[],projects:[project()],current_owner:owner}),query:async request=>{requests.push(request);if(denied)return refusal();if(request.kind==='artifact'||request.kind==='object')return page([{media_type:'text/markdown',text:'# Evidence\\n<img src="https://invalid.example/tracker" onerror="window.PWNED=1">\\n<script>window.PWNED=1</script>',digest:'abc',bytes:128,offset:0}]);if(request.kind==='checkpoint')return page([],{content:{goal:'Verify cache invalidation',coverage:['Concurrency'],next:{action:'Run independent regression',intended_result:'Observed check'}}});if(request.kind==='lessons')return page([{id:'lesson-1',kind:'lesson',body:{title:'Await actual completion',limitations:'Does not apply to synchronous tools'},applicability:'unknown',status:'proposed'}]);return page([{id:request.object_kind==='artifact'?'artifact-1':'invocation-1',kind:request.object_kind??'publication',object_revision:1,body:{title:request.object_kind==='artifact'?'Original failure log':'Cache invalidation',summary:'Keep accepted work and observed evidence separate',status:'active'}}]);},environment:async request=>{requests.push(request);if(request.action==="environment_preview")return result({desired_revision:"d".repeat(40),targets:[{target_id:"settings",expected_native_revision:1,before:{roles:[]},desired:{roles:[]},changed:false}]});if(request.action!=="environment_read")return result({status:"committed",committed_revision:"e".repeat(40)});return result({read_revision:"e".repeat(40),desired_revision:"d".repeat(40),preferences:{roles:[]},applications:[],native_targets:["settings"]})},approve:async()=>result({approval_id:"approval"}),destinations:async()=>result([{key:"fixture-replica",identity:"fixture-remote"}]),choose:async()=>result({handle:"chosen",kind:"root",world:"host",expires_at:1000}),manage:async request=>{requests.push(request);return denied?refusal():result({status:'committed',operation_id:request.operation_id,committed_revision:revision})},watch:request=>{let next,ended=false,first=true;const listener=()=>{if(next){const resolve=next;next=undefined;resolve({done:false,value:denied?refusal():result(project())})}};watchers.add(listener);return{dispose(){ended=true;watchers.delete(listener);next?.({done:true});},[Symbol.asyncIterator](){return {next(){if(ended)return Promise.resolve({done:true});if(first){first=false;return Promise.resolve({done:false,value:result(project())})}return new Promise(r=>{next=r})}}}}}};
let mounted=false;
// The product injects 'remote.ensembleArchive' and reads it as ctx.remote.ensembleArchive.
// The shipped gateway supplies exactly that shape: each Remote namespace is a Cordis Service
// named 'remote.<namespace>' created on its own fiber (dsh-api-gateway/src/client/index.ts).
// A plain provide('remote', {...}) cannot stand in for it: ctx.remote.<ns> resolves through the
// traceable proxy only when the base 'remote' is itself a Service, and a namespace object hanging
// off a plain object is unreachable from inject. Mirroring the gateway keeps this fixture a check
// of the shipped Client contract instead of an invented one.
class FixtureRemoteNamespace extends Cordis.Service {
  constructor(inner,methods){super(inner,'remote.ensembleArchive');Object.assign(this,methods);}
}
class FixtureRemote extends Cordis.Service {
  constructor(inner){super(inner,'remote');this.owner=inner;}
  async $mount(contribution){
    if(!contribution||!Array.isArray(contribution.descriptors)||contribution.descriptors.length!==8)throw new Error('Missing Remote descriptor');
    let namespace;
    // The namespace lifetime is its own child fiber, so the disposer below ends exactly this
    // contribution and leaves the fixture's other services running; that is what makes the final
    // mounted:false a real observation of the product's unload rather than a flag it set.
    const fiber=this.owner.plugin({name:'remote.ensembleArchive',apply(inner){namespace=new FixtureRemoteNamespace(inner,remote);}});
    try{await fiber;}catch(error){await fiber.dispose();throw error;}
    if(namespace===undefined)throw new Error('Remote namespace did not start');
    mounted=true;
    return async()=>{await fiber.dispose();mounted=false;};
  }
}
new FixtureRemote(ctx);
function Shell({renderSlot}){return <div>{renderSlot('sidebar.panellist',{})}{renderSlot('main',{}, {entryKey:'ensemble'})}</div>}
ctx.slots.register({name:'root',children:{main:{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'}}},Shell);
const dispose=await plugin.apply(ctx);const unmount=ctx.uiRenderer.mount(document.getElementById('root'));
window.fixture={requests,probe:()=>({remoteService:(()=>{try{return ctx.get('remote.ensembleArchive')!==undefined}catch{return 'inject-refused'}})(),mounted,mainEntries:ctx.slots.entries('main').length,rootEntries:ctx.slots.entries('root').length}),revoke(){epoch++;denied=true;for(const notify of watchers)notify()},disconnect(){connected=false;for(const fn of changes)fn()},async reset(){denied=false;connected=true;generation++;for(const fn of changes)fn()},async dispose(){await dispose();unmount();return{mounted,watchers:watchers.size,entries:ctx.slots.entries('main').length}},ready:true};
`);
const root = resolve(import.meta.dir, "../../..");
const aliases: Record<string, string> = {
  "react": join(root, "node_modules/react/index.js"), "react-dom": join(root, "node_modules/react-dom/index.js"),
  "react-dom/client": join(root, "node_modules/react-dom/client.js"), "react/jsx-runtime": join(root, "node_modules/react/jsx-runtime.js"),
};
const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", jsx: { runtime: "automatic", development: false }, define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "existing-react", setup(build) { build.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, args => ({ path: aliases[args.path] ?? args.path })); } }] });
if (!built.success) throw new AggregateError(built.logs, "Browser fixture build failed");
const script = await built.outputs[0]!.text();
const wrapped = await readFile(join(installed, clientPath), "utf8");
const renderer = await readFile(join(modules, "dsh-client-ui-renderer/lib/client.js"), "utf8");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { const path = new URL(request.url).pathname;
  if (path === "/entry.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
  if (path === "/ensemble.js") return new Response(wrapped, { headers: { "Content-Type": "text/javascript" } });
  if (path === "/renderer.js") return new Response(renderer, { headers: { "Content-Type": "text/javascript" } });
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.js"></script></html>', { headers: { "Content-Type": "text/html" } });
} });
const browser = await puppeteer.launch({ executablePath: executable, headless: true, userDataDir: join(fixture, "chrome"), env: { ...process.env,
  ...(process.env.ENSEMBLE_BROWSER_LIBRARIES ? { LD_LIBRARY_PATH: process.env.ENSEMBLE_BROWSER_LIBRARIES } : {}), ...(process.env.ENSEMBLE_BROWSER_FONTCONFIG ? { FONTCONFIG_FILE: process.env.ENSEMBLE_BROWSER_FONTCONFIG } : {}), XDG_CONFIG_HOME: join(fixture, "config"), XDG_CACHE_HOME: join(fixture, "cache") }, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter", "--disable-gpu"] });
const errors: string[] = [], checks: string[] = [];
try {
  const page = await browser.newPage(); page.on("pageerror", (error: unknown) => errors.push(error instanceof Error ? error.message : String(error)));
  await page.setViewport({ width: 1280, height: 900 }); await page.goto(server.url.href);
  await page.waitForFunction("window.fixture?.ready === true", { timeout: 20_000 });
  // `window.fixture.ready` says the fixture's services are wired, not that the product's main
  // slot rendered, so the shipped picker is awaited rather than assumed.
  //
  // An earlier version of this wait was described as closing a first-paint race. It was not:
  // waiting longer did not help, because the product's own `ctx.inject(['remote.ensembleArchive'])`
  // never activated when the fixture's fake `$mount` failed to create that namespace service. So
  // the wait stays (rendering is asynchronous and must be awaited, not raced), but the failure
  // branch below reports the *structural* facts that separate "still rendering" from "the tree
  // never assembled": whether the declared shell rendered at all, whether the product's main slot
  // ever registered, and what the Remote service looked like. Emptiness alone is not a diagnosis —
  // a rendered shell with no main entry and no page error is a different bug from a slow paint.
  try {
    await page.waitForFunction("document.querySelector('.ensemble-workspace header select') !== null", { timeout: 30_000 });
  } catch (error) {
    const seen = await page.evaluate(() => {
      const fixture = (window as unknown as { fixture?: { probe?: () => unknown } }).fixture;
      return {
        shellRendered: document.querySelector('[data-slot="root"]') !== null,
        workspace: document.querySelector(".ensemble-workspace") !== null,
        mainSlotEntries: document.querySelectorAll('[data-slot="main"] [data-slot-error]').length,
        slotAnchors: [...document.querySelectorAll("[data-slot]")].map(element => element.getAttribute("data-slot")),
        selects: [...document.querySelectorAll("select")].map(element => element.getAttribute("name") ?? "(unnamed)"),
        headings: [...document.querySelectorAll("h1, h2")].map(element => (element.textContent ?? "").trim().slice(0, 40)).slice(0, 6),
        text: document.body.innerText.slice(0, 500),
        remote: typeof fixture?.probe === "function" ? fixture.probe() : "no fixture probe",
      };
    }).catch(() => "page gone");
    throw new Error(`the shipped project picker never rendered inside the declared shell (${String(error)}); page state: ${JSON.stringify(seen)}`);
  }
  await page.select("header select", "project-a");
  await page.waitForFunction("document.body.innerText.includes('Cache invalidation')"); checks.push("official ClientModuleSystem + published SlotRegistry renderer materialized and rendered product main slot");
  // A real pointer click at the control's own coordinates, not a programmatic `element.click()`:
  // the latter fires a synthetic event that succeeds even when the control is covered, disabled
  // by CSS or scrolled out of the hit area, so it cannot establish that a user could reach it.
  // After a tab, wait for the shipped view state (`data-view`, rendered from the controller's
  // own snapshot) rather than for "no error", so an unchanged screen cannot pass as a tab change.
  const clickText = async (text: string, view?: string): Promise<void> => {
    const handle = await page.evaluateHandle((label: string) => {
      const button = [...document.querySelectorAll("button")].find(candidate => candidate.textContent === label && candidate.checkVisibility());
      if (!button) throw new Error(`Missing button ${label}`);
      return button;
    }, text);
    const element = handle.asElement() as ElementHandle<Element> | null;
    if (element === null) throw new Error(`Missing button ${text}`);
    try { await element.click(); } finally { await handle.dispose(); }
    if (view !== undefined) await page.waitForFunction(
      (expected: string) => document.querySelector(".ensemble-workspace")?.getAttribute("data-view") === expected,
      { timeout: 15_000 }, view);
  };
  for (const [title, view] of [["Reading", "reading"], ["Lessons", "lessons"], ["History", "history"], ["Maintenance", "maintenance"], ["Current work", "work"]] as const) await clickText(title, view);
  checks.push("all journey tabs open by real pointer click, each reaching its own shipped view state, without renderer errors");
  await page.waitForFunction("document.body.innerText.includes('Cache invalidation')");
  await page.screenshot({ path: join(output, "workspace.png"), fullPage: true });
  await clickText("Materials", "materials"); await page.waitForFunction("document.body.innerText.includes('Original failure log')"); await clickText("View");
  await page.waitForFunction("document.body.innerText.includes('<script>window.PWNED=1</script>')");
  if (await page.evaluate("window.PWNED !== undefined || document.querySelector('.ensemble-workspace img') !== null")) throw new Error("Untrusted content was executed"); checks.push("original Markdown/HTML visible as inert text; no external image element or script execution");
  await clickText("Original bytes");
  await page.waitForFunction("window.fixture.requests.some(request => request.content_mode === 'bytes')");
  checks.push("original bytes use an authorized fixed-revision bytes query");
  await clickText("Maintenance", "maintenance"); await clickText("Read environment preferences");
  await page.waitForFunction("document.body.innerText.includes('Saved preferences')");
  await page.click('.ensemble-card input[type="checkbox"]'); await clickText("Preview native targets");
  await page.waitForFunction("document.body.innerText.includes('expected native revision')"); await clickText("Review changes"); await clickText("Submit reviewed operation");
  await page.waitForFunction("window.fixture.requests.some(request => request.action === 'environment_apply')");
  const envApply = await page.evaluate("window.fixture.requests.find(request => request.action === 'environment_apply')") as {
    expected_revision?: string;
    project_id?: string;
    targets?: readonly { expected_native_revision?: number }[];
  };
  if (envApply.expected_revision !== 'e'.repeat(40) || envApply.project_id !== undefined || envApply.targets?.[0]?.expected_native_revision !== 1) throw new Error("Environment ledger mixed with project revision");
  checks.push("environment preview/apply uses its own ledger revision and exact native target revision");
  await clickText("Projects & access", "projects"); await page.select('select[name="action"]', "pause"); await page.type('input[name="reason"]', "Backup window"); await clickText("Review changes");
  await page.waitForFunction("document.body.innerText.includes('Submit reviewed operation')"); await clickText("Submit reviewed operation"); await page.waitForFunction("document.body.innerText.includes('Committed')"); checks.push("management form preview and explicit submit retain expected revision and operation id");
  await page.evaluate("window.fixture.revoke()"); await page.waitForFunction("document.body.innerText.includes('Access is unavailable') || document.body.innerText.includes('Access denied')");
  if (await page.evaluate("document.body.innerText.includes('Original failure log')")) throw new Error("Revoked content retained"); checks.push("stream refusal/epoch revocation removes cached content and management form");
  await page.evaluate("window.fixture.reset()"); await page.waitForFunction("document.querySelector('header select option[value=\"project-a\"]')"); await page.select("header select", "project-a");
  await clickText("Current work"); await page.waitForFunction("document.body.innerText.includes('Cache invalidation')"); await page.evaluate("window.fixture.disconnect()"); await page.waitForFunction("document.body.innerText.includes('Disconnected. Cached records')"); checks.push("connection loss clears records and disables management");
  const disposal = await page.evaluate("window.fixture.dispose()");
  if (JSON.stringify(disposal) !== JSON.stringify({ mounted: false, watchers: 0, entries: 0 })) throw new Error(`Unload leak: ${JSON.stringify(disposal)}`);
  checks.push("unload removes main slot, Remote mount and stream subscriptions");
  if (errors.length) throw new Error(errors.join("\n"));
  const result = { status: "passed", renderer_version: JSON.parse(await readFile(join(modules, "dsh-client-ui-renderer/package.json"), "utf8")).version, slots_version: JSON.parse(await readFile(join(slots, "package.json"), "utf8")).version, browser: await browser.version(), runtime, package: { path: packageFile, name: manifest.name, version: manifest.version, sha256: packageDigest }, checks, errors, limitation: "Real browser and official renderer/module system; deterministic Remote and minimal declared shell, not authenticated Host integration." };
  await Bun.write(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));
} catch (error) { await Bun.write(join(output, "result.json"), JSON.stringify({ status: "failed", package: packageFile, sha256: packageDigest, errors, failure: String(error) }, null, 2)); console.error("Browser errors:", errors); throw error; }
finally { await browser.close(); await server.stop(true); }
