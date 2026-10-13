import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyChangeSet,
  type ChangeSet,
  type ChangeSetApplyOptions
} from "../../src/main/proposals/change-set-applier.js";
import { validateChangeSet } from "../../src/shared/core/worker-proposal.js";

const BASE_SHA = "a".repeat(40);
const TASK_SPEC_SHA = "b".repeat(64);
const LIMITS = {
  max_operations: 20,
  max_file_bytes: 64 * 1024,
  max_total_bytes: 256 * 1024
} as const;

type Fixture = {
  root: string;
  managedRoot: string;
  worktreeRoot: string;
  existingPath: string;
  original: string;
};

let fixture: Fixture;

const hash = (content: string): string => createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

const makeChangeSet = (
  operations: ChangeSet["operations"],
  overrides: Partial<ChangeSet> = {}
): ChangeSet => ({
  schema_version: "1.0",
  task_id: "TASK-F04",
  base_sha: BASE_SHA,
  task_spec_sha256: TASK_SPEC_SHA,
  status: "completed",
  summary: "controlled fixture update",
  operations,
  acceptance_notes: [],
  risks: [],
  blocker: null,
  ...overrides
});

const options = (overrides: Partial<ChangeSetApplyOptions> = {}): ChangeSetApplyOptions => ({
  worktreeRoot: fixture.worktreeRoot,
  managedWorktreeRoot: fixture.managedRoot,
  taskSpec: {
    task_id: "TASK-F04",
    base_sha: BASE_SHA,
    scope: {
      allowed_paths: ["src/**"],
      forbidden_paths: ["src/private/**"]
    },
    limits: {
      max_attempts: 1,
      run_timeout_seconds: 60,
      max_changed_files: 20,
      max_diff_bytes: 256 * 1024
    }
  },
  taskSpecSha256: TASK_SPEC_SHA,
  limits: LIMITS,
  ...overrides
});

const create = (relativePath: string, content: string): ChangeSet["operations"][number] => ({
  type: "create_file",
  path: relativePath,
  expected_sha256: null,
  content
});

const replace = (relativePath: string, previous: string, content: string): ChangeSet["operations"][number] => ({
  type: "replace_file",
  path: relativePath,
  expected_sha256: hash(previous),
  content
});

const makeSymlink = (target: string, linkPath: string): boolean => {
  try {
    symlinkSync(target, linkPath, "junction");
    return true;
  } catch {
    // Some Windows CI workers do not grant symlink creation to the test user.
    // The non-symlink path checks remain covered by the regular-file tests.
    return false;
  }
};

