import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import type { AgentExecution, PlannerAgentAdapter } from "../../src/main/adapters/agent-adapter.js";
import type { ProcessResult } from "../../src/main/process/runner.js";
import { readBoundedContext } from "../../src/shared/core/bounded-context.js";
import { parseCodexTerminalEvents } from "../../src/shared/core/codex-terminal-events.js";
import { classifyProcessResult } from "../../src/shared/core/failure-taxonomy.js";
import {
  evaluatePhase19Run,
  evaluatePhase19Sample,
  PHASE_1_9_CASE_IDS,
  validatePhase19ExecutionApproval,
  validatePhase19Registration,
  type Phase19ExecutionApproval,
  type Phase19FixtureState,
  type Phase19Registration,
  type Phase19Sample,
  type Phase19RunDecision,
} from "../../src/shared/core/phase1-9-runtime-certification.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";
import { readPhase19FixtureState } from "./phase1-9-runtime-certification.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
function assert(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }

type Seal = {
  version: string;
  execution_authorized: boolean;
  registration_sha256: string;
  schema_sha256: string;
  artifacts: Array<{ path: string; sha256: string }>;
  registered_case_count: number;
  fixture_count: number;
};
type Fixture = { id: string; repo: string; baseSha: string; baseTree: string; files: Record<string, string> };
type FixtureManifest = { version: string; fixtures: Fixture[] };
export type Phase110RuntimeIdentity = { executable: string; version: string; sha256: string };
export type Phase110Ready = {
  registration: Phase19Registration;
  fixtures: ReadonlyMap<string, string>;
  fixtureHashes: ReadonlyMap<string, Readonly<Record<string, string>>>;
  executable: string;
  schemaPath: string;
  outputRoot: string;
  sealSha256: string;
};
export type Phase110PreflightInput = {
  sourceRoot: string;
  preparationRoot: string;
  outputRoot: string;
  expectedSealSha256: string;
  approval: Phase19ExecutionApproval;
  runtime: Phase110RuntimeIdentity;
  schemaPath: string;
};
type Phase110Readiness = {
  version: string;
  git_head: string;
  preparation_seal_sha256: string;
  files: Array<{ path: string; sha256: string }>;
};

/** Bind a future approval to the exact reviewed source, documentation and Git base. */
export function verifyPhase110Readiness(sourceRoot: string, readinessHash: string, sealHash: string): void {
  assert(/^[0-9a-f]{64}$/.test(readinessHash), "PHASE110_READINESS_HASH_REQUIRED");
  const readinessCandidates = [
    path.join(sourceRoot, "phase1-10-evidence", "offline-readiness-final.json"),
    path.join(sourceRoot, "phase1-10-evidence", "offline-readiness-revision1.json"),
    path.join(sourceRoot, "phase1-10-requalification-evidence", "offline-readiness.json"),
    path.join(sourceRoot, "phase1-10-requalification-evidence", "offline-readiness-final.json"),
    path.join(sourceRoot, "phase1-10-run3-evidence", "offline-readiness-final.json"),
  ];
  const readinessPath = readinessCandidates.find((candidate) => existsSync(candidate) && sha256(readFileSync(candidate)) === readinessHash);
  assert(readinessPath, "PHASE110_READINESS_HASH_DRIFT");
  const readiness = readJson<Phase110Readiness>(readinessPath);
  assert(readiness.version === "phase1.10-offline-readiness.v1" && readiness.preparation_seal_sha256 === sealHash && readiness.files.length > 0, "PHASE110_READINESS_INVALID");
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true }).trim();
  assert(gitHead === readiness.git_head, "PHASE110_GIT_HEAD_DRIFT");
  for (const file of readiness.files) {
    const target = path.resolve(sourceRoot, file.path);
    const relative = path.relative(sourceRoot, target);
    assert(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "PHASE110_READINESS_PATH_INVALID");
    assert(sha256(readFileSync(target)) === file.sha256, `PHASE110_SOURCE_HASH_DRIFT:${file.path}`);
  }
}

