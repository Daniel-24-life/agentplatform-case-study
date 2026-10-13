/**
 * Phase 1.4 conditional real-runtime tracks.
 *
 * This file is intentionally opt-in.  Vitest's normal suite never enters a
 * Codex process.  The track consumes an already terminalized canary directory
 * as an immutable control, creates a new evidence directory, and refuses to
 * run when the preregistered fixed-variable contract cannot be maintained.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildCodexArgs, CodexAdapter, parseCodexUsage } from "../../src/main/adapters/codex/codex-adapter.js";
import { runProcess, type ProcessResult } from "../../src/main/process/runner.js";
import {
  assertExistingPhase14Output,
  assertFreshPhase14Output,
  buildPhase14RequestTelemetry,
  capturePhase14TreeEvidence,
  classifyPhase14Failure,
  createPhase14SourceSnapshot,
  evaluatePhase14Canary,
  evaluatePhase14Certification,
  hasExplicitPhase14TransportError,
  PHASE14_BOUNDED_CLEANUP_SECONDS,
  PHASE14_CANARY_TIMEOUT_SECONDS,
  PHASE14_CERTIFICATION_CASE_IDS,
  PHASE14_ISOLATION_CALL_LIMIT,
  PHASE14_ISOLATION_MATRIX,
  summarizePhase14Process,
  type Phase14CanaryDecision,
  type Phase14IsolationVariant,
  type Phase14RuntimeEvent,
  type Phase14Sample,
  type Phase14Usage
} from "../../src/shared/core/runtime-certification.js";
import { parseTransportObservation, validateReadOnlyArchitectResponse, type RuntimeStabilityCase } from "../../src/shared/core/runtime-stability.js";

const enabled = process.env.RUN_PHASE1_4_ISOLATION === "1";
const certificationEnabled = process.env.RUN_PHASE1_4_CERTIFICATION === "1";

/** Codex CLI feature switches used by I-02; they precede the `exec` command. */
export const PHASE14_BOUNDED_CONTEXT_PREFIX_ARGS = ["--disable", "shell_tool", "--disable", "unified_exec"] as const;
export const phase14IsolationCallDirectory = (outputPath: string, variantId: string): string => path.join(outputPath, variantId);

/** Select a fresh, ordered subset without allowing duplicate or unknown IDs. */
export const selectPhase14IsolationVariants = (raw: string | undefined): Phase14IsolationVariant[] => {
  if (raw === undefined) return [...PHASE14_ISOLATION_MATRIX];
  const values = raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  if (values.length === 0) throw new Error("PHASE1_4_ISOLATION_VARIANTS must contain at least one ID");
  const known = new Set(PHASE14_ISOLATION_MATRIX.map((variant) => variant.id));
  const seen = new Set<string>();
  for (const value of values) {
    if (!known.has(value as Phase14IsolationVariant["id"])) throw new Error(`Unknown Phase 1.4 isolation variant: ${value}`);
    if (seen.has(value)) throw new Error(`Duplicate Phase 1.4 isolation variant: ${value}`);
    seen.add(value);
  }
  return PHASE14_ISOLATION_MATRIX.filter((variant) => seen.has(variant.id));
};

type CanaryRecord = {
  outputPath: string;
  decision: Phase14CanaryDecision;
  sample: Phase14Sample;
  request: { canaryCase: RuntimeStabilityCase; baseSha: string; prompt: string; preparedContext: string; schema: string; request: ReturnType<typeof buildPhase14RequestTelemetry> };
  preregistration: Phase14Sample & { [key: string]: unknown };
  fixtureRoot: string;
  fixtureTreeDigest: string;
  sourceTreeDigest: string;
};

type TrackResult = {
  status: "PASS" | "FAIL" | "BLOCKED";
  outputPath: string;
  samples: Phase14Sample[];
  notRun: Array<{ id: string; reason: string }>;
  strongCalls: number;
  stopReason: string | null;
};

const writeJson = (filePath: string, value: unknown): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const hashFile = (filePath: string): string | null => existsSync(filePath) ? createHash("sha256").update(readFileSync(filePath)).digest("hex") : null;

