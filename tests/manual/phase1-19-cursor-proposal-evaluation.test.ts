import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GitService } from "../../src/main/git/git-service.js";
import { runDeterministicGate } from "../../src/main/gate/deterministic-gate.js";
import { applyChangeSet } from "../../src/main/proposals/change-set-applier.js";
import { buildWorkerProposalRequest, taskSpecCanonicalSha256 } from "../../src/main/proposals/proposal-context.js";
import { runApprovedTests } from "../../src/main/testing/test-runner.js";
import { parseCursorProposalTrace } from "../../src/shared/core/cursor-proposal-trace.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

const root = path.resolve(import.meta.dirname, "../..");
const runNumber = process.env.PHASE119_PROPOSAL_EVALUATE === "2" ? 2 : 1;
const preparation = path.join(root, `phase1-19-proposal-preparation-run${runNumber}`);
const output = path.join(root, `cursor-wsl-proposal-run${runNumber}`);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

describe("Phase 1.19 real Cursor proposal platform evaluation", () => {
  it.skipIf(!["1", "2"].includes(process.env.PHASE119_PROPOSAL_EVALUATE ?? ""))("validates one real proposal and runs controlled apply, TestRun and Gate", async () => {
    const decisionFile = path.join(output, "decision.json");
    expect(existsSync(decisionFile)).toBe(false);
    const readiness = JSON.parse(readFileSync(path.join(preparation, "readiness.json"), "utf8")) as {
      source: { request_sha256: string; task_spec_sha256: string };
      fixture: { checkout: string; base_sha: string; workspace: string; source_file_sha256: string };
    };
    const taskSpec = JSON.parse(readFileSync(path.join(preparation, "task-spec.json"), "utf8")) as TaskSpec;
    const request = JSON.parse(readFileSync(path.join(preparation, "worker-proposal-request.json"), "utf8")) as ReturnType<typeof buildWorkerProposalRequest>;
    let stage = "preflight";
    try {
      expect(sha(JSON.stringify(request))).toBe(readiness.source.request_sha256);
      expect(taskSpecCanonicalSha256(taskSpec)).toBe(readiness.source.task_spec_sha256);
      expect(git(readiness.fixture.checkout, "rev-parse", "HEAD")).toBe(readiness.fixture.base_sha);
      expect(git(readiness.fixture.checkout, "status", "--porcelain=v1")).toBe("");
      const controller = JSON.parse(readFileSync(path.join(output, "controller.json"), "utf8")) as {
        exit_code: number; process_converged: boolean; output_limit: boolean; outer_timeout: boolean;
        fixture_sha256_before: string; fixture_sha256_after: string; real_calls: number;
      };
      expect(controller.exit_code).toBe(0);
      expect(controller.process_converged).toBe(true);
      expect(controller.output_limit).toBe(false);
      expect(controller.outer_timeout).toBe(false);
      expect(controller.fixture_sha256_before).toBe(controller.fixture_sha256_after);
      expect(controller.real_calls).toBe(1);
      stage = "proposal_validation";
      const stdout = readFileSync(path.join(output, "stdout.ndjson"), "utf8");
      const proposal = parseCursorProposalTrace(stdout, request, readiness.fixture.workspace);
      expect(proposal.changeSet.status).toBe("completed");
      expect(proposal.changeSet.operations.length).toBe(1);
      expect(proposal.changeSet.operations[0]?.path).toBe("src/message.txt");
      stage = "controlled_apply";
      const evaluationCheckout = path.join(output, "fixture-checkout");
      execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--no-hardlinks", readiness.fixture.checkout, evaluationCheckout],
        { cwd: output, windowsHide: true });
      git(evaluationCheckout, "config", "core.autocrlf", "false");
      expect(git(evaluationCheckout, "rev-parse", "HEAD")).toBe(readiness.fixture.base_sha);
      const managed = path.join(output, "managed");
      mkdirSync(managed);
      const service = new GitService("git", managed);
      const created = await service.createWorktree(evaluationCheckout, { taskId: taskSpec.task_id, attempt: 1, baseSha: readiness.fixture.base_sha });
      const worktree = created.worktreePath;
      const rebuilt = buildWorkerProposalRequest({ taskSpec, managedWorktree: worktree });
      expect(sha(JSON.stringify(rebuilt))).toBe(readiness.source.request_sha256);
      const applied = applyChangeSet(proposal.changeSet, { worktreeRoot: worktree, managedWorktreeRoot: managed,
        taskSpec, taskSpecSha256: readiness.source.task_spec_sha256, limits: request.limits });
      stage = "platform_tests";
      const tests = await runApprovedTests(worktree, taskSpec.test_commands, path.join(output, "test-logs"));
      stage = "deterministic_gate";
      const evidence = await service.collectEvidence(worktree);
      const gate = runDeterministicGate({ spec: taskSpec, baseSha: evidence.head, changedFiles: evidence.changedFiles,
        invalidPaths: evidence.invalidPaths, diff: evidence.diff, tests, workerValid: true, artifacts: [] });
      expect(tests[0]?.result.status).toBe("SUCCEEDED");
      expect(gate.passed).toBe(true);
      expect(evidence.changedFiles).toEqual(["src/message.txt"]);
      expect(readFileSync(path.join(readiness.fixture.checkout, "src/message.txt"), "utf8")).toBe("before\n");
      expect(sha(readFileSync(path.join(readiness.fixture.checkout, "src/message.txt")))).toBe(readiness.fixture.source_file_sha256);
      expect(git(readiness.fixture.checkout, "status", "--porcelain=v1")).toBe("");
      const decision = { version: "phase1-19-cursor-proposal-decision.v1", status: "PASS", real_cursor_calls: 1,
        retry: 0, proposal: { status: proposal.changeSet.status, operations: proposal.changeSet.operations.length,
          input_tokens: proposal.inputTokens, output_tokens: proposal.outputTokens, cached_input_tokens: proposal.cachedInputTokens },
        applied, tests: tests.map(test => ({ id: test.id, required: test.required, status: test.result.status, exit_code: test.result.exitCode })),
        gate, git: { base_sha: evidence.head, changed_files: evidence.changedFiles, diff_sha256: sha(evidence.diff) },
        source_checkout_unchanged: true, production_route: "NOT_IMPLEMENTED" };
      writeFileSync(decisionFile, `${JSON.stringify(decision, null, 2)}\n`, { flag: "wx" });
      console.log(JSON.stringify({ status: "PASS", applied_paths: applied.changed_paths, gate: gate.passed }));
    } catch (error) {
      if (!existsSync(decisionFile)) writeFileSync(decisionFile, `${JSON.stringify({
        version: "phase1-19-cursor-proposal-decision.v1", status: "FAIL", stage, real_cursor_calls: 1, retry: 0,
        failure: error instanceof Error ? error.message.slice(0, 1000) : "unknown"
      }, null, 2)}\n`, { flag: "wx" });
      throw error;
    }
  }, 240_000);
});