/** Read-only preflight. Every check runs before a model process or output root is created. */
export function verifyPhase110Ready(input: Phase110PreflightInput): Phase110Ready {
  const sourceRoot = path.resolve(input.sourceRoot);
  const preparationRoot = path.resolve(input.preparationRoot);
  const outputRoot = path.resolve(input.outputRoot);
  assert(path.isAbsolute(input.sourceRoot) && path.isAbsolute(input.preparationRoot) && path.isAbsolute(input.outputRoot), "PHASE110_ABSOLUTE_PATH_REQUIRED");
  const oldPreparationRoot = path.join(sourceRoot, "phase1-9-evidence", "preparation-20260926");
  const newPreparationRoot = path.join(sourceRoot, "phase1-10-requalification-evidence", "preparation-run1");
  const oldOutputRoot = path.join(sourceRoot, "phase1-10-runtime-certification-run1");
  const newOutputRoot = path.join(sourceRoot, "phase1-10-runtime-certification-run2");
  const run3PreparationRoot = path.join(sourceRoot, "phase1-10-run3-evidence", "preparation-run1");
  const run3OutputRoot = path.join(sourceRoot, "phase1-10-runtime-certification-run3");
  assert((preparationRoot === oldPreparationRoot && outputRoot === oldOutputRoot) || (preparationRoot === newPreparationRoot && outputRoot === newOutputRoot) || (preparationRoot === run3PreparationRoot && outputRoot === run3OutputRoot), "PHASE110_OUTPUT_ROOT_INVALID");
  assert(!existsSync(outputRoot), "PHASE110_OUTPUT_ROOT_NOT_FRESH");
  const approvalErrors = validatePhase19ExecutionApproval(input.approval, { preparationSealSha256: input.expectedSealSha256, outputRoot, outputRootExists: false });
  assert(approvalErrors.length === 0, `PHASE110_APPROVAL_INVALID:${approvalErrors.join(",")}`);
  assert(input.approval.max_requests === PHASE_1_9_CASE_IDS.length, "PHASE110_REQUEST_BUDGET_INVALID");
  const sealPath = path.join(preparationRoot, "preparation-seal.json");
  assert(existsSync(sealPath), "PHASE110_SEAL_MISSING");
  const sealBytes = readFileSync(sealPath);
  assert(sha256(sealBytes) === input.expectedSealSha256, "PHASE110_SEAL_HASH_DRIFT");
  const seal = JSON.parse(sealBytes.toString("utf8")) as Seal;
  assert(seal.version === "phase1.9-preparation-seal.v1" && seal.execution_authorized === false && seal.registered_case_count === 10 && seal.fixture_count === 10, "PHASE110_SEAL_INVALID");
  assert(seal.artifacts.length === 2 && new Set(seal.artifacts.map((item) => item.path)).size === 2, "PHASE110_SEAL_ARTIFACTS_INVALID");
  const expectedArtifacts = new Set(["preregistration.json", "fixture-manifest.json"]);
  for (const artifact of seal.artifacts) {
    assert(expectedArtifacts.has(artifact.path), "PHASE110_SEAL_ARTIFACTS_INVALID");
    assert(sha256(readFileSync(path.join(preparationRoot, artifact.path))) === artifact.sha256, `PHASE110_ARTIFACT_HASH_DRIFT:${artifact.path}`);
  }
  const registrationPath = path.join(preparationRoot, "preregistration.json");
  assert(sha256(readFileSync(registrationPath)) === seal.registration_sha256, "PHASE110_REGISTRATION_HASH_DRIFT");
  assert(sha256(readFileSync(input.schemaPath)) === seal.schema_sha256, "PHASE110_SCHEMA_HASH_DRIFT");
  const registration = readJson<Phase19Registration>(registrationPath);
  const registrationErrors = validatePhase19Registration(registration);
  assert(registrationErrors.length === 0, `PHASE110_REGISTRATION_INVALID:${registrationErrors.join(",")}`);
  const fixtureManifest = readJson<FixtureManifest>(path.join(preparationRoot, "fixture-manifest.json"));
  assert(fixtureManifest.version === "phase1.9-fixtures.v1" && fixtureManifest.fixtures.length === 10, "PHASE110_FIXTURE_MANIFEST_INVALID");
  const fixtures = new Map<string, string>();
  const fixtureHashes = new Map<string, Readonly<Record<string, string>>>();
  for (const [index, fixture] of fixtureManifest.fixtures.entries()) {
    const item = registration.cases[index];
    assert(item?.id === fixture.id && item.baseSha === fixture.baseSha && item.baseTree === fixture.baseTree, `PHASE110_FIXTURE_MAPPING_DRIFT:${fixture.id}`);
    assert(fixture.repo === `fixtures/${fixture.id}`, `PHASE110_FIXTURE_PATH_INVALID:${fixture.id}`);
    const repo = path.join(preparationRoot, fixture.repo);
    assert(realpathSync(repo) === repo, `PHASE110_FIXTURE_SYMLINK:${fixture.id}`);
    const state = readPhase19FixtureState(repo);
    assert(state.head === item.baseSha && state.tree === item.baseTree && state.status === "", `PHASE110_FIXTURE_DRIFT:${fixture.id}`);
    for (const file of item.fixtureFiles) {
      assert(Object.hasOwn(fixture.files, file) && sha256(readFileSync(path.join(repo, file))) === fixture.files[file], `PHASE110_FIXTURE_FILE_DRIFT:${fixture.id}:${file}`);
    }
    assert(Object.keys(fixture.files).length === item.fixtureFiles.length, `PHASE110_FIXTURE_FILE_SET_DRIFT:${fixture.id}`);
    const context = readBoundedContext(repo, [...item.contextPaths]);
    assert(context.sha256 === item.contextSha256 && context.totalBytes === item.contextBytes, `PHASE110_CONTEXT_DRIFT:${fixture.id}`);
    assert(sha256(item.prompt) === item.promptSha256 && item.schemaSha256 === seal.schema_sha256, `PHASE110_PROMPT_OR_SCHEMA_DRIFT:${fixture.id}`);
    fixtures.set(item.id, repo);
    fixtureHashes.set(item.id, fixture.files);
  }
  assert(path.isAbsolute(input.runtime.executable) && path.isAbsolute(realpathSync(input.runtime.executable)), "PHASE110_EXECUTABLE_INVALID");
  assert(sha256(readFileSync(input.runtime.executable)) === input.runtime.sha256, "PHASE110_EXECUTABLE_HASH_DRIFT");
  const version = spawnSync(input.runtime.executable, ["--version"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000 });
  assert(version.status === 0 && String(version.stdout).trim() === input.runtime.version, "PHASE110_EXECUTABLE_VERSION_DRIFT");
  return { registration, fixtures, fixtureHashes, executable: input.runtime.executable, schemaPath: input.schemaPath, outputRoot, sealSha256: input.expectedSealSha256 };
}

