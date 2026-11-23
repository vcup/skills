/**
 * The served-client phase must read the Host's own manifest and bundle, and must
 * fail loudly on each way an installed-but-unserved artifact shows up: no
 * manifest, no Client row, a row without a URL, a bundle that is not a page
 * module factory, or a factory that registers the wrong seats. Each of these has
 * a distinct remedy, so the messages are asserted too.
 */

import { describe, expect, test } from "bun:test";
import { bootManifest, deliveredCode, factoryFacts, ServedClientError } from "./served-client.ts";

const factory = (source: string): string => `window.__ModuleLoader__.load({id:"dsh-ensemble",factory(require){${source}}})`;

describe("boot manifest", () => {
  test("reads a nested manifest out of assigned HTML", () => {
    const html = `<script>globalThis["__DSH_BOOT__"] = {"rev":"abc","modules":[{"id":"react","url":"a.js"},{"id":"dsh-ensemble","url":"dsh-ensemble/client.js"}],"plugins":[{"id":"dsh-ensemble"}]};</script>`;
    expect(bootManifest(html).modules.map(row => row.id)).toEqual(["react", "dsh-ensemble"]);
  });

  test("handles braces and quotes inside strings", () => {
    const html = `<script>x["__DSH_BOOT__"] = {"label":"a } b { c \\" d","modules":[{"id":"dsh-ensemble","url":"u"}]};</script>`;
    expect(bootManifest(html).modules[0]?.url).toBe("u");
  });

  test("a page with no manifest is refused", () => {
    expect(() => bootManifest("<html><body>nothing</body></html>")).toThrow(ServedClientError);
  });

  test("an unterminated manifest is refused rather than half-parsed", () => {
    expect(() => bootManifest(`["__DSH_BOOT__"] = {"modules":[{"id":"x"}`)).toThrow(/unterminated/u);
  });
});

describe("delivered code", () => {
  test("removes the combo route's sourceMappingURL trailer and nothing else", () => {
    const installed = "window.__ModuleLoader__.load({id:\"x\",factory(r){return 1;}});\n";
    const served = `${installed};\n//# sourceMappingURL=??x/client.js.map&rev=0f2e29b579d8\n`;
    expect(deliveredCode(served)).toBe(installed);
  });

  test("keeps a genuine code difference visible", () => {
    const installed = "window.__ModuleLoader__.load({id:\"x\",factory(r){return 1;}});\n";
    expect(deliveredCode(`${installed.replace("return 1", "return 2")};\n//# sourceMappingURL=??x/client.js.map&rev=0f2e29b579d8\n`)).not.toBe(installed);
  });

  test("a bundle with no trailer is unchanged", () => {
    const code = "window.__ModuleLoader__.load({id:\"x\",factory(r){}});\n";
    expect(deliveredCode(code)).toBe(code);
  });

  test("does not truncate code that merely ends near a comment-like string", () => {
    // Every near miss keeps the code intact: a wrong strip would hide a stale artifact.
    for (const served of [
      "window.__ModuleLoader__.load({id:\"x\",factory(r){}});\n;\n//# sourceMappingURL=data:application/json;base64,AAA\n",
      "window.__ModuleLoader__.load({id:\"x\",factory(r){}});\n//# sourceMappingURL=??x/client.js.map\n",
      "window.__ModuleLoader__.load({id:\"x\",factory(r){}});\n;\n//# sourceMappingURL=??x/client.js.map&rev=zzzz\n",
      // A short rev is not the route's shape; keep the bytes so a mismatch stays loud.
      "window.__ModuleLoader__.load({id:\"x\",factory(r){}});\n;\n//# sourceMappingURL=??x/client.js.map&rev=abc\n",
      "window.__ModuleLoader__.load({id:\"x\",factory(r){}});\n;\n//# sourceMappingURL=??x/other.js.map&rev=abcdef\n",
    ]) expect(deliveredCode(served)).toBe(served);
  });
});

describe("factory facts", () => {
  test("a real factory reports its exports and both seats", () => {
    const facts = factoryFacts(factory(`const inject=["slots","remote"];function apply(ctx){};ctx.slots.register({name:"main",key:"ensemble"});ctx.slots.register({name:"sidebar.panellist",id:"ensemble"});exports.inject=inject;exports.apply=apply;`));
    expect(facts.exports).toEqual(["apply", "inject"]);
    expect(facts.seats).toEqual(["main:keyed(ensemble)", "sidebar.panellist"]);
  });

  test("a bundle that is not a page module factory is refused", () => {
    expect(() => factoryFacts("export function apply() {}")).toThrow(/page module factory/u);
  });

  test("a factory without the keyed main page is refused, not silently accepted", () => {
    expect(() => factoryFacts(factory(`function apply(){};ctx.slots.register({name:"sidebar.panellist"});`))).toThrow(/keyed main page/u);
  });

  test("the sidebar panel is reported when present and omitted when absent", () => {
    const withPanel = factoryFacts(factory(`name:"main",key:"ensemble";ctx.slots.register({name:"sidebar.panellist"});`));
    expect(withPanel.seats).toContain("sidebar.panellist");
    const withoutPanel = factoryFacts(factory(`name:"main",key:"ensemble";`));
    expect(withoutPanel.seats).toEqual(["main:keyed(ensemble)"]);
  });
});
