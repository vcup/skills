import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishDirectory, readRegular } from "./files.ts";

/** Every fixture lives under a fresh private directory; nothing here names a shared path. */
function fixture() { const base = mkdtempSync(join(tmpdir(), "ensemble-files-")); return { base, dir: (name: string) => join(base, name) }; }

describe("trusted destination publication", () => {
    test("publishes complete bytes and never overwrites an existing destination", () => {
        const f = fixture();
        const destination = f.dir("out");
        publishDirectory(destination, [{ path: "originals/a.bin", bytes: new Uint8Array([0, 255, 128]) }]);
        expect(readFileSync(join(destination, "originals/a.bin"))).toEqual(Buffer.from([0, 255, 128]));
        expect(() => publishDirectory(destination, [{ path: "b", bytes: new Uint8Array([1]) }])).toThrow("destination_exists");
        expect(readdirSync(f.base).filter(name => name.startsWith(".ensemble-stage-"))).toEqual([]);
    });

    test("a symlinked destination parent is refused before any staging file is written", () => {
        const f = fixture();
        const real = f.dir("real-parent");
        mkdirSync(real);
        const alias = f.dir("alias-parent");
        symlinkSync(real, alias);
        expect(() => publishDirectory(join(alias, "out"), [{ path: "a", bytes: new Uint8Array([1]) }])).toThrow();
        expect(existsSync(join(real, "out"))).toBe(false);
        expect(readdirSync(real)).toEqual([]);
    });

    test("unsafe logical paths and duplicate names fail before the destination exists", () => {
        const f = fixture();
        const destination = f.dir("out");
        for (const files of [
            [{ path: "../escape", bytes: new Uint8Array([1]) }],
            [{ path: "/absolute", bytes: new Uint8Array([1]) }],
            [{ path: "a\\b", bytes: new Uint8Array([1]) }],
            [{ path: "same", bytes: new Uint8Array([1]) }, { path: "same", bytes: new Uint8Array([2]) }],
        ]) {
            expect(() => publishDirectory(destination, files)).toThrow();
            expect(existsSync(destination)).toBe(false);
        }
    });

    test("a destination leaf replaced by a symlink is refused and its target is untouched", () => {
        const f = fixture();
        const destination = f.dir("out");
        const outside = f.dir("outside");
        mkdirSync(outside);
        publishDirectory(destination, [{ path: "safe", bytes: new Uint8Array([1]) }]);
        renameSync(destination, f.dir("out-moved"));
        symlinkSync(outside, destination);
        expect(() => publishDirectory(destination, [{ path: "x", bytes: new Uint8Array([2]) }])).toThrow();
        expect(readdirSync(outside)).toEqual([]);
    });

    test("readRegular refuses symlinked files, symlinked parents and oversized files", () => {
        const f = fixture();
        const real = f.dir("real");
        mkdirSync(real);
        writeFileSync(join(real, "file"), "bounded");
        expect(Buffer.from(readRegular(join(real, "file"), 64)).toString()).toBe("bounded");
        symlinkSync(join(real, "file"), join(real, "file-link"));
        expect(() => readRegular(join(real, "file-link"))).toThrow();
        const alias = f.dir("alias");
        symlinkSync(real, alias);
        expect(() => readRegular(join(alias, "file"))).toThrow();
        expect(() => readRegular(join(real, "file"), 2)).toThrow("budget");
        rmSync(join(real, "file-link"));
    });
});