const cleanupDurationMs = (process: ProcessResult): number => {
  if (!process.termination) return 0;
  const starts = process.termination.taskkill.map((item) => item.requestedAtMs).filter((value): value is number => typeof value === "number");
  return starts.length > 0 && typeof process.endedAtMs === "number" ? Math.max(0, process.endedAtMs - Math.min(...starts)) : process.termination.settledWithoutClose ? 10_001 : 0;
};

const fixtureStateOrInvalid = (repo: string): Phase19FixtureState => {
  try { return readPhase19FixtureState(repo); } catch { return { head: "", tree: "", status: "UNREADABLE_FIXTURE" }; }
};

const taskAuthorityReasons = (task: TaskSpec | undefined, item: Phase19Registration["cases"][number]): string[] => {
  if (!task) return [];
  const reasons: string[] = [];
  if (task.context_paths.length !== item.contextPaths.length || item.contextPaths.some((entry) => !task.context_paths.includes(entry))) reasons.push("CONTEXT_PATHS_DRIFT");
  if (task.scope.allowed_paths.length !== 1 || task.scope.allowed_paths[0] !== item.fixtureFiles[0]) reasons.push("ALLOWED_PATHS_DRIFT");
  const command = task.test_commands[0];
  if (task.test_commands.length !== 1 || !command || command.id !== "unit-tests" || command.program !== "pnpm" || command.args.length !== 1 || command.args[0] !== "test" || command.cwd !== "." || command.timeout_seconds !== 300 || command.required !== true) reasons.push("TEST_COMMANDS_DRIFT");
  return reasons;
};