const readJson = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, "utf8")) as T;

const processFromError = (error: unknown): ProcessResult | null => {
  const candidate = (error as { result?: unknown }).result;
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Partial<ProcessResult>;
  return typeof value.status === "string" && typeof value.stdout === "string" && typeof value.stderr === "string" && typeof value.durationMs === "number" ? candidate as ProcessResult : null;
};

const classifySymptom = (result: ProcessResult | null, outputValid: boolean): Phase14Sample["failureSymptom"] => {
  if (result?.status === "TIMED_OUT") return "PROCESS_TIMEOUT";
  if (result?.status === "START_FAILED") return "START_FAILURE";
  if (result?.status === "SUCCEEDED" && !outputValid) return "OUTPUT_INVALID";
  if (result?.status === "SUCCEEDED") return "NONE";
  return "TERMINAL_FAILURE";
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Read and verify a canary directory without writing to it. */
export const readQualifiedPhase14Canary = (canaryPath: string): CanaryRecord => {
  const outputPath = assertExistingPhase14Output(canaryPath);
  const required = ["canary-prepare-manifest.json", "canary-preregistration.json", "canary-request.json", "canary-sample.json", "canary-decision.json"];
  for (const file of required) if (!existsSync(path.join(outputPath, file))) throw new Error(`Phase 1.4 canary is incomplete: ${file}`);
  const sample = readJson<{ sample: Phase14Sample }>(path.join(outputPath, "canary-sample.json")).sample;
  const decision = readJson<Phase14CanaryDecision>(path.join(outputPath, "canary-decision.json"));
  const prepared = readJson<{ fixture: { rootRelative: string; tree: { digest: string } }; sourceSnapshot: { tree: { digest: string; }; sourceManifestSha256?: string | null }; request: { path: string; sha256: string | null }; preregistration: { path: string; sha256: string | null } }>(path.join(outputPath, "canary-prepare-manifest.json"));
  const request = readJson<CanaryRecord["request"]>(path.join(outputPath, "canary-request.json"));
  const preregistration = readJson<CanaryRecord["preregistration"]>(path.join(outputPath, "canary-preregistration.json"));
  if (!prepared.request.path || hashFile(path.join(outputPath, prepared.request.path)) !== prepared.request.sha256) throw new Error("Phase 1.4 canary request hash changed after prepare");
  if (!prepared.preregistration.path || hashFile(path.join(outputPath, prepared.preregistration.path)) !== prepared.preregistration.sha256) throw new Error("Phase 1.4 canary preregistration hash changed after prepare");
  const evaluated = evaluatePhase14Canary(sample);
  if (JSON.stringify(evaluated) !== JSON.stringify(decision)) throw new Error("Phase 1.4 canary decision does not match the immutable sample");
  if (sample.track !== "CANARY" || sample.id !== "P14-CANARY-01" || !decision.qualifiesForIsolation || decision.status !== "PASS") throw new Error("Phase 1.4 isolation requires a qualifying canary decision");
  const fixtureRoot = path.join(outputPath, prepared.fixture.rootRelative);
  const fixtureTree = capturePhase14TreeEvidence(fixtureRoot);
  const sourceTree = capturePhase14TreeEvidence(path.join(outputPath, "source-snapshot", "source"));
  if (fixtureTree.digest !== prepared.fixture.tree.digest || sourceTree.digest !== prepared.sourceSnapshot.tree.digest) throw new Error("Phase 1.4 canary tree changed; refusing isolation");
  return { outputPath, decision, sample, request, preregistration, fixtureRoot, fixtureTreeDigest: fixtureTree.digest, sourceTreeDigest: sourceTree.digest };
};

export const PHASE14_SIMPLIFIED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    task_id: { type: "string" },
    base_sha: { type: "string" },
    context_paths: { type: "array", items: { type: "string" } },
    facts: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    read_only: { type: "boolean", const: true }
  },
  required: ["task_id", "base_sha", "context_paths", "facts", "risks", "read_only"]
} as const;

