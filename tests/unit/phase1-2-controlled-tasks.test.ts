import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { buildPhase12BlockedEvidence, buildPhase12Evidence, importPhase12DevelopmentEvidence, importPhase12HoldoutEvidence, phase12DevelopmentTasks, phase12HoldoutTasks, phase12TaskHash, phase12TaskPopulation, phase12Tasks, selectPhase12HoldoutTasks, verifyPhase12ArmFileEvidence, type Phase12EvidenceDocument, type Phase12Models } from "../manual/phase1-2-controlled-tasks.js";
import { isCompletedPhase12EvaluationStatus } from "../manual/phase1-real-ab.test.js";

describe("Phase 1.2 completed evaluation status", () => {
  it.each(["PASS", "PARTIAL", "FAIL", "BLOCKED"] as const)("accepts %s", (status) => {
    expect(isCompletedPhase12EvaluationStatus(status)).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(isCompletedPhase12EvaluationStatus("UNKNOWN" as never)).toBe(false);
  });
});

const models: Phase12Models = { strong: "gpt-5.6-sol", cheap: "gpt-5.5", strongReasoning: "medium" };
const summary = () => ({
  sameBase: true, isolated: true, sourceClean: true, testsPassed: true, gatesPassed: true, finalVerdict: "PASS",
  p0Findings: 0, p1Findings: 0, metrics: { highTierCalls: 2 }, evidenceComplete: true,
  specConsistent: true, testsConsistent: true, acceptanceConsistent: true, highTierUsageComplete: false
});
const pair = (id: string, population: "development" | "holdout") => ({ id, population, baseline: summary(), variant: summary(), eventualSuccess: true, firstAttemptSuccess: true, sharedPlannerCalls: 1, humanIntervention: 0, routeConsistent: true, artifactConsistent: true });
const check = (id: string, population: "development" | "holdout") => ({ id, population, sameBase: true, isolated: true, specConsistent: true, testsConsistent: true, acceptanceConsistent: true, routeConsistent: true, artifactConsistent: true, sharedPlanner: { runId: `${id}-planner`, status: "SUCCEEDED", model: models.strong, reasoning: models.strongReasoning, durationMs: 1, usageJson: "{}", failure: null, artifactPaths: [`tasks/${id}/baseline/artifacts/runs/${id}-planner/final.json`] } });
const arm = (id: string, armName: "baseline" | "variant") => ({ arm: armName, taskId: id, evidencePaths: [`tasks/${id}/${armName}/run.sqlite`] });
const document = (population: "development" | "holdout" | "all") => {
  const selected = phase12TaskPopulation(population === "holdout" ? "all" : population);
  return buildPhase12Evidence({ population, models, preflight: { passed: true }, importedDevelopment: false, pairs: selected.map((task) => pair(task.id, task.id.startsWith("HOLDOUT_") ? "holdout" : "development")) as never, pairChecks: selected.map((task) => check(task.id, task.id.startsWith("HOLDOUT_") ? "holdout" : "development")), taskEvidence: selected.map((task) => ({ id: task.id, population: task.id.startsWith("HOLDOUT_") ? "holdout" : "development", baseline: arm(task.id, "baseline"), variant: arm(task.id, "variant") })) });
};

