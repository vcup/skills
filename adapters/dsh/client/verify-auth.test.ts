/**
 * The authenticated-Host gate refuses to run on anything less than a real
 * handoff, a real installed package and a real browser.
 *
 * These tests drive the gate's own interface — argv parsing, handoff validation
 * and cookie extraction — and assert the *refusals*. They deliberately do not
 * assert a pass: without a live Host and a browser binary the only honest
 * outcomes are "prerequisite missing" (exit 2) and "check failed" (exit 1), and a
 * test that faked a pass would be exactly the mock-as-evidence this gate exists to
 * replace.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PrerequisiteError,
  parseOptions,
  readCookie,
  readHandoff,
} from "./verify-auth.ts";

const made: string[] = [];
function installed(dir: string): string {
  const root = join(dir, "node_modules", "dsh-ensemble");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dsh-ensemble", version: "1.0.0" }));
  writeFileSync(join(root, "lib", "cookie-jar.mjs"), "");
  return root;
}
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-verify-auth-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("argv contract", () => {
  test("requires connection, browser and output", () => {
    expect(() => parseOptions([])).toThrow(PrerequisiteError);
    expect(() => parseOptions(["--connection", "c.json"])).toThrow(/--browser/u);
    expect(() => parseOptions(["--connection", "c.json", "--browser", "chrome"])).toThrow(/--output/u);
  });

  test("rejects an option without a value instead of consuming the next option", () => {
    expect(() => parseOptions(["--connection", "--browser", "/bin/chrome", "--output", "/tmp/out"])).toThrow(/needs a value/u);
    expect(() => parseOptions(["--connection", "", "--browser", "/bin/chrome", "--output", "/tmp/out"])).toThrow(/needs a value/u);
  });

  test("rejects an unknown or misspelled option", () => {
    expect(() => parseOptions(["--connection", "c.json", "--browser", "/bin/chrome", "--output", "/tmp/out", "--package", "x.tgz"])).toThrow(/unknown argument --package/u);
    expect(() => parseOptions(["--conn", "c.json"])).toThrow(/unknown argument/u);
  });

  test("resolves the three inputs it accepts", () => {
    const options = parseOptions(["--connection", "connection.json", "--browser", "/bin/chrome", "--output", "evidence"]);
    expect(options.connection.endsWith("connection.json")).toBe(true);
    expect(options.browser).toBe("/bin/chrome");
    expect(options.output.endsWith("evidence")).toBe(true);
  });
});

describe("handoff contract", () => {
  function handoff(value: unknown): string {
    const dir = scratch();
    const file = join(dir, "connection.json");
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  }
  test("a missing handoff is a prerequisite failure, not a client failure", async () => {
    await expect(readHandoff(join(scratch(), "connection.json"))).rejects.toBeInstanceOf(PrerequisiteError);
  });

  test("malformed JSON and non-object JSON are refused", async () => {
    await expect(readHandoff(handoff("{not json"))).rejects.toThrow(/not JSON/u);
    await expect(readHandoff(handoff([]))).rejects.toThrow(/missing origin/u);
  });

  test("every mandatory field is enforced", async () => {
    const dir = scratch();
    const browserCookieFile = join(dir, "browser-cookie");
    const apiCookieFile = join(dir, "remote-cookie");
    writeFileSync(browserCookieFile, "dsh-auth-x\tv1.page\n");
    writeFileSync(apiCookieFile, "dsh-auth-x\tv2.api\n");
    const packageRoot = installed(dir);
    await expect(readHandoff(handoff({ browserCookieFile, apiCookieFile, packageRoot }))).rejects.toThrow(/missing origin/u);
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", apiCookieFile, packageRoot }))).rejects.toThrow(/browserCookieFile/u);
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", browserCookieFile, packageRoot }))).rejects.toThrow(/no apiCookieFile/u);
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", browserCookieFile, apiCookieFile }))).rejects.toThrow(/missing packageRoot/u);
  });

  test("a non-http origin, a missing cookie file and a non-package root are refused", async () => {
    const dir = scratch();
    const browserCookieFile = join(dir, "browser-cookie");
    const apiCookieFile = join(dir, "remote-cookie");
    writeFileSync(browserCookieFile, "dsh-auth-x\tv1.page\n");
    writeFileSync(apiCookieFile, "dsh-auth-x\tv2.api\n");
    const packageRoot = installed(dir);
    await expect(readHandoff(handoff({ origin: "file:///etc/passwd", browserCookieFile, apiCookieFile, packageRoot }))).rejects.toThrow(/http/u);
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", browserCookieFile: join(dir, "absent"), apiCookieFile, packageRoot }))).rejects.toThrow(/browserCookieFile does not exist/u);
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", browserCookieFile, apiCookieFile: join(dir, "absent"), packageRoot }))).rejects.toThrow(/apiCookieFile does not exist/u);
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", browserCookieFile, apiCookieFile, packageRoot: dir }))).rejects.toThrow(/not an installed package/u);
  });

  test("accepts a real-shaped handoff and keeps the origin", async () => {
    const dir = scratch();
    const browserCookieFile = join(dir, "browser-cookie");
    const apiCookieFile = join(dir, "remote-cookie");
    writeFileSync(browserCookieFile, "dsh-auth-x\tv1.page\n");
    writeFileSync(apiCookieFile, "dsh-auth-x\tv2.api\n");
    const packageRoot = installed(dir);
    const value = await readHandoff(handoff({ origin: "http://127.0.0.1:41234/", browserCookieFile, apiCookieFile, packageRoot, projectId: "p1", head: "a".repeat(40), headSource: "live" }));
    expect(value.origin).toBe("http://127.0.0.1:41234");
    expect(value.projectId).toBe("p1");
    expect(value.head).toBe("a".repeat(40));
    expect(value.headSource).toBe("live");
  });

  test("a legacy handoff carrying only the API cookie is refused by name", async () => {
    const dir = scratch();
    const apiCookieFile = join(dir, "remote-cookie");
    writeFileSync(apiCookieFile, "dsh-auth-x\tv2.api\n");
    const packageRoot = installed(dir);
    // The exact shape the serve fixture published before the fix: one cookie, meaning API.
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", cookieFile: apiCookieFile, cookieFileMeaning: "api", apiCookieFile, packageRoot }))).rejects.toThrow(/browserCookieFile/u);
  });

  test("a legacy cookieFile labelled api fills the API role, but never the page role", async () => {
    const dir = scratch();
    const apiCookieFile = join(dir, "remote-cookie");
    const browserCookieFile = join(dir, "browser-cookie");
    writeFileSync(apiCookieFile, "dsh-auth-x\tv2.api\n");
    writeFileSync(browserCookieFile, "dsh-auth-x\tv1.page\n");
    const packageRoot = installed(dir);
    const value = await readHandoff(handoff({ origin: "http://127.0.0.1:1", browserCookieFile, cookieFile: apiCookieFile, cookieFileMeaning: "api", packageRoot }));
    expect(value.apiCookieFile).toBe(apiCookieFile);
    expect(value.browserCookieFile).toBe(browserCookieFile);
  });

  test("an unlabelled legacy cookieFile is not silently used for the API role", async () => {
    const dir = scratch();
    const legacy = join(dir, "cookie");
    const browserCookieFile = join(dir, "browser-cookie");
    writeFileSync(legacy, "dsh-auth-x\tvalue\n");
    writeFileSync(browserCookieFile, "dsh-auth-x\tv1.page\n");
    const packageRoot = installed(dir);
    await expect(readHandoff(handoff({ origin: "http://127.0.0.1:1", browserCookieFile, cookieFile: legacy, packageRoot }))).rejects.toThrow(/no apiCookieFile/u);
  });
});

describe("credential handling", () => {
  test("reads the session cookie out of a curl jar, including the #HttpOnly_ line", async () => {
    const dir = scratch();
    const packageRoot = installed(dir);
    writeFileSync(join(packageRoot, "lib", "cookie-jar.mjs"), `export function parseCookieText(text) {
      const lines = text.split("\\n").map(line => line.trim()).filter(line => line !== "" && (line.startsWith("#HttpOnly_") || !line.startsWith("#")));
      for (const line of lines) {
        const columns = line.replace(/^#HttpOnly_/u, "").split("\\t");
        const name = columns[columns.length - 2] ?? "";
        const value = columns[columns.length - 1] ?? "";
        if (name.startsWith("dsh-auth-") && value !== "") return name + "=" + value;
      }
      return "";
    }\n`);
    const cookieFile = join(dir, "jar");
    writeFileSync(cookieFile, `# Netscape HTTP Cookie File\n#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tdsh-auth-abc\tsecret-value\n`);
    const cookie = await readCookie(packageRoot, cookieFile, "http://127.0.0.1:41234");
    expect(cookie).toEqual({ name: "dsh-auth-abc", value: "secret-value", url: "http://127.0.0.1:41234" });
  });

  test("an empty cookie file is refused rather than attempted anonymously", async () => {
    const dir = scratch();
    const packageRoot = installed(dir);
    writeFileSync(join(packageRoot, "lib", "cookie-jar.mjs"), "export function parseCookieText() { return \"\"; }\n");
    const cookieFile = join(dir, "jar");
    writeFileSync(cookieFile, "# Netscape HTTP Cookie File\n");
    await expect(readCookie(packageRoot, cookieFile, "http://127.0.0.1:41234")).rejects.toThrow(/no session cookie/u);
  });
});