const simplifiedSchema = JSON.stringify(PHASE14_SIMPLIFIED_SCHEMA);

type SimplifiedArchitectOutput = {
  task_id: string;
  base_sha: string;
  context_paths: string[];
  facts: string[];
  risks: string[];
  read_only: true;
};

const hasAffirmativeWriteIntent = (values: readonly string[]): boolean => /(?:\b(?:will|should|must|please)\s+(?:write|edit|create|delete|rename|commit|push|run|execute)\b|\b(?:write|edit|create|delete|rename|commit|push)\s+(?:the|a|an|any|files?|repository)\b|\bgit\s+(?:add|commit|push|reset|checkout)\b)/i.test(values.join("\n"));

/** Independent I-01 validator; it deliberately does not call TaskSpec validation. */
export const validatePhase14SimplifiedArchitectResponse = (output: unknown, input: { taskId: string; baseSha: string; contextPaths: readonly string[] }): { schemaValid: boolean; semanticValid: boolean } => {
  if (!output || typeof output !== "object" || Array.isArray(output)) return { schemaValid: false, semanticValid: false };
  const value = output as Partial<SimplifiedArchitectOutput> & Record<string, unknown>;
  const schemaValid = typeof value.task_id === "string" && typeof value.base_sha === "string" && Array.isArray(value.context_paths) && value.context_paths.every((item) => typeof item === "string") && Array.isArray(value.facts) && value.facts.every((item) => typeof item === "string") && Array.isArray(value.risks) && value.risks.every((item) => typeof item === "string") && value.read_only === true && Object.keys(value).every((key) => Object.prototype.hasOwnProperty.call(PHASE14_SIMPLIFIED_SCHEMA.properties, key));
  if (!schemaValid) return { schemaValid: false, semanticValid: false };
  const contextPaths = value.context_paths as string[];
  const facts = value.facts as string[];
  const risks = value.risks as string[];
  const semanticValid = value.task_id === input.taskId && value.base_sha === input.baseSha && input.contextPaths.every((item) => contextPaths.includes(item)) && facts.length > 0 && risks.length > 0 && value.read_only === true && !hasAffirmativeWriteIntent([...facts, ...risks]);
  return { schemaValid: true, semanticValid };
};

