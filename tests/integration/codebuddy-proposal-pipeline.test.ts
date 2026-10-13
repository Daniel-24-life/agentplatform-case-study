import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CodeBuddyAdapter } from "../../src/main/adapters/codebuddy/codebuddy-adapter.js";
import { GitService } from "../../src/main/git/git-service.js";
import { runProcess } from "../../src/main/process/runner.js";
import { applyChangeSet } from "../../src/main/proposals/change-set-applier.js";
import {
  buildWorkerProposalRequest,
  taskSpecCanonicalSha256
} from "../../src/main/proposals/proposal-context.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

describe("DG3-F offline worker-proposal pipeline", () => {
  it("keeps the provider outside the repository and lets only AgentPlatform apply and test the proposal", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-dg3f-pipeline-"));
    const checkout = path.join(root, "checkout");
    const managedRoot = path.join(root, "managed");
    const fakeEntry = path.join(root, "fake-codebuddy.cjs");
    let worktree = "";
    const gitService = new GitService("git", managedRoot);

    try {
      mkdirSync(path.join(checkout, "src"), { recursive: true });
      writeFileSync(path.join(checkout, "src", "message.txt"), "before\n", "utf8");
      writeFileSync(path.join(checkout, "verify.mjs"), [
        "import { readFileSync } from 'node:fs';",
        "if (readFileSync(new URL('./src/message.txt', import.meta.url), 'utf8') !== 'ready\\n') process.exit(1);"
      ].join("\n"), "utf8");
      git(checkout, "init", "--initial-branch=main");
      git(checkout, "config", "user.email", "dg3f@example.invalid");
      git(checkout, "config", "user.name", "DG3-F Fixture");
      git(checkout, "add", "--", "src/message.txt", "verify.mjs");
      git(checkout, "-c", "commit.gpgSign=false", "commit", "-m", "DG3-F fixture");
      const baseSha = git(checkout, "rev-parse", "HEAD");

      const created = await gitService.createWorktree(checkout, { taskId: "DG3F-OFFLINE", attempt: 1, baseSha });
      worktree = created.worktreePath;
      const taskSpec: TaskSpec = {
        schema_version: "2.0",
        task_id: "DG3F-OFFLINE",
        title: "Produce the bounded fixture change",
        goal: "Replace src/message.txt with exactly ready followed by a newline.",
        base_sha: baseSha,
        context_paths: ["src/message.txt"],
        scope: { allowed_paths: ["src/**"], forbidden_paths: [] },
        acceptance_criteria: [{ id: "AC-01", text: "The registered verification script exits successfully." }],
        test_commands: [{ id: "fixture", program: "node", args: ["verify.mjs"], cwd: ".", timeout_seconds: 20, required: true }],
        execution_policy: {
          planner_recommendation: "cheap",
          planner_confidence: "high",
          recommendation_reasons: ["Frozen DG3-F fixture"],
          user_lock: "cheap"
        },
        limits: { max_attempts: 1, run_timeout_seconds: 180, max_changed_files: 1, max_diff_bytes: 1024 }
      };
      const request = buildWorkerProposalRequest({ taskSpec, managedWorktree: worktree });
      const changeSet = {
        schema_version: "1.0",
        task_id: request.task_id,
        base_sha: request.base_sha,
        task_spec_sha256: request.task_spec_sha256,
        status: "completed",
        summary: "Replace the bounded fixture value.",
        operations: [{
          type: "replace_file",
          path: "src/message.txt",
          expected_sha256: request.context_files[0]!.sha256,
          content: "ready\n"
        }],
        acceptance_notes: [{ criterion_id: "AC-01", note: "Proposed the requested complete file content." }],
        risks: [],
        blocker: null
      };
      writeFileSync(fakeEntry, `process.stdout.write(${JSON.stringify(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: changeSet,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }))});\n`, "utf8");

      const runDirectory = path.join(root, "provider-run");
      const outputPath = path.join(root, "artifacts", "change-set.json");
      const adapter = new CodeBuddyAdapter({
        executableResolver: () => ({ nodePath: process.execPath, entryPath: fakeEntry }),
        proxyResolver: () => ({})
      });
      const beforeProvider = readFileSync(path.join(worktree, "src", "message.txt"), "utf8");
      const execution = await adapter.runProposal({
        request,
        runDirectory,
        model: "glm-5.3",
        reasoning: "low",
        timeoutSeconds: 20,
        schemaPath: path.resolve("schemas/change-set.schema.json"),
        outputPath,
        hashOnlyLogs: true,
        runId: "dg3f-offline-proposal"
      });
      expect(readFileSync(path.join(worktree, "src", "message.txt"), "utf8")).toBe(beforeProvider);
      expect(readFileSync(path.join(checkout, "src", "message.txt"), "utf8")).toBe("before\n");

      const applied = applyChangeSet(execution.output, {
        worktreeRoot: worktree,
        managedWorktreeRoot: managedRoot,
        taskSpec,
        taskSpecSha256: taskSpecCanonicalSha256(taskSpec),
        limits: request.limits
      });
      expect(applied.changed_paths).toEqual(["src/message.txt"]);

      const registeredTest = taskSpec.test_commands[0]!;
      const testResult = await runProcess({
        program: registeredTest.program,
        args: registeredTest.args,
        cwd: path.resolve(worktree, registeredTest.cwd),
        timeoutSeconds: registeredTest.timeout_seconds,
        hashOnlyLogs: true,
        runId: "dg3f-offline-test"
      });
      expect(testResult.status).toBe("SUCCEEDED");
      const evidence = await gitService.collectEvidence(worktree);
      expect(evidence.head).toBe(baseSha);
      expect(evidence.changedFiles).toEqual(["src/message.txt"]);
      expect(evidence.diff).toContain("+ready");
      expect(readFileSync(path.join(checkout, "src", "message.txt"), "utf8")).toBe("before\n");
    } finally {
      if (worktree) {
        try {
          await gitService.cleanupWorktree(checkout, worktree);
        } catch {
          // The disposable root is removed below even if Git cleanup fails.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
