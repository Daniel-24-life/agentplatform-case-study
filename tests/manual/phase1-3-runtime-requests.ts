import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter, CodexOutputError, CodexRunError, parseCodexUsage } from "../../src/main/adapters/codex/codex-adapter.js";
import { runProcess, type ProcessResult } from "../../src/main/process/runner.js";
import { runCodexRuntimePreflight, type CodexRuntimePreflightResult } from "../../src/main/runtime/codex-runtime-preflight.js";
import {
  assertPhase13OptIn,
  captureFixtureIntegrity,
  collectEvidenceFiles,
  evaluateRuntimeStability,
  hashCaseDefinition,
  hashDirectory,
  materializeCasePrompt,
  sha256Text,
  parseTransportObservation,
  phase13CaseOrder,
  phase13RuntimeCases,
  PHASE13_CHEAP_MODEL,
  PHASE13_EXPECTED_BASE_SHA,
  PHASE13_FIXTURE_COMMIT_DATE,
  PHASE13_FIXTURE_COMMIT_MESSAGE,
  PHASE13_FIXTURE_IDENTITY,
  PHASE13_HARD_TIMEOUT_SECONDS,
  PHASE13_PARSER_VERSION,
  PHASE13_REASONING,
  PHASE13_SAMPLE_COUNT,
  PHASE13_STRONG_MODEL,
  shouldStopRuntimeRun,
  validateReadOnlyArchitectResponse,
  writeJsonAtomic,
  type RuntimeSample,
  type RuntimeStabilityCase,
  type RuntimeUsage
} from "../../src/shared/core/runtime-stability.js";

const enabled = process.env.RUN_PHASE1_3_RUNTIME === "1";
const fixtureContent: Record<string, string> = {
  "README.md": `# Phase 1.3 synthetic runtime fixture
This is a deliberately small release candidate used only for read-only Architect stability testing.
The documented source of truth is split across runtime code, domain code, operational notes, and evidence indexes.
The expected invariant is that a read-only health inspection cannot mutate state and a reservation cannot exceed inventory.
The operations note calls the candidate ready only when mode is pilot, timeout is at least 600 seconds, and readOnly is true.
`,
  "docs/operations.md": `# Operations
The service loads runtimeConfig, reports health, and leaves the repository unchanged during inspection.
Readiness requires mode=pilot, timeoutSeconds>=600, readOnly=true, and a clean evidence index.
The fallback note says a missing mode should be treated as a diagnostic risk, while the service code has a safe default.
Operators must compare the configuration, service behavior, domain invariants, and evidence index before calling the candidate ready.
`,
  "docs/orders.md": `# Orders
An order progresses draft -> reserved -> fulfilled. Reservation consumes no more than available inventory.
The order document assumes a reservation is rejected for negative quantities and for quantities above availability.
The documented fulfillment path assumes the reserved quantity remains stable until fulfillment, which is a cross-file risk.
`,
  "src/runtime/config.ts": `export type RuntimeConfig = { mode: string; timeoutSeconds: number; readOnly: boolean; retryLimit: number };
export const runtimeConfig: RuntimeConfig = { mode: 'pilot', timeoutSeconds: 900, readOnly: true, retryLimit: 1 };
export const requiredReadOnlyFields = ['mode', 'timeoutSeconds', 'readOnly'] as const;
`,
  "src/runtime/service.ts": `import type { RuntimeConfig } from './config';
export function health(config: RuntimeConfig): string {
  if (config.mode !== 'pilot') return 'risk:mode';
  if (config.timeoutSeconds < 600) return 'risk:timeout';
  return config.readOnly ? 'ready:pilot' : 'risk:write-capable';
}
export function retryBudget(config: RuntimeConfig): number { return Math.max(0, config.retryLimit); }
`,
  "src/domain/inventory.ts": `export type InventorySnapshot = { available: number; reserved: number };
export const reserve = (snapshot: InventorySnapshot, requested: number): InventorySnapshot | null => {
  if (requested < 0 || requested > snapshot.available - snapshot.reserved) return null;
  return { ...snapshot, reserved: snapshot.reserved + requested };
};
export const invariant = (snapshot: InventorySnapshot): boolean => snapshot.available >= 0 && snapshot.reserved >= 0 && snapshot.reserved <= snapshot.available;
`,
  "src/domain/orders.ts": `import type { InventorySnapshot } from './inventory';
export const orderState = ['draft', 'reserved', 'fulfilled'] as const;
export type Order = { id: string; state: typeof orderState[number]; quantity: number };
export function canFulfill(order: Order, inventory: InventorySnapshot): boolean {
  return order.state === 'reserved' && order.quantity <= inventory.reserved;
}
// The documentation assumes inventory remains stable between reserve and fulfill.
`,
  "tests/contracts.md": `# Contract evidence
Contract C-01: reserved must never exceed available, including after repeated reservations.
Contract C-02: negative and over-available requests are rejected without changing the snapshot.
Contract C-03: fulfillment is allowed only for a reserved order whose quantity is covered by reserved inventory.
Contract C-04: read-only runtime inspection must not write files, update Git, or consume a reservation.
The evidence index intentionally omits a direct test for inventory stability between reservation and fulfillment.
`,
  "tests/evidence-index.md": `# Evidence index
config -> src/runtime/config.ts -> requiredReadOnlyFields and retryLimit.
health -> src/runtime/service.ts -> mode, timeout, and readOnly readiness branches.
reservation -> src/domain/inventory.ts -> reserve and invariant.
fulfillment -> src/domain/orders.ts -> canFulfill and the stability assumption.
contracts -> tests/contracts.md -> C-01 through C-04; missing coverage is called out explicitly.
`
};

