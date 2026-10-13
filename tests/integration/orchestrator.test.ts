import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { GitService } from "../../src/main/git/git-service.js";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import type { ProcessResult } from "../../src/main/process/runner.js";
import { CheapWorkerAdapter } from "../../src/main/adapters/cheap-worker/cheap-worker-adapter.js";
import { AgentRunError, type AgentExecution, type ReviewerInput, type WorkerInput } from "../../src/main/adapters/agent-adapter.js";
import type { CursorProposalInput } from "../../src/main/adapters/cursor/cursor-proposal-adapter.js";
import type { ChangeSet } from "../../src/shared/core/worker-proposal.js";
import type { FinalGateResult } from "../../src/shared/core/final-gate.js";
import type { WorkerResult } from "../../src/shared/core/worker-result.js";
import { WorkerRouter, type WorkerProfiles } from "../../src/main/router/worker-router.js";
import { TaskOrchestrator } from "../../src/main/orchestrator/task-orchestrator.js";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Scenario = {
  recommendation: "cheap" | "strong";
  userLock: "cheap" | "strong" | null;
  maxAttempts: number;
  cheapOutcomes: Array<"completed" | "failed" | "blocked">;
  strongOutcomes: Array<"completed" | "failed" | "blocked">;
  scopeViolation?: boolean;
  noOp?: boolean;
  emptyNoOp?: boolean;
  testFailure?: boolean;
  runtimeFailure?: "timeout" | "transport";
  commitWorktree?: boolean;
  architectMutation?: "tracked" | "untracked" | "commit" | "branch";
  architectFailure?: boolean;
  reviewerMutation?: "tracked" | "untracked" | "commit" | "branch";
  reviewerFailure?: boolean;
};

type Harness = {
  root: string;
  repo: string;
  baseHead: string;
  database: AppDatabase;
  orchestrator: TaskOrchestrator;
  cheap: CountingCheapWorkerAdapter;
  reviewer: CountingReviewerAdapter;
  codex: CountingCodexAdapter;
  cursor: FakeCursorProposalAdapter;
  taskId: string;
  sourceStatus: () => string;
  close: () => void;
};