const completeHoldoutArm = (root: string, id: string, arm: "baseline" | "variant") => {
  const armRoot = path.join(root, id, arm);
  const attemptRoot = path.join(armRoot, "artifacts", "attempts", "ATTEMPT");
  mkdirSync(attemptRoot, { recursive: true });
  const databasePath = path.join(armRoot, "run.sqlite");
  const database = new AppDatabase(databasePath);
  database.createProject({ id: `${id}-${arm}-project`, name: id, repoPath: armRoot, repoRealPath: armRoot, lastSeenHead: "a".repeat(40) });
  database.createTask({ id, projectId: `${id}-${arm}-project`, title: id, requestText: id, status: "DRAFT", baseSha: "a".repeat(40) });
  database.close();
  const base = { canonicalSha: "a".repeat(40), taskBaseSha: "a".repeat(40), sourceInitialHead: "a".repeat(40), sourceFinalHead: "a".repeat(40), sourceClean: true, worktreeHead: "a".repeat(40), worktreePath: path.join(armRoot, "worktree"), managedRoot: path.join(armRoot, "managed"), diffSha256: null };
  const approvedSpecJson = "{}";
  writeFileSync(path.join(armRoot, "task-spec.json"), JSON.stringify({ approvedSpecJson, specHash: "spec", testsHash: "tests", acceptanceHash: "accept" }));
  writeFileSync(path.join(armRoot, "source-state.json"), JSON.stringify(base));
  const manifest = { schema_version: "1.0", task_id: id, attempt_id: "ATTEMPT", base_sha: "a".repeat(40), branch: `phase1/${id}/${arm}`, worktree_head: "a".repeat(40), artifacts: [] };
  const manifestPath = path.join(attemptRoot, "evidence-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const manifestBytes = readFileSync(manifestPath);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  const manifestArtifact = { kind: "manifest", path: "evidence-manifest.json", sizeBytes: manifestBytes.length, sha256: manifestHash };
  const snapshot = { attemptId: "ATTEMPT", branch: manifest.branch, worktreePath: base.worktreePath, worker: {}, git: { head: "a".repeat(40), changedFiles: [], diff: "", stat: "" }, artifacts: [manifestArtifact] };
  const detail = { snapshot, runs: [], metrics: { highTierCalls: 0 }, task: { status: "PASSED" } };
  const armEvidence: any = { arm, taskId: id, taskSuccess: true, testsPassed: true, gatePassed: true, finalVerdict: "PASS", p0Findings: 0, p1Findings: 0, runs: [], metrics: { highTierCalls: 0 }, highTierUsageComplete: false, failure: null, base, evidencePaths: [databasePath, path.join(armRoot, "task-spec.json"), path.join(armRoot, "source-state.json"), path.join(armRoot, "arm-result.json"), path.join(armRoot, "artifacts")], evidenceFileHashes: {}, evidenceManifestSha256: manifestHash, humanIntervention: 0, specJson: approvedSpecJson, specHash: "spec", testsHash: "tests", acceptanceHash: "accept", detail };
  armEvidence.evidenceFileHashes = Object.fromEntries(["run.sqlite", "task-spec.json", "source-state.json"].map((file) => [file, createHash("sha256").update(readFileSync(path.join(armRoot, file))).digest("hex")]));
  writeFileSync(path.join(armRoot, "arm-result.json"), JSON.stringify(armEvidence));
  expect(existsSync(path.join(armRoot, "arm-result.json"))).toBe(true);
  return armEvidence;
};

describe("Phase 1.2 preregistered controlled tasks", () => {
  it("rejects tampered artifacts, manifest hashes, and path traversal", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "phase12-evidence-"));
    const attempt = path.join(root, "attempts", "A");
    mkdirSync(attempt, { recursive: true });
    const artifactPath = "stdout.log";
    const manifestPath = "evidence-manifest.json";
    writeFileSync(path.join(attempt, artifactPath), "trusted\n");
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const manifest = { schema_version: "1.0", task_id: "T", attempt_id: "A", base_sha: "base", branch: "branch", worktree_head: "head", artifacts: [{ kind: "stdout", path: artifactPath, sizeBytes: 8, sha256: hash(path.join(attempt, artifactPath)) }] };
    writeFileSync(path.join(attempt, manifestPath), JSON.stringify(manifest));
    const evidence = { armRoot: root, attemptRoot: attempt, fileHashes: {}, artifacts: [{ kind: "stdout", path: artifactPath, sizeBytes: 8, sha256: hash(path.join(attempt, artifactPath)) }, { kind: "manifest", path: manifestPath, sizeBytes: readFileSync(path.join(attempt, manifestPath)).length, sha256: hash(path.join(attempt, manifestPath)) }], manifestContext: { taskId: "T", attemptId: "A", baseSha: "base", branch: "branch", worktreeHead: "head" } };
    expect(verifyPhase12ArmFileEvidence(evidence)).toBe(true);
    writeFileSync(path.join(attempt, artifactPath), "tampered\n");
    expect(verifyPhase12ArmFileEvidence(evidence)).toBe(false);
    writeFileSync(path.join(attempt, artifactPath), "trusted\n");
    const escaped = { ...evidence, artifacts: [{ ...evidence.artifacts[0], path: "../../outside" }, evidence.artifacts[1]] };
    expect(verifyPhase12ArmFileEvidence(escaped)).toBe(false);
    const forgedManifest = { ...evidence, artifacts: [evidence.artifacts[0], { ...evidence.artifacts[1], sha256: "0".repeat(64) }] };
    expect(verifyPhase12ArmFileEvidence(forgedManifest)).toBe(false);
  });

  it("freezes four development and six unseen holdout definitions", () => {
    expect(phase12DevelopmentTasks).toHaveLength(4);
    expect(phase12HoldoutTasks).toHaveLength(6);
    expect(new Set(phase12Tasks.map((task) => task.id)).size).toBe(10);
    expect(phase12DevelopmentTasks.map((task) => task.id)).toEqual(["DEV_COUNTER", "DEV_CONFIG", "DEV_FORMAT", "PATH_REPORT"]);
    expect(phase12HoldoutTasks.map((task) => task.id)).toEqual(["HOLDOUT_SUM", "HOLDOUT_CLAMP", "HOLDOUT_UNIQUE", "HOLDOUT_PARSE_BOOL", "HOLDOUT_GROUP", "HOLDOUT_LINES"]);
  });

  it("has deterministic, distinct definition hashes and scoped verification", () => {
    const hashes = phase12Tasks.map(phase12TaskHash);
    expect(new Set(hashes).size).toBe(10);
    for (const task of phase12Tasks) {
      expect(task.file).toMatch(/^src\/[a-z0-9-]+\.mjs$/);
      expect(task.source).toContain("TODO");
      expect(task.verification).toContain("assert");
      expect(task.criteria.length).toBeGreaterThan(1);
    }
  });

  it("writes population-scoped hashes so development cannot claim the holdout definitions", () => {
    expect(Object.keys(document("development").definitionHashes)).toEqual(phase12DevelopmentTasks.map((task) => task.id));
    expect(Object.keys(document("holdout").definitionHashes)).toEqual(phase12Tasks.map((task) => task.id));
    expect(Object.keys(document("all").definitionHashes)).toEqual(phase12Tasks.map((task) => task.id));
  });

  it("imports only complete current-model development evidence and retains raw evidence", () => {
    const evidence = document("development");
    expect(importPhase12DevelopmentEvidence(evidence, models).taskEvidence).toEqual(evidence.taskEvidence);
    const wrongModels = structuredClone(evidence);
    wrongModels.models.cheap = "other";
    expect(() => importPhase12DevelopmentEvidence(wrongModels, models)).toThrow("Invalid development evaluation evidence");
    const allHashes = structuredClone(evidence) as Phase12EvidenceDocument;
    allHashes.definitionHashes.HOLDOUT_SUM = phase12TaskHash(phase12HoldoutTasks[0]);
    expect(() => importPhase12DevelopmentEvidence(allHashes, models)).toThrow("Invalid development evaluation evidence");
    const incomplete = structuredClone(evidence);
    incomplete.pairChecks.pop();
    expect(() => importPhase12DevelopmentEvidence(incomplete, models)).toThrow("Invalid development evaluation evidence");
    const forged = structuredClone(evidence);
    (forged.taskEvidence[0].baseline as { taskId: string }).taskId = "HOLDOUT_SUM";
    expect(() => importPhase12DevelopmentEvidence(forged, models)).toThrow("Invalid development evaluation evidence");
  });

  it("resumes from completed holdout pairs and selects only the remaining frozen tasks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "phase12-resume-"));
    const development = document("development");
    const baseline = completeHoldoutArm(root, "HOLDOUT_SUM", "baseline");
    const variant = completeHoldoutArm(root, "HOLDOUT_SUM", "variant");
    const resumedPair = { ...pair("HOLDOUT_SUM", "holdout"), baseline: summary(), variant: summary() };
    const resumedChecks = check("HOLDOUT_SUM", "holdout");
    mkdirSync(path.join(root, "planner"), { recursive: true });
    writeFileSync(path.join(root, "planner", "final.json"), "{}\n");
    resumedChecks.sharedPlanner.artifactPaths = [path.join(root, "planner", "final.json")];
    const prior = buildPhase12BlockedEvidence({
      population: "holdout", models, preflight: { passed: true }, importedDevelopment: true,
      pairs: [...development.pairs, resumedPair] as never,
      pairChecks: [...development.pairChecks, resumedChecks],
      taskEvidence: [...development.taskEvidence, { id: "HOLDOUT_SUM", population: "holdout", baseline, variant }],
      failureCode: "PROCESS_TIMEOUT"
    });
    const imported = importPhase12HoldoutEvidence(prior, models, development);
    expect(imported.pairs.map((entry) => entry.id)).toEqual([...phase12DevelopmentTasks.map((task) => task.id), "HOLDOUT_SUM"]);
    expect(selectPhase12HoldoutTasks(imported).map((task) => task.id)).toEqual(["HOLDOUT_CLAMP", "HOLDOUT_UNIQUE", "HOLDOUT_PARSE_BOOL", "HOLDOUT_GROUP", "HOLDOUT_LINES"]);
  });

  it.each([
    ["model mismatch", (value: any) => { value.models.cheap = "other"; }],
    ["definition hash mismatch", (value: any) => { value.definitionHashes.HOLDOUT_SUM = "0".repeat(64); }],
    ["tampered artifact hash", (value: any) => { value.taskEvidence[4].baseline.evidenceFileHashes["run.sqlite"] = "0".repeat(64); }],
    ["unknown task", (value: any) => { value.pairs[4].id = "UNKNOWN"; }],
    ["duplicate task", (value: any) => { value.pairs[4].id = "DEV_COUNTER"; }],
    ["out-of-order task", (value: any) => { [value.pairs[3], value.pairs[4]] = [value.pairs[4], value.pairs[3]]; }],
    ["incomplete task-quality failure", (value: any) => {
      value.taskEvidence.push({
        id: "HOLDOUT_CLAMP",
        population: "holdout",
        baseline: value.taskEvidence[4].baseline,
        variant: { ...value.taskEvidence[4].variant, failure: { domain: "task", code: "TEST_FAILED" } }
      });
    }]
  ])("rejects %s during holdout resume", (_name, mutate) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "phase12-resume-reject-"));
    const development = document("development");
    const baseline = completeHoldoutArm(root, "HOLDOUT_SUM", "baseline");
    const variant = completeHoldoutArm(root, "HOLDOUT_SUM", "variant");
    mkdirSync(path.join(root, "planner"), { recursive: true });
    writeFileSync(path.join(root, "planner", "final.json"), "{}\n");
    const resumedChecks = check("HOLDOUT_SUM", "holdout");
    resumedChecks.sharedPlanner.artifactPaths = [path.join(root, "planner", "final.json")];
    const prior = buildPhase12BlockedEvidence({
      population: "holdout", models, preflight: { passed: true }, importedDevelopment: true,
      pairs: [...development.pairs, pair("HOLDOUT_SUM", "holdout")] as never,
      pairChecks: [...development.pairChecks, resumedChecks],
      taskEvidence: [...development.taskEvidence, { id: "HOLDOUT_SUM", population: "holdout", baseline, variant }],
      failureCode: "PROCESS_TIMEOUT"
    });
    const forged = structuredClone(prior);
    mutate(forged);
    expect(() => importPhase12HoldoutEvidence(forged, models, development)).toThrow(/Invalid holdout/);
  });

  it("does not treat a prior runtime-incomplete task as a completed pair", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "phase12-runtime-resume-"));
    const development = document("development");
    const baseline = completeHoldoutArm(root, "HOLDOUT_SUM", "baseline");
    baseline.failure = { domain: "runtime", code: "PROCESS_TIMEOUT" };
    writeFileSync(baseline.evidencePaths[3], JSON.stringify(baseline));
    const prior = buildPhase12BlockedEvidence({
      population: "holdout", models, preflight: { passed: true }, importedDevelopment: true,
      pairs: development.pairs as never, pairChecks: development.pairChecks,
      taskEvidence: [...development.taskEvidence, { id: "HOLDOUT_SUM", population: "holdout", baseline }],
      failureCode: "PROCESS_TIMEOUT"
    });
    const imported = importPhase12HoldoutEvidence(prior, models, development);
    expect(imported.pairs.some((entry) => entry.id === "HOLDOUT_SUM")).toBe(false);
    expect(selectPhase12HoldoutTasks(imported)[0].id).toBe("HOLDOUT_SUM");
  });

  it("records a first-arm runtime timeout as BLOCKED evidence without requiring a full population", () => {
    const id = phase12DevelopmentTasks[0].id;
    const blocked = buildPhase12BlockedEvidence({
      population: "development", models, preflight: { passed: true }, importedDevelopment: false,
      pairs: [], pairChecks: [], taskEvidence: [{ id, population: "development", baseline: arm(id, "baseline") }],
      failureCode: "PROCESS_TIMEOUT"
    });
    expect(blocked.evaluation).toEqual({ status: "BLOCKED", validCount: 0, reason: "RUNTIME_OR_USER_FAILURE", failureCode: "PROCESS_TIMEOUT" });
    expect(blocked.taskEvidence).toHaveLength(1);
    expect(blocked.taskEvidence[0].variant).toBeUndefined();
    expect(Object.keys(blocked.definitionHashes)).toEqual(phase12DevelopmentTasks.map((task) => task.id));
  });
});
