import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import { CheapWorkerAdapter } from "../../src/main/adapters/cheap-worker/cheap-worker-adapter.js";
import { AppDatabase } from "../../src/main/db/database.js";
import { GitService } from "../../src/main/git/git-service.js";
import { TaskOrchestrator } from "../../src/main/orchestrator/task-orchestrator.js";
import { runProcess } from "../../src/main/process/runner.js";
import { runCodexRuntimePreflight } from "../../src/main/runtime/codex-runtime-preflight.js";
import { WorkerRouter, type WorkerClass, type WorkerProfiles, type WorkerRouteDecision, type WorkerRouteRequest } from "../../src/main/router/worker-router.js";
import { evaluatePhase11, evaluatePhase12, type EvaluationSummary, type Phase12Pair } from "../../src/shared/core/ab-evaluation.js";
import type { RunRecord, TaskDetailRecord } from "../../src/shared/contracts/records.js";
import { controlledTasks, hashText, taskSpecFor, writeControlledFixture, type ControlledTask } from "./phase1-controlled-tasks.js";
import { asControlledTasks, buildPhase12BlockedEvidence, buildPhase12Evidence, importPhase12DevelopmentEvidence, importPhase12HoldoutEvidence, phase12TaskPopulation, selectPhase12HoldoutTasks, type Phase12EvidenceDocument, type Phase12PairChecksEvidence, type Phase12TaskEvidence } from "./phase1-2-controlled-tasks.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const atomicJson = (target: string, value: unknown): void => {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  json(temporary, value);
  renameSync(temporary, target);
};
const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runProcess({ program: "git", args, cwd, timeoutSeconds: 30 });
  if (result.status !== "SUCCEEDED") throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
const ensureOutput = (): string => {
  if (!process.env.PHASE1_AB_OUTPUT) throw new Error("PHASE1_AB_OUTPUT must be explicitly set");
  const output = path.resolve(process.env.PHASE1_AB_OUTPUT);
  if (output.split(path.sep).some((part) => part === "phase1-ab-artifacts-run6" || part === "phase1-1-ab-artifacts-run11")) throw new Error("Refusing to write beneath protected Phase 1 evidence");
  if (existsSync(output)) throw new Error("PHASE1_AB_OUTPUT already exists; refusing to overwrite evidence");
  return output;
};
const realAbEnabled = (): boolean => process.env.RUN_REAL_AB === "1" && Boolean(process.env.PHASE1_AB_OUTPUT);

export const isCompletedPhase12EvaluationStatus = (status: EvaluationSummary["status"]): boolean => ["PASS", "PARTIAL", "FAIL", "BLOCKED"].includes(status);

class FixedWorkerRouter extends WorkerRouter {
  constructor(private readonly _workerClass: WorkerClass, private readonly fixedProfiles: WorkerProfiles) { super(fixedProfiles); }
  override decide(_request: WorkerRouteRequest): WorkerRouteDecision {
    const profile = this.fixedProfiles[this._workerClass];
    return { ...profile, workerClass: this._workerClass, escalation: false, reasonCodes: [`CONTROLLED_${this._workerClass.toUpperCase()}`], userLocked: true, blocked: false, requiresApproval: false };
  }
}

