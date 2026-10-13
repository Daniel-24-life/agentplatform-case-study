import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedContext } from "../../src/shared/core/bounded-context.js";

describe("bounded context", () => {
  it("reads safe files with deterministic deduplication and ordering", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bounded-context-")); mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "b.txt"), "b"); writeFileSync(path.join(root, "src", "a.txt"), "a");
    const result = readBoundedContext(root, ["b.txt", "src/a.txt", "b.txt"]);
    expect(result.items.map(item => item.path)).toEqual(["b.txt", "src/a.txt"]);
    expect(result.items.every(item => item.sha256.length === 64)).toBe(true);
    expect(result.sha256).toHaveLength(64); expect(result.totalBytes).toBe(2); expect(result.truncated).toBe(false);
  });

  it("rejects absolute, traversal and symlink escape paths", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bounded-context-")); const outside = mkdtempSync(path.join(os.tmpdir(), "bounded-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "secret"); symlinkSync(outside, path.join(root, "escape"), "junction");
    expect(() => readBoundedContext(root, ["../secret", path.join(root, "secret")])).toThrow();
    expect(() => readBoundedContext(root, ["escape/secret.txt"])).toThrow(/symlink/);
  });

  it("enforces file, per-file and total byte limits with metadata", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bounded-context-")); writeFileSync(path.join(root, "a"), "12345"); writeFileSync(path.join(root, "b"), "67890");
    const result = readBoundedContext(root, ["a", "b"], { maxFiles: 1, maxBytesPerFile: 3, maxTotalBytes: 3 });
    expect(result.items).toHaveLength(1); expect(result.items[0].content).toBe("123"); expect(result.items[0].truncated).toBe(true);
    expect(result.truncated).toBe(true); expect(result.truncation.files).toBe(2); expect(result.truncation.bytes).toBe(2);
  });
});