/** Rehash every persisted case artifact and decision after execution. */
export function verifyPhase110RunArtifacts(outputRoot: string): boolean {
  try {
    const rootManifest = readJson<{ version: string; calls: number; artifacts: Array<{ path: string; sha256: string }> }>(path.join(outputRoot, "run-artifact-manifest.json"));
    if (rootManifest.version !== "phase1.10-run-artifacts.v1" || !Number.isInteger(rootManifest.calls) || rootManifest.calls < 1 || rootManifest.calls > 10 || rootManifest.artifacts.length !== rootManifest.calls + 2) return false;
    const expectedRootPaths = ["run-start.json", "run-decision.json", ...PHASE_1_9_CASE_IDS.slice(0, rootManifest.calls).map((id) => `${id}/case-seal.json`)];
    if (JSON.stringify(rootManifest.artifacts.map((item) => item.path).sort()) !== JSON.stringify(expectedRootPaths.sort())) return false;
    for (const artifact of rootManifest.artifacts) if (sha256(readFileSync(path.join(outputRoot, artifact.path))) !== artifact.sha256) return false;
    const decision = readJson<Phase19RunDecision>(path.join(outputRoot, "run-decision.json"));
    if (decision.calls !== rootManifest.calls) return false;
    for (const id of PHASE_1_9_CASE_IDS.slice(0, rootManifest.calls)) {
      const caseRoot = path.join(outputRoot, id);
      const seal = readJson<{ version: string; id: string; artifacts: Array<{ path: string; sha256: string }> }>(path.join(caseRoot, "case-seal.json"));
      if (seal.version !== "phase1.10-case-seal.v1" || seal.id !== id) return false;
      const allowed = new Set(["execution-evidence.json", "task-spec.json", "case-artifact-manifest.json", "sample.json", "decision.json"]);
      if (seal.artifacts.length < 4 || seal.artifacts.length > 5 || new Set(seal.artifacts.map((item) => item.path)).size !== seal.artifacts.length || seal.artifacts.some((item) => !allowed.has(item.path))) return false;
      if (!["execution-evidence.json", "case-artifact-manifest.json", "sample.json", "decision.json"].every((name) => seal.artifacts.some((item) => item.path === name))) return false;
      for (const artifact of seal.artifacts) if (sha256(readFileSync(path.join(caseRoot, artifact.path))) !== artifact.sha256) return false;
    }
    return true;
  } catch { return false; }
}