const hashFile = (filePath: string): string => createHash("sha256").update(readFileSync(filePath)).digest("hex");
const hashFileIfPresent = (filePath: string): string | null => existsSync(filePath) ? hashFile(filePath) : null;

const gitStatus = async (cwd: string): Promise<string> => {
  const result = await runProcess({ program: "git", args: ["status", "--porcelain=v1"], cwd, timeoutSeconds: 30 });
  if (result.status !== "SUCCEEDED") throw new Error(`git status failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};

const gitDiff = async (cwd: string): Promise<string> => {
  const result = await runProcess({ program: "git", args: ["diff", "--binary"], cwd, timeoutSeconds: 30 });
  if (result.status !== "SUCCEEDED") throw new Error(`git diff failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};

const gitHead = async (cwd: string): Promise<string> => {
  const result = await runProcess({ program: "git", args: ["rev-parse", "HEAD"], cwd, timeoutSeconds: 30 });
  if (result.status !== "SUCCEEDED") throw new Error(`git HEAD failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};

const runGit = async (cwd: string, args: string[], env: Record<string, string> = {}): Promise<ProcessResult> => runProcess({ program: "git", args, cwd, timeoutSeconds: 30, env });

const createFixture = async (outputRoot: string): Promise<{ root: string; baseSha: string; files: string[] }> => {
  const root = path.join(outputRoot, "fixture");
  mkdirSync(root);
  for (const [relative, content] of Object.entries(fixtureContent)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  const init = await runGit(root, ["init"]);
  if (init.status !== "SUCCEEDED") throw new Error(`fixture init failed: ${init.stderr}`);
  for (const args of [["config", "user.email", "phase13@example.invalid"], ["config", "user.name", "Phase 1.3 Runtime"]]) {
    const result = await runGit(root, args);
    if (result.status !== "SUCCEEDED") throw new Error(`fixture setup failed: ${result.stderr}`);
  }
  const add = await runGit(root, ["add", "."]);
  if (add.status !== "SUCCEEDED") throw new Error(`fixture add failed: ${add.stderr}`);
  const commit = await runGit(root, ["commit", "--no-verify", "-m", PHASE13_FIXTURE_COMMIT_MESSAGE], {
    GIT_AUTHOR_NAME: PHASE13_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: PHASE13_FIXTURE_IDENTITY.email,
    GIT_AUTHOR_DATE: PHASE13_FIXTURE_COMMIT_DATE,
    GIT_COMMITTER_NAME: PHASE13_FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: PHASE13_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_DATE: PHASE13_FIXTURE_COMMIT_DATE
  });
  if (commit.status !== "SUCCEEDED") throw new Error(`fixture commit failed: ${commit.stderr}`);
  const head = await runGit(root, ["rev-parse", "HEAD"]);
  if (head.status !== "SUCCEEDED") throw new Error(`fixture base SHA failed: ${head.stderr}`);
  const baseSha = head.stdout.trim();
  if (baseSha !== PHASE13_EXPECTED_BASE_SHA) throw new Error(`Synthetic fixture base SHA mismatch: expected ${PHASE13_EXPECTED_BASE_SHA}, got ${baseSha}`);
  return { root, baseSha, files: Object.keys(fixtureContent) };
};

const processSummary = (result: ProcessResult | null): Record<string, unknown> | null => result ? {
  status: result.status,
  exitCode: result.exitCode,
  durationMs: result.durationMs,
  pid: result.pid ?? null,
  stdoutSha256: result.stdoutSha256,
  stderrSha256: result.stderrSha256
} : null;

const processResultFromError = (error: unknown): ProcessResult | null => {
  const candidate = (error as { result?: unknown }).result;
  if (!candidate || typeof candidate !== "object") return null;
  const result = candidate as Partial<ProcessResult>;
  return typeof result.status === "string" && typeof result.stdout === "string" && typeof result.stderr === "string" && typeof result.durationMs === "number" ? candidate as ProcessResult : null;
};

const classifyError = (error: unknown): { code: string; kind: "transport" | "protocol" | "user" | "global" | "none" } => {
  if (error instanceof CodexOutputError) return { code: error.code, kind: "protocol" };
  if (error instanceof CodexRunError) {
    if (error.classification.code === "CLI_NOT_AUTHENTICATED" || error.classification.code === "MODEL_UNAVAILABLE" || error.classification.code === "QUOTA_EXHAUSTED") return { code: error.classification.code, kind: "global" };
    return { code: error.classification.code, kind: error.classification.domain === "runtime" ? "transport" : error.classification.domain === "user" ? "user" : "protocol" };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/OUTPUT_SCHEMA_INVALID|schema/i.test(message)) return { code: "OUTPUT_SCHEMA_INVALID", kind: "protocol" };
  return { code: "MODEL_RUNTIME_FAILED", kind: "transport" };
};

const writeSignal = (text: string): boolean => /\b(?:apply_patch|write_file|edit_file|delete_file|move_file|Set-Content|Out-File)\b|\bgit\s+(?:add|commit|reset|checkout|merge|push)\b|(?:^|\s)(?:rm|rmdir|del|mv|touch)\s+|\b(?:cat|tee)\s+[^\r\n]*(?:>>?|\|)\s*/i.test(text);

const caseManifest = (baseSha: string): Record<string, unknown>[] => phase13RuntimeCases.map((item) => ({
  id: item.id,
  order: item.order,
  kind: item.kind,
  caseDefinitionSha256: hashCaseDefinition(item),
  promptSha256: sha256Text(materializeCasePrompt(item, baseSha)),
  baseSha,
  contextPaths: item.contextPaths,
  fixtureFiles: item.fixtureFiles,
  readOnly: true,
  model: PHASE13_STRONG_MODEL,
  reasoning: PHASE13_REASONING,
  timeoutSeconds: PHASE13_HARD_TIMEOUT_SECONDS
}));

const runCase = async (item: RuntimeStabilityCase, order: number, fixture: { root: string; baseSha: string; files: string[] }, outputRoot: string, schemaPath: string): Promise<RuntimeSample> => {
  const sampleRoot = path.join(outputRoot, `sample-${String(order).padStart(2, "0")}-${item.id}`);
  mkdirSync(sampleRoot);
  const prompt = materializeCasePrompt(item, fixture.baseSha);
  writeJsonAtomic(path.join(sampleRoot, "request.json"), { id: item.id, order, model: PHASE13_STRONG_MODEL, reasoning: PHASE13_REASONING, timeoutSeconds: PHASE13_HARD_TIMEOUT_SECONDS, prompt, caseDefinitionSha256: hashCaseDefinition(item), promptSha256: sha256Text(prompt), baseSha: fixture.baseSha, contextPaths: item.contextPaths });
  const before = await captureFixtureIntegrity(fixture.root, gitStatus, gitDiff, gitHead, fixture.baseSha);
  const started = Date.now();
  let process: ProcessResult | null = null;
  let usage: RuntimeUsage | null = null;
  let protocolValid = false;
  let semanticValid = false;
  let failureCode: string | null = null;
  let failureKind: "transport" | "protocol" | "user" | "global" | "write" | "none" = "none";
  const outputPath = path.join(sampleRoot, "response.json");
  try {
    const execution = await new CodexAdapter().runPlanner({ cwd: fixture.root, model: PHASE13_STRONG_MODEL, reasoning: PHASE13_REASONING, timeoutSeconds: PHASE13_HARD_TIMEOUT_SECONDS, schemaPath, outputPath, prompt, runId: `phase13-${item.id}` });
    process = execution.process;
    usage = execution.usage as RuntimeUsage | null;
    const validation = validateReadOnlyArchitectResponse(execution.output, item, fixture.baseSha, fixture.files);
    protocolValid = validation.schemaValid;
    semanticValid = validation.semanticValid;
    if (!validation.valid) failureCode = "OUTPUT_SCHEMA_INVALID";
    writeJsonAtomic(path.join(sampleRoot, "validation.json"), validation);
  } catch (error) {
    const classified = classifyError(error);
    failureCode = classified.code;
    failureKind = classified.kind;
    const failedProcess = error instanceof CodexRunError ? error.result : processResultFromError(error);
    if (failedProcess) { process = failedProcess; usage = parseCodexUsage(failedProcess.stdout) as RuntimeUsage | null; }
    writeJsonAtomic(path.join(sampleRoot, "error.json"), { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error), failureCode, failureKind });
    if (!process && existsSync(outputPath)) {
      try {
        const validation = validateReadOnlyArchitectResponse(JSON.parse(readFileSync(outputPath, "utf8")), item, fixture.baseSha, fixture.files);
        protocolValid = validation.schemaValid;
        semanticValid = validation.semanticValid;
      } catch { /* the error artifact is authoritative */ }
    }
  }
  const after = await captureFixtureIntegrity(fixture.root, gitStatus, gitDiff, gitHead, fixture.baseSha);
  const stdout = process?.stdout ?? "";
  const stderr = process?.stderr ?? "";
  const fullStdoutPath = path.join(sampleRoot, "stdout.log");
  const fullStderrPath = path.join(sampleRoot, "stderr.log");
  if (process && !existsSync(fullStdoutPath)) writeFileSync(fullStdoutPath, stdout, "utf8");
  if (process && !existsSync(fullStderrPath)) writeFileSync(fullStderrPath, stderr, "utf8");
  const fullStdout = existsSync(fullStdoutPath) ? readFileSync(fullStdoutPath, "utf8") : stdout;
  const fullStderr = existsSync(fullStderrPath) ? readFileSync(fullStderrPath, "utf8") : stderr;
  if (!usage) usage = parseCodexUsage(fullStdout) as RuntimeUsage | null;
  const transport = parseTransportObservation(fullStdout, fullStderr, failureKind === "transport" && Boolean(failureCode));
  const writeAttempt = writeSignal(fullStdout) || writeSignal(fullStderr);
  const integrityValid = before.treeHash === after.treeHash && before.headMatchesBaseSha && after.headMatchesBaseSha && before.clean && after.clean && !writeAttempt;
  if (!integrityValid) { failureCode = "EVIDENCE_CORRUPT"; failureKind = "write"; }
  const classification = failureCode ? (failureKind === "protocol" ? { failureClass: "task-protocol/schema" as const, fatal: true } : failureKind === "write" ? { failureClass: "write/integrity" as const, fatal: true } : failureKind === "user" ? { failureClass: "user" as const, fatal: true } : failureKind === "global" ? { failureClass: "model/auth/quota" as const, fatal: true } : failureKind === "transport" ? { failureClass: "transport/runtime" as const, fatal: true } : { failureClass: "unclassified" as const, fatal: true }) : { failureClass: "none" as const, fatal: false };
  const durationMs = Date.now() - started;
  const artifactHashes: Record<string, string | null> = {
    request: hashFileIfPresent(path.join(sampleRoot, "request.json")),
    response: hashFileIfPresent(outputPath),
    validation: hashFileIfPresent(path.join(sampleRoot, "validation.json")),
    error: hashFileIfPresent(path.join(sampleRoot, "error.json")),
    codexOutputSchema: hashFileIfPresent(path.join(sampleRoot, "codex-output-schema.json")),
    stdout: hashFileIfPresent(fullStdoutPath),
    stderr: hashFileIfPresent(fullStderrPath)
  };
  const sample: RuntimeSample = { id: item.id, order, complete: process !== null && process.status !== "START_FAILED", durationMs, protocolValid, semanticValid, integrityValid, transport, failureCode, failureClass: classification.failureClass, fatal: classification.fatal, retryCount: 0, humanIntervention: false, usage, artifactHashes };
  writeJsonAtomic(path.join(sampleRoot, "sample-manifest.json"), { sample, process: processSummary(process), before, after, writeAttempt });
  const sampleManifestSha256 = hashFile(path.join(sampleRoot, "sample-manifest.json"));
  writeJsonAtomic(path.join(sampleRoot, "result.json"), { ...sample, process: processSummary(process), before, after, writeAttempt, sampleManifestSha256 });
  return sample;
};

export const createPhase13FixtureForTest = createFixture;
export type Phase13RuntimeRun = { outputPath: string; preflight: CodexRuntimePreflightResult; evaluation: ReturnType<typeof evaluateRuntimeStability>; samples: RuntimeSample[] };

export const runPhase13RuntimeHarness = async (env: Record<string, string | undefined> = process.env): Promise<Phase13RuntimeRun> => {
  const { outputPath } = assertPhase13OptIn(env);
  const fixture = await createFixture(outputPath);
  const schemaPath = path.resolve("schemas/task-spec.schema.json");
  writeJsonAtomic(path.join(outputPath, "manifest.json"), { schemaVersion: "1.0", parserVersion: PHASE13_PARSER_VERSION, sampleCount: PHASE13_SAMPLE_COUNT, sampleOrder: phase13CaseOrder, cases: caseManifest(fixture.baseSha), fixture: { baseSha: fixture.baseSha, treeHash: hashDirectory(fixture.root), files: fixture.files }, config: { model: PHASE13_STRONG_MODEL, cheapModel: PHASE13_CHEAP_MODEL, reasoning: PHASE13_REASONING, timeoutSeconds: PHASE13_HARD_TIMEOUT_SECONDS, retryCount: 0, humanIntervention: false } });
  const preflight = await runCodexRuntimePreflight({ models: [PHASE13_STRONG_MODEL, PHASE13_CHEAP_MODEL], artifactRoot: path.join(outputPath, "preflight"), timeoutSeconds: 120 });
  const samples: RuntimeSample[] = [];
  if (!preflight.passed) {
    const blocked = evaluateRuntimeStability({ preflightPassed: false, samples, stopped: true, evidenceValid: true });
    writeJsonAtomic(path.join(outputPath, "partial-evaluation.json"), { schemaVersion: "1.0", parserVersion: PHASE13_PARSER_VERSION, samples, stopped: true, stopReason: "runtime preflight failed", evaluation: blocked });
  }
  if (preflight.passed) {
    for (const item of phase13RuntimeCases) {
      const sample = await runCase(item, item.order, fixture, outputPath, schemaPath);
      samples.push(sample);
      const stop = shouldStopRuntimeRun(samples, sample);
      const decision = evaluateRuntimeStability({ preflightPassed: true, samples, stopped: stop.stop, evidenceValid: sample.integrityValid });
      writeJsonAtomic(path.join(outputPath, "partial-evaluation.json"), { schemaVersion: "1.0", parserVersion: PHASE13_PARSER_VERSION, samples, stopped: stop.stop, stopReason: stop.reason ?? null, evaluation: decision });
      if (stop.stop) break;
    }
  }
  const evaluation = evaluateRuntimeStability({ preflightPassed: preflight.passed, samples, stopped: samples.length < PHASE13_SAMPLE_COUNT && !preflight.passed ? true : samples.length < PHASE13_SAMPLE_COUNT && shouldStopRuntimeRun(samples, samples.at(-1)).stop, evidenceValid: samples.every((sample) => sample.integrityValid) });
  const result = { schemaVersion: "1.0", parserVersion: PHASE13_PARSER_VERSION, preflight, samples, evaluation, product: "NOT_EVALUATED" as const };
  writeJsonAtomic(path.join(outputPath, "evaluation.json"), result);
  writeJsonAtomic(path.join(outputPath, "aggregate-manifest.json"), { schemaVersion: "1.0", parserVersion: PHASE13_PARSER_VERSION, rule: "all files under this run except aggregate-manifest.json itself and fixture/.git metadata", files: collectEvidenceFiles(outputPath) });
  return { outputPath, preflight, evaluation, samples };
};

describe("Phase 1.3 runtime stability harness", () => {
  it.skipIf(!enabled)("runs the preregistered ten read-only Architect requests", async () => {
    const result = await runPhase13RuntimeHarness();
    expect(result.samples.length).toBeLessThanOrEqual(PHASE13_SAMPLE_COUNT);
    expect(result.evaluation.product).toBe("NOT_EVALUATED");
  }, 10_800_000);
});
