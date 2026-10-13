import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateTaskSpec, type ReasoningLevel, type TaskSpec } from "../../shared/core/task-spec.js";
import type { WorkerResult } from "../../shared/core/worker-result.js";
import type { FinalGateResult } from "../../shared/core/final-gate.js";
import { AppDatabase, ensureArtifactLayout } from "../db/database.js";
import { GitService } from "../git/git-service.js";
import { AgentOutputError, AgentRunError, type AgentExecution, type PlannerAgentAdapter, type ReviewerAgentAdapter, type WorkerAgentAdapter } from "../adapters/agent-adapter.js";
import { DEFAULT_WORKER_PROFILES, WorkerRouter, type PreviousOutcome, type WorkerProfiles, type WorkerRouteDecision } from "../router/worker-router.js";
import { runApprovedTests, type TestRun } from "../testing/test-runner.js";
import { runDeterministicGate, type DeterministicGate } from "../gate/deterministic-gate.js";
import { writeEvidence, type EvidenceEntry } from "../evidence/manifest.js";
import { referenceFile, verifyAttemptManifest, type AttemptManifest, type ManifestReference } from "../evidence/attempt-manifest.js";
import type { TaskDetailRecord } from "../../shared/contracts/records.js";
import type { TaskStatus } from "../../shared/core/task-state.js";
import { classifyFailureCode, type FailureClassification } from "../../shared/core/failure-taxonomy.js";
import { ERROR_CODES, type ErrorCode } from "../../shared/core/errors.js";
import { checkWorkerEvidence } from "../../shared/core/worker-evidence.js";
import { validateWorkerResult } from "../../shared/core/worker-result.js";
import { buildTaskSpecPrompt } from "../../shared/core/task-spec-prompt.js";
import { validateExpectedTaskSpecIdentity } from "../../shared/core/task-spec.js";
import { buildWorkerProposalRequest, taskSpecCanonicalSha256 } from "../proposals/proposal-context.js";
import { applyChangeSet } from "../proposals/change-set-applier.js";
import type { CursorProposalAdapter } from "../adapters/cursor/cursor-proposal-adapter.js";

type SnapshotRouteDecision = {
  workerClass: "cheap" | "strong";
  adapterId: string;
  model: string;
  reasoning: ReasoningLevel;
  highTier: boolean;
  escalation: boolean;
  reasonCodes: string[];
  userLocked: boolean;
  blocked: boolean;
  requiresApproval: boolean;
};

type Snapshot = {
  attemptId: string;
  branch: string;
  worktreePath: string;
  worker: WorkerResult;
  diagnostics?: string[];
  git: Awaited<ReturnType<GitService["collectEvidence"]>>;
  routeDecision?: SnapshotRouteDecision;
  tests?: TestRun[];
  gate?: DeterministicGate;
  final?: FinalGateResult;
  artifacts: EvidenceEntry[];
};

type ManagedRun = { id: string; dir: string };
type ReadOnlyState = { head: string; branch: string; gitHash: string };

export class TaskOrchestrator {
  private readonly database: AppDatabase;
  private readonly git: GitService;
  private readonly planner: PlannerAgentAdapter;
  private readonly reviewer: ReviewerAgentAdapter;
  private readonly workers: Map<string, WorkerAgentAdapter>;
  private readonly router: WorkerRouter;
  private readonly profiles: WorkerProfiles;
  private readonly artifactRoot: string;
  private readonly schemaRoot: string;
  private readonly cursorProposal: Pick<CursorProposalAdapter, "id" | "runProposal"> | null;

  constructor(
    database: AppDatabase,
    git: GitService,
    planner: PlannerAgentAdapter,
    reviewer: ReviewerAgentAdapter,
    workers: WorkerAgentAdapter[],
    router: WorkerRouter | undefined = undefined,
    profiles: WorkerProfiles = DEFAULT_WORKER_PROFILES,
    artifactRoot = "",
    schemaRoot = "",
    cursorProposal: Pick<CursorProposalAdapter, "id" | "runProposal"> | null = null
  ) {
    this.database = database;
    this.git = git;
    this.planner = planner;
    this.reviewer = reviewer;
    this.workers = new Map(workers.map((worker) => [worker.id, worker]));
    this.profiles = profiles;
    this.router = router ?? new WorkerRouter(profiles);
    this.artifactRoot = artifactRoot;
    this.schemaRoot = schemaRoot;
    this.cursorProposal = cursorProposal;
  }

  private task(id: string) {
    const task = this.database.getTask(id);
    if (!task) throw new Error("Task not found");
    return task;
  }

  private project(id: string) {
    const project = this.database.getProject(id);
    if (!project) throw new Error("Project not found");
    return project;
  }

  private spec(id: string): TaskSpec {
    const task = this.task(id);
    if (!task.specJson) throw new Error("TaskSpec missing");
    const checked = validateTaskSpec(JSON.parse(task.specJson));
    if (!checked.valid) throw new Error("OUTPUT_SCHEMA_INVALID");
    const identity = validateExpectedTaskSpecIdentity(checked.value, { taskId: task.id, baseSha: task.baseSha });
    if (!identity.valid) throw new Error("OUTPUT_SCHEMA_INVALID: identity mismatch");
    return checked.value;
  }

  private attemptRoot(attemptId: string): string {
    return path.resolve(this.artifactRoot, "attempts", attemptId);
  }

  private snapshotPath(attemptId: string): string {
    return path.join(this.attemptRoot(attemptId), "snapshot.json");
  }

  private save(snapshot: Snapshot): void {
    mkdirSync(this.attemptRoot(snapshot.attemptId), { recursive: true });
    writeFileSync(this.snapshotPath(snapshot.attemptId), JSON.stringify(snapshot, null, 2));
  }

  private load(attemptId: string): Snapshot {
    return JSON.parse(readFileSync(this.snapshotPath(attemptId), "utf8")) as Snapshot;
  }