/** Persist each sample before deciding whether a subsequent request is allowed. */
export async function executePhase110Cases(ready: Phase110Ready, adapter: PlannerAgentAdapter): Promise<Phase19RunDecision> {
  mkdirSync(ready.outputRoot, { recursive: false });
  writeFileSync(path.join(ready.outputRoot, "run-start.json"), `${JSON.stringify({ version: "phase1.10-run.v1", preparation_seal_sha256: ready.sealSha256, case_count: ready.registration.cases.length, real_model_call_limit: ready.registration.cases.length }, null, 2)}\n`, { flag: "wx" });
  const samples: Phase19Sample[] = [];
  const authorityFailures: string[] = [];
  for (const item of ready.registration.cases) {
    const repo = ready.fixtures.get(item.id);
    assert(repo, `PHASE110_FIXTURE_MISSING:${item.id}`);
    const before = fixtureStateOrInvalid(repo);
    const caseRoot = path.join(ready.outputRoot, item.id);
    mkdirSync(caseRoot, { recursive: false });
    const outputPath = path.join(caseRoot, "task-spec.json");
    let execution: AgentExecution<TaskSpec> | undefined;
    let process: ProcessResult | undefined;
    let errorName: string | null = null;
    try {
      execution = await adapter.runPlanner({ cwd: repo, model: ready.registration.model, reasoning: ready.registration.reasoning, timeoutSeconds: ready.registration.timeoutMs / 1000, schemaPath: ready.schemaPath, outputPath, prompt: item.prompt, hashOnlyLogs: true, runId: `phase110-${item.id}` });
      process = execution.process;
    } catch (error) {
      errorName = error instanceof Error ? error.name : "UnknownError";
      process = (error as { result?: ProcessResult }).result;
    }
    const after = fixtureStateOrInvalid(repo);
    const context = (() => { try { return readBoundedContext(repo, [...item.contextPaths]); } catch { return null; } })();
    const failure = process ? classifyProcessResult(process) : null;
    const caseEvidence = {
      id: item.id, order: item.order, errorName,
      process: process ? { status: process.status, exitCode: process.exitCode, durationMs: process.durationMs, cleanupDurationMs: cleanupDurationMs(process), closeObserved: process.closeObserved, stdoutClosed: process.stdoutClosed, stderrClosed: process.stderrClosed, stdoutDestroyed: process.stdoutDestroyed, stderrDestroyed: process.stderrDestroyed, stdoutSha256: process.stdoutSha256, stderrSha256: process.stderrSha256, failureClassification: failure ? { code: failure.code, domain: failure.domain, retryable: failure.retryable, failFast: failure.failFast } : null } : null,
      terminalEvents: process ? parseCodexTerminalEvents(process.stdout).map((event) => ({ kind: event.kind, usage: event.usage ?? null })) : [],
      fixture: { before, after },
      inputHashes: { prompt: sha256(item.prompt), context: context?.sha256 ?? null },
      usage: execution?.usage ?? null,
    };
    const evidencePath = path.join(caseRoot, "execution-evidence.json");
    writeFileSync(evidencePath, `${JSON.stringify(caseEvidence, null, 2)}\n`, { flag: "wx" });
    const artifacts = ["execution-evidence.json", ...(existsSync(outputPath) ? ["task-spec.json"] : [])].map((name) => ({ path: name, sha256: sha256(readFileSync(path.join(caseRoot, name))) }));
    const manifestPath = path.join(caseRoot, "case-artifact-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify({ version: "phase1.10-case-artifacts.v1", id: item.id, artifacts }, null, 2)}\n`, { flag: "wx" });
    const registeredHashes = ready.fixtureHashes.get(item.id);
    const artifactHashesValid = artifacts.length === 2 && artifacts.every((artifact) => sha256(readFileSync(path.join(caseRoot, artifact.path))) === artifact.sha256) && item.promptSha256 === sha256(item.prompt) && item.contextSha256 === context?.sha256 && Boolean(registeredHashes) && item.fixtureFiles.every((file) => {
      try { return sha256(readFileSync(path.join(repo, file))) === registeredHashes?.[file]; } catch { return false; }
    });
    const sample: Phase19Sample = {
      id: item.id, order: item.order, processStatus: process?.status ?? "START_FAILED", exitCode: process?.exitCode ?? null,
      durationMs: process?.durationMs ?? ready.registration.timeoutMs + 1, cleanupDurationMs: process ? cleanupDurationMs(process) : ready.registration.cleanupCeilingMs + 1,
      stdout: process?.stdout ?? "", taskSpec: execution?.output ?? null, before, after,
      processConverged: Boolean(process?.closeObserved),
      stdioConverged: Boolean(process && (process.stdoutClosed || process.stdoutDestroyed) && (process.stderrClosed || process.stderrDestroyed)),
      artifactHashesValid, retryCount: 0, humanIntervention: false,
    };
    writeFileSync(path.join(caseRoot, "sample.json"), `${JSON.stringify({ ...sample, stdout: undefined }, null, 2)}\n`, { flag: "wx" });
    const result = evaluatePhase19Sample(ready.registration, sample);
    const authorityReasons = taskAuthorityReasons(result.taskSpec, item);
    const reasons = [...result.reasons, ...authorityReasons];
    const decisionPath = path.join(caseRoot, "decision.json");
    writeFileSync(decisionPath, `${JSON.stringify({ status: reasons.length === 0 ? "PASS" : "FAIL", reasons }, null, 2)}\n`, { flag: "wx" });
    const caseSealArtifacts = ["execution-evidence.json", ...(existsSync(outputPath) ? ["task-spec.json"] : []), "case-artifact-manifest.json", "sample.json", "decision.json"].map((name) => ({ path: name, sha256: sha256(readFileSync(path.join(caseRoot, name))) }));
    writeFileSync(path.join(caseRoot, "case-seal.json"), `${JSON.stringify({ version: "phase1.10-case-seal.v1", id: item.id, artifacts: caseSealArtifacts }, null, 2)}\n`, { flag: "wx" });
    samples.push(sample);
    if (authorityReasons.length > 0) authorityFailures.push(...authorityReasons);
    if (reasons.length > 0) break;
  }
  const baseDecision = evaluatePhase19Run(ready.registration, samples);
  const decision: Phase19RunDecision = authorityFailures.length > 0
    ? { status: "FAIL", calls: samples.length, passed: Math.max(0, samples.length - 1), failed: 1, notRun: PHASE_1_9_CASE_IDS.slice(samples.length), reasons: [...new Set([...baseDecision.reasons.filter((reason) => reason !== "REGISTERED_CASES_NOT_COMPLETE"), ...authorityFailures])] }
    : baseDecision;
  writeFileSync(path.join(ready.outputRoot, "run-decision.json"), `${JSON.stringify(decision, null, 2)}\n`, { flag: "wx" });
  const runArtifacts = ["run-start.json", "run-decision.json", ...PHASE_1_9_CASE_IDS.slice(0, samples.length).map((id) => `${id}/case-seal.json`)].map((name) => ({ path: name, sha256: sha256(readFileSync(path.join(ready.outputRoot, name))) }));
  writeFileSync(path.join(ready.outputRoot, "run-artifact-manifest.json"), `${JSON.stringify({ version: "phase1.10-run-artifacts.v1", calls: samples.length, artifacts: runArtifacts }, null, 2)}\n`, { flag: "wx" });
  assert(verifyPhase110RunArtifacts(ready.outputRoot), "PHASE110_POST_RUN_ARTIFACT_DRIFT");
  return decision;
}

/** Real entry point: it stays unreachable from ordinary test commands. */
export async function executePhase110RealRun(env: Record<string, string | undefined> = process.env) {
  assert(env.RUN_PHASE1_10_RUNTIME === "1" && env.PHASE1_10_EXECUTION_APPROVAL === "I_APPROVE_10_REAL_CODEX_CALLS", "PHASE110_REAL_EXECUTION_NOT_APPROVED");
  const sourceRoot = path.resolve(env.PHASE1_10_SOURCE_ROOT ?? "");
  assert(path.isAbsolute(env.PHASE1_10_SOURCE_ROOT ?? "") && existsSync(sourceRoot), "PHASE110_SOURCE_ROOT_INVALID");
  const sealHash = env.PHASE1_10_SEAL_SHA256 ?? "";
  assert(/^[0-9a-f]{64}$/.test(sealHash), "PHASE110_SEAL_HASH_REQUIRED");
  const readinessHash = env.PHASE1_10_READINESS_SHA256 ?? "";
  verifyPhase110Readiness(sourceRoot, readinessHash, sealHash);
  const approvalPath = env.PHASE1_10_APPROVAL_FILE ?? "";
  assert(path.isAbsolute(approvalPath) && existsSync(approvalPath), "PHASE110_APPROVAL_FILE_REQUIRED");
  const approval = readJson<Phase19ExecutionApproval & { offline_readiness_sha256: string }>(approvalPath);
  assert(approval.offline_readiness_sha256 === readinessHash, "PHASE110_APPROVAL_READINESS_MISMATCH");
  const baseline = readJson<{ toolchain: { codex_path: string; codex_version: string; codex_sha256: string } }>(path.join(sourceRoot, "phase1-9-evidence", "baseline.json"));
  const ready = verifyPhase110Ready({
    sourceRoot,
    preparationRoot: path.join(sourceRoot, "phase1-10-run3-evidence", "preparation-run1"),
    outputRoot: path.join(sourceRoot, "phase1-10-runtime-certification-run3"),
    expectedSealSha256: sealHash,
    approval,
    runtime: { executable: baseline.toolchain.codex_path, version: baseline.toolchain.codex_version, sha256: baseline.toolchain.codex_sha256 },
    schemaPath: path.join(sourceRoot, "schemas", "task-spec.schema.json"),
  });
  const account = spawnSync(ready.executable, ["login", "status"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000 });
  if (account.status !== 0) {
    const evidenceRoot = path.join(sourceRoot, "phase1-10-requalification-evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(path.join(evidenceRoot, `account-preflight-failure-${randomUUID()}.json`), `${JSON.stringify({ status: "PHASE110_ACCOUNT_PREFLIGHT_FAILED", exitCode: account.status, stdoutSha256: sha256(String(account.stdout ?? "")), stderrSha256: sha256(String(account.stderr ?? "")) }, null, 2)}\n`, { flag: "wx" });
    throw new Error("PHASE110_ACCOUNT_PREFLIGHT_FAILED");
  }
  const adapter = new CodexAdapter(ready.executable);
  return executePhase110Cases(ready, adapter);
}
