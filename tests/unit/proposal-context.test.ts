import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildProposalContext,
  PROPOSAL_CONTEXT_LIMITS,
  taskSpecCanonicalSha256,
  type ProposalContextRequest
} from "../../src/main/proposals/proposal-context.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";
import { validateWorkerProposalRequest } from "../../src/shared/core/worker-proposal.js";

const baseTaskSpec = (overrides: Partial<TaskSpec> = {}): TaskSpec => ({
  schema_version: "2.0",
  task_id: "TASK-F02",
  title: "bounded proposal context",
  goal: "prepare a bounded worker request",
  base_sha: "a".repeat(40),
  context_paths: ["src/input.txt"],
  scope: { allowed_paths: ["src/**"], forbidden_paths: [] },
  acceptance_criteria: [{ id: "AC-01", text: "context is bounded" }],
  test_commands: [{ id: "check", program: "node", args: ["--version"], cwd: ".", timeout_seconds: 60, required: true }],
  execution_policy: {
    planner_recommendation: "cheap",
    planner_confidence: "high",
    recommendation_reasons: ["small bounded fixture"],
    user_lock: null
  },
  limits: { max_attempts: 1, run_timeout_seconds: 60, max_changed_files: 4, max_diff_bytes: 1024 },
  ...overrides
});

const tempWorktree = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proposal-context-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "input.txt"), "hello\n", "utf8");
  return root;
};

const build = (root: string, taskSpec: TaskSpec = baseTaskSpec()): ProposalContextRequest =>
  buildProposalContext({ taskSpec, managedWorktree: root });

describe("proposal context builder", () => {
  it("copies only approved scope context with bytes, digest and UTF-8 content", () => {
    const root = tempWorktree();
    const result = build(root);

    expect(result.schema_version).toBe("1.0");
    expect(result.task_id).toBe("TASK-F02");
    expect(result.base_sha).toBe("a".repeat(40));
    expect(result.context_files).toEqual([{ path: "src/input.txt", byte_count: 6, sha256: expect.any(String), content: "hello\n" }]);
    expect(result.context_files[0]?.sha256).toHaveLength(64);
    expect(result.task_spec_sha256).toBe(taskSpecCanonicalSha256(baseTaskSpec()));
    expect(result.limits).toEqual({ max_operations: 4, max_file_bytes: 64 * 1024, max_total_bytes: 256 * 1024 });
    expect(validateWorkerProposalRequest(result).valid).toBe(true);
  });

  it("rejects paths outside TaskSpec scope and unsafe relative paths", () => {
    const root = tempWorktree();
    writeFileSync(path.join(root, "outside.txt"), "no", "utf8");

    expect(() => build(root, baseTaskSpec({ context_paths: ["outside.txt"] }))).toThrow(/SCOPE|scope/i);
    expect(() => build(root, baseTaskSpec({ context_paths: ["../outside.txt"] }))).toThrow(/TASK_SPEC_INVALID|UNSAFE|safe relative/i);
    expect(() => build(root, baseTaskSpec({ context_paths: [path.join(root, "src", "input.txt")] }))).toThrow(/TASK_SPEC_INVALID|UNSAFE|safe relative/i);
  });

  it("rejects the fixed credential denylist, symlinks, directories, and special content", () => {
    const root = tempWorktree();
    writeFileSync(path.join(root, ".env.local"), "TOKEN=secret\n", "utf8");
    writeFileSync(path.join(root, "src", "private.pem"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
    writeFileSync(path.join(root, "src", "credentials.json"), "{}\n", "utf8");
    mkdirSync(path.join(root, "src", "folder"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "proposal-context-outside-"));
    writeFileSync(path.join(outside, "data.txt"), "secret", "utf8");
    // A junction is available on Windows without requiring file-symlink
    // privileges and exercises the same ancestor-symlink rejection.
    symlinkSync(outside, path.join(root, "src", "escape"), "junction");

    expect(() => build(root, baseTaskSpec({ context_paths: [".env.local"], scope: { allowed_paths: ["**/*"], forbidden_paths: [] } }))).toThrow(/SECRET/);
    expect(() => build(root, baseTaskSpec({ context_paths: ["src/private.pem"] }))).toThrow(/SECRET|BINARY/);
    expect(() => build(root, baseTaskSpec({ context_paths: ["src/credentials.json"] }))).toThrow(/SECRET/);
    expect(() => build(root, baseTaskSpec({ context_paths: ["src/folder"] }))).toThrow(/REGULAR|directory/i);
    expect(() => build(root, baseTaskSpec({ context_paths: ["src/escape/data.txt"], scope: { allowed_paths: ["src/**"], forbidden_paths: [] } }))).toThrow(/SYMLINK/);
    expect(() => build(root, baseTaskSpec({ context_paths: ["src/input.txt"] }))).not.toThrow();
    void outside;
  });

  it("rejects invalid UTF-8, NUL binary data, and size limits", () => {
    const root = tempWorktree();
    writeFileSync(path.join(root, "src", "bad.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    writeFileSync(path.join(root, "src", "nul.txt"), Buffer.from("ok\0no", "utf8"));
    writeFileSync(path.join(root, "src", "large.txt"), Buffer.alloc(PROPOSAL_CONTEXT_LIMITS.maxBytesPerFile + 1, 0x61));

    expect(() => build(root, baseTaskSpec({ context_paths: ["src/bad.bin"] }))).toThrow(/UTF-8|NON_UTF8/i);
    expect(() => build(root, baseTaskSpec({ context_paths: ["src/nul.txt"] }))).toThrow(/BINARY|private-key/i);
    expect(() => build(root, baseTaskSpec({ context_paths: ["src/large.txt"] }))).toThrow(/LARGE|bytes/i);
  });

  it("enforces file and aggregate limits before a provider could launch", () => {
    const root = tempWorktree();
    const contextPaths: string[] = [];
    for (let index = 0; index < PROPOSAL_CONTEXT_LIMITS.maxFiles + 1; index += 1) {
      const file = `src/file-${index}.txt`;
      writeFileSync(path.join(root, file), "x", "utf8");
      contextPaths.push(file);
    }
    expect(() => build(root, baseTaskSpec({ context_paths: contextPaths }))).toThrow(/TOO_MANY|files/i);

    const aggregateRoot = tempWorktree();
    const aggregatePaths = ["src/a.txt", "src/b.txt"];
    writeFileSync(path.join(aggregateRoot, "src", "a.txt"), "a".repeat(150 * 1024), "utf8");
    writeFileSync(path.join(aggregateRoot, "src", "b.txt"), "b".repeat(110 * 1024), "utf8");
    expect(() => build(aggregateRoot, baseTaskSpec({ context_paths: aggregatePaths }))).toThrow(/CONTEXT_TOO_LARGE|bytes/i);
  });

  it("performs the bounded read/hash window before returning context", () => {
    const root = tempWorktree();
    const result = build(root);
    expect(result.context_files[0]?.byte_count).toBe(6);
    expect(result.context_files[0]?.sha256).toHaveLength(64);
  });

});
