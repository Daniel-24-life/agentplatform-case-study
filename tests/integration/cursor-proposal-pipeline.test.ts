import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GitService } from "../../src/main/git/git-service.js";
import { runDeterministicGate } from "../../src/main/gate/deterministic-gate.js";
import { applyChangeSet } from "../../src/main/proposals/change-set-applier.js";
import { buildWorkerProposalRequest, taskSpecCanonicalSha256 } from "../../src/main/proposals/proposal-context.js";
import { runApprovedTests } from "../../src/main/testing/test-runner.js";
import { parseCursorProposalTrace } from "../../src/shared/core/cursor-proposal-trace.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

describe("Cursor proposal to platform-owned gate", () => {
  it("applies a validated Ask trace only inside a managed worktree and runs the approved test", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-cursor-proposal-"));
    const checkout = path.join(root, "checkout");
    const managed = path.join(root, "managed");
    let worktree = "";
    const service = new GitService("git", managed);
    try {
      mkdirSync(path.join(checkout, "src"), { recursive: true });
      writeFileSync(path.join(checkout, "src/message.txt"), "before\n");
      writeFileSync(path.join(checkout, "verify.mjs"),
        "import {readFileSync} from 'node:fs'; if(readFileSync(new URL('./src/message.txt', import.meta.url),'utf8')!=='ready\\n') process.exit(1);\n");
      git(checkout, "init", "--initial-branch=main");
      git(checkout, "config", "user.email", "fixture@example.invalid");
      git(checkout, "config", "user.name", "Cursor Fixture");
      git(checkout, "add", "--", "src/message.txt", "verify.mjs");
      git(checkout, "-c", "commit.gpgSign=false", "commit", "-m", "fixture");
      const baseSha = git(checkout, "rev-parse", "HEAD");
      const taskSpec: TaskSpec = {
        schema_version: "2.0", task_id: "CURSOR-OFFLINE", title: "Normalize fixture line",
        goal: "Replace src/message.txt with ready followed by a newline.", base_sha: baseSha,
        context_paths: ["src/message.txt"], scope: { allowed_paths: ["src/**"], forbidden_paths: [] },
        acceptance_criteria: [{ id: "AC-01", text: "The fixture verification exits successfully." }],
        test_commands: [{ id: "fixture", program: "node", args: ["verify.mjs"], cwd: ".", timeout_seconds: 20, required: true }],
        execution_policy: { planner_recommendation: "cheap", planner_confidence: "high",
          recommendation_reasons: ["Offline fixture"], user_lock: "cheap" },
        limits: { max_attempts: 1, run_timeout_seconds: 180, max_changed_files: 1, max_diff_bytes: 1024 }
      };
      const created = await service.createWorktree(checkout, { taskId: "CURSOR-OFFLINE", attempt: 1, baseSha });
      worktree = created.worktreePath;
      const request = buildWorkerProposalRequest({ taskSpec, managedWorktree: worktree });
      const proposal = {
        schema_version: "1.0", task_id: request.task_id, base_sha: request.base_sha,
        task_spec_sha256: request.task_spec_sha256, status: "completed",
        summary: "Replace the fixture value.",
        operations: [{ type: "replace_file", path: "src/message.txt",
          expected_sha256: request.context_files[0]!.sha256, content: "ready\n" }],
        acceptance_notes: [{ criterion_id: "AC-01", note: "Proposed the complete target file." }],
        risks: [], blocker: null
      };
      const event = (value: object): string => JSON.stringify(value);
      const stdout = [
        event({ type: "system", subtype: "init" }),
        event({ type: "tool_call", subtype: "started", call_id: "read-1", tool_call: { readToolCall: { args: { path: "context.json" } } } }),
        event({ type: "tool_call", subtype: "completed", call_id: "read-1", tool_call: { readToolCall: { args: { path: "context.json" } } } }),
        event({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(proposal) })
      ].join("\n") + "\n";
      const parsed = parseCursorProposalTrace(stdout, request, "/opt/agentplatform-cursor-proposals/fake");
      expect(readFileSync(path.join(worktree, "src/message.txt"), "utf8")).toBe(request.context_files[0]!.content);
      const applied = applyChangeSet(parsed.changeSet, { worktreeRoot: worktree, managedWorktreeRoot: managed,
        taskSpec, taskSpecSha256: taskSpecCanonicalSha256(taskSpec), limits: request.limits });
      expect(applied.changed_paths).toEqual(["src/message.txt"]);
      const tests = await runApprovedTests(worktree, taskSpec.test_commands, path.join(root, "test-logs"));
      const evidence = await service.collectEvidence(worktree);
      const gate = runDeterministicGate({ spec: taskSpec, baseSha: evidence.head, changedFiles: evidence.changedFiles,
        invalidPaths: evidence.invalidPaths, diff: evidence.diff, tests,
        workerValid: parsed.changeSet.status === "completed", artifacts: [] });
      expect(tests[0]?.result.status).toBe("SUCCEEDED");
      expect(gate).toEqual({ passed: true, failures: [] });
      expect(readFileSync(path.join(checkout, "src/message.txt"), "utf8")).toBe("before\n");
    } finally {
      if (worktree) await service.cleanupWorktree(checkout, worktree);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
