import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runApprovedTests } from "../../src/main/testing/test-runner.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runApprovedTests", () => {
  it("runs an approved command in a contained relative cwd with argument arrays", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "approved-tests-"));
    roots.push(root);
    const worktree = path.join(root, "worktree");
    const logRoot = path.join(root, "logs");
    const nested = path.join(worktree, "nested");
    mkdirSync(nested, { recursive: true });
    const marker = "literal;&&|$HOME";
    const result = await runApprovedTests(worktree, [{
      id: "fake",
      program: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]}))", marker],
      cwd: "nested",
      timeout_seconds: 5,
      required: true,
    }], logRoot);

    expect(result).toHaveLength(1);
    expect(result[0].result.status).toBe("SUCCEEDED");
    expect(JSON.parse(result[0].result.stdout)).toEqual({ cwd: nested, arg: marker });
    expect(readFileSync(path.join(logRoot, "fake", "stdout.log"), "utf8")).toContain(marker);
  });

  it.each(["../outside", path.resolve("outside")])("rejects cwd %s outside the worktree", async (cwd) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "approved-tests-"));
    roots.push(root);
    const worktree = path.join(root, "worktree");
    await expect(runApprovedTests(worktree, [{
      id: "escape",
      program: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd,
      timeout_seconds: 5,
      required: true,
    }], path.join(root, "logs"))).rejects.toThrow("Test cwd escapes worktree");
  });

  it("rejects cwd that resolves through a link outside the worktree", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "approved-tests-"));
    roots.push(root);
    const worktree = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    mkdirSync(worktree);
    mkdirSync(outside);
    symlinkSync(outside, path.join(worktree, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(runApprovedTests(worktree, [{
      id: "escape",
      program: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: "linked",
      timeout_seconds: 5,
      required: true,
    }], path.join(root, "logs"))).rejects.toThrow("Test cwd escapes worktree");
  });
});