const fakeCodexSource = String.raw`
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const statePath = args[args.indexOf('--state') + 1];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const outputPath = args[args.indexOf('--output-last-message') + 1];
const schemaFile = args[args.indexOf('--output-schema') + 1];
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
const cwd = args[args.indexOf('-C') + 1];
const model = args[args.indexOf('-m') + 1];
const prompt = args[args.length - 1];
const taskMatch = prompt.match(/TASK-[A-Z0-9_-]+/);
const taskId = taskMatch ? taskMatch[0] : state.taskId;
const shaMatch = prompt.match(/[0-9a-f]{40}/);
const baseSha = shaMatch ? shaMatch[0] : state.baseHead;
const write = (value) => fs.writeFileSync(outputPath, JSON.stringify(value));
const mutateReadOnly = (mutation, role) => {
  if (!mutation) return;
  if (mutation === 'tracked') fs.writeFileSync(path.join(cwd, 'src', 'fixture.js'), role + ' changed\n');
  if (mutation === 'untracked') fs.writeFileSync(path.join(cwd, role + '-untracked.txt'), role + ' untracked\n');
  if (mutation === 'commit') {
    fs.writeFileSync(path.join(cwd, 'src', role + '-committed.txt'), role + ' committed\n');
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=AgentPlatform Test', 'commit', '-m', role + ' commit'], { cwd });
  }
  if (mutation === 'branch') execFileSync('git', ['checkout', '-b', role + '-observed-branch'], { cwd });
};
state.calls = state.calls || { cheap: 0, strong: 0, reviewer: 0, planner: 0 };
if (schema.properties && schema.properties.execution_policy) {
  state.calls.planner += 1;
  write({ schema_version: '2.0', task_id: taskId, title: 'Fixture', goal: 'Run orchestration fixture', base_sha: baseSha,
    context_paths: [],
    scope: { allowed_paths: ['src/**'], forbidden_paths: [] },
    acceptance_criteria: [{ id: 'AC-01', text: 'fixture output exists' }],
    test_commands: [{ id: 'unit', program: 'node', args: ['-e', 'process.exit(' + (state.testFailure ? 1 : 0) + ')'], cwd: 'src', timeout_seconds: 60, required: true }],
    execution_policy: { planner_recommendation: state.recommendation, planner_confidence: 'high', recommendation_reasons: ['fixture'], user_lock: state.userLock },
    limits: { max_attempts: state.maxAttempts, run_timeout_seconds: 60, max_changed_files: 10, max_diff_bytes: 100000 } });
  mutateReadOnly(state.architectMutation, 'architect');
  if (state.architectFailure) { process.stderr.write('architect fixture failure'); process.exit(1); }
} else if (schema.properties && schema.properties.status) {
  const workerClass = model === 'cheap-model' ? 'cheap' : 'strong';
  state.calls[workerClass] += 1;
  const count = state.calls[workerClass];
  const outcomes = workerClass === 'cheap' ? state.cheapOutcomes : state.strongOutcomes;
  const status = outcomes[count - 1] || 'completed';
  let changedFiles = [];
  if (status === 'completed' && !state.noOp && !state.emptyNoOp) {
    const file = state.scopeViolation ? path.join(cwd, 'outside.txt') : path.join(cwd, 'src', 'result-' + workerClass + '-' + count + '.txt');
    fs.writeFileSync(file, 'fixture\n');
    changedFiles = [state.scopeViolation ? 'outside.txt' : 'src/result-' + workerClass + '-' + count + '.txt'];
  }
  if (status === 'completed' && state.noOp && !state.emptyNoOp) changedFiles = ['src/result-claimed.txt'];
  if (status === 'completed' && state.commitWorktree) {
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=AgentPlatform Test', 'commit', '-m', 'worker commit'], { cwd });
    fs.writeFileSync(path.join(cwd, 'src', 'uncommitted.txt'), 'still changed\n');
    changedFiles = ['src/uncommitted.txt'];
  }
  write({ schema_version: '1.0', task_id: taskId, status, summary: status, changed_files: changedFiles,
    acceptance_notes: status === 'blocked' ? [] : [{ criterion_id: 'AC-01', note: status === 'completed' ? 'created' : 'retry required' }],
    risks: [], blocker: status === 'blocked' ? 'fixture blocker' : null });
} else {
  state.calls.reviewer += 1;
  mutateReadOnly(state.reviewerMutation, 'reviewer');
  if (state.reviewerFailure) { process.stderr.write('reviewer fixture failure'); process.exit(1); }
  write({ schema_version: '1.0', task_id: taskId, verdict: 'PASS', summary: 'fixture review',
    criteria: [{ criterion_id: 'AC-01', status: 'satisfied', evidence: 'deterministic evidence' }], findings: [],
    test_assessment: 'passed', scope_assessment: 'passed', rework_instructions: [] });
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

class CountingCheapWorkerAdapter extends CheapWorkerAdapter {
  calls = 0;

  override async runWorker(input: WorkerInput): Promise<AgentExecution<WorkerResult>> {
    this.calls += 1;
    return super.runWorker(input);
  }
}

class RuntimeFailCheapWorkerAdapter extends CheapWorkerAdapter {
  readonly kind: "timeout" | "transport";
  calls = 0;
  constructor(kind: "timeout" | "transport", program: string, prefixArgs: string[]) { super(program, prefixArgs); this.kind = kind; }
  override async runWorker(_input: WorkerInput): Promise<AgentExecution<WorkerResult>> {
    this.calls += 1;
    const result: ProcessResult = { exitCode: this.kind === "timeout" ? null : 1, status: this.kind === "timeout" ? "TIMED_OUT" : "FAILED", stdout: this.kind === "timeout" ? '{"status":"ok"}' : "", stderr: this.kind === "transport" ? "websocket transport failed" : "", stdoutSha256: "", stderrSha256: "", durationMs: 12, pid: null };
    throw new AgentRunError("second worker runtime failure", result, {
      code: this.kind === "timeout" ? "PROCESS_TIMEOUT" : "TRANSPORT_FAILURE",
      domain: "runtime",
      retryable: true,
      failFast: true,
      diagnosticSummary: "fixture runtime failure"
    });
  }
}

class CountingCodexAdapter extends CodexAdapter {
  builderCalls = 0;
  plannerPrompts: string[] = [];

  override async runPlanner(input: Parameters<CodexAdapter["runPlanner"]>[0]): ReturnType<CodexAdapter["runPlanner"]> {
    this.plannerPrompts.push(input.prompt);
    return super.runPlanner(input);
  }

  override async runWorker(input: WorkerInput): Promise<AgentExecution<WorkerResult>> {
    this.builderCalls += 1;
    return super.runWorker(input);
  }
}

class CountingReviewerAdapter extends CodexAdapter {
  calls = 0;
  prompts: string[] = [];

  override async runReviewer(input: ReviewerInput): Promise<AgentExecution<FinalGateResult>> {
    this.calls += 1;
    this.prompts.push(input.prompt);
    return super.runReviewer(input);
  }
}

class FakeCursorProposalAdapter {
  readonly id = "cursor-proposal";
  calls = 0;
  status: ChangeSet["status"] = "completed";
  async runProposal(input: CursorProposalInput): Promise<AgentExecution<ChangeSet>> {
    this.calls += 1;
    const output: ChangeSet = { schema_version: "1.0", task_id: input.request.task_id,
      base_sha: input.request.base_sha, task_spec_sha256: input.request.task_spec_sha256,
      status: this.status, summary: "Fake Cursor proposal",
      operations: this.status === "completed" ? [{ type: "create_file", path: "src/cursor.txt", expected_sha256: null, content: "cursor\n" }] : [],
      acceptance_notes: [{ criterion_id: "AC-01", note: "Fixture proposal" }], risks: [],
      blocker: this.status === "blocked" ? "Cannot complete fixture" : null };
    writeFileSync(input.outputPath, JSON.stringify(output));
    writeFileSync(path.join(input.runDirectory, "stdout.log"), "fake cursor trace");
    writeFileSync(path.join(input.runDirectory, "stderr.log"), "");
    return { output, process: { status: "SUCCEEDED", exitCode: 0, stdout: "", stderr: "", stdoutSha256: "", stderrSha256: "", durationMs: 1 }, usage: null };
  }
}

const makeHarness = (scenario: Scenario): Harness => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-orchestrator-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "AgentPlatform Test");
  writeFileSync(path.join(repo, "src", "fixture.js"), "fixture\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const baseHead = git(repo, "rev-parse", "HEAD");
  const fake = path.join(root, "fake-codex.cjs");
  const statePath = path.join(root, "state.json");
  const taskId = "TASK-ORCH01";
  writeFileSync(fake, fakeCodexSource);
  writeFileSync(statePath, JSON.stringify({ taskId, baseHead, ...scenario, calls: { cheap: 0, strong: 0, reviewer: 0, planner: 0 } }));
  const database = new AppDatabase(path.join(root, "app.db"));
  database.createProject({ id: "P1", name: "fixture", repoPath: repo, repoRealPath: repo, lastSeenHead: baseHead });
  database.createTask({ id: taskId, projectId: "P1", title: "Fixture", requestText: "Run fixture", status: "DRAFT", baseSha: baseHead });
  const prefixArgs = [fake, "--state", statePath];
  const codex = new CountingCodexAdapter(process.execPath, prefixArgs);
  const cheap = scenario.runtimeFailure ? new RuntimeFailCheapWorkerAdapter(scenario.runtimeFailure, process.execPath, prefixArgs) : new CountingCheapWorkerAdapter(process.execPath, prefixArgs);
  const reviewer = new CountingReviewerAdapter(process.execPath, prefixArgs);
  const cursor = new FakeCursorProposalAdapter();
  const profiles: WorkerProfiles = {
    cheap: { adapterId: "cheap-worker", model: "cheap-model", reasoning: "low", highTier: false },
    strong: { adapterId: "codex", model: "strong-model", reasoning: "medium", highTier: true }
  };
  const orchestrator = new TaskOrchestrator(database, new GitService("git", path.join(root, "managed")), codex, reviewer, [codex, cheap], new WorkerRouter(profiles), profiles, path.join(root, "artifacts"), path.resolve("schemas"), cursor);
  return { root, repo, baseHead, database, orchestrator, cheap: cheap as CountingCheapWorkerAdapter, reviewer, codex, cursor, taskId, sourceStatus: () => git(repo, "status", "--porcelain=v1"), close: () => database.close() };
};

const prepare = async (harness: Harness): Promise<void> => {
  await harness.orchestrator.startDesign(harness.taskId);
  harness.orchestrator.approveSpec(harness.taskId);
};

const finish = async (harness: Harness): Promise<void> => {
  await harness.orchestrator.startTests(harness.taskId);
  await harness.orchestrator.startFinalGate(harness.taskId);
};

const readHashedJsonArtifact = <T>(harness: Harness, runId: string, kind: string): T => {
  const artifact = harness.database.listArtifacts(runId).find((item) => item.kind === kind);
  if (!artifact) throw new Error(`Missing ${kind} artifact for ${runId}`);
  const content = readFileSync(artifact.path);
  expect(createHash("sha256").update(content).digest("hex")).toBe(artifact.sha256);
  expect(content.byteLength).toBe(artifact.sizeBytes);
  return JSON.parse(content.toString("utf8")) as T;
};

describe("TaskOrchestrator multi-model execution", () => {
  it("uses Cursor only when explicitly selected, persists its identity and gates platform-applied changes", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 1, cheapOutcomes: [], strongOutcomes: [] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId, "cursor");
      const built = harness.orchestrator.detail(harness.taskId);
      expect(built.task.status).toBe("BUILT");
      expect(harness.cursor.calls).toBe(1);
      expect(harness.codex.builderCalls).toBe(0);
      expect(harness.cheap.calls).toBe(0);
      expect(built.runs.find(run => run.stage === "builder")?.adapter).toBe("cursor-proposal");
      expect(built.events.some(event => event.type === "ROUTE_DECIDED" && event.payloadJson.includes("cursor-proposal"))).toBe(true);
      expect(built.snapshot?.routeDecision?.adapterId).toBe("cursor-proposal");
      expect(readFileSync(path.join(built.attempt!.worktreePath, "src/cursor.txt"), "utf8")).toBe("cursor\n");
      expect(harness.sourceStatus()).toBe("");
      await harness.orchestrator.startTests(harness.taskId);
      expect(harness.orchestrator.detail(harness.taskId).snapshot?.gate?.passed).toBe(true);
    } finally { harness.close(); }
  });

  it("blocks a failed explicit Cursor proposal without switching providers", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 2, cheapOutcomes: [], strongOutcomes: [] });
    try {
      await prepare(harness);
      harness.cursor.status = "blocked";
      await harness.orchestrator.startBuild(harness.taskId, "cursor");
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("BLOCKED");
      expect(harness.cursor.calls).toBe(1);
      expect(harness.codex.builderCalls).toBe(0);
      expect(harness.cheap.calls).toBe(0);
      expect(harness.sourceStatus()).toBe("");
    } finally { harness.close(); }
  });

  it("rejects dirty or drifted source before starting Architect", async () => {
    const dirty = makeHarness({ recommendation: "strong", userLock: null, maxAttempts: 2, cheapOutcomes: [], strongOutcomes: [] });
    try {
      writeFileSync(path.join(dirty.repo, "src", "fixture.js"), "changed\n");
      await expect(dirty.orchestrator.startDesign(dirty.taskId)).rejects.toThrow("REPOSITORY_DIRTY");
      expect(dirty.codex.plannerPrompts).toHaveLength(0);
      expect(dirty.orchestrator.detail(dirty.taskId).task.status).toBe("DRAFT");
    } finally { dirty.close(); }

    const drifted = makeHarness({ recommendation: "strong", userLock: null, maxAttempts: 2, cheapOutcomes: [], strongOutcomes: [] });
    try {
      writeFileSync(path.join(drifted.repo, "src", "fixture.js"), "new committed base\n");
      git(drifted.repo, "add", ".");
      git(drifted.repo, "commit", "-m", "drift");
      await expect(drifted.orchestrator.startDesign(drifted.taskId)).rejects.toThrow("BASE_SHA_CHANGED");
      expect(drifted.codex.plannerPrompts).toHaveLength(0);
      expect(drifted.orchestrator.detail(drifted.taskId).task.status).toBe("DRAFT");
    } finally { drifted.close(); }
  }, 30000);

  it("baseline lock strong uses only the Codex strong builder", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: ["completed"], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await finish(harness);
      const detail = harness.orchestrator.detail(harness.taskId);
      const builder = harness.database.listRuns(detail.attempt!.id).find((run) => run.stage === "builder");
      expect(detail.task.status).toBe("PASSED");
      expect(builder).toMatchObject({ adapter: "codex", workerClass: "strong", isHighTier: true, isEscalation: false });
      expect(harness.cheap.calls).toBe(0);
      expect(harness.codex.builderCalls).toBe(1);
      expect(harness.reviewer.prompts[0]).toContain('"attempt"');
      expect(harness.reviewer.prompts[0]).toContain('"changed_files"');
      expect(harness.reviewer.prompts[0]).toContain('"deterministic_gate"');
      expect(harness.reviewer.prompts[0]).toContain('evidence-manifest.json');
      expect(harness.reviewer.prompts[0]).toContain('Deterministic gate results are authoritative');
      expect(harness.sourceStatus()).toBe("");
      expect(git(harness.repo, "rev-parse", "HEAD")).toBe(harness.baseHead);
    } finally { harness.close(); }
  }, 30000);

  it("gives the architect an explicit immutable identity and scope contract", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: null, maxAttempts: 2, cheapOutcomes: [], strongOutcomes: [] });
    try {
      await harness.orchestrator.startDesign(harness.taskId);
      const prompt = harness.codex.plannerPrompts[0];
      expect(prompt).toContain(`task_id MUST be exactly: ${harness.taskId}`);
      expect(prompt).toContain(`base_sha MUST be exactly: ${harness.baseHead}`);
      expect(prompt).toContain("context_paths are read-only");
      expect(prompt).toContain("choose safe repository-relative context paths");
      expect(prompt).toContain("choose at least one minimal safe repository-relative write scope");
      expect(prompt).toContain("structured platform-owned declarations");
      expect(prompt).not.toContain("use only these paths: []");
    } finally { harness.close(); }
  }, 30000);

  it.each([
    ["tracked", false],
    ["untracked", true],
    ["commit", false]
  ] as const)("rejects Architect %s repository mutation after %s adapter completion", async (mutation, failed) => {
    const harness = makeHarness({ recommendation: "strong", userLock: null, maxAttempts: 2, cheapOutcomes: [], strongOutcomes: [], architectMutation: mutation, architectFailure: failed });
    try {
      await expect(harness.orchestrator.startDesign(harness.taskId)).rejects.toThrow("SCOPE_VIOLATION");
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("SPEC_INVALID");
      expect(detail.task.specJson).toBeNull();
      expect(detail.task.specApprovedAt).toBeNull();
      if (mutation === "commit") expect(git(harness.repo, "rev-parse", "HEAD")).not.toBe(harness.baseHead);
      else expect(harness.sourceStatus()).not.toBe("");
      const architect = detail.runs.find((run) => run.stage === "architect");
      expect(architect).toBeDefined();
      expect(architect).toMatchObject({ status: "FAILED", errorCode: "SCOPE_VIOLATION" });
      const audit = readHashedJsonArtifact<{ role: string; runId: string; unchanged: boolean; before: Record<string, string>; after: Record<string, string> }>(harness, architect!.id, "read-only-audit");
      expect(audit).toMatchObject({ role: "architect", runId: architect!.id, unchanged: false });
      expect(audit.before).not.toEqual(audit.after);
    } finally { harness.close(); }
  }, 30000);

  it("rejects a failed Reviewer that writes to its read-only worktree", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"], reviewerMutation: "tracked", reviewerFailure: true });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("SCOPE_VIOLATION");
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("BLOCKED");
      expect(harness.reviewer.calls).toBe(1);
      const reviewer = detail.runs.find((run) => run.stage === "reviewer");
      expect(reviewer).toMatchObject({ status: "FAILED", errorCode: "SCOPE_VIOLATION" });
      const audit = readHashedJsonArtifact<{ role: string; runId: string; unchanged: boolean; before: Record<string, string>; after: Record<string, string> }>(harness, reviewer!.id, "read-only-audit");
      expect(audit).toMatchObject({ role: "reviewer", runId: reviewer!.id, unchanged: false });
      expect(audit.before).not.toEqual(audit.after);
      expect(git(detail.attempt!.worktreePath, "status", "--porcelain=v1")).not.toBe("");
    } finally { harness.close(); }
  }, 30000);

  it("rejects a successful Reviewer when it changes the worktree branch", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"], reviewerMutation: "branch" });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("SCOPE_VIOLATION");
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("BLOCKED");
      expect(harness.reviewer.calls).toBe(1);
      const reviewer = detail.runs.find((run) => run.stage === "reviewer");
      expect(reviewer).toMatchObject({ status: "FAILED", errorCode: "SCOPE_VIOLATION" });
      const audit = readHashedJsonArtifact<{ role: string; runId: string; unchanged: boolean; before: { branch: string }; after: { branch: string } }>(harness, reviewer!.id, "read-only-audit");
      expect(audit).toMatchObject({ role: "reviewer", runId: reviewer!.id, unchanged: false });
      expect(audit.before.branch).not.toBe(audit.after.branch);
      expect(git(detail.attempt!.worktreePath, "branch", "--show-current")).not.toBe(detail.attempt!.branch);
    } finally { harness.close(); }
  }, 30000);

  it("records hashed read-only input and audit artifacts with identities separate from Worker", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await finish(harness);
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("PASSED");
      const architect = detail.runs.find((run) => run.stage === "architect");
      const attempt = detail.attempt!;
      const builder = detail.runs.find((run) => run.stage === "builder");
      const reviewer = detail.runs.find((run) => run.stage === "reviewer");
      expect(architect).toBeDefined();
      expect(builder).toBeDefined();
      expect(reviewer).toBeDefined();

      const architectInput = readHashedJsonArtifact<{ role: string; runId: string; taskId: string; attemptId: string | null; baseSha: string; prompt: string; workerRunIds: string[] }>(harness, architect!.id, "read-only-input");
      expect(architectInput).toMatchObject({ role: "architect", runId: architect!.id, taskId: harness.taskId, attemptId: null, baseSha: harness.baseHead, workerRunIds: [] });
      expect(architectInput.prompt).toContain(`task_id MUST be exactly: ${harness.taskId}`);
      const architectAudit = readHashedJsonArtifact<{ role: string; runId: string; unchanged: boolean; before: { head: string; branch: string; gitHash: string }; after: { head: string; branch: string; gitHash: string } }>(harness, architect!.id, "read-only-audit");
      expect(architectAudit).toMatchObject({ role: "architect", runId: architect!.id, unchanged: true });
      expect(architectAudit.before).toEqual(architectAudit.after);
      expect(architectAudit.before).toMatchObject({ head: harness.baseHead, branch: expect.any(String), gitHash: expect.any(String) });

      const reviewerInput = readHashedJsonArtifact<{ role: string; runId: string; taskId: string; attemptId: string; baseSha: string; prompt: string; workerRunIds: string[] }>(harness, reviewer!.id, "read-only-input");
      expect(reviewerInput).toMatchObject({ role: "reviewer", runId: reviewer!.id, taskId: harness.taskId, attemptId: attempt.id, baseSha: harness.baseHead, workerRunIds: [builder!.id] });
      expect(reviewerInput.prompt).toContain("Worker claims are untrusted");
      const reviewerAudit = readHashedJsonArtifact<{ role: string; runId: string; unchanged: boolean; before: { head: string; branch: string; gitHash: string }; after: { head: string; branch: string; gitHash: string } }>(harness, reviewer!.id, "read-only-audit");
      expect(reviewerAudit).toMatchObject({ role: "reviewer", runId: reviewer!.id, unchanged: true });
      expect(reviewerAudit.before).toEqual(reviewerAudit.after);

      expect(architect!.id).not.toBe(builder!.id);
      expect(reviewer!.id).not.toBe(builder!.id);
      expect(harness.database.listArtifacts(builder!.id).some((artifact) => artifact.kind === "read-only-input" || artifact.kind === "read-only-audit")).toBe(false);
    } finally { harness.close(); }
  }, 30000);

  it("does not approve a persisted schema-valid spec with drifted identity", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: null, maxAttempts: 2, cheapOutcomes: [], strongOutcomes: [] });
    try {
      await harness.orchestrator.startDesign(harness.taskId);
      const task = harness.database.getTask(harness.taskId)!;
      const drifted = JSON.parse(task.specJson!);
      drifted.task_id = "TASK-DRIFTED";
      harness.database.saveSpec(harness.taskId, JSON.stringify(drifted));
      expect(() => harness.orchestrator.approveSpec(harness.taskId)).toThrow("OUTPUT_SCHEMA_INVALID: identity mismatch");
      expect(harness.database.getTask(harness.taskId)!.specApprovedAt).toBeNull();
    } finally { harness.close(); }
  }, 30000);

  it("planner cheap recommendation uses the cheap-worker adapter", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 2, cheapOutcomes: ["completed"], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      const attempt = harness.database.getLatestAttempt(harness.taskId)!;
      const builder = harness.database.listRuns(attempt.id).find((run) => run.stage === "builder");
      expect(builder).toMatchObject({ adapter: "cheap-worker", workerClass: "cheap", isHighTier: false, isEscalation: false });
      expect(harness.cheap.calls).toBe(1);
      expect(harness.codex.builderCalls).toBe(0);
      await finish(harness);
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("PASSED");
      expect(harness.sourceStatus()).toBe("");
    } finally { harness.close(); }
  }, 30000);

  it("retries a failed cheap worker with a second cheap attempt", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 3, cheapOutcomes: ["failed", "completed"], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("REWORK");
      await harness.orchestrator.startBuild(harness.taskId);
      const attempt = harness.database.getLatestAttempt(harness.taskId)!;
      expect(attempt.number).toBe(2);
      expect(harness.database.listRuns(attempt.id).find((run) => run.stage === "builder")).toMatchObject({ adapter: "cheap-worker", workerClass: "cheap", isHighTier: false, isEscalation: false });
      expect(harness.cheap.calls).toBe(2);
      expect(harness.database.taskRunMetrics(harness.taskId).strongRuns).toBe(0);
      await finish(harness);
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("PASSED");
      expect(harness.sourceStatus()).toBe("");
    } finally { harness.close(); }
  }, 30000);

  it("requires approval after the cheap retry and binds approval to attempt three", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 3, cheapOutcomes: ["failed", "failed"], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startBuild(harness.taskId);
      const attemptsBefore = Number((harness.database.db.prepare("SELECT COUNT(*) n FROM attempts WHERE task_id=?").get(harness.taskId) as { n: number }).n);
      const runsBefore = Number((harness.database.db.prepare("SELECT COUNT(*) n FROM runs").get() as { n: number }).n);
      await expect(harness.orchestrator.startBuild(harness.taskId)).rejects.toThrow("ESCALATION_APPROVAL_REQUIRED");
      expect(Number((harness.database.db.prepare("SELECT COUNT(*) n FROM attempts WHERE task_id=?").get(harness.taskId) as { n: number }).n)).toBe(attemptsBefore);
      expect(Number((harness.database.db.prepare("SELECT COUNT(*) n FROM runs").get() as { n: number }).n)).toBe(runsBefore);
      await harness.orchestrator.approveEscalation(harness.taskId);
      const approval = harness.database.listEvents(harness.taskId).find((event) => event.type === "ESCALATION_APPROVED");
      expect(approval ? JSON.parse(approval.payloadJson) : null).toMatchObject({ approved: true, attempt: 3 });
      await harness.orchestrator.startBuild(harness.taskId);
      const attempt = harness.database.getLatestAttempt(harness.taskId)!;
      expect(attempt.number).toBe(3);
      expect(harness.database.listRuns(attempt.id).find((run) => run.stage === "builder")).toMatchObject({ adapter: "codex", workerClass: "strong", isHighTier: true, isEscalation: true });
      await finish(harness);
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("PASSED");
      expect(harness.sourceStatus()).toBe("");
    } finally { harness.close(); }
  }, 30000);

  it("blocks on a deterministic scope gate without invoking the reviewer", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 2, cheapOutcomes: ["completed"], strongOutcomes: ["completed"], scopeViolation: true });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("BLOCKED");
      expect(detail.snapshot?.gate?.failures.some((failure) => failure.startsWith("SCOPE_VIOLATION"))).toBe(true);
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("Deterministic gate did not pass");
      expect(harness.reviewer.calls).toBe(0);
      expect(harness.sourceStatus()).toBe("");
    } finally { harness.close(); }
  }, 30000);

  it("blocks when the worker changes the worktree HEAD", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"], commitWorktree: true });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("BLOCKED");
      expect(detail.snapshot?.gate?.failures).toContain("BASE_SHA_CHANGED");
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("Deterministic gate did not pass");
      expect(harness.reviewer.calls).toBe(0);
      expect(git(harness.repo, "rev-parse", "HEAD")).toBe(harness.baseHead);
    } finally { harness.close(); }
  }, 30000);

  it("does not start the reviewer if the gated worktree changes", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const attempt = harness.database.getLatestAttempt(harness.taskId)!;
      writeFileSync(path.join(attempt.worktreePath, "src", "late.txt"), "late change\n");
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("EVIDENCE_CORRUPT");
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("BLOCKED");
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it("does not start the reviewer if an evidence artifact changes", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      const manifest = detail.snapshot!.artifacts.find((artifact) => artifact.kind === "manifest")!;
      writeFileSync(path.join(harness.root, "artifacts", "attempts", detail.attempt!.id, manifest.path), "tampered\n");
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("EVIDENCE_CORRUPT");
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("BLOCKED");
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it("blocks a manifest with a forged TestRun even if its snapshot hash is updated", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      const root = path.join(harness.root, "artifacts", "attempts", detail.attempt!.id);
      const file = path.join(root, "evidence-manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      expect(manifest.task_spec).toMatchObject({ revision: 1, sha256: createHash("sha256").update(detail.task.specJson!).digest("hex") });
      expect(manifest.test_runs[0].run_id).toBe(detail.snapshot!.tests![0].runId);
      expect(manifest.artifacts.some((item: { kind: string }) => item.kind === manifest.test_runs[0].stdout)).toBe(true);
      manifest.test_runs[0].run_id = "forged-run";
      const changed = JSON.stringify(manifest, null, 2);
      writeFileSync(file, changed);
      const snapshotFile = path.join(root, "snapshot.json");
      const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
      const recorded = snapshot.artifacts.find((item: { kind: string }) => item.kind === "manifest");
      recorded.sha256 = createHash("sha256").update(changed).digest("hex");
      recorded.sizeBytes = Buffer.byteLength(changed);
      writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("EVIDENCE_CORRUPT");
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it.each([
    ["TaskSpec hash", (manifest: Record<string, any>) => { delete manifest.task_spec.sha256; }],
    ["Git stat reference", (manifest: Record<string, any>) => { manifest.git.stat = "worker-result"; }],
    ["TestRun list", (manifest: Record<string, any>) => { manifest.test_runs = []; }],
    ["artifact reference", (manifest: Record<string, any>) => { manifest.artifacts = manifest.artifacts.filter((item: { kind: string }) => item.kind !== "diff"); }]
  ])("blocks a missing or altered %s manifest field before Reviewer", async (_name, mutate) => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const attempt = harness.database.getLatestAttempt(harness.taskId)!;
      const root = path.join(harness.root, "artifacts", "attempts", attempt.id);
      const file = path.join(root, "evidence-manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      mutate(manifest);
      const changed = JSON.stringify(manifest, null, 2);
      writeFileSync(file, changed);
      const snapshotFile = path.join(root, "snapshot.json");
      const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
      const recorded = snapshot.artifacts.find((item: { kind: string }) => item.kind === "manifest");
      recorded.sha256 = createHash("sha256").update(changed).digest("hex");
      recorded.sizeBytes = Buffer.byteLength(changed);
      writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("EVIDENCE_CORRUPT");
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it("blocks a modified raw TestRun log before the reviewer", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"] });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      writeFileSync(path.join(harness.root, "artifacts", "attempts", detail.attempt!.id, "tests", "unit", "stdout.log"), "tampered");
      await expect(harness.orchestrator.startFinalGate(harness.taskId)).rejects.toThrow("EVIDENCE_CORRUPT");
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it("blocks when an approved test changes the worktree after Worker evidence", async () => {
    const harness = makeHarness({ recommendation: "strong", userLock: "strong", maxAttempts: 2, cheapOutcomes: [], strongOutcomes: ["completed"] });
    try {
      await harness.orchestrator.startDesign(harness.taskId);
      const spec = JSON.parse(harness.database.getTask(harness.taskId)!.specJson!);
      spec.test_commands[0].args = ["-e", "require('fs').writeFileSync('late-test.txt','x')"];
      harness.database.saveSpec(harness.taskId, JSON.stringify(spec));
      harness.orchestrator.approveSpec(harness.taskId);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("BLOCKED");
      expect(detail.snapshot?.gate?.failures).toContain("EVIDENCE_CORRUPT");
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it("routes a false completed noop through retry and escalation evidence", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 3, cheapOutcomes: ["completed", "completed"], strongOutcomes: ["completed"], noOp: true });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("REWORK");
      await harness.orchestrator.startBuild(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("REWORK");
      expect(detail.events.some((event) => event.type === "WORKER_EVIDENCE_DIAGNOSTICS")).toBe(true);
      expect(detail.snapshot?.diagnostics).toContain("WORKER_NOOP");
      expect(detail.snapshot?.artifacts.some((artifact) => artifact.kind === "worker-diagnostics")).toBe(true);
      await expect(harness.orchestrator.startBuild(harness.taskId)).rejects.toThrow("ESCALATION_APPROVAL_REQUIRED");
      await harness.orchestrator.approveEscalation(harness.taskId);
      const approval = harness.database.listEvents(harness.taskId).find((event) => event.type === "ESCALATION_APPROVED");
      expect(approval ? JSON.parse(approval.payloadJson) : null).toMatchObject({ approved: true, attempt: 3 });
      await harness.orchestrator.startBuild(harness.taskId);
      const third = harness.orchestrator.detail(harness.taskId);
      expect(third.attempt?.number).toBe(3);
      expect(third.events.some((event) => event.type === "ROUTE_DECIDED" && JSON.parse(event.payloadJson).reasonCodes.includes("NOOP_ESCALATION"))).toBe(true);
      expect(harness.database.listRuns(third.attempt!.id).find((run) => run.stage === "builder")).toMatchObject({ workerClass: "strong", isEscalation: true });
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it("turns an empty completed worker into noop rework only after required test failure", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 2, cheapOutcomes: ["completed"], strongOutcomes: [], emptyNoOp: true, testFailure: true });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      const detail = harness.orchestrator.detail(harness.taskId);
      expect(detail.task.status).toBe("REWORK");
      expect(detail.snapshot?.diagnostics).toContain("WORKER_NOOP");
      expect(detail.snapshot?.artifacts.filter((artifact) => artifact.kind === "worker-diagnostics")).toHaveLength(1);
      expect(detail.events.filter((event) => event.type === "WORKER_EVIDENCE_DIAGNOSTICS")).toHaveLength(1);
      expect(harness.reviewer.calls).toBe(0);
    } finally { harness.close(); }
  }, 30000);

  it("allows an empty completed worker when required tests pass", async () => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 2, cheapOutcomes: ["completed"], strongOutcomes: [], emptyNoOp: true, testFailure: false });
    try {
      await prepare(harness);
      await harness.orchestrator.startBuild(harness.taskId);
      await harness.orchestrator.startTests(harness.taskId);
      expect(harness.orchestrator.detail(harness.taskId).task.status).toBe("GATE_READY");
      expect(harness.orchestrator.detail(harness.taskId).snapshot?.diagnostics ?? []).toEqual([]);
    } finally { harness.close(); }
  }, 30000);

  it.each([
    ["timeout", "PROCESS_TIMEOUT"],
    ["transport", "TRANSPORT_FAILURE"]
  ] as const)("fails fast on cheap runtime %s without retry or escalation", async (runtimeFailure, errorCode) => {
    const harness = makeHarness({ recommendation: "cheap", userLock: null, maxAttempts: 3, cheapOutcomes: [], strongOutcomes: [], runtimeFailure });
    try {
      await prepare(harness);
      await expect(harness.orchestrator.startBuild(harness.taskId)).rejects.toThrow();
      const detail = harness.orchestrator.detail(harness.taskId);
      const attempt = detail.attempt!;
      const run = harness.database.listRuns(attempt.id).find((item) => item.stage === "builder")!;
      expect(detail.task.status).toBe("BLOCKED");
      expect(attempt.status).toBe("BLOCKED");
      expect(run).toMatchObject({ errorCode, failureDomain: "runtime" });
      expect(detail.events.some((event) => event.type === "RUN_CLASSIFIED" && JSON.parse(event.payloadJson).code === errorCode)).toBe(true);
      const runsBefore = detail.runs.length;
      await expect(harness.orchestrator.startBuild(harness.taskId)).rejects.toThrow();
      expect(harness.orchestrator.detail(harness.taskId).runs.length).toBe(runsBefore);
      expect(harness.codex.builderCalls).toBe(0);
      expect(harness.cheap.calls).toBe(1);
    } finally { harness.close(); }
  }, 30000);
});