const runVariant = async (input: {
  canary: CanaryRecord;
  variant: Phase14IsolationVariant;
  outputPath: string;
  executablePath: string;
  schemaPath: string;
  schema: string;
  prompt: string;
  reasoning: "low" | "medium" | "high";
  model: string;
  order: number;
  prefixArgs?: string[];
  sourceTreeDigest: string;
  sourceManifestSha256: string;
}): Promise<Phase14Sample> => {
  const startedAt = Date.now();
  const events: Phase14RuntimeEvent[] = [{ name: "prepared.input.verified", atMs: startedAt }];
  const callPath = phase14IsolationCallDirectory(input.outputPath, input.variant.id);
  mkdirSync(callPath, { recursive: true });
  const responsePath = path.join(callPath, "response.json");
  const adapter = new CodexAdapter(input.executablePath, input.prefixArgs ?? []);
  let execution: { output: unknown; process: ProcessResult; usage: Phase14Usage | null } | null = null;
  let failedProcess: ProcessResult | null = null;
  let error: unknown = null;
  let protocolValid = false;
  let semanticValid = false;
  try {
    if (input.variant.id === "I-01") {
      const directProcess = await runProcess({ program: input.executablePath, args: [...(input.prefixArgs ?? []), ...buildCodexArgs({ role: "architect", cwd: input.canary.fixtureRoot, model: input.model, reasoning: input.reasoning, timeoutSeconds: PHASE14_CANARY_TIMEOUT_SECONDS, schemaPath: input.schemaPath, outputPath: responsePath, prompt: input.prompt, runId: `phase14-isolation-${input.variant.id}`, onSpawn: (pid) => events.push({ name: "process.spawn", atMs: Date.now(), detail: String(pid ?? "null") }), onOutput: (stream, atMs, bytes) => events.push({ name: `${stream}.activity`, atMs, detail: String(bytes) }) })], cwd: input.canary.fixtureRoot, timeoutSeconds: PHASE14_CANARY_TIMEOUT_SECONDS, logDir: callPath, runId: `phase14-isolation-${input.variant.id}`, onSpawn: (pid) => events.push({ name: "process.spawn", atMs: Date.now(), detail: String(pid ?? "null") }), onOutput: (stream, atMs, bytes) => events.push({ name: `${stream}.activity`, atMs, detail: String(bytes) }) });
      if (directProcess.status !== "SUCCEEDED") {
        failedProcess = directProcess;
        throw new Error(`I-01 Codex process ${directProcess.status}`);
      }
      failedProcess = directProcess;
      execution = { output: JSON.parse(readFileSync(responsePath, "utf8")) as unknown, process: directProcess, usage: parseCodexUsage(directProcess.stdout) };
    } else {
      execution = await adapter.runPlanner({ cwd: input.canary.fixtureRoot, model: input.model, reasoning: input.reasoning, timeoutSeconds: PHASE14_CANARY_TIMEOUT_SECONDS, schemaPath: input.schemaPath, outputPath: responsePath, prompt: input.prompt, runId: `phase14-isolation-${input.variant.id}`, onSpawn: (pid) => events.push({ name: "process.spawn", atMs: Date.now(), detail: String(pid ?? "null") }), onOutput: (stream, atMs, bytes) => events.push({ name: `${stream}.activity`, atMs, detail: String(bytes) }) });
    }
    const validation = input.variant.id === "I-01" ? validatePhase14SimplifiedArchitectResponse(execution.output, { taskId: input.canary.request.canaryCase.id, baseSha: input.canary.request.baseSha, contextPaths: input.canary.request.canaryCase.contextPaths }) : validateReadOnlyArchitectResponse(execution.output, input.canary.request.canaryCase, input.canary.request.baseSha, input.canary.request.canaryCase.fixtureFiles);
    protocolValid = validation.schemaValid;
    semanticValid = validation.semanticValid;
  } catch (caught) {
    error = caught;
    failedProcess = processFromError(caught) ?? failedProcess;
  }
  const process = execution?.process ?? failedProcess;
  events.push({ name: "process.terminal", atMs: Date.now(), detail: process?.status ?? "unknown" });
  const knownPids = events.filter((event) => event.name === "process.spawn").map((event) => Number(event.detail)).filter((pid) => Number.isInteger(pid) && pid > 0);
  const remainingKnownPids = knownPids.filter(processIsAlive);
  const terminalPath = path.join(callPath, "terminal-result.json");
  writeJson(terminalPath, execution ? { status: execution.process.status, output: execution.output, usage: execution.usage } : { status: process?.status ?? "UNKNOWN", error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) } });
  const stdoutPath = path.join(callPath, "stdout.log");
  const stderrPath = path.join(callPath, "stderr.log");
  const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : process?.stdout ?? "";
  const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : process?.stderr ?? "";
  const fixtureAfter = await runProcess({ program: "git", args: ["status", "--porcelain=v1"], cwd: input.canary.fixtureRoot, timeoutSeconds: 30 });
  const fixtureClean = fixtureAfter.status === "SUCCEEDED" && fixtureAfter.stdout.trim().length === 0 && capturePhase14TreeEvidence(input.canary.fixtureRoot).digest === input.canary.fixtureTreeDigest;
  const processTelemetry = summarizePhase14Process({ events, stdout, stderr, process, knownPids, remainingKnownPids, terminalResultPersisted: existsSync(terminalPath), evidencePersisted: existsSync(terminalPath) && existsSync(path.join(input.outputPath, "isolation-preregistration.json")), closeObserved: process?.closeObserved, stdoutClosed: process?.stdoutClosed, stderrClosed: process?.stderrClosed, stdoutDestroyed: process?.stdoutDestroyed, stderrDestroyed: process?.stderrDestroyed });
  const transport = parseTransportObservation(stdout, stderr, false);
  const authoritative = process?.status === "SUCCEEDED" && (processTelemetry.responseCompleted || processTelemetry.turnCompleted) && protocolValid && semanticValid;
  const codexTerminal = process?.status === "SUCCEEDED";
  const symptom = classifySymptom(process, protocolValid && semanticValid);
  const explicitTransportFailure = hasExplicitPhase14TransportError(stdout, stderr);
  const availabilityFailure = /(?:auth(?:entication|orization)?|invalid[_ -]?api[_ -]?key|quota|rate[ -]?limit|insufficient(?:[_ -]?quota|[_ -]?usage)|(?:account|model|service)[^\r\n]{0,80}unavailable|temporarily unavailable)/i.test(`${error instanceof Error ? error.message : String(error ?? "")}\n${stderr}`);
  const axes = classifyPhase14Failure({ symptom, process: processTelemetry, codex: { responseCompleted: processTelemetry.responseCompleted, turnCompleted: processTelemetry.turnCompleted, terminal: codexTerminal }, transport: { failed: explicitTransportFailure || transport.reconnectCount > 0 || transport.fallbackCount > 0, reconnectCount: transport.reconnectCount, fallbackCount: transport.fallbackCount }, protocol: { terminalOutput: codexTerminal, schemaValid: protocolValid, semanticValid, integrityValid: fixtureClean } });
  const request = buildPhase14RequestTelemetry({ prompt: input.prompt, schema: input.schema, preparedContext: input.canary.request.preparedContext });
  const sample: Phase14Sample = { protocolVersion: "phase1-4-runtime-certification-v1", track: "ISOLATION", id: input.variant.id, order: input.order, runtimeLabel: input.variant.id === "I-04" ? "current-qualified-stable-candidate" : "codex-cli-0.151.0", model: input.model, reasoning: input.reasoning, executablePath: input.executablePath, executableSha256: hashFile(input.executablePath), cliVersion: null, complete: authoritative, protocolValid, semanticValid, integrityValid: fixtureClean, fixtureClean, durationMs: Date.now() - startedAt, outerWallClockMs: Date.now() - startedAt, childProcessDurationMs: process?.durationMs ?? null, retryCount: 0, fallbackCount: transport.fallbackCount, humanIntervention: false, usage: execution?.usage ?? null, request, process: processTelemetry, failureSymptom: symptom, failureAxes: axes.axes, failureCode: availabilityFailure ? "ACCOUNT_QUOTA_OR_MODEL_UNAVAILABLE" : axes.axes.length > 0 ? "PHASE14_RUNTIME_FAILURE" : null };
  writeJson(path.join(callPath, "sample.json"), { sample, fixtureTree: input.canary.fixtureTreeDigest, fixedAgentPlatformSource: { treeDigest: input.sourceTreeDigest, manifestSha256: input.sourceManifestSha256 }, process, timeline: events, logs: { stdout: hashFile(stdoutPath), stderr: hashFile(stderrPath), error: error instanceof Error ? error.message : String(error ?? "") } });
  return sample;
};

