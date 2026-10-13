import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import { runProcess, type ProcessResult } from "../../src/main/process/runner.js";
import {
  assertPhase14OptIn,
  assertPhase14PrepareOptIn,
  buildPhase14CanaryPreregistration,
  buildPhase14RequestTelemetry,
  capturePhase14TreeEvidence,
  classifyPhase14Failure,
  createPhase14SourceSnapshot,
  evaluatePhase14Canary,
  hasExplicitPhase14TransportError,
  PHASE14_CANARY_TIMEOUT_SECONDS,
  runPhase14ArchitectRequest,
  summarizePhase14Process,
  type Phase14RuntimeEvent,
  type Phase14Sample,
  type Phase14SourceSnapshot,
  type Phase14Usage
} from "../../src/shared/core/runtime-certification.js";
import { parseTransportObservation, PHASE13_FIXTURE_COMMIT_DATE, validateReadOnlyArchitectResponse, type RuntimeStabilityCase } from "../../src/shared/core/runtime-stability.js";

const prepareEnabled = process.env.RUN_PHASE1_4_PREPARE === "1";
const enabled = process.env.RUN_PHASE1_4_RUNTIME === "1";

const canaryCase: RuntimeStabilityCase = {
  id: "P14-CANARY-01",
  order: 1,
  kind: "cross_file_reasoning",
  title: "Phase 1.4 runtime canary",
  prompt: "You are the read-only Architect for the Phase 1.4 canary. Inspect the bounded fixture context, explain the contract and runtime risk, and return one TaskSpec JSON object. Do not change any file, invoke a Worker, or run a write command. Use base_sha \"{{BASE_SHA}}\" and task_id \"P14-CANARY-01\".",
  contextPaths: ["README.md", "docs/context.md", "docs/operations.md", "src/runtime.ts", "src/service.ts", "src/domain/inventory.ts", "src/domain/order.ts", "tests/contracts.md", "tests/evidence-index.md"],
  acceptanceCriteria: ["references every context path", "cross-references runtime, service, inventory and order evidence", "separates observed facts from one bounded risk", "contains no write intent"],
  fixtureFiles: ["README.md", "docs/context.md", "docs/operations.md", "src/runtime.ts", "src/service.ts", "src/domain/inventory.ts", "src/domain/order.ts", "tests/contracts.md", "tests/evidence-index.md"]
};

const fixtureContent: Record<string, string> = {
  "README.md": "# Phase 1.4 fresh canary fixture\nThis fixture is read-only and independent from Phase 1.3.\nThe canary must synthesize evidence across runtime, domain, operations, and contract files.\nA valid conclusion references every prepared path and keeps facts separate from risks.\n",
  "docs/context.md": "# Context\nThe runtime must preserve clean Git state while producing a structured analysis.\nThe service health contract depends on mode=pilot, timeoutSeconds>=600, and readOnly=true.\nThe operations note requires a bounded retry budget and an evidence index with no unexplained gap.\n",
  "docs/operations.md": "# Operations\nRead-only inspection may read configuration and status but cannot modify a repository.\nIf a response is incomplete, the caller records the failure and does not ask a Worker to explain it.\nThe release check compares runtime state, domain invariants, and evidence coverage.\n",
  "src/runtime.ts": "export type RuntimeConfig = { mode: string; timeoutSeconds: number; readOnly: boolean; retryLimit: number };\nexport const runtime: RuntimeConfig = { mode: 'pilot', timeoutSeconds: 900, readOnly: true, retryLimit: 0 };\nexport const health = (config: RuntimeConfig): string => config.mode === 'pilot' && config.timeoutSeconds >= 600 && config.readOnly ? 'ready' : 'risk';\n",
  "src/service.ts": "import type { RuntimeConfig } from './runtime';\nexport const retryBudget = (config: RuntimeConfig): number => Math.max(0, config.retryLimit);\nexport const inspectionIsReadOnly = (config: RuntimeConfig): boolean => config.readOnly;\n",
  "src/domain/inventory.ts": "export type Inventory = { available: number; reserved: number };\nexport const reserve = (inventory: Inventory, quantity: number): Inventory | null => quantity < 0 || quantity > inventory.available - inventory.reserved ? null : { ...inventory, reserved: inventory.reserved + quantity };\nexport const invariant = (inventory: Inventory): boolean => inventory.reserved >= 0 && inventory.reserved <= inventory.available;\n",
  "src/domain/order.ts": "import type { Inventory } from './inventory';\nexport type Order = { state: 'draft' | 'reserved' | 'fulfilled'; quantity: number };\nexport const canFulfill = (order: Order, inventory: Inventory): boolean => order.state === 'reserved' && order.quantity <= inventory.reserved;\n",
  "tests/contracts.md": "# Contracts\nC-01: the Architect response is structured and the fixture remains unchanged.\nC-02: negative and over-available reservations are rejected without mutation.\nC-03: a fulfilled order must have a reserved quantity that covers its order quantity.\nC-04: read-only inspection does not write files or update Git.\n",
  "tests/evidence-index.md": "# Evidence index\nruntime -> src/runtime.ts -> health and read-only configuration.\nservice -> src/service.ts -> retry budget and read-only inspection.\ninventory -> src/domain/inventory.ts -> reservation invariant.\norder -> src/domain/order.ts -> fulfillment assumption.\ncontracts -> tests/contracts.md -> C-01 through C-04.\n"
};