  private beginRun(input: {
    taskId: string;
    attemptId: string | null;
    stage: string;
    adapter?: string;
    model: string | null;
    reasoning: ReasoningLevel | null;
    cwd: string;
    workerClass?: "cheap" | "strong" | null;
    isEscalation?: boolean;
    isHighTier?: boolean;
    productRunActionId?: string;
    productStage?: "build" | "review";
  }): ManagedRun {
    if (input.productRunActionId) this.assertProductRunAction(input.taskId, input.productRunActionId, input.productStage ?? (input.stage === "reviewer" ? "review" : "build"));
    const id = randomUUID();
    const dir = ensureArtifactLayout(this.artifactRoot, id);
    this.database.createRun({
      id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      stage: input.stage,
      adapter: input.adapter ?? "codex",
      model: input.model,
      reasoning: input.reasoning,
      workerClass: input.workerClass ?? null,
      cwd: input.cwd,
      pid: null,
      status: "STARTING",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      errorCode: null,
      failureDomain: null,
      durationMs: null,
      isEscalation: input.isEscalation ?? false,
      isHighTier: input.isHighTier ?? true,
      usageJson: null
    });
    if (input.productRunActionId) {
      const attached = this.database.db.prepare(`UPDATE runs SET product_run_action_id=?
        WHERE id=? AND task_id=? AND product_run_action_id IS NULL
          AND EXISTS (SELECT 1 FROM product_run_actions
            WHERE id=? AND task_id=? AND status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED') AND stage=?)`)
        .run(input.productRunActionId, id, input.taskId, input.productRunActionId, input.taskId, input.productStage ?? (input.stage === "reviewer" ? "review" : "build"));
      if (Number(attached.changes) !== 1) {
        this.database.updateRun(id, { status: "START_FAILED", errorCode: "PRODUCT_RUN_ACTION_INVALID", endedAt: new Date().toISOString() });
        throw new Error("PRODUCT_RUN_ACTION_INVALID");
      }
    }
    this.appendEvent(input.taskId, "RUN_STARTED", { stage: input.stage, runId: id }, id);
    return { id, dir };
  }

  private assertProductRunAction(taskId: string, productRunActionId: string, expectedStage: "build" | "review"): void {
    const row = this.database.db.prepare(`SELECT task_id,status,stage FROM product_run_actions WHERE id=?`).get(productRunActionId) as { task_id?: unknown; status?: unknown; stage?: unknown } | undefined;
    if (!row || String(row.task_id) !== taskId || !["RUNNING", "PAUSE_REQUESTED", "CANCEL_REQUESTED"].includes(String(row.status)) || row.stage !== expectedStage) throw new Error("PRODUCT_RUN_ACTION_INVALID");
  }

  private onRunSpawn(runId: string) {
    return (pid: number | null) => {
      this.database.updateRun(runId, { pid, status: pid === null ? "START_FAILED" : "RUNNING" });
      const run = this.database.getRun(runId);
      if (run?.taskId) this.appendEvent(run.taskId, "RUN_SPAWNED", { runId, status: pid === null ? "START_FAILED" : "RUNNING" }, runId);
    };
  }

  private finishRun(runId: string, status: string, exitCode: number | null, errorCode: string | null = null, durationMs: number | null = null, usage: AgentExecution<unknown>["usage"] = null, classification: FailureClassification | null = null): void {
    this.database.updateRun(runId, { status, exitCode, endedAt: new Date().toISOString(), errorCode, failureDomain: classification?.domain ?? null, durationMs, usageJson: usage ? JSON.stringify(usage) : null });
    const run = this.database.getRun(runId);
    if (run?.taskId) this.appendEvent(run.taskId, "RUN_FINISHED", { runId, status, exitCode, errorCode }, runId);
  }