const stopReason = (sample: Phase14Sample): string | null => {
  if (sample.failureAxes.includes("PLATFORM_PROCESS_CONTROL")) return "platform process-control regression";
  if (sample.failureCode && /auth|quota|unavailable/i.test(sample.failureCode)) return "account/model availability failure";
  if (sample.failureSymptom === "PROCESS_TIMEOUT" && (!sample.process.processTreeConverged || sample.process.remainingKnownPids.length > 0)) return "unbounded timeout convergence failure";
  return null;
};

/** Execute the conditional isolation matrix; no call starts before canary PASS. */
export const runPhase14IsolationTrack = async (env: Record<string, string | undefined> = process.env): Promise<TrackResult> => {
  if (env.RUN_PHASE1_4_ISOLATION !== "1") throw new Error("RUN_PHASE1_4_ISOLATION=1 is required for Phase 1.4 isolation");
  if (!env.PHASE1_4_CANARY_OUTPUT) throw new Error("PHASE1_4_CANARY_OUTPUT is required");
  const selectedVariants = selectPhase14IsolationVariants(env.PHASE1_4_ISOLATION_VARIANTS);
  const canary = readQualifiedPhase14Canary(env.PHASE1_4_CANARY_OUTPUT);
  const parent = env.PHASE1_4_ISOLATION_OUTPUT ? path.dirname(path.resolve(env.PHASE1_4_ISOLATION_OUTPUT)) : path.join(path.dirname(canary.outputPath));
  const outputPath = assertFreshPhase14Output(env.PHASE1_4_ISOLATION_OUTPUT ?? path.join(parent, `runtime-isolation-${Date.now()}`));
  const executablePath = env.CODEX_PROGRAM;
  if (!executablePath || !path.isAbsolute(executablePath) || !existsSync(executablePath)) throw new Error("CODEX_PROGRAM must be an existing absolute executable path");
  const model = canary.sample.model;
  const currentSourceSnapshot = createPhase14SourceSnapshot({ sourceRoot: process.cwd(), snapshotRoot: path.join(outputPath, "current-source-snapshot") });
  const currentSourceManifestPath = path.join(currentSourceSnapshot.snapshotRoot, "snapshot-manifest.json");
  const currentSourceManifestSha256 = hashFile(currentSourceManifestPath);
  if (!currentSourceManifestSha256) throw new Error("Phase 1.4 current source manifest was not persisted");
  const schemaPath = path.join(canary.outputPath, "source-snapshot", "source", "schemas", "task-spec.schema.json");
  const simplifiedSchemaPath = path.join(outputPath, "i-01-simplified-schema.json");
  writeJson(simplifiedSchemaPath, PHASE14_SIMPLIFIED_SCHEMA);
  const fixed = { machine: "current Windows host", proxy: "CodexAdapter production proxy resolver", account: "same authenticated account", model, fixtureTreeDigest: canary.fixtureTreeDigest, baseSha: canary.request.baseSha, promptSha256: canary.request.request.promptSha256, timeoutSeconds: PHASE14_CANARY_TIMEOUT_SECONDS, agentplatformSourceTreeDigest: currentSourceSnapshot.tree.digest, agentplatformSourceManifestSha256: currentSourceManifestSha256 };
  writeJson(path.join(outputPath, "isolation-preregistration.json"), { protocolVersion: "phase1-4-runtime-certification-v1", track: "ISOLATION", preparedAt: new Date().toISOString(), canaryControl: { directory: canary.outputPath, sourceTreeDigest: canary.sourceTreeDigest, decisionSha256: hashFile(path.join(canary.outputPath, "canary-decision.json")), sampleSha256: hashFile(path.join(canary.outputPath, "canary-sample.json")), preregistrationSha256: hashFile(path.join(canary.outputPath, "canary-preregistration.json")), decision: canary.decision }, fixed, callLimit: PHASE14_ISOLATION_CALL_LIMIT, matrix: selectedVariants.map((variant) => ({ ...variant, fixedAgentPlatformSourceTreeDigest: currentSourceSnapshot.tree.digest, fixedAgentPlatformSourceManifestSha256: currentSourceManifestSha256 })), boundedContextFlags: [...PHASE14_BOUNDED_CONTEXT_PREFIX_ARGS], simplifiedSchemaPath: "i-01-simplified-schema.json", source: "fresh evidence; canary is read-only control" });
  const samples: Phase14Sample[] = [];
  const notRun: Array<{ id: string; reason: string }> = [];
  let stop: string | null = null;
  for (const variant of selectedVariants) {
    if (samples.length >= PHASE14_ISOLATION_CALL_LIMIT || stop) break;
    if (variant.id === "I-04") {
      const candidate = env.PHASE1_4_CLI_CANDIDATE;
      if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate) || path.resolve(candidate) === path.resolve(executablePath)) {
        notRun.push({ id: variant.id, reason: "NOT_RUN: no distinct current qualified stable candidate absolute executable was supplied" });
        continue;
      }
    }
    const variantExecutable = variant.id === "I-04" ? env.PHASE1_4_CLI_CANDIDATE! : executablePath;
    const variantReasoning = variant.id === "I-03" ? "low" : canary.sample.reasoning ?? "medium";
    const variantSchema = variant.id === "I-01" ? simplifiedSchema : canary.request.schema;
    const variantSchemaPath = variant.id === "I-01" ? simplifiedSchemaPath : schemaPath;
    const prefixArgs = variant.id === "I-02" ? [...PHASE14_BOUNDED_CONTEXT_PREFIX_ARGS] : [];
    const sample = await runVariant({ canary, variant, outputPath, executablePath: variantExecutable, schemaPath: variantSchemaPath, schema: variantSchema, prompt: canary.request.prompt, reasoning: variantReasoning, model, order: samples.length + 1, prefixArgs, sourceTreeDigest: currentSourceSnapshot.tree.digest, sourceManifestSha256: currentSourceManifestSha256 });
    samples.push(sample);
    stop = stopReason(sample);
  }
  const candidate = samples.find((sample) => sample.complete && sample.protocolValid && sample.semanticValid && sample.integrityValid && sample.fixtureClean && sample.failureAxes.length === 0 && sample.retryCount === 0 && !sample.humanIntervention);
  const status = stop ? "BLOCKED" : samples.some((sample) => sample.failureAxes.length > 0) ? "FAIL" : "BLOCKED";
  const candidateSamplePath = candidate ? path.relative(outputPath, path.join(phase14IsolationCallDirectory(outputPath, candidate.id), "sample.json")).replaceAll("\\", "/") : null;
  const candidateEvidenceSha256 = candidateSamplePath ? hashFile(path.join(outputPath, candidateSamplePath)) : null;
  writeJson(path.join(outputPath, "isolation-summary.json"), { status, candidateQualified: candidate !== undefined && candidateEvidenceSha256 !== null, candidateRuntime: candidate?.runtimeLabel ?? null, candidateSamplePath, candidateEvidenceSha256, fixedAgentPlatformSource: { treeDigest: currentSourceSnapshot.tree.digest, manifestSha256: currentSourceManifestSha256 }, samples: samples.map((sample) => ({ id: sample.id, runtimeLabel: sample.runtimeLabel, failureAxes: sample.failureAxes, failureSymptom: sample.failureSymptom, durationMs: sample.durationMs, usage: sample.usage })), notRun, strongCalls: samples.length, callLimit: PHASE14_ISOLATION_CALL_LIMIT, stopReason: stop, canaryControl: { directory: canary.outputPath, sourceTreeDigest: canary.sourceTreeDigest, decisionSha256: hashFile(path.join(canary.outputPath, "canary-decision.json")) } });
  return { status, outputPath, samples, notRun, strongCalls: samples.length, stopReason: stop };
};