type Arm = "baseline" | "variant";
type FailureEvidence = { domain: "runtime" | "task" | "user"; code: string } | null;
type ArmEvidence = {
  arm: Arm; taskId: string; taskSuccess: boolean; testsPassed: boolean; gatePassed: boolean; finalVerdict: string;
  p0Findings: number; p1Findings: number; runs: RunRecord[]; metrics: TaskDetailRecord["metrics"];
  highTierUsageComplete: boolean; failure: FailureEvidence;
  base: { canonicalSha: string; taskBaseSha: string; sourceInitialHead: string; sourceFinalHead: string; sourceClean: boolean; worktreeHead: string | null; worktreePath: string | null; managedRoot: string; diffSha256: string | null };
  evidencePaths: string[]; evidenceFileHashes: Record<string, string>; evidenceManifestSha256: string | null; humanIntervention: number; specJson: string; specHash: string; testsHash: string; acceptanceHash: string; detail: TaskDetailRecord;
};
type SharedPlannerEvidence = { runId: string; status: string; model: string | null; reasoning: string | null; durationMs: number | null; usageJson: string | null; failure: FailureEvidence; artifactPaths: string[] };
const completeHighTierUsage = (runs: RunRecord[]): boolean => {
  const highTier = runs.filter((run) => run.isHighTier);
  return highTier.length > 0 && highTier.every((run) => {
    if (run.status !== "SUCCEEDED" || run.usageJson === null) return false;
    try {
      const totalTokens = (JSON.parse(run.usageJson) as { totalTokens?: unknown }).totalTokens;
      return typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens >= 0;
    } catch { return false; }
  });
};
const isManagedDescendant = (managedRoot: string, worktreePath: string | null): boolean => {
  if (worktreePath === null) return false;
  const relative = path.relative(path.resolve(managedRoot), path.resolve(worktreePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const lastFailure = (detail: TaskDetailRecord): FailureEvidence => {
  if (detail.task.status === "PASSED") return null;
  const failed = [...detail.runs].reverse().find((run) => run.failureDomain && run.errorCode);
  if (failed?.failureDomain && failed.errorCode) return { domain: failed.failureDomain, code: failed.errorCode };
  return { domain: "task", code: detail.task.status };
};
const driveArm = async (orchestrator: TaskOrchestrator, task: ControlledTask, baseSha: string, sharedSpec?: ReturnType<typeof taskSpecFor>): Promise<void> => {
  if (sharedSpec) {
    // Reuse the single planner-approved TaskSpec for the second arm. This
    // keeps the A/B comparison focused on worker routing and avoids a second
    // real planner call whose output would immediately be overwritten.
    const database = (orchestrator as unknown as { database: AppDatabase }).database;
    database.transitionTask(task.id, "DESIGNING");
    database.saveSpec(task.id, JSON.stringify(sharedSpec));
    database.transitionTask(task.id, "SPEC_READY");
  } else {
    await orchestrator.startDesign(task.id);
    orchestrator.updateSpec(task.id, taskSpecFor(task, baseSha));
  }
  orchestrator.approveSpec(task.id);
  while (true) {
    const status = orchestrator.detail(task.id).task.status;
    if (status === "SPEC_APPROVED" || status === "REWORK") await orchestrator.startBuild(task.id);
    else if (status === "BUILT") await orchestrator.startTests(task.id);
    else if (status === "GATE_READY") await orchestrator.startFinalGate(task.id);
    else return;
  }
};

async function runArm(task: ControlledTask, arm: Arm, canonicalSource: string, canonicalSha: string, output: string, strongModel: string, cheapModel: string, strongReasoning: "low" | "medium", sharedSpec?: ReturnType<typeof taskSpecFor>): Promise<ArmEvidence> {
  const stage = mkdtempSync(path.join(os.tmpdir(), `agentplatform-phase11-${task.id.toLowerCase()}-${arm}-`));
  const sourceClone = path.join(stage, "source");
  const managedRoot = path.join(stage, "managed");
  const artifactRoot = path.join(stage, "artifacts");
  const databasePath = path.join(stage, "run.sqlite");
  const finalRoot = path.join(output, "tasks", task.id, arm);
  let database: AppDatabase | null = null;
  try {
    await git(stage, ["clone", canonicalSource, sourceClone]);
    const sourceInitialHead = await git(sourceClone, ["rev-parse", "HEAD"]);
    if (sourceInitialHead !== canonicalSha) throw new Error("canonical SHA drifted");
    database = new AppDatabase(databasePath);
    const projectId = `${task.id}-${arm}-PROJECT`;
    database.createProject({ id: projectId, name: task.id, repoPath: sourceClone, repoRealPath: sourceClone, lastSeenHead: sourceInitialHead });
    database.createTask({ id: task.id, projectId, title: task.id, requestText: task.goal, status: "DRAFT", baseSha: canonicalSha });
    const strong = new CodexAdapter();
    const cheap = new CheapWorkerAdapter();
    const profiles: WorkerProfiles = {
      cheap: { adapterId: "cheap-worker", model: cheapModel, reasoning: "low", highTier: false },
      strong: { adapterId: "codex", model: strongModel, reasoning: strongReasoning, highTier: true }
    };
    const workerClass: WorkerClass = arm === "baseline" ? "strong" : "cheap";
    const orchestrator = new TaskOrchestrator(database, new GitService("git", managedRoot), strong, strong, [strong, cheap], new FixedWorkerRouter(workerClass, profiles), profiles, artifactRoot, path.join(repositoryRoot, "schemas"));
    try { await driveArm(orchestrator, task, canonicalSha, sharedSpec); } catch { /* durable run records carry the failure */ }
    const detail = orchestrator.detail(task.id);
    const approvedSpecJson = detail.task.specJson ?? JSON.stringify(taskSpecFor(task, canonicalSha));
    const approvedSpec = JSON.parse(approvedSpecJson) as ReturnType<typeof taskSpecFor>;
    const sourceFinalHead = await git(sourceClone, ["rev-parse", "HEAD"]);
    const sourceClean = (await git(sourceClone, ["status", "--porcelain=v1"])) === "";
    const worktreePath = detail.attempt?.worktreePath ? path.resolve(detail.attempt.worktreePath) : null;
    const worktreeHead = worktreePath ? await git(worktreePath, ["rev-parse", "HEAD"]) : null;
    const tests = detail.snapshot?.tests ?? [];
    const testsPassed = tests.length > 0 && tests.every((test) => !test.required || test.result.status === "SUCCEEDED");
    const final = detail.snapshot?.final;
    const result: ArmEvidence = {
      arm, taskId: task.id, taskSuccess: detail.task.status === "PASSED", testsPassed,
      gatePassed: detail.snapshot?.gate?.passed === true, finalVerdict: final?.verdict ?? "BLOCKED",
      p0Findings: final?.findings.filter((finding) => finding.severity === "critical").length ?? 0,
      p1Findings: final?.findings.filter((finding) => finding.severity === "high").length ?? 0,
      runs: detail.runs, metrics: detail.metrics, highTierUsageComplete: completeHighTierUsage(detail.runs),
      failure: lastFailure(detail),
      base: { canonicalSha, taskBaseSha: detail.task.baseSha, sourceInitialHead, sourceFinalHead, sourceClean, worktreeHead, worktreePath, managedRoot: path.resolve(managedRoot), diffSha256: detail.snapshot ? hashText(detail.snapshot.git.diff) : null },
      evidencePaths: [], evidenceFileHashes: {}, evidenceManifestSha256: null, humanIntervention: detail.events.filter((event) => event.type === "ESCALATION_APPROVED").length,
      specJson: approvedSpecJson, specHash: hashText(approvedSpecJson), testsHash: hashText(JSON.stringify(approvedSpec.test_commands)), acceptanceHash: hashText(JSON.stringify(approvedSpec.acceptance_criteria)), detail
    };
    mkdirSync(finalRoot, { recursive: true });
    database.close(); database = null;
    cpSync(databasePath, path.join(finalRoot, "run.sqlite"));
    if (existsSync(artifactRoot)) cpSync(artifactRoot, path.join(finalRoot, "artifacts"), { recursive: true });
    json(path.join(finalRoot, "task-spec.json"), { approvedSpecJson, specHash: result.specHash, testsHash: result.testsHash, acceptanceHash: result.acceptanceHash });
    json(path.join(finalRoot, "source-state.json"), result.base);
    result.evidencePaths = ["run.sqlite", "task-spec.json", "source-state.json", "arm-result.json", "artifacts"].map((entry) => path.join(finalRoot, entry));
    result.evidenceManifestSha256 = detail.snapshot?.artifacts.find((artifact) => artifact.kind === "manifest")?.sha256 ?? null;
    result.evidenceFileHashes = Object.fromEntries(result.evidencePaths.slice(0, 3).map((file) => [path.basename(file), createHash("sha256").update(readFileSync(file)).digest("hex")]));
    atomicJson(path.join(finalRoot, "arm-result.json"), result);
    return result;
  } finally {
    database?.close();
    rmSync(stage, { recursive: true, force: true });
  }
}

const pairChecks = (baseline: ArmEvidence, variant: ArmEvidence) => ({
  sameBase: [baseline, variant].every((arm) => arm.base.canonicalSha === arm.base.taskBaseSha && arm.base.canonicalSha === arm.base.sourceInitialHead && arm.base.canonicalSha === arm.base.sourceFinalHead && arm.base.canonicalSha === arm.base.worktreeHead),
  isolated: baseline.base.worktreePath !== variant.base.worktreePath && baseline.base.managedRoot !== variant.base.managedRoot && isManagedDescendant(baseline.base.managedRoot, baseline.base.worktreePath) && isManagedDescendant(variant.base.managedRoot, variant.base.worktreePath),
  specConsistent: baseline.specHash === variant.specHash,
  testsConsistent: baseline.testsHash === variant.testsHash,
  acceptanceConsistent: baseline.acceptanceHash === variant.acceptanceHash,
  routeConsistent: baseline.runs.filter((run) => run.stage === "builder").every((run) => run.adapter === "codex" && run.workerClass === "strong" && run.isHighTier)
    && variant.runs.filter((run) => run.stage === "builder").every((run) => run.adapter === "cheap-worker" && run.workerClass === "cheap" && !run.isHighTier)
});
const persistentEvidenceComplete = (evidence: ArmEvidence): boolean => {
  if (!evidence.evidencePaths.every(existsSync)) return false;
  try {
    const finalRoot = path.dirname(evidence.evidencePaths[0]);
    const contained = (relative: string): string | null => {
      if (!relative || path.isAbsolute(relative)) return null;
      const target = path.resolve(finalRoot, relative);
      const lexical = path.relative(path.resolve(finalRoot), target);
      if (lexical === "" || lexical === ".." || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical) || !existsSync(target)) return null;
      try {
        const rootReal = realpathSync(finalRoot); const targetReal = realpathSync(target);
        const physical = path.relative(rootReal, targetReal);
        if (physical === "" || physical === ".." || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) return null;
        return targetReal;
      } catch { return null; }
    };
    for (const [relative, expected] of Object.entries(evidence.evidenceFileHashes)) {
      const target = contained(relative);
      if (target === null || statSync(target).isDirectory() || createHash("sha256").update(readFileSync(target)).digest("hex") !== expected) return false;
    }
    const taskSpec = JSON.parse(readFileSync(evidence.evidencePaths[1], "utf8")) as { approvedSpecJson?: string; specHash?: string; testsHash?: string; acceptanceHash?: string };
    if (taskSpec.approvedSpecJson !== evidence.specJson || taskSpec.specHash !== evidence.specHash || taskSpec.testsHash !== evidence.testsHash || taskSpec.acceptanceHash !== evidence.acceptanceHash) return false;
    const sourceState = JSON.parse(readFileSync(evidence.evidencePaths[2], "utf8")) as ArmEvidence["base"];
    if (JSON.stringify(sourceState) !== JSON.stringify(evidence.base)) return false;
    if (evidence.detail.snapshot) {
      const manifests = evidence.detail.snapshot.artifacts.filter((artifact) => artifact.kind === "manifest");
      if (manifests.length !== 1 || evidence.evidenceManifestSha256 !== manifests[0].sha256) return false;
      for (const artifact of evidence.detail.snapshot.artifacts) {
        const target = contained(path.join("artifacts", "attempts", evidence.detail.snapshot.attemptId, artifact.path));
        if (target === null || statSync(target).size !== artifact.sizeBytes || createHash("sha256").update(readFileSync(target)).digest("hex") !== artifact.sha256) return false;
      }
      const manifestTarget = contained(path.join("artifacts", "attempts", evidence.detail.snapshot.attemptId, manifests[0].path));
      if (manifestTarget === null || createHash("sha256").update(readFileSync(manifestTarget)).digest("hex") !== evidence.evidenceManifestSha256) return false;
    }
    const persisted = new AppDatabase(evidence.evidencePaths[0]);
    try { return persisted.listTaskRuns(evidence.taskId).length === evidence.runs.length; }
    finally { persisted.close(); }
  } catch { return false; }
};
const withSharedPlannerCost = (metrics: TaskDetailRecord["metrics"], planner: SharedPlannerEvidence): TaskDetailRecord["metrics"] => {
  const usage = planner.usageJson ? (() => { try { return JSON.parse(planner.usageJson) as { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }; } catch { return {}; } })() : {};
  const add = (a: number | null, b: number | null | undefined) => a === null || b === null || b === undefined ? null : a + b;
  return { ...metrics, runCount: metrics.runCount + 1, highTierCalls: metrics.highTierCalls + 1, highTierInputTokens: add(metrics.highTierInputTokens, usage.inputTokens), highTierOutputTokens: add(metrics.highTierOutputTokens, usage.outputTokens), highTierTotalTokens: add(metrics.highTierTotalTokens, usage.totalTokens), totalDurationMs: metrics.totalDurationMs + (planner.durationMs ?? 0), inputTokens: add(metrics.inputTokens, usage.inputTokens), outputTokens: add(metrics.outputTokens, usage.outputTokens), totalTokens: add(metrics.totalTokens, usage.totalTokens), usageAvailableRuns: metrics.usageAvailableRuns + (planner.usageJson ? 1 : 0), agentRunCount: metrics.agentRunCount + 1 };
};
const asSummary = (evidence: ArmEvidence, checks: ReturnType<typeof pairChecks>, planner: SharedPlannerEvidence, plannerAlreadyIncluded: boolean): EvaluationSummary => ({
  sameBase: checks.sameBase, isolated: checks.isolated, sourceClean: evidence.base.sourceClean, testsPassed: evidence.testsPassed,
  gatesPassed: evidence.gatePassed, finalVerdict: evidence.finalVerdict, p0Findings: evidence.p0Findings, p1Findings: evidence.p1Findings,
  metrics: plannerAlreadyIncluded ? evidence.metrics : withSharedPlannerCost(evidence.metrics, planner), failureDomain: evidence.failure?.domain ?? null, evidenceComplete: persistentEvidenceComplete(evidence) && checks.routeConsistent,
  specConsistent: checks.specConsistent, testsConsistent: checks.testsConsistent, acceptanceConsistent: checks.acceptanceConsistent,
  highTierUsageComplete: evidence.highTierUsageComplete
});
const sharedPlannerFor = (baseline: ArmEvidence): SharedPlannerEvidence => {
  const plannerRun = baseline.runs.find((run) => run.stage === "architect");
  const plannerArtifactRoot = plannerRun ? path.join(path.dirname(baseline.evidencePaths[0]), "artifacts", "runs", plannerRun.id) : "";
  return plannerRun
    ? { runId: plannerRun.id, status: plannerRun.status, model: plannerRun.model, reasoning: plannerRun.reasoning, durationMs: plannerRun.durationMs, usageJson: plannerRun.usageJson, failure: plannerRun.failureDomain && plannerRun.errorCode ? { domain: plannerRun.failureDomain, code: plannerRun.errorCode } : null, artifactPaths: ["final.json", "stdout.log", "stderr.log"].map((entry) => path.join(plannerArtifactRoot, entry)).filter(existsSync) }
    : { runId: "MISSING", status: "FAILED", model: null, reasoning: null, durationMs: null, usageJson: null, failure: { domain: "runtime", code: "PLANNER_EVIDENCE_MISSING" }, artifactPaths: [] };
};

describe("Phase 1.1 real A/B", () => {
  it.skipIf(process.env.RUN_REAL_AB !== "1" || process.env.PHASE1_AB_PHASE === "1.2")("runs controlled strong-only and strong-planner/cheap-worker pairs", async () => {
    const output = ensureOutput();
    mkdirSync(output);
    const strongModel = process.env.PHASE1_STRONG_MODEL ?? "gpt-5.6-sol";
    const cheapModel = process.env.PHASE1_CHEAP_MODEL ?? "gpt-5.5";
    const strongReasoning = process.env.PHASE1_STRONG_REASONING ?? "medium";
    if (strongReasoning !== "low" && strongReasoning !== "medium") throw new Error("PHASE1_STRONG_REASONING must be low or medium");
    const preflight = await runCodexRuntimePreflight({ models: [strongModel, cheapModel], artifactRoot: path.join(output, "preflight"), timeoutSeconds: 120 });
    if (!preflight.passed) {
      atomicJson(path.join(output, "evaluation.json"), { schemaVersion: "1.1", models: { strong: strongModel, cheap: cheapModel }, preflight, tasks: [], evaluation: { status: "BLOCKED", validCount: 0, reason: "RUNTIME_PREFLIGHT_FAILED" } });
      throw new Error("RUNTIME_PREFLIGHT_FAILED");
    }
    const pairs: Array<{ id: string; baseline: ArmEvidence; variant?: ArmEvidence }> = [];
    for (const task of controlledTasks) {
      const fixture = writeControlledFixture(task);
      try {
        await git(fixture, ["init"]);
        await git(fixture, ["config", "user.email", "phase11@example.invalid"]);
        await git(fixture, ["config", "user.name", "Phase 1.1"]);
        await git(fixture, ["add", "."]);
        await git(fixture, ["commit", "-m", "canonical"]);
        const canonicalSha = await git(fixture, ["rev-parse", "HEAD"]);
        const baseline = await runArm(task, "baseline", fixture, canonicalSha, output, strongModel, cheapModel, strongReasoning);
        const pair: { id: string; baseline: ArmEvidence; variant?: ArmEvidence } = { id: task.id, baseline };
        pairs.push(pair);
        atomicJson(path.join(output, "evaluation.partial.json"), pairs);
        if (baseline.failure?.domain === "runtime" || baseline.failure?.domain === "user") break;
        const plannedSpec = pair.baseline.specJson ? JSON.parse(pair.baseline.specJson) as ReturnType<typeof taskSpecFor> : undefined;
        pair.variant = await runArm(task, "variant", fixture, canonicalSha, output, strongModel, cheapModel, strongReasoning, plannedSpec);
        atomicJson(path.join(output, "evaluation.partial.json"), pairs);
        if (pair.variant.failure?.domain === "runtime" || pair.variant.failure?.domain === "user") break;
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    }
    const completed = pairs.filter((pair): pair is { id: string; baseline: ArmEvidence; variant: ArmEvidence } => pair.variant !== undefined);
    const evaluatedPairs = completed.map((pair) => {
      const checks = pairChecks(pair.baseline, pair.variant);
      const sharedPlanner = sharedPlannerFor(pair.baseline);
      if (sharedPlanner.status !== "SUCCEEDED" || sharedPlanner.failure?.domain === "runtime" || sharedPlanner.failure?.domain === "user") { checks.sameBase = false; }
      return { id: pair.id, checks, sharedPlanner, baseline: asSummary(pair.baseline, checks, sharedPlanner, true), variant: asSummary(pair.variant, checks, sharedPlanner, false) };
    });
    const evaluation = evaluatePhase11(evaluatedPairs.map(({ id, baseline, variant }) => ({ id, baseline, variant })));
    atomicJson(path.join(output, "evaluation.json"), { schemaVersion: "1.1", models: { strong: strongModel, cheap: cheapModel, strongReasoning }, preflight, tasks: pairs, pairChecks: evaluatedPairs.map(({ id, checks, sharedPlanner }) => ({ id, ...checks, sharedPlanner })), evaluation });
    expect(evaluation.status).toBe("PASS");
  }, 30 * 60 * 1000);
});

describe("Phase 1.2 real A/B", () => {
  it.skipIf(!realAbEnabled() || process.env.PHASE1_AB_PHASE !== "1.2")("runs the preregistered development or holdout population", async () => {
    const population = process.env.PHASE1_AB_POPULATION;
    if (population !== "development" && population !== "holdout" && population !== "all") throw new Error("PHASE1_AB_POPULATION must be development, holdout, or all");
    const tasks = asControlledTasks(phase12TaskPopulation(population));
    expect(tasks.length).toBe(population === "development" ? 4 : population === "holdout" ? 6 : 10);
    // The run11 driver below is intentionally shared: each population receives a new output directory.
    const output = ensureOutput();
    mkdirSync(output);
    const strongModel = process.env.PHASE1_STRONG_MODEL ?? "gpt-5.6-sol";
    const cheapModel = process.env.PHASE1_CHEAP_MODEL ?? "gpt-5.5";
    const strongReasoning = process.env.PHASE1_STRONG_REASONING ?? "medium";
    if (strongReasoning !== "low" && strongReasoning !== "medium") throw new Error("PHASE1_STRONG_REASONING must be low or medium");
    const preflight = await runCodexRuntimePreflight({ models: [strongModel, cheapModel], artifactRoot: path.join(output, "preflight"), timeoutSeconds: 120 });
    if (!preflight.passed) {
      const evidence = buildPhase12BlockedEvidence({ population, models: { strong: strongModel, cheap: cheapModel, strongReasoning }, preflight, importedDevelopment: false, pairs: [], pairChecks: [], taskEvidence: [], failureCode: "RUNTIME_PREFLIGHT_FAILED" });
      atomicJson(path.join(output, "evaluation.json"), evidence);
      throw new Error("RUNTIME_PREFLIGHT_FAILED");
    }
    const pairs: Phase12Pair[] = [];
    const evidenceChecks: Phase12PairChecksEvidence[] = [];
    const taskEvidence: Phase12TaskEvidence[] = [];
    let fatalFailure: FailureEvidence = null;
    let importedDevelopment = false;
    if (population === "holdout" || population === "all") {
      const source = process.env.PHASE1_AB_DEVELOPMENT_EVIDENCE;
      if (!source && population !== "all") throw new Error("PHASE1_AB_DEVELOPMENT_EVIDENCE is required for holdout-only merge");
      let development: Phase12EvidenceDocument | undefined;
      if (source) {
        development = importPhase12DevelopmentEvidence(JSON.parse(readFileSync(path.resolve(source), "utf8")), { strong: strongModel, cheap: cheapModel, strongReasoning });
        pairs.push(...development.pairs);
        evidenceChecks.push(...development.pairChecks);
        taskEvidence.push(...development.taskEvidence);
        importedDevelopment = true;
      }
      const priorPath = process.env.PHASE1_AB_PRIOR_HOLDOUT_EVIDENCE;
      if (priorPath) {
        if (population !== "holdout" || !development) throw new Error("PHASE1_AB_PRIOR_HOLDOUT_EVIDENCE requires holdout population and development evidence");
        const prior = importPhase12HoldoutEvidence(JSON.parse(readFileSync(path.resolve(priorPath), "utf8")), { strong: strongModel, cheap: cheapModel, strongReasoning }, development);
        pairs.length = 0; evidenceChecks.length = 0; taskEvidence.length = 0;
        pairs.push(...prior.pairs);
        evidenceChecks.push(...prior.pairChecks);
        taskEvidence.push(...prior.taskEvidence);
        const remaining = asControlledTasks(selectPhase12HoldoutTasks(prior));
        tasks.splice(0, tasks.length, ...remaining);
      }
    }
    for (const task of tasks) {
      if (pairs.some((pair) => pair.id === task.id)) continue;
      const fixture = writeControlledFixture(task);
      try {
        await git(fixture, ["init"]); await git(fixture, ["config", "user.email", "phase12@example.invalid"]); await git(fixture, ["config", "user.name", "Phase 1.2"]); await git(fixture, ["add", "."]); await git(fixture, ["commit", "-m", "canonical"]);
        const canonicalSha = await git(fixture, ["rev-parse", "HEAD"]);
        const baseline = await runArm(task, "baseline", fixture, canonicalSha, output, strongModel, cheapModel, strongReasoning);
        if (baseline.failure?.domain === "runtime" || baseline.failure?.domain === "user") {
          taskEvidence.push({ id: task.id, population: task.id.startsWith("HOLDOUT_") ? "holdout" : "development", baseline });
          fatalFailure = baseline.failure;
          break;
        }
        const plannedSpec = JSON.parse(baseline.specJson) as ReturnType<typeof taskSpecFor>;
        const variant = await runArm(task, "variant", fixture, canonicalSha, output, strongModel, cheapModel, strongReasoning, plannedSpec);
        if (variant.failure?.domain === "runtime" || variant.failure?.domain === "user") {
          taskEvidence.push({ id: task.id, population: task.id.startsWith("HOLDOUT_") ? "holdout" : "development", baseline, variant });
          fatalFailure = variant.failure;
          break;
        }
        const checks = pairChecks(baseline, variant);
        const sharedPlanner = sharedPlannerFor(baseline);
        const taskPopulation = task.id.startsWith("HOLDOUT_") ? "holdout" : "development";
        const artifactConsistent = persistentEvidenceComplete(baseline) && persistentEvidenceComplete(variant);
        pairs.push({ id: task.id, population: taskPopulation, baseline: asSummary(baseline, checks, sharedPlanner, true), variant: asSummary(variant, checks, sharedPlanner, false), firstAttemptSuccess: variant.detail.attempt?.number === 1 && variant.taskSuccess, eventualSuccess: variant.taskSuccess, sharedPlannerCalls: 1, humanIntervention: variant.humanIntervention, routeConsistent: checks.routeConsistent, artifactConsistent });
        evidenceChecks.push({ id: task.id, population: taskPopulation, ...checks, artifactConsistent, sharedPlanner });
        taskEvidence.push({ id: task.id, population: taskPopulation, baseline, variant });
        atomicJson(path.join(output, "evaluation.partial.json"), { schemaVersion: "1.2", population, pairs });
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    }
    if (fatalFailure) {
      const evidence = buildPhase12BlockedEvidence({ population, models: { strong: strongModel, cheap: cheapModel, strongReasoning }, preflight, importedDevelopment, pairs, pairChecks: evidenceChecks, taskEvidence, failureCode: fatalFailure.code });
      atomicJson(path.join(output, "evaluation.json"), evidence);
      throw new Error(`RUNTIME_OR_USER_FAILURE:${fatalFailure.code}`);
    }
    const evaluation = evaluatePhase12(pairs);
    const evidence: Phase12EvidenceDocument = buildPhase12Evidence({ population, models: { strong: strongModel, cheap: cheapModel, strongReasoning }, preflight, importedDevelopment, pairs, pairChecks: evidenceChecks, taskEvidence });
    atomicJson(path.join(output, "evaluation.json"), { ...evidence, evaluation });
    expect(isCompletedPhase12EvaluationStatus(evaluation.status)).toBe(true);
  }, 30 * 60 * 1000);
});
