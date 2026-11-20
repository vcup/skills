/**
 * Tests for `adapters/dsh/compatibility.ts`, the one module that decides which
 * DSH releases this probe supports.
 *
 * These are the negative tests that matter: the set must fail *closed*. A
 * range such as `>=0.2.2-rc.4` would admit every future prerelease, because
 * DSH's own gate evaluates ranges with `includePrerelease: true`. So the tests
 * below assert the properties that keep that mistake out — exact literals, no
 * range operators, and refusal of anything not enumerated.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DSH_VERSION,
  DSH_PEER_PACKAGES,
  DSH_PEER_RANGE,
  DSH_REGISTRY_PACKAGES,
  DSH_RELEASE_PACKAGES,
  DSH_RUNTIME_PACKAGE,
  ENGINES_DSH,
  isSupportedDshVersion,
  judgeProbeShadow,
  judgeReleases,
  SHARED_INSTANCE_PACKAGE,
  SUPPORTED_DSH_VERSIONS,
  supportedVersionsText,
} from "./compatibility.ts";

describe("the supported set", () => {
  test("is an exact enumeration, not a range", () => {
    // Every entry is a literal release string; nothing here can widen by itself.
    for (const version of SUPPORTED_DSH_VERSIONS) expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
    // The derived range is a disjunction of those literals only. A single
    // `>=`, `^`, `~`, `*` or `latest` would silently admit untested releases.
    expect(ENGINES_DSH).toBe(SUPPORTED_DSH_VERSIONS.join(" || "));
    expect(ENGINES_DSH).not.toMatch(/[><^~]|\*|latest|x\b/);
    expect(ENGINES_DSH.split(" || ")).toHaveLength(SUPPORTED_DSH_VERSIONS.length);
  });

  test("names a default that is itself tested", () => {
    expect(SUPPORTED_DSH_VERSIONS).toContain(DEFAULT_DSH_VERSION);
    // The default is the newest tested release, not a floating tag.
    expect(DEFAULT_DSH_VERSION).toBe(SUPPORTED_DSH_VERSIONS[SUPPORTED_DSH_VERSIONS.length - 1]);
  });

  test("the peer range is the same disjunction as engines", () => {
    expect(DSH_PEER_RANGE).toBe(ENGINES_DSH);
  });

  test("cordis is named separately and is never treated as a DSH release", () => {
    expect(SHARED_INSTANCE_PACKAGE).toBe("@deepseek-ai/cordis");
    expect(DSH_RELEASE_PACKAGES as readonly string[]).not.toContain(SHARED_INSTANCE_PACKAGE);
    // The registry list is the release packages, so an upstream check cannot
    // compare cordis against a DSH release.
    expect(DSH_REGISTRY_PACKAGES).toEqual(DSH_RELEASE_PACKAGES);
    expect(DSH_RELEASE_PACKAGES).toContain(DSH_RUNTIME_PACKAGE);
    for (const peer of DSH_PEER_PACKAGES) expect(DSH_RELEASE_PACKAGES).toContain(peer);
  });

  test("the human-readable phrase lists every tested release", () => {
    for (const version of SUPPORTED_DSH_VERSIONS) expect(supportedVersionsText()).toContain(version);
  });
});

describe("isSupportedDshVersion", () => {
  test("accepts exactly the tested releases", () => {
    for (const version of SUPPORTED_DSH_VERSIONS) expect(isSupportedDshVersion(version)).toBe(true);
  });

  test("refuses untested, future and malformed versions", () => {
    for (const value of [
      "0.2.2-rc.6",
      "0.2.3-rc.1",
      "0.3.0",
      "1.0.0",
      "0.2.2", // the release without its prerelease tag is a different version
      "0.2.2-rc.4 ",
      "v0.2.2-rc.4",
      "latest",
      "",
      "  ",
    ]) {
      expect(isSupportedDshVersion(value)).toBe(false);
    }
  });

  test("refuses non-strings without throwing", () => {
    for (const value of [undefined, null, 4, {}, []]) expect(isSupportedDshVersion(value)).toBe(false);
  });
});

describe("judgeReleases", () => {
  const clean = SUPPORTED_DSH_VERSIONS.map((version) => ({
    package: "@deepseek-ai/dsh-skill",
    version,
  }));

  test("accepts an install where every DSH package agrees on a tested release", () => {
    for (const version of SUPPORTED_DSH_VERSIONS) {
      const readings = DSH_RELEASE_PACKAGES.map((name) => ({ package: name, version }));
      const verdict = judgeReleases(readings, { require: DSH_RELEASE_PACKAGES });
      expect(verdict.ok).toBe(true);
      expect(verdict.problems).toEqual([]);
    }
  });

  test("refuses a required package that is missing or unreadable", () => {
    const missing = judgeReleases(clean, { require: ["@deepseek-ai/dsh-tools"] });
    expect(missing.ok).toBe(false);
    expect(missing.problems.join("\n")).toContain("not installed");

    const unreadable = judgeReleases([{ package: "@deepseek-ai/dsh-skill", version: undefined }], {
      require: ["@deepseek-ai/dsh-skill"],
    });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.problems.join("\n")).toContain("no readable version");
  });

  test("refuses an untested release and names it", () => {
    const verdict = judgeReleases([{ package: "@deepseek-ai/dsh", version: "0.2.2-rc.6" }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toContain("0.2.2-rc.6");
    expect(verdict.problems.join("\n")).toContain("outside the tested DSH set");
  });

  test("refuses two DSH releases in one install", () => {
    const verdict = judgeReleases([
      { package: "@deepseek-ai/dsh", version: "0.2.2-rc.5" },
      { package: "@deepseek-ai/dsh-skill", version: "0.2.2-rc.4" },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toContain("mixed DSH releases");
  });

  test("a cordis version difference is not a mixed DSH install", () => {
    // cordis is a separate shared instance: it is deliberately absent from the
    // judged readings, so its version can never look like a second release.
    const verdict = judgeReleases([
      { package: "@deepseek-ai/dsh", version: "0.2.2-rc.5" },
      { package: "@deepseek-ai/dsh-skill", version: "0.2.2-rc.5" },
    ]);
    expect(verdict.ok).toBe(true);
  });

  test("an absent optional package does not fail the verdict", () => {
    const verdict = judgeReleases([{ package: "@deepseek-ai/dsh-skill", version: "0.2.2-rc.5" }], {
      require: ["@deepseek-ai/dsh-skill"],
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("judgeProbeShadow", () => {
  const host = DSH_RELEASE_PACKAGES.map((name) => ({ package: name, version: "0.2.2-rc.5" }));

  test("a deduped install has no shadow copy", () => {
    expect(judgeProbeShadow(host, []).ok).toBe(true);
    // A copy at the same version as the host is the same shared instance.
    expect(judgeProbeShadow(host, [{ package: "@deepseek-ai/dsh-skill", version: "0.2.2-rc.5" }]).ok).toBe(true);
  });

  test("a private copy at a different release is the mixed shape and is refused", () => {
    const verdict = judgeProbeShadow(host, [{ package: "@deepseek-ai/dsh-skill", version: "0.2.2-rc.4" }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toContain("private");
    expect(verdict.problems.join("\n")).toContain("0.2.2-rc.4");
    expect(verdict.problems.join("\n")).toContain("0.2.2-rc.5");
  });

  test("a private copy with no host counterpart is refused", () => {
    const verdict = judgeProbeShadow([], [{ package: "@deepseek-ai/dsh-tools", version: "0.2.2-rc.4" }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join("\n")).toContain("no copy");
  });
});