/** Certification is kept behind a distinct candidate marker and fresh root. */
export const phase14CertificationPrerequisite = (isolationSummaryPath: string): boolean => {
  if (!existsSync(isolationSummaryPath)) return false;
  const summary = readJson<{ candidateQualified?: boolean; candidateRuntime?: string; candidateSamplePath?: string | null; candidateEvidenceSha256?: string | null }>(isolationSummaryPath);
  if (summary.candidateQualified !== true || typeof summary.candidateRuntime !== "string" || summary.candidateRuntime.length === 0 || typeof summary.candidateSamplePath !== "string" || typeof summary.candidateEvidenceSha256 !== "string") return false;
  const summaryRoot = path.dirname(path.resolve(isolationSummaryPath));
  const candidatePath = path.resolve(summaryRoot, summary.candidateSamplePath);
  if (!candidatePath.startsWith(`${summaryRoot}${path.sep}`)) return false;
  return hashFile(candidatePath) === summary.candidateEvidenceSha256;
};

/** A certification preregistration always names a new, complete ten-case set. */
export const buildPhase14CertificationPreregistration = (input: { candidateEvidencePath: string; runtimeLabel: string; fixtureTreeDigest: string; baseSha: string; promptSha256: string; schemaSha256: string; contextSha256: string }) => ({
  protocolVersion: "phase1-4-runtime-certification-v1",
  track: "CERTIFICATION" as const,
  source: "fresh independent certification; Phase 1.3 samples are excluded",
  candidateEvidencePath: input.candidateEvidencePath,
  runtimeLabel: input.runtimeLabel,
  fixtureTreeDigest: input.fixtureTreeDigest,
  baseSha: input.baseSha,
  request: { promptSha256: input.promptSha256, schemaSha256: input.schemaSha256, contextSha256: input.contextSha256 },
  caseIds: [...PHASE14_CERTIFICATION_CASE_IDS],
  requirements: { authoritativeStructuredCompletion: 10, semanticAndIntegrityValid: 10, maxSecondsPerCase: 600, maxRetries: 0, maxHumanIntervention: 0, maxFatalRuntime: 0, fixtureMustRemainClean: true, boundedTimeoutSeconds: 910 }
});