beforeEach(() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-change-set-"));
  const managedRoot = path.join(root, "managed");
  const worktreeRoot = path.join(managedRoot, "task", "1");
  const srcRoot = path.join(worktreeRoot, "src");
  mkdirSync(srcRoot, { recursive: true });
  const original = "before\n";
  const existingPath = path.join(srcRoot, "existing.ts");
  writeFileSync(existingPath, original, "utf8");
  fixture = { root, managedRoot, worktreeRoot, existingPath, original };
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

describe("platform-owned change-set applier", () => {
  it("applies a validated create_file through an adjacent atomic temp", () => {
    const result = applyChangeSet(makeChangeSet([create("src/new.ts", "export const value = 1;\n")]), options());
    expect(result.applied).toBe(true);
    expect(result.changed_paths).toEqual(["src/new.ts"]);
    expect(readFileSync(path.join(fixture.worktreeRoot, "src", "new.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it("applies a replace_file only when the original hash matches", () => {
    const result = applyChangeSet(makeChangeSet([replace("src/existing.ts", fixture.original, "after\n")]), options());
    expect(result.total_bytes).toBe(Buffer.byteLength("after\n", "utf8"));
    expect(readFileSync(fixture.existingPath, "utf8")).toBe("after\n");
  });

  it("rejects every identity drift before touching an existing target", () => {
    const cases: Array<Partial<ChangeSet>> = [
      { task_id: "TASK-OTHER" },
      { base_sha: "c".repeat(40) },
      { task_spec_sha256: "c".repeat(64) }
    ];
    for (const changeSetOverrides of cases) {
      expect(() => applyChangeSet(makeChangeSet([replace("src/existing.ts", fixture.original, "after\n")], changeSetOverrides), options())).toThrow(/IDENTITY_MISMATCH/);
      expect(readFileSync(fixture.existingPath, "utf8")).toBe(fixture.original);
    }
  });

  it("validates every operation before the first write", () => {
    const invalidSecond = create("docs/not-allowed.ts", "must not write\n");
    expect(() => applyChangeSet(makeChangeSet([
      replace("src/existing.ts", fixture.original, "would be written\n"),
      invalidSecond
    ]), options())).toThrow(/SCOPE_VIOLATION/);
    expect(readFileSync(fixture.existingPath, "utf8")).toBe(fixture.original);
    expect(existsSync(path.join(fixture.worktreeRoot, "docs", "not-allowed.ts"))).toBe(false);
  });

  it.each([
    "../outside.ts",
    "src/../../outside.ts",
    "C:\\outside.ts",
    "\\\\server\\outside.ts",
    "src/.\\file.ts",
    "src/file:stream.ts",
    ".git/config",
    ".env"
  ])("rejects unsafe relative target %s", (target) => {
    expect(() => applyChangeSet(makeChangeSet([create(target, "bad\n")]), options())).toThrow(/UNSAFE_PATH|CHANGE_SET_INVALID/);
    expect(readFileSync(fixture.existingPath, "utf8")).toBe(fixture.original);
  });

  it("rejects forbidden scope even when an allowed glob also matches", () => {
    expect(() => applyChangeSet(makeChangeSet([create("src/private/secret.ts", "no\n")]), options())).toThrow(/SCOPE_VIOLATION/);
    expect(existsSync(path.join(fixture.worktreeRoot, "src", "private", "secret.ts"))).toBe(false);
  });

  it("rejects duplicate and Windows case-colliding operation paths", () => {
    expect(() => applyChangeSet(makeChangeSet([
      create("src/new.ts", "one\n"),
      create("src\\NEW.ts", "two\n")
    ]), options())).toThrow(/DUPLICATE_PATH|CASE_COLLISION|CHANGE_SET_INVALID/);
    expect(existsSync(path.join(fixture.worktreeRoot, "src", "new.ts"))).toBe(false);
  });

  it("rejects a case-colliding existing target rather than silently changing its name", () => {
    const existing = path.join(fixture.worktreeRoot, "src", "Actual.ts");
    writeFileSync(existing, "actual\n", "utf8");
    expect(() => applyChangeSet(makeChangeSet([create("src/actual.ts", "new\n")]), options())).toThrow(/TARGET_EXISTS|CASE_COLLISION/);
    expect(readFileSync(existing, "utf8")).toBe("actual\n");
  });

  it("rejects an existing target whose expected hash is stale", () => {
    expect(() => applyChangeSet(makeChangeSet([replace("src/existing.ts", "stale\n", "after\n")]), options())).toThrow(/TARGET_HASH_MISMATCH/);
    expect(readFileSync(fixture.existingPath, "utf8")).toBe(fixture.original);
  });

  it("rejects create_file over an existing file, directory, or missing parent", () => {
    expect(() => applyChangeSet(makeChangeSet([create("src/existing.ts", "no\n")]), options())).toThrow(/TARGET_EXISTS/);
    mkdirSync(path.join(fixture.worktreeRoot, "src", "directory"));
    expect(() => applyChangeSet(makeChangeSet([replace("src/directory", fixture.original, "no\n")]), options())).toThrow(/TARGET_NOT_REGULAR/);
    expect(() => applyChangeSet(makeChangeSet([create("src/missing/new.ts", "no\n")]), options())).toThrow(/PARENT_MISSING/);
    expect(readFileSync(fixture.existingPath, "utf8")).toBe(fixture.original);
  });

  it("rejects symlink targets and symlink ancestors", () => {
    const outside = path.join(fixture.root, "outside");
    mkdirSync(outside);
    const targetLink = path.join(fixture.worktreeRoot, "src", "link.ts");
    const directoryLink = path.join(fixture.worktreeRoot, "src", "linked");
    const targetReady = makeSymlink(fixture.existingPath, targetLink);
    const ancestorReady = makeSymlink(outside, directoryLink);
    if (!targetReady || !ancestorReady) return;

    expect(() => applyChangeSet(makeChangeSet([replace("src/link.ts", fixture.original, "no\n")]), options())).toThrow(/TARGET_SYMLINK/);
    expect(() => applyChangeSet(makeChangeSet([create("src/linked/new.ts", "no\n")]), options())).toThrow(/PARENT_SYMLINK/);
    expect(existsSync(path.join(outside, "new.ts"))).toBe(false);
    expect(readFileSync(fixture.existingPath, "utf8")).toBe(fixture.original);
  });

  it("rejects NUL/binary-like content and all bounded output overflows", () => {
    expect(() => applyChangeSet(makeChangeSet([create("src/nul.ts", "bad\0text")]), options())).toThrow(/CONTENT_INVALID|CHANGE_SET_INVALID/);
    expect(() => applyChangeSet(makeChangeSet([create("src/large.ts", "x".repeat(65))]), options({ limits: { ...LIMITS, max_file_bytes: 64 } }))).toThrow(/FILE_LIMIT_EXCEEDED/);
    expect(() => applyChangeSet(makeChangeSet([create("src/a.ts", "12345"), create("src/b.ts", "67890")]), options({ limits: { ...LIMITS, max_total_bytes: 9 } }))).toThrow(/TOTAL_LIMIT_EXCEEDED/);
    expect(() => applyChangeSet(makeChangeSet([create("src/a.ts", "1"), create("src/b.ts", "2")]), options({ limits: { ...LIMITS, max_operations: 1 } }))).toThrow(/OPERATION_LIMIT_EXCEEDED/);
    expect(readFileSync(fixture.existingPath, "utf8")).toBe(fixture.original);
  });

  it("requires completed status and valid shared contract", () => {
    expect(() => applyChangeSet(makeChangeSet([], { status: "blocked", blocker: "needs review" }), options())).toThrow(/STATUS_NOT_COMPLETED|CHANGE_SET_INVALID/);
    expect(validateChangeSet(makeChangeSet([create("src/new.ts", "ok\n")])).valid).toBe(true);
  });

  it("refuses a worktree outside the explicit managed root and leaves the user checkout untouched", () => {
    const userCheckout = path.join(fixture.root, "user-checkout");
    mkdirSync(userCheckout);
    const sentinel = path.join(userCheckout, "sentinel.txt");
    writeFileSync(sentinel, "user checkout\n", "utf8");
    expect(() => applyChangeSet(makeChangeSet([create("src/escape.ts", "no\n")]), options({ worktreeRoot: userCheckout }))).toThrow(/WORKTREE_OUTSIDE_MANAGED_ROOT/);
    expect(readFileSync(sentinel, "utf8")).toBe("user checkout\n");
    expect(existsSync(path.join(userCheckout, "src", "escape.ts"))).toBe(false);
  });
});