type Phase14PreparedCanary = {
  outputPath: string;
  sourceSnapshot: Phase14SourceSnapshot;
  fixture: { root: string; baseSha: string; files: string[] };
  schemaPath: string;
  prompt: string;
  preparedContext: string;
  schema: string;
  request: ReturnType<typeof buildPhase14RequestTelemetry>;
  preregistration: ReturnType<typeof buildPhase14CanaryPreregistration>;
};

const writeJson = (filePath: string, value: unknown): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const runGit = async (cwd: string, args: string[], env: Record<string, string> = {}): Promise<ProcessResult> => runProcess({ program: "git", args, cwd, timeoutSeconds: 30, env });

const prepareFixture = async (root: string): Promise<{ root: string; baseSha: string; files: string[] }> => {
  const fixtureRoot = path.join(root, "fixture");
  mkdirSync(fixtureRoot, { recursive: true });
  for (const [relative, content] of Object.entries(fixtureContent)) {
    const target = path.join(fixtureRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  for (const args of [["init"], ["config", "user.email", "phase14@example.invalid"], ["config", "user.name", "Phase 1.4 Runtime"], ["add", "."]]) {
    const result = await runGit(fixtureRoot, args);
    if (result.status !== "SUCCEEDED") throw new Error(`fixture setup failed: ${result.stderr || result.stdout}`);
  }
  const commit = await runGit(fixtureRoot, ["commit", "--no-verify", "-m", "Phase 1.4 fresh runtime canary"], {
    GIT_AUTHOR_NAME: "Phase 1.4 Runtime",
    GIT_AUTHOR_EMAIL: "phase14@example.invalid",
    GIT_AUTHOR_DATE: PHASE13_FIXTURE_COMMIT_DATE,
    GIT_COMMITTER_NAME: "Phase 1.4 Runtime",
    GIT_COMMITTER_EMAIL: "phase14@example.invalid",
    GIT_COMMITTER_DATE: PHASE13_FIXTURE_COMMIT_DATE
  });
  if (commit.status !== "SUCCEEDED") throw new Error(`fixture commit failed: ${commit.stderr || commit.stdout}`);
  const head = await runGit(fixtureRoot, ["rev-parse", "HEAD"]);
  if (head.status !== "SUCCEEDED") throw new Error(`fixture SHA failed: ${head.stderr || head.stdout}`);
  return { root: fixtureRoot, baseSha: head.stdout.trim(), files: Object.keys(fixtureContent) };
};

const hashFile = (filePath: string): string | null => existsSync(filePath) ? createHash("sha256").update(readFileSync(filePath)).digest("hex") : null;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const processFromError = (error: unknown): ProcessResult | null => {
  const candidate = (error as { result?: unknown }).result;
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Partial<ProcessResult>;
  return typeof value.status === "string" && typeof value.stdout === "string" && typeof value.stderr === "string" && typeof value.durationMs === "number" ? candidate as ProcessResult : null;
};

const classifySymptom = (result: ProcessResult | null, outputValid: boolean): Phase14Sample["failureSymptom"] => {
  if (result?.status === "TIMED_OUT") return "PROCESS_TIMEOUT";
  if (result?.status === "START_FAILED") return "START_FAILURE";
  if (result && result.status === "SUCCEEDED" && !outputValid) return "OUTPUT_INVALID";
  return result?.status === "SUCCEEDED" ? "NONE" : "TERMINAL_FAILURE";
};

const prepareCanary = async (env: Record<string, string | undefined> = process.env): Promise<Phase14PreparedCanary> => {
  const executablePath = env.CODEX_PROGRAM;
  if (!executablePath || !path.isAbsolute(executablePath) || !existsSync(executablePath)) throw new Error("CODEX_PROGRAM must be an existing absolute executable path for Phase 1.4");
  const { outputPath } = assertPhase14PrepareOptIn(env);
  const sourceSnapshot = createPhase14SourceSnapshot({ sourceRoot: process.cwd(), snapshotRoot: path.join(outputPath, "source-snapshot") });
  const fixture = await prepareFixture(outputPath);
  const schemaPath = path.join(sourceSnapshot.sourceRoot, "schemas", "task-spec.schema.json");
  const schema = readFileSync(schemaPath, "utf8");
  const preparedContext = canaryCase.contextPaths.map((relative) => `${relative}\n${readFileSync(path.join(fixture.root, relative), "utf8")}`).join("\n");
  // The prepared context is part of the exact prompt bytes.  This makes the
  // I-02 isolation comparison auditable: it may change the exploration
  // surface only when the runner can keep this prompt hash fixed.
  const prompt = `${canaryCase.prompt.replaceAll("{{BASE_SHA}}", fixture.baseSha)}\n\nPrepared read-only context (exact bytes; do not use shell or write commands):\n${preparedContext}`;
  const request = buildPhase14RequestTelemetry({ prompt, schema, preparedContext });
  const preregistration = buildPhase14CanaryPreregistration({ canaryId: canaryCase.id, model: env.PHASE1_4_MODEL ?? "gpt-5.6-sol", reasoning: (env.PHASE1_4_REASONING as "low" | "medium" | "high" | undefined) ?? "medium", baseSha: fixture.baseSha, fixtureTree: capturePhase14TreeEvidence(fixture.root), request });
  const preregistrationPath = path.join(outputPath, "canary-preregistration.json");
  const requestPath = path.join(outputPath, "canary-request.json");
  writeJson(preregistrationPath, { ...preregistration, sourceSnapshot: { tree: sourceSnapshot.tree, packageLockSha256: sourceSnapshot.packageLockSha256, gitHeadStatus: sourceSnapshot.gitHeadStatus } });
  writeJson(requestPath, { canaryCase, baseSha: fixture.baseSha, prompt, preparedContext, schema, request });
  const preparation = {
    protocolVersion: "phase1-4-runtime-certification-v1",
    preparedAt: new Date().toISOString(),
    executablePath,
    runtimeLabel: env.PHASE1_4_RUNTIME_LABEL ?? "codex-cli-0.151.0",
    cliVersion: env.PHASE1_4_CLI_VERSION ?? "codex-cli 0.151.0",
    sourceSnapshot: { tree: sourceSnapshot.tree, sourceManifestSha256: hashFile(path.join(sourceSnapshot.snapshotRoot, "snapshot-manifest.json")), gitHeadStatus: sourceSnapshot.gitHeadStatus },
    fixture: { rootRelative: "fixture", baseSha: fixture.baseSha, tree: preregistration.fixtureTree, files: fixture.files },
    request: { path: "canary-request.json", sha256: hashFile(requestPath) },
    preregistration: { path: "canary-preregistration.json", sha256: hashFile(preregistrationPath) }
  };
  writeJson(path.join(outputPath, "canary-prepare-manifest.json"), preparation);
  return { outputPath, sourceSnapshot, fixture, schemaPath, prompt, preparedContext, schema, request, preregistration };
};

const readPreparedCanary = async (env: Record<string, string | undefined> = process.env): Promise<Phase14PreparedCanary> => {
  const { outputPath } = assertPhase14OptIn(env);
  for (const file of ["canary-terminal-result.json", "canary-error.json", "canary-sample.json", "canary-decision.json", "canary-response.json", "stdout.log", "stderr.log"]) if (existsSync(path.join(outputPath, file))) throw new Error(`Phase 1.4 canary output is already terminal or was already executed: ${file}`);
  const preparationPath = path.join(outputPath, "canary-prepare-manifest.json");
  const preregistrationPath = path.join(outputPath, "canary-preregistration.json");
  const requestPath = path.join(outputPath, "canary-request.json");
  if (!existsSync(preparationPath) || !existsSync(preregistrationPath) || !existsSync(requestPath)) throw new Error("Phase 1.4 canary must be prepared before execution");
  const preparation = JSON.parse(readFileSync(preparationPath, "utf8")) as { executablePath: string; runtimeLabel: string; cliVersion: string; sourceSnapshot: { tree: ReturnType<typeof capturePhase14TreeEvidence>; sourceManifestSha256: string | null; gitHeadStatus: string }; fixture: { rootRelative: string; baseSha: string; tree: ReturnType<typeof capturePhase14TreeEvidence>; files: string[] }; request: { path: string; sha256: string | null }; preregistration: { path: string; sha256: string | null } };
  const preregistration = JSON.parse(readFileSync(preregistrationPath, "utf8")) as ReturnType<typeof buildPhase14CanaryPreregistration>;
  const requestRecord = JSON.parse(readFileSync(requestPath, "utf8")) as { canaryCase: RuntimeStabilityCase; baseSha: string; prompt: string; preparedContext: string; schema: string; request: ReturnType<typeof buildPhase14RequestTelemetry> };
  if (hashFile(preregistrationPath) !== preparation.preregistration.sha256 || hashFile(requestPath) !== preparation.request.sha256) throw new Error("Phase 1.4 preregistration/request hash changed after prepare");
  const sourceSnapshotRoot = path.join(outputPath, "source-snapshot");
  const sourceRoot = path.join(sourceSnapshotRoot, "source");
  const sourceTree = capturePhase14TreeEvidence(sourceRoot);
  if (JSON.stringify(sourceTree) !== JSON.stringify(preparation.sourceSnapshot.tree)) throw new Error("Phase 1.4 source snapshot tree changed after prepare");
  if (hashFile(path.join(sourceSnapshotRoot, "snapshot-manifest.json")) !== preparation.sourceSnapshot.sourceManifestSha256) throw new Error("Phase 1.4 source snapshot manifest changed after prepare");
  const fixtureRoot = path.join(outputPath, preparation.fixture.rootRelative);
  const fixtureTree = capturePhase14TreeEvidence(fixtureRoot);
  if (JSON.stringify(fixtureTree) !== JSON.stringify(preparation.fixture.tree)) throw new Error("Phase 1.4 canary fixture tree changed after prepare");
  const head = await runGit(fixtureRoot, ["rev-parse", "HEAD"]);
  if (head.status !== "SUCCEEDED" || head.stdout.trim() !== preparation.fixture.baseSha) throw new Error("Phase 1.4 canary fixture base SHA changed after prepare");
  if (requestRecord.baseSha !== preparation.fixture.baseSha || JSON.stringify(requestRecord.request) !== JSON.stringify(preregistration.request)) throw new Error("Phase 1.4 canary request telemetry changed after prepare");
  return { outputPath, sourceSnapshot: { snapshotRoot: sourceSnapshotRoot, sourceRoot, gitHead: null, gitHeadStatus: preparation.sourceSnapshot.gitHeadStatus === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE_NO_GIT", packageLockSha256: null, packageLockBytes: null, tree: sourceTree, files: [] }, fixture: { root: fixtureRoot, baseSha: preparation.fixture.baseSha, files: preparation.fixture.files }, schemaPath: path.join(sourceRoot, "schemas", "task-spec.schema.json"), prompt: requestRecord.prompt, preparedContext: requestRecord.preparedContext, schema: requestRecord.schema, request: requestRecord.request, preregistration };
};

/** Zero-quota step: creates a fresh snapshot, fixture, request telemetry and canary preregistration only. */
export const preparePhase14Canary = prepareCanary;

/** Real step: consumes an existing prepared directory and executes exactly one request. */
export const executePhase14Canary = async (env: Record<string, string | undefined> = process.env): Promise<{ outputPath: string; sample: Phase14Sample; decision: ReturnType<typeof evaluatePhase14Canary> }> => {
  const prepared = await readPreparedCanary(env);
  const executablePath = env.CODEX_PROGRAM;
  if (!executablePath || !path.isAbsolute(executablePath) || executablePath !== (JSON.parse(readFileSync(path.join(prepared.outputPath, "canary-prepare-manifest.json"), "utf8")) as { executablePath: string }).executablePath) throw new Error("CODEX_PROGRAM must match the absolute executable path sealed during prepare");
  const outerStartedAt = Date.now();
  const events: Phase14RuntimeEvent[] = [{ name: "prepared.input.verified", atMs: outerStartedAt }];
  let execution: { output: unknown; process: ProcessResult; usage: Phase14Usage | null } | null = null;
  let failedProcess: ProcessResult | null = null;
  let terminalError: unknown = null;
  let protocolValid = false;
  let semanticValid = false;
  const outputPathForCodex = path.join(prepared.outputPath, "canary-response.json");
  const adapter = new CodexAdapter(executablePath);
  try {
    execution = await runPhase14ArchitectRequest(adapter, { cwd: prepared.fixture.root, model: prepared.preregistration.model, reasoning: prepared.preregistration.reasoning, timeoutSeconds: PHASE14_CANARY_TIMEOUT_SECONDS, schemaPath: prepared.schemaPath, outputPath: outputPathForCodex, prompt: prepared.prompt, runId: "phase14-canary-01", onSpawn: (pid) => { events.push({ name: "process.spawn", atMs: Date.now(), detail: String(pid ?? "null") }); }, onOutput: (stream, atMs, bytes) => { events.push({ name: `${stream}.activity`, atMs, detail: String(bytes) }); } });
    const validation = validateReadOnlyArchitectResponse(execution.output, canaryCase, prepared.fixture.baseSha, prepared.fixture.files);
    protocolValid = validation.schemaValid;
    semanticValid = validation.semanticValid;
    events.push({ name: "process.terminal", atMs: Date.now(), detail: execution.process.status });
  } catch (error) {
    terminalError = error;
    failedProcess = processFromError(error);
    events.push({ name: "process.terminal", atMs: Date.now(), detail: failedProcess?.status ?? "unknown" });
  }
  const process = execution?.process ?? failedProcess;
  const knownPids = events.filter((event) => event.name === "process.spawn").map((event) => Number(event.detail)).filter((pid) => Number.isInteger(pid) && pid > 0);
  const remainingKnownPids = knownPids.filter(processIsAlive);
  const terminalArtifactPath = path.join(prepared.outputPath, "canary-terminal-result.json");
  if (execution) writeJson(terminalArtifactPath, { status: execution.process.status, output: execution.output, usage: execution.usage });
  else writeJson(terminalArtifactPath, { status: process?.status ?? "UNKNOWN", error: terminalError instanceof Error ? { name: terminalError.name, message: terminalError.message } : { name: "UnknownError", message: String(terminalError) } });
  const terminalResultPersisted = existsSync(terminalArtifactPath) && hashFile(terminalArtifactPath) !== null;
  const stdoutLogPath = path.join(prepared.outputPath, "stdout.log");
  const stderrLogPath = path.join(prepared.outputPath, "stderr.log");
  const stdout = existsSync(stdoutLogPath) ? readFileSync(stdoutLogPath, "utf8") : process?.stdout ?? "";
  const stderr = existsSync(stderrLogPath) ? readFileSync(stderrLogPath, "utf8") : process?.stderr ?? "";
  const evidencePersisted = terminalResultPersisted && existsSync(path.join(prepared.outputPath, "canary-preregistration.json")) && existsSync(path.join(prepared.outputPath, "canary-request.json")) && existsSync(path.join(prepared.sourceSnapshot.snapshotRoot, "snapshot-manifest.json")) && (process === null || (existsSync(stdoutLogPath) && existsSync(stderrLogPath)));
  const fixtureAfter = await runGit(prepared.fixture.root, ["status", "--porcelain=v1"]);
  const fixtureClean = fixtureAfter.status === "SUCCEEDED" && fixtureAfter.stdout.trim().length === 0 && capturePhase14TreeEvidence(prepared.fixture.root).digest === prepared.preregistration.fixtureTree.digest;
  const transport = parseTransportObservation(stdout, stderr, false);
  const explicitTransportFailure = hasExplicitPhase14TransportError(stdout, stderr);
  const processTelemetry = summarizePhase14Process({ events, stdout, stderr, process, knownPids, remainingKnownPids, terminalResultPersisted, evidencePersisted, closeObserved: process?.closeObserved, stdoutClosed: process?.stdoutClosed, stderrClosed: process?.stderrClosed, stdoutDestroyed: process?.stdoutDestroyed, stderrDestroyed: process?.stderrDestroyed });
  const authoritativeCompletion = process?.status === "SUCCEEDED" && (processTelemetry.responseCompleted || processTelemetry.turnCompleted) && protocolValid && semanticValid;
  const symptom = classifySymptom(process, protocolValid && semanticValid);
  const axes = classifyPhase14Failure({ symptom, process: processTelemetry, codex: { responseCompleted: processTelemetry.responseCompleted, turnCompleted: processTelemetry.turnCompleted, terminal: authoritativeCompletion }, transport: { failed: explicitTransportFailure || transport.reconnectCount > 0 || transport.fallbackCount > 0, reconnectCount: transport.reconnectCount, fallbackCount: transport.fallbackCount }, protocol: { terminalOutput: process?.status === "SUCCEEDED", schemaValid: protocolValid, semanticValid, integrityValid: fixtureClean } });
  const outerWallClockMs = Date.now() - outerStartedAt;
  const sample: Phase14Sample = { protocolVersion: "phase1-4-runtime-certification-v1", track: "CANARY", id: canaryCase.id, order: 1, runtimeLabel: (JSON.parse(readFileSync(path.join(prepared.outputPath, "canary-prepare-manifest.json"), "utf8")) as { runtimeLabel: string }).runtimeLabel, model: prepared.preregistration.model, reasoning: prepared.preregistration.reasoning, executablePath, executableSha256: hashFile(executablePath), cliVersion: (JSON.parse(readFileSync(path.join(prepared.outputPath, "canary-prepare-manifest.json"), "utf8")) as { cliVersion: string }).cliVersion, complete: authoritativeCompletion, protocolValid, semanticValid, integrityValid: fixtureClean, fixtureClean, durationMs: outerWallClockMs, outerWallClockMs, childProcessDurationMs: process?.durationMs ?? null, retryCount: 0, fallbackCount: transport.fallbackCount, humanIntervention: false, usage: execution?.usage ?? null, request: prepared.request, process: processTelemetry, failureSymptom: symptom, failureAxes: axes.axes, failureCode: axes.axes.length > 0 ? "PHASE14_RUNTIME_FAILURE" : null };
  writeJson(path.join(prepared.outputPath, "canary-sample.json"), { sample, fixtureTree: prepared.preregistration.fixtureTree, process: process ? { status: process.status, exitCode: process.exitCode, durationMs: process.durationMs, stdoutSha256: process.stdoutSha256, stderrSha256: process.stderrSha256, termination: process.termination ?? null, closeObserved: process.closeObserved ?? false, stdoutClosed: process.stdoutClosed ?? false, stderrClosed: process.stderrClosed ?? false } : null, fullLogs: { stdout: hashFile(stdoutLogPath), stderr: hashFile(stderrLogPath) } });
  const decision = evaluatePhase14Canary(sample);
  writeJson(path.join(prepared.outputPath, "canary-decision.json"), decision);
  return { outputPath: prepared.outputPath, sample, decision };
};

describe("Phase 1.4 canary preparation and execution", () => {
  it.skipIf(!prepareEnabled)("prepares a fresh zero-quota canary directory", async () => {
    const result = await preparePhase14Canary();
    expect(result.preregistration.track).toBe("CANARY");
    expect(existsSync(path.join(result.outputPath, "canary-prepare-manifest.json"))).toBe(true);
    expect(existsSync(path.join(result.outputPath, "canary-request.json"))).toBe(true);
  }, 120_000);

  it.skipIf(!enabled)("executes exactly the already-prepared single canary", async () => {
    const result = await executePhase14Canary();
    expect(result.sample.track).toBe("CANARY");
    expect(result.sample.id).toBe("P14-CANARY-01");
    expect(result.sample.retryCount).toBe(0);
  }, 920_000);
});