export type Phase14CertificationExecutor = (_input: { id: string; order: number; outputPath: string }) => Promise<Phase14Sample>;

/**
 * Run the fresh ten-case certification only from an explicit isolation
 * candidate marker.  The executor is injected so this orchestration remains
 * quota-free in normal tests; the real runner supplies the existing Codex
 * Adapter path after the canary and isolation gates.
 */
export const runPhase14CertificationTrack = async (input: {
  candidateEvidencePath: string;
  outputPath: string;
  preregistration: ReturnType<typeof buildPhase14CertificationPreregistration>;
  execute: Phase14CertificationExecutor;
}): Promise<{ outputPath: string; samples: Phase14Sample[]; decision: ReturnType<typeof evaluatePhase14Certification> }> => {
  if (!phase14CertificationPrerequisite(input.candidateEvidencePath)) throw new Error("Phase 1.4 certification requires an explicitly qualified isolation candidate");
  const outputPath = assertFreshPhase14Output(input.outputPath);
  writeJson(path.join(outputPath, "certification-preregistration.json"), input.preregistration);
  const samples: Phase14Sample[] = [];
  for (const [index, id] of PHASE14_CERTIFICATION_CASE_IDS.entries()) {
    const sample = await input.execute({ id, order: index + 1, outputPath });
    if (sample.track !== "CERTIFICATION" || sample.id !== id || sample.order !== index + 1) throw new Error(`Phase 1.4 certification executor returned an invalid fresh case: ${id}`);
    samples.push(sample);
    writeJson(path.join(outputPath, `${id.toLowerCase()}-sample.json`), sample);
  }
  const decision = evaluatePhase14Certification(samples);
  writeJson(path.join(outputPath, "certification-decision.json"), decision);
  return { outputPath, samples, decision };
};