  private failRun(runId: string, error: unknown, taskId?: string): void {
    if (error instanceof AgentRunError || error instanceof AgentOutputError) {
      this.finishRun(runId, error.result.status, error.result.exitCode, error.classification.code, error.result.durationMs, null, error.classification);
      if (taskId) this.appendEvent(taskId, "RUN_CLASSIFIED", { code: error.classification.code, domain: error.classification.domain, retryable: error.classification.retryable, failFast: error.classification.failFast, summary: error.classification.diagnosticSummary }, runId);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code: ErrorCode = message.includes("OUTPUT_SCHEMA_INVALID") ? ERROR_CODES.OUTPUT_SCHEMA_INVALID : message.includes("SCOPE_VIOLATION") ? ERROR_CODES.SCOPE_VIOLATION : ERROR_CODES.TASK_FAILED;
    const classification = classifyFailureCode(code);
    this.finishRun(runId, "FAILED", 0, classification.code, null, null, classification);
    if (taskId) this.appendEvent(taskId, "RUN_CLASSIFIED", { code: classification.code, domain: classification.domain, retryable: classification.retryable, failFast: classification.failFast, summary: classification.diagnosticSummary }, runId);
  }

  private recordRunArtifact(runId: string, kind: string, filePath: string): void {
    if (!existsSync(filePath)) return;
    const data = readFileSync(filePath);
    this.database.createArtifact({ id: randomUUID(), runId, kind, path: filePath, sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: statSync(filePath).size });
  }

  private async readOnlyState(cwd: string): Promise<ReadOnlyState> {
    const repository = await this.git.inspect(cwd);
    const evidence = await this.git.collectEvidence(cwd);
    return { head: evidence.head, branch: repository.branch, gitHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
  }

  /** Sandbox controls writes; this audit rejects observable Git drift even on failed runs. */
  private async runReadOnly<T>(managed: ManagedRun, cwd: string, before: ReadOnlyState, input: {
    role: "architect" | "reviewer"; taskId: string; attemptId: string | null;
    baseSha: string; prompt: string; workerRunIds: string[];
  }, invoke: () => Promise<AgentExecution<T>>): Promise<AgentExecution<T>> {
    const inputFile = path.join(managed.dir, "read-only-input.json");
    writeFileSync(inputFile, JSON.stringify({ ...input, runId: managed.id, before }, null, 2), { flag: "wx" });
    this.recordRunArtifact(managed.id, "read-only-input", inputFile);
    let execution: AgentExecution<T> | undefined;
    let failure: unknown;
    try { execution = await invoke(); } catch (error) { failure = error; }
    let after: ReadOnlyState | null = null;
    try { after = await this.readOnlyState(cwd); } catch { /* Unverifiable state must fail closed. */ }
    const unchanged = after !== null && JSON.stringify(before) === JSON.stringify(after);
    const auditFile = path.join(managed.dir, "read-only-audit.json");
    writeFileSync(auditFile, JSON.stringify({ role: input.role, runId: managed.id, before, after, unchanged }, null, 2), { flag: "wx" });
    this.recordRunArtifact(managed.id, "read-only-audit", auditFile);
    this.recordRunArtifact(managed.id, "stdout", path.join(managed.dir, "stdout.log"));
    this.recordRunArtifact(managed.id, "stderr", path.join(managed.dir, "stderr.log"));
    if (!unchanged) throw new Error("SCOPE_VIOLATION: read-only agent changed repository or its state cannot be verified");
    if (!execution) throw failure;
    return execution;
  }

  private transitionFromRunError(taskId: string, error: unknown, fallback: TaskStatus): void {
    if (error instanceof AgentRunError && error.result.status === "CANCELLED") {
      this.database.transitionTask(taskId, "CANCELLED");
      return;
    }
    if (error instanceof AgentRunError && error.classification.domain === "runtime") {
      this.database.transitionTask(taskId, "BLOCKED");
      return;
    }
    this.database.transitionTask(taskId, fallback);
  }

  private appendEvent(taskId: string, type: string, payload: Record<string, unknown>, runId: string | null = null): void {
    this.database.appendEvent({ id: randomUUID(), taskId, runId, sequence: this.database.listEvents(taskId).length + 1, type, payloadJson: JSON.stringify(payload), createdAt: new Date().toISOString() });
  }

  private routeSnapshot(route: WorkerRouteDecision): SnapshotRouteDecision {
    return {
      workerClass: route.workerClass,
      adapterId: route.adapterId,
      model: route.model,
      reasoning: route.reasoning,
      highTier: route.highTier,
      escalation: route.escalation,
      reasonCodes: [...route.reasonCodes],
      userLocked: route.userLocked,
      blocked: route.blocked ?? false,
      requiresApproval: route.requiresApproval ?? false
    };
  }

  private escalationApprovalFor(taskId: string, targetAttempt: number): boolean {
    return this.database.listEvents(taskId).some((event) => {
      if (event.type !== "ESCALATION_APPROVED") return false;
      try {
        const payload = JSON.parse(event.payloadJson) as { approved?: boolean; attempt?: number };
        return payload.approved === true && payload.attempt === targetAttempt;
      } catch {
        return false;
      }
    });
  }

  private isHardGateFailure(failure: string): boolean {
    const code = failure.split(":", 1)[0];
    return code === "BASE_SHA_CHANGED" || code === "EVIDENCE_CORRUPT" || code === "OUTPUT_SCHEMA_INVALID" || code === "SCOPE_VIOLATION" || code === "UNSAFE_GIT_PATH";
  }

  private previousOutcome(taskId: string, nextAttempt: number): PreviousOutcome | undefined {
    const previous = this.database.getLatestAttempt(taskId);
    if (!previous) return undefined;
    try {
      const snapshot = this.load(previous.id);
      const route = snapshot.routeDecision;
      const failures = [...(snapshot.gate?.failures ?? []), ...(snapshot.diagnostics ?? [])];
      const hardFailure = failures.some((failure) => this.isHardGateFailure(failure));
      const failureKind = failures[0]?.split(":", 1)[0]?.toLowerCase();
      const gateFailed = failures.length > 0;
      const workerFailed = snapshot.worker.status !== "completed" || (snapshot.diagnostics ?? []).length > 0;
      const reviewRework = snapshot.final?.verdict === "REWORK";
      const status: PreviousOutcome["status"] = hardFailure || snapshot.worker.status === "blocked"
        ? "blocked"
        : workerFailed || gateFailed || reviewRework
          ? "failed"
          : "succeeded";
      const requiresEscalation = route?.workerClass === "cheap" && previous.number >= 2 && status !== "succeeded";
      return {
        workerClass: route?.workerClass,
        status,
        failureKind: failureKind ?? (snapshot.diagnostics?.[0]?.split(":", 1)[0]?.toLowerCase() ?? (snapshot.worker.status === "blocked" ? "worker_blocked" : reviewRework ? "review_rework" : undefined)),
        hardFailure,
        requiresEscalation,
        escalationApproved: this.escalationApprovalFor(taskId, nextAttempt)
      };
    } catch {
      return { status: "blocked", failureKind: "evidence_corrupt", hardFailure: true, requiresEscalation: false, escalationApproved: false };
    }
  }

  private previousFeedback(taskId: string): string {
    const previous = this.database.getLatestAttempt(taskId);
    if (!previous) return "";
    try {
      const snapshot = this.load(previous.id);
      return JSON.stringify({
        attempt: previous.number,
        routeDecision: snapshot.routeDecision,
        worker: { status: snapshot.worker.status, summary: snapshot.worker.summary, blocker: snapshot.worker.blocker, risks: snapshot.worker.risks },
        claimed_changed_files: snapshot.worker.changed_files,
        authoritative_changed_files: snapshot.git.changedFiles,
        actual_files: snapshot.git.changedFiles,
        diff_stat: snapshot.git.stat,
        diff: snapshot.git.diff.length > 12000 ? `${snapshot.git.diff.slice(0, 12000)}\n[diff truncated by orchestrator]` : snapshot.git.diff,
        tests: snapshot.tests?.map((test) => ({ id: test.id, status: test.result.status, exit_code: test.result.exitCode, stderr: test.result.stderr.slice(-4000) })),
        deterministic_gate: snapshot.gate,
        diagnostics: snapshot.diagnostics ?? [],
        correction: (snapshot.diagnostics ?? []).length > 0 ? "Correct every worker evidence diagnostic before claiming completion; ensure claimed files match the authoritative Git diff." : "Address the recorded test and deterministic gate findings before claiming completion.",
        final_gate: snapshot.final ? { verdict: snapshot.final.verdict, summary: snapshot.final.summary, findings: snapshot.final.findings, rework_instructions: snapshot.final.rework_instructions } : undefined
      }, null, 2);
    } catch {
      return "";
    }
  }

  private workerFailureStatus(route: WorkerRouteDecision, worker: WorkerResult, attempt: number, maxAttempts: number): TaskStatus {
    if (route.workerClass === "cheap" && attempt < maxAttempts) return "REWORK";
    return worker.status === "blocked" ? "BLOCKED" : "FAILED";
  }

  private runFailureStatus(route: WorkerRouteDecision, error: unknown, attempt: number, maxAttempts: number): TaskStatus {
    if (error instanceof AgentRunError && error.classification.domain === "runtime") return "BLOCKED";
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("OUTPUT_SCHEMA_INVALID") || message.includes("SCOPE_VIOLATION") || message.includes("EVIDENCE_CORRUPT")) return "BLOCKED";
    if (route.workerClass === "cheap" && attempt < maxAttempts) return "REWORK";
    return "FAILED";
  }

  detail(taskId: string): TaskDetailRecord {
    const task = this.task(taskId);
    const attempt = this.database.getLatestAttempt(taskId) ?? null;
    let snapshot: Snapshot | null = null;
    if (attempt) {
      try { snapshot = this.load(attempt.id); } catch { snapshot = null; }
    }
    const events = this.database.listEvents(taskId);
    const latestRoute = events.filter((event) => event.type === "ROUTE_DECIDED").at(-1);
    let escalationPending = false;
    if (latestRoute) {
      try {
        const payload = JSON.parse(latestRoute.payloadJson) as { attempt?: number; requiresApproval?: boolean };
        const target = payload.attempt;
        escalationPending = payload.requiresApproval === true && typeof target === "number" && !events.some((event) => {
          if (event.type !== "ESCALATION_APPROVED") return false;
          try { const approval = JSON.parse(event.payloadJson) as { approved?: boolean; attempt?: number }; return approval.approved === true && approval.attempt === target; } catch { return false; }
        });
      } catch { escalationPending = false; }
    }
    return { task, attempt, events, snapshot, runs: this.database.listTaskRuns(taskId), metrics: this.database.taskRunMetrics(taskId), escalationPending };
  }

  updateSpec(taskId: string, revision: unknown) {
    const task = this.task(taskId);
    if (task.status !== "SPEC_READY") throw new Error("Spec is not editable");
    const checked = validateTaskSpec(revision);
    if (!checked.valid) throw new Error(checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    const identity = validateExpectedTaskSpecIdentity(checked.value, { taskId: task.id, baseSha: task.baseSha });
    if (!identity.valid) throw new Error("Task identity or base SHA changed");
    return this.database.saveSpec(taskId, JSON.stringify(checked.value));
  }

  async startDesign(taskId: string) {
    const task = this.task(taskId);
    const project = this.project(task.projectId);
    const repository = await this.git.inspect(project.repoRealPath);
    if (!repository.clean) throw new Error("REPOSITORY_DIRTY");
    if (repository.head !== task.baseSha) throw new Error("BASE_SHA_CHANGED");
    const before = await this.readOnlyState(project.repoRealPath);
    if (before.head !== task.baseSha || before.branch !== repository.branch || !(await this.git.inspect(project.repoRealPath)).clean) throw new Error("REPOSITORY_DIRTY");
    this.database.transitionTask(taskId, "DESIGNING");
    const profile = this.profiles.strong;
    const managed = this.beginRun({ taskId, attemptId: null, stage: "architect", adapter: this.planner.id, model: profile.model, reasoning: profile.reasoning, cwd: project.repoRealPath, workerClass: null, isEscalation: false, isHighTier: profile.highTier });
    const outputPath = path.join(managed.dir, "final.json");
    try {
      const prompt = buildTaskSpecPrompt({ taskId: task.id, baseSha: task.baseSha, request: task.requestText });
      const execution = await this.runReadOnly(managed, project.repoRealPath, before, { role: "architect", taskId, attemptId: null, baseSha: task.baseSha, prompt, workerRunIds: [] }, () => this.planner.runPlanner({ cwd: project.repoRealPath, model: profile.model, reasoning: profile.reasoning, timeoutSeconds: 900, runId: managed.id, onSpawn: this.onRunSpawn(managed.id), schemaPath: path.join(this.schemaRoot, "task-spec.schema.json"), outputPath, prompt }));
      const spec = execution.output;
      const identity = validateExpectedTaskSpecIdentity(spec, { taskId: task.id, baseSha: task.baseSha });
      if (!identity.valid) throw new Error("OUTPUT_SCHEMA_INVALID: identity mismatch");
      this.finishRun(managed.id, "SUCCEEDED", execution.process.exitCode, null, execution.process.durationMs, execution.usage);
      this.recordRunArtifact(managed.id, "final", outputPath);
      this.database.saveSpec(taskId, JSON.stringify(spec));
      return this.database.transitionTask(taskId, "SPEC_READY");
    } catch (error) {
      this.failRun(managed.id, error, taskId);
      this.transitionFromRunError(taskId, error, "SPEC_INVALID");
      throw error;
    }
  }

  approveSpec(taskId: string) {
    const task = this.task(taskId);
    if (task.status !== "SPEC_READY" || !task.specJson) throw new Error("Spec is not ready");
    this.spec(taskId);
    this.database.approveSpec(taskId, task.specJson);
    return this.database.transitionTask(taskId, "SPEC_APPROVED");
  }

  async startBuild(taskId: string, provider: "default" | "codex" | "cursor" = "default", productRunActionId?: string) {
    const task = this.task(taskId);
    if (!task.specApprovedAt) throw new Error("Spec is not approved");
    const spec = this.spec(taskId);
    if (productRunActionId) this.assertProductRunAction(taskId, productRunActionId, "build");
    const project = this.project(task.projectId);
    const previous = this.database.getLatestAttempt(taskId);
    const number = (previous?.number ?? 0) + 1;
    const previousOutcome = this.previousOutcome(taskId, number);
    const defaultRoute = this.router.decide({ taskSpec: spec, attemptNumber: number, previousOutcome });
    if (provider === "cursor") {
      if (!this.cursorProposal || task.status !== "SPEC_APPROVED" || number !== 1 ||
          spec.execution_policy.user_lock === "strong" || defaultRoute.blocked) {
        throw new Error("CURSOR_ROUTE_NOT_AVAILABLE");
      }
      const source = await this.git.inspect(project.repoRealPath);
      if (!source.clean) throw new Error("REPOSITORY_DIRTY");
      if (source.head !== task.baseSha) throw new Error("BASE_SHA_CHANGED");
    }
    const route: WorkerRouteDecision = provider === "cursor" ? {
      ...defaultRoute, adapterId: "cursor-proposal", model: "auto", reasoning: "low", highTier: false,
      workerClass: "cheap", escalation: false, userLocked: true,
      reasonCodes: ["USER_SELECTED_CURSOR_PROPOSAL"]
    } : defaultRoute;
    const routeSnapshot = this.routeSnapshot(route);
    this.appendEvent(taskId, "ROUTE_DECIDED", { attempt: number, workerClass: route.workerClass, adapterId: route.adapterId, model: route.model, reasoning: route.reasoning, highTier: route.highTier, escalation: route.escalation, recommendation: spec.execution_policy.planner_recommendation, lock: spec.execution_policy.user_lock, reasonCodes: route.reasonCodes, userLocked: route.userLocked, blocked: route.blocked ?? false, requiresApproval: route.requiresApproval ?? false });
    if (route.blocked) {
      if (route.requiresApproval) throw new Error("ESCALATION_APPROVAL_REQUIRED");
      if (task.status === "REWORK" || task.status === "SPEC_APPROVED") this.database.transitionTask(taskId, "BLOCKED");
      throw new Error("ROUTE_BLOCKED");
    }
    const adapter = provider === "cursor" ? null : this.workers.get(route.adapterId);
    if (provider !== "cursor" && !adapter) throw new Error("Worker adapter unavailable");
    const reworkContext = task.status === "REWORK" ? this.previousFeedback(taskId) : "";
    this.database.transitionTask(taskId, "PREPARING_WORKTREE");
    let worktree: Awaited<ReturnType<GitService["createWorktree"]>>;
    try { worktree = await this.git.createWorktree(project.repoRealPath, { taskId, attempt: number, baseSha: task.baseSha }); }
    catch (error) { this.database.transitionTask(taskId, "BLOCKED"); throw error; }
    const attemptId = randomUUID();
    this.database.createAttempt({ id: attemptId, taskId, number, branch: worktree.branch, worktreePath: worktree.worktreePath, status: "ACTIVE", createdAt: new Date().toISOString() });
    this.database.transitionTask(taskId, "BUILDING");
    const managed = this.beginRun({ taskId, attemptId, stage: "builder", adapter: route.adapterId, model: route.model, reasoning: route.reasoning, cwd: worktree.worktreePath, workerClass: route.workerClass, isEscalation: route.escalation, isHighTier: route.highTier, productRunActionId, productStage: "build" });
    const outputPath = path.join(managed.dir, "final.json");
    try {
      const execution: AgentExecution<WorkerResult> = provider === "cursor" ? await (async () => {
        const request = buildWorkerProposalRequest({ taskSpec: spec, managedWorktree: worktree.worktreePath });
        const proposal = await this.cursorProposal!.runProposal({ request, runDirectory: managed.dir,
          outputPath: path.join(managed.dir, "change-set.json"), runId: managed.id,
          timeoutSeconds: spec.limits.run_timeout_seconds, onSpawn: this.onRunSpawn(managed.id) });
        if (proposal.output.status === "completed") {
          applyChangeSet(proposal.output, { worktreeRoot: worktree.worktreePath, managedWorktreeRoot: this.git.getManagedRoot(),
            taskSpec: spec, taskSpecSha256: taskSpecCanonicalSha256(spec), limits: request.limits });
        }
        const candidate: WorkerResult = { schema_version: "1.0", task_id: taskId, status: proposal.output.status,
          summary: proposal.output.summary, changed_files: proposal.output.operations.map(operation => operation.path),
          acceptance_notes: proposal.output.acceptance_notes, risks: proposal.output.risks, blocker: proposal.output.blocker };
        const checked = validateWorkerResult(candidate, { taskId });
        if (!checked.valid) throw new Error("OUTPUT_SCHEMA_INVALID: cursor worker result");
        writeFileSync(outputPath, `${JSON.stringify(checked.value, null, 2)}\n`, { flag: "wx" });
        return { ...proposal, output: checked.value };
      })() : await adapter!.runWorker({ taskId, cwd: worktree.worktreePath, model: route.model, reasoning: route.reasoning, timeoutSeconds: spec.limits.run_timeout_seconds, runId: managed.id, onSpawn: this.onRunSpawn(managed.id), schemaPath: path.join(this.schemaRoot, "agent-result.schema.json"), outputPath, prompt: `Implement only this approved TaskSpec. Do not push, merge, install dependencies, or modify forbidden paths.\n${JSON.stringify(spec)}${reworkContext ? `\nREWORK EVIDENCE:\n${reworkContext}` : ""}` });
      const worker = execution.output;
      this.finishRun(managed.id, "SUCCEEDED", execution.process.exitCode, null, execution.process.durationMs, execution.usage);
      this.recordRunArtifact(managed.id, "final", outputPath);
      if (provider === "cursor") this.recordRunArtifact(managed.id, "proposal", path.join(managed.dir, "change-set.json"));
      this.recordRunArtifact(managed.id, "stdout", path.join(managed.dir, "stdout.log"));
      this.recordRunArtifact(managed.id, "stderr", path.join(managed.dir, "stderr.log"));
      const git = await this.git.collectEvidence(worktree.worktreePath);
      const evidenceCheck = checkWorkerEvidence({ worker, authoritativeChangedFiles: git.changedFiles, diff: git.diff });
      const diagnostics = evidenceCheck.diagnostics;
      const root = this.attemptRoot(attemptId);
      const artifacts = [writeEvidence(root, "worker-result", "worker-result.json", JSON.stringify(worker, null, 2)), writeEvidence(root, "diff", "changes.diff", git.diff), writeEvidence(root, "diff-stat", "diff-stat.txt", git.stat), writeEvidence(root, "changed-files", "changed-files.json", JSON.stringify(git.changedFiles, null, 2))];
      const diagnosticArtifact = diagnostics.length > 0 ? writeEvidence(root, "worker-diagnostics", "worker-diagnostics.json", JSON.stringify({ diagnostics, worker_changed_files: evidenceCheck.workerChangedFiles, authoritative_changed_files: evidenceCheck.authoritativeChangedFiles }, null, 2)) : null;
      if (diagnosticArtifact) artifacts.push(diagnosticArtifact);
      this.save({ attemptId, branch: worktree.branch, worktreePath: worktree.worktreePath, worker, diagnostics, git, routeDecision: routeSnapshot, artifacts });
      if (diagnostics.length > 0) this.appendEvent(taskId, "WORKER_EVIDENCE_DIAGNOSTICS", { attempt: number, diagnostics, worker_changed_files: evidenceCheck.workerChangedFiles, authoritative_changed_files: evidenceCheck.authoritativeChangedFiles }, managed.id);
      if (worker.status !== "completed") {
        const nextStatus = provider === "cursor" ? "BLOCKED" : this.workerFailureStatus(route, worker, number, spec.limits.max_attempts);
        this.database.updateAttemptStatus(attemptId, nextStatus);
        return this.database.transitionTask(taskId, nextStatus);
      }
      if (diagnostics.length > 0) {
        const nextStatus = provider === "cursor" ? "BLOCKED" : this.workerFailureStatus(route, worker, number, spec.limits.max_attempts);
        this.database.updateAttemptStatus(attemptId, nextStatus);
        return this.database.transitionTask(taskId, nextStatus);
      }
      return this.database.transitionTask(taskId, "BUILT");
    } catch (error) {
      this.failRun(managed.id, error, taskId);
      if (error instanceof AgentRunError && error.result.status === "CANCELLED") {
        this.database.updateAttemptStatus(attemptId, "CANCELLED");
        this.database.transitionTask(taskId, "CANCELLED");
      } else {
        const nextStatus = provider === "cursor" ? "BLOCKED" : this.runFailureStatus(route, error, number, spec.limits.max_attempts);
        this.database.updateAttemptStatus(attemptId, nextStatus);
        this.database.transitionTask(taskId, nextStatus);
      }
      throw error;
    }
  }

  async startTests(taskId: string) {
    const task = this.task(taskId);
    const spec = this.spec(taskId);
    const attempt = this.database.getLatestAttempt(taskId);
    if (!attempt) throw new Error("Attempt missing");
    const snapshot = this.load(attempt.id);
    this.database.transitionTask(taskId, "TESTING");
    let tests: TestRun[];
    try { tests = await runApprovedTests(attempt.worktreePath, spec.test_commands, path.join(this.attemptRoot(attempt.id), "tests"), {
      begin: command => {
        const managed = this.beginRun({ taskId, attemptId: attempt.id, stage: `test:${command.id}`, adapter: "test-runner", model: null, reasoning: null, cwd: path.resolve(attempt.worktreePath, command.cwd), isHighTier: false });
        return { runId: managed.id, onSpawn: this.onRunSpawn(managed.id) };
      },
      finish: (runId, result, logDir) => {
        this.finishRun(runId, result.status, result.exitCode, result.status === "SUCCEEDED" ? null : result.status, result.durationMs);
        this.recordRunArtifact(runId, "stdout", path.join(logDir, "stdout.log"));
        this.recordRunArtifact(runId, "stderr", path.join(logDir, "stderr.log"));
      }
    }); }
    catch (error) { this.database.updateAttemptStatus(attempt.id, "BLOCKED"); this.database.transitionTask(taskId, "BLOCKED"); throw error; }
    snapshot.tests = tests;
    const root = this.attemptRoot(attempt.id);
    const requiredTestFailed = tests.some((test) => test.required && test.result.status !== "SUCCEEDED");
    if (requiredTestFailed && snapshot.worker.status === "completed" && snapshot.git.changedFiles.length === 0 && snapshot.worker.changed_files.length === 0) {
      const check = checkWorkerEvidence({ worker: snapshot.worker, authoritativeChangedFiles: snapshot.git.changedFiles, diff: snapshot.git.diff.trim(), requiresChange: true });
      const existing = new Set(snapshot.diagnostics ?? []);
      const diagnostics = check.diagnostics.length > 0 ? check.diagnostics : ["WORKER_NOOP"];
      const added = diagnostics.filter((diagnostic) => !existing.has(diagnostic));
      if (added.length > 0) {
        snapshot.diagnostics = [...existing, ...added];
        snapshot.artifacts.push(writeEvidence(root, "worker-diagnostics", "worker-diagnostics-tests.json", JSON.stringify({ diagnostics: snapshot.diagnostics, reason: "required_test_failed", claimed_changed_files: check.workerChangedFiles, authoritative_changed_files: check.authoritativeChangedFiles }, null, 2)));
        this.appendEvent(taskId, "WORKER_EVIDENCE_DIAGNOSTICS", { attempt: attempt.number, diagnostics: added, reason: "required_test_failed" }, null);
      }
    }
    try {
    const testArtifacts: EvidenceEntry[] = [writeEvidence(root, "test-results", "test-results.json", JSON.stringify(tests, null, 2))];
    for (const test of tests) {
      testArtifacts.push(writeEvidence(root, `test-${test.id}-result`, `test-${test.id}-result.json`, JSON.stringify(test, null, 2)));
      testArtifacts.push(writeEvidence(root, `test-${test.id}-stdout`, `test-${test.id}-stdout.log`, test.result.stdout));
      testArtifacts.push(writeEvidence(root, `test-${test.id}-stderr`, `test-${test.id}-stderr.log`, test.result.stderr));
    }
    snapshot.artifacts.push(...testArtifacts);
    this.save(snapshot);
    if (tests.some((test) => test.result.status === "CANCELLED")) { this.database.updateAttemptStatus(attempt.id, "CANCELLED"); return this.database.transitionTask(taskId, "CANCELLED"); }
    this.database.transitionTask(taskId, "DETERMINISTIC_GATE");
    const postTestsGit = await this.git.collectEvidence(attempt.worktreePath);
    const gitDrifted = postTestsGit.head !== snapshot.git.head || postTestsGit.diff !== snapshot.git.diff || postTestsGit.stat !== snapshot.git.stat || JSON.stringify(postTestsGit.changedFiles) !== JSON.stringify(snapshot.git.changedFiles) || JSON.stringify(postTestsGit.invalidPaths) !== JSON.stringify(snapshot.git.invalidPaths);
    const gate = runDeterministicGate({ spec, baseSha: snapshot.git.head, changedFiles: snapshot.git.changedFiles, invalidPaths: snapshot.git.invalidPaths, diff: snapshot.git.diff, tests, workerValid: snapshot.worker.status === "completed", workerDiagnostics: [...(snapshot.diagnostics ?? []), ...(gitDrifted ? ["EVIDENCE_CORRUPT"] : [])], artifacts: snapshot.artifacts.map((item) => ({ content: readFileSync(path.join(root, item.path)), sha256: item.sha256 })) });
    const gateArtifact = writeEvidence(root, "deterministic-gate", "deterministic-gate.json", JSON.stringify(gate, null, 2));
    if (!task.specJson || !task.specApprovedAt) throw new Error("EVIDENCE_CORRUPT: approved TaskSpec missing");
    const approvedSpec = writeEvidence(root, "task-spec-approved", "task-spec-approved.json", task.specJson);
    const attemptArtifacts = [...snapshot.artifacts, gateArtifact, approvedSpec];
    const runRecords = this.database.listRuns(attempt.id);
    const references: ManifestReference[] = attemptArtifacts.map(item => referenceFile(this.artifactRoot, attempt.id, item.kind, "attempt", item.path));
    for (const run of runRecords) {
      if (run.stage.startsWith("test:")) {
        const id = run.stage.slice(5);
        for (const stream of ["stdout", "stderr"] as const) references.push(referenceFile(this.artifactRoot, attempt.id, `run-${run.id}-${stream}`, "attempt", `tests/${id}/${stream}.log`));
      } else {
        for (const stream of ["stdout", "stderr"] as const) references.push(referenceFile(this.artifactRoot, attempt.id, `run-${run.id}-${stream}`, "runs", `${run.id}/${stream}.log`));
      }
    }
    const manifestValue: AttemptManifest = {
      schema_version: "1.1", project_id: task.projectId, task_id: taskId, attempt_id: attempt.id,
      task_spec: { revision: task.specRevision, approved_at: task.specApprovedAt, sha256: createHash("sha256").update(task.specJson).digest("hex"), artifact: approvedSpec.kind },
      run_ids: runRecords.map(run => run.id), base_sha: task.baseSha, branch: attempt.branch, worktree_head: snapshot.git.head,
      changed_files: snapshot.git.changedFiles, git: { diff: "diff", stat: "diff-stat", changed_files: "changed-files" },
      test_runs: tests.map(test => ({ id: test.id, run_id: test.runId!, required: test.required, status: test.result.status, result: `test-${test.id}-result`, stdout: `run-${test.runId}-stdout`, stderr: `run-${test.runId}-stderr` })),
      deterministic_gate: { passed: gate.passed, artifact: gateArtifact.kind }, artifacts: references, generated_at: new Date().toISOString()
    };
    verifyAttemptManifest(this.artifactRoot, manifestValue);
    const manifest = writeEvidence(root, "manifest", "evidence-manifest.json", JSON.stringify(manifestValue, null, 2));
    snapshot.gate = gate;
    snapshot.artifacts.push(gateArtifact, approvedSpec, manifest);
    this.save(snapshot);
    if (gate.passed) { this.database.updateAttemptStatus(attempt.id, "GATE_READY"); return this.database.transitionTask(taskId, "GATE_READY"); }
    if (gate.failures.some((failure) => this.isHardGateFailure(failure))) { this.database.updateAttemptStatus(attempt.id, "BLOCKED"); return this.database.transitionTask(taskId, "BLOCKED"); }
    const nextStatus: TaskStatus = attempt.number < spec.limits.max_attempts ? "REWORK" : "FAILED";
    this.database.updateAttemptStatus(attempt.id, nextStatus);
    return this.database.transitionTask(taskId, nextStatus);
    } catch (error) {
      if (["TESTING", "DETERMINISTIC_GATE"].includes(this.task(taskId).status)) {
        this.database.updateAttemptStatus(attempt.id, "BLOCKED");
        this.database.transitionTask(taskId, "BLOCKED");
      }
      throw error;
    }
  }

  async approveEscalation(taskId: string) {
    const task = this.task(taskId);
    if (task.status !== "REWORK") throw new Error("Escalation approval requires REWORK");
    const latest = this.database.getLatestAttempt(taskId);
    if (!latest || latest.number < 2) throw new Error("Escalation is not pending");
    const snapshot = this.load(latest.id);
    const route = snapshot.routeDecision;
    if (!route || route.workerClass !== "cheap" || !route.reasonCodes.includes("CHEAP_RETRY")) throw new Error("Escalation is not pending");
    if (snapshot.worker.status === "completed" && (snapshot.diagnostics ?? []).length === 0 && snapshot.gate?.passed !== false && snapshot.final?.verdict !== "REWORK") throw new Error("Escalation is not pending");
    const targetAttempt = latest.number + 1;
    if (this.escalationApprovalFor(taskId, targetAttempt)) return task;
    const spec = this.spec(taskId);
    const previousOutcome = this.previousOutcome(taskId, targetAttempt);
    const predicted = this.router.decide({ taskSpec: spec, attemptNumber: targetAttempt, previousOutcome });
    if (!predicted.requiresApproval || !predicted.escalation || predicted.workerClass !== "strong") throw new Error("Escalation is not pending");
    this.appendEvent(taskId, "ESCALATION_APPROVED", { approved: true, attempt: targetAttempt, previousAttempt: latest.number, reasonCodes: predicted.reasonCodes });
    return task;
  }

  private reviewerEvidence(attemptId: string, attempt: { id: string; number: number; branch: string; worktreePath: string }, snapshot: Snapshot): string {
    const manifest = snapshot.artifacts.find((item) => item.kind === "manifest");
    const root = this.attemptRoot(attemptId);
    const boundedDiff = snapshot.git.diff.length > 12000 ? `${snapshot.git.diff.slice(0, 12000)}\n[diff truncated by orchestrator]` : snapshot.git.diff;
    return JSON.stringify({
      attempt: { id: attempt.id, number: attempt.number, branch: attempt.branch },
      evidence_manifest: manifest ? { absolute_path: path.join(root, manifest.path), sha256: manifest.sha256 } : null,
      changed_files: snapshot.git.changedFiles,
      diff: boundedDiff,
      tests: snapshot.tests?.map((test) => ({ id: test.id, status: test.result.status, exit_code: test.result.exitCode, stdout: test.result.stdout.slice(-2000), stderr: test.result.stderr.slice(-2000) })) ?? [],
      deterministic_gate: snapshot.gate,
      review_constraints: ["This evidence is for the current attempt only.", "Deterministic gate results are authoritative and cannot be overridden.", "Do not modify the worktree; report only the final gate result."]
    }, null, 2);
  }

  async startFinalGate(taskId: string, productRunActionId?: string) {
    const spec = this.spec(taskId);
    if (productRunActionId) this.assertProductRunAction(taskId, productRunActionId, "review");
    const attempt = this.database.getLatestAttempt(taskId);
    if (!attempt) throw new Error("Attempt missing");
    const snapshot = this.load(attempt.id);
    if (!snapshot.gate?.passed) throw new Error("Deterministic gate did not pass");
    let before: ReadOnlyState;
    try {
      before = await this.readOnlyState(attempt.worktreePath);
      const current = await this.git.collectEvidence(attempt.worktreePath);
      if (current.head !== snapshot.git.head || current.diff !== snapshot.git.diff || current.stat !== snapshot.git.stat || JSON.stringify(current.changedFiles) !== JSON.stringify(snapshot.git.changedFiles) || JSON.stringify(current.invalidPaths) !== JSON.stringify(snapshot.git.invalidPaths)) throw new Error("worktree changed after deterministic gate");
      const root = this.attemptRoot(attempt.id);
      for (const artifact of snapshot.artifacts) {
        const file = path.resolve(root, artifact.path);
        const relative = path.relative(root, file);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !lstatSync(file).isFile()) throw new Error("artifact path invalid");
        const content = readFileSync(file);
        if (content.length !== artifact.sizeBytes || createHash("sha256").update(content).digest("hex") !== artifact.sha256) throw new Error("artifact hash invalid");
      }
      const manifestEntry = snapshot.artifacts.find(item => item.kind === "manifest");
      if (!manifestEntry) throw new Error("manifest missing");
      const manifest = JSON.parse(readFileSync(path.join(root, manifestEntry.path), "utf8")) as AttemptManifest;
      verifyAttemptManifest(this.artifactRoot, manifest);
      const task = this.task(taskId);
      const specHash = createHash("sha256").update(task.specJson ?? "").digest("hex");
      if (!task.specApprovedAt || manifest.project_id !== task.projectId || manifest.task_id !== taskId || manifest.attempt_id !== attempt.id || manifest.task_spec.revision !== task.specRevision || manifest.task_spec.approved_at !== task.specApprovedAt || manifest.task_spec.sha256 !== specHash || manifest.task_spec.artifact !== "task-spec-approved" || manifest.base_sha !== task.baseSha || manifest.branch !== attempt.branch || manifest.worktree_head !== current.head || JSON.stringify(manifest.changed_files) !== JSON.stringify(current.changedFiles) || manifest.git.diff !== "diff" || manifest.git.stat !== "diff-stat" || manifest.git.changed_files !== "changed-files" || manifest.deterministic_gate.artifact !== "deterministic-gate" || !manifest.deterministic_gate.passed) throw new Error("manifest identity mismatch");
      if (readFileSync(path.join(root, "task-spec-approved.json"), "utf8") !== task.specJson || readFileSync(path.join(root, "changes.diff"), "utf8") !== current.diff || readFileSync(path.join(root, "diff-stat.txt"), "utf8") !== current.stat || readFileSync(path.join(root, "changed-files.json"), "utf8") !== JSON.stringify(current.changedFiles, null, 2) || readFileSync(path.join(root, "deterministic-gate.json"), "utf8") !== JSON.stringify(snapshot.gate, null, 2)) throw new Error("manifest content mismatch");
      const expectedEntries = snapshot.artifacts.filter(item => item.kind !== "manifest");
      if (expectedEntries.some(item => !manifest.artifacts.some(ref => ref.root === "attempt" && ref.kind === item.kind && ref.path === item.path && ref.sizeBytes === item.sizeBytes && ref.sha256 === item.sha256))) throw new Error("manifest artifact missing");
      const runs = this.database.listRuns(attempt.id);
      if (JSON.stringify(manifest.run_ids) !== JSON.stringify(runs.map(run => run.id)) || manifest.test_runs.length !== (snapshot.tests?.length ?? 0)) throw new Error("manifest runs mismatch");
      for (const run of runs) {
        const refs = manifest.artifacts.filter(ref => ref.kind === `run-${run.id}-stdout` || ref.kind === `run-${run.id}-stderr`);
        const saved = this.database.listArtifacts(run.id).filter(item => item.kind === "stdout" || item.kind === "stderr");
        if (refs.length !== 2 || saved.length !== 2 || saved.some(item => !refs.some(ref => ref.kind === `run-${run.id}-${item.kind}` && ref.sha256 === item.sha256 && ref.sizeBytes === item.sizeBytes))) throw new Error("manifest run log mismatch");
      }
      for (const test of snapshot.tests ?? []) {
        const entry = manifest.test_runs.find(item => item.id === test.id);
        const run = runs.find(item => item.id === test.runId);
        if (!entry || entry.run_id !== test.runId || entry.required !== test.required || entry.status !== test.result.status || entry.result !== `test-${test.id}-result` || entry.stdout !== `run-${test.runId}-stdout` || entry.stderr !== `run-${test.runId}-stderr` || run?.status !== test.result.status || readFileSync(path.join(root, `test-${test.id}-result.json`), "utf8") !== JSON.stringify(test, null, 2)) throw new Error("manifest test mismatch");
      }
    } catch {
      this.database.updateAttemptStatus(attempt.id, "BLOCKED");
      this.database.transitionTask(taskId, "BLOCKED");
      throw new Error("EVIDENCE_CORRUPT: gate evidence changed before final review");
    }
    this.database.transitionTask(taskId, "REVIEWING");
    const profile = this.profiles.strong;
    const managed = this.beginRun({ taskId, attemptId: attempt.id, stage: "reviewer", adapter: this.reviewer.id, model: profile.model, reasoning: profile.reasoning, cwd: attempt.worktreePath, isHighTier: profile.highTier, productRunActionId, productStage: "review" });
    const output = path.join(managed.dir, "final.json");
    try {
      const evidence = this.reviewerEvidence(attempt.id, attempt, snapshot);
      const prompt = `Review approved TaskSpec and the following orchestrator-verified evidence for this attempt. Evaluate independently of the Worker. Worker claims are untrusted; only platform TestRun results prove tests. Do not modify files. The deterministic gate is authoritative and cannot be bypassed.\nTASK_SPEC:\n${JSON.stringify(spec)}\nEVIDENCE:\n${evidence}`;
      const workerRunIds = this.database.listRuns(attempt.id).filter(run => run.stage === "builder").map(run => run.id);
      const execution = await this.runReadOnly(managed, attempt.worktreePath, before, { role: "reviewer", taskId, attemptId: attempt.id, baseSha: this.task(taskId).baseSha, prompt, workerRunIds }, () => this.reviewer.runReviewer({ cwd: attempt.worktreePath, model: profile.model, reasoning: profile.reasoning, timeoutSeconds: 600, runId: managed.id, onSpawn: this.onRunSpawn(managed.id), schemaPath: path.join(this.schemaRoot, "final-gate.schema.json"), outputPath: output, prompt, context: { taskId, validCriterionIds: spec.acceptance_criteria.map((criterion) => criterion.id), deterministicGatePassed: true, requiredTestsPassed: true, scopePassed: true } }));
      this.finishRun(managed.id, "SUCCEEDED", execution.process.exitCode, null, execution.process.durationMs, execution.usage);
      this.recordRunArtifact(managed.id, "final", output);
      snapshot.final = execution.output;
      snapshot.artifacts.push(writeEvidence(this.attemptRoot(attempt.id), "final-gate", "final-gate.json", JSON.stringify(execution.output, null, 2)));
      this.save(snapshot);
      if (execution.output.verdict === "PASS") { this.database.updateAttemptStatus(attempt.id, "PASS"); return this.database.transitionTask(taskId, "PASSED"); }
      if (execution.output.verdict === "BLOCKED") { this.database.updateAttemptStatus(attempt.id, "BLOCKED"); return this.database.transitionTask(taskId, "BLOCKED"); }
      const nextStatus: TaskStatus = attempt.number < spec.limits.max_attempts ? "REWORK" : "FAILED";
      this.database.updateAttemptStatus(attempt.id, nextStatus);
      return this.database.transitionTask(taskId, nextStatus);
    } catch (error) {
      this.failRun(managed.id, error, taskId);
      if (error instanceof AgentRunError && error.result.status === "CANCELLED") {
        this.database.updateAttemptStatus(attempt.id, "CANCELLED");
        this.database.transitionTask(taskId, "CANCELLED");
      } else {
        this.database.updateAttemptStatus(attempt.id, "BLOCKED");
        this.transitionFromRunError(taskId, error, "BLOCKED");
      }
      throw error;
    }
  }
}