export const certificationGate = (samples: readonly Phase14Sample[]) => evaluatePhase14Certification(samples);

describe("Phase 1.4 conditional isolation and certification tracks", () => {
  it.skipIf(enabled)("keeps normal tests quota-free", () => expect(enabled).toBe(false));
  it.skipIf(certificationEnabled)("keeps certification behind an explicit candidate marker", () => expect(phase14CertificationPrerequisite("missing-isolation-summary.json")).toBe(false));
  it.skipIf(enabled)("retains the eight-call hard cap and four preregistered variables", () => {
    expect(PHASE14_ISOLATION_CALL_LIMIT).toBe(8);
    expect(PHASE14_ISOLATION_MATRIX.map((variant) => variant.id)).toEqual(["I-01", "I-02", "I-03", "I-04"]);
    expect(PHASE14_BOUNDED_CLEANUP_SECONDS).toBe(10);
  });
  it.skipIf(!enabled)("runs only from a qualifying immutable canary", async () => {
    const result = await runPhase14IsolationTrack();
    expect(result.outputPath).toContain("runtime-isolation");
    expect(result.strongCalls).toBeLessThanOrEqual(PHASE14_ISOLATION_CALL_LIMIT);
  }, 3_700_000);
  it.skipIf(certificationEnabled)("certification track remains candidate gated", () => {
    expect(phase14CertificationPrerequisite("missing-isolation-summary.json")).toBe(false);
  });
});
