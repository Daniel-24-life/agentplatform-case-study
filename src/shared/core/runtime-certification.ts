import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentExecution, PlannerAgentAdapter, PlannerInput } from "../../main/adapters/agent-adapter.js";
import type { ProcessResult } from "../../main/process/runner.js";
import type { TaskSpec } from "./task-spec.js";
import { CANONICAL_TREE_HASH_VERSION, collectEvidenceFiles, hashDirectory, sha256Text } from "./runtime-stability.js";

/**
 * Phase 1.4 is deliberately a separate evidence protocol.  These values are
 * kept here instead of being inferred from a report so that a future real run
 * cannot silently change the canary or certification gates.
 */
export const PHASE14_PROTOCOL_VERSION = "phase1-4-runtime-certification-v1";
export const PHASE14_CANARY_TIMEOUT_SECONDS = 900;
export const PHASE14_BOUNDED_CLEANUP_SECONDS = 10;
export const PHASE14_CANARY_WALL_CLOCK_LIMIT_MS = 910_000;
export const PHASE14_CERTIFICATION_CASE_COUNT = 10;
export const PHASE14_CERTIFICATION_CASE_LIMIT_SECONDS = 600;
export const PHASE14_ISOLATION_CALL_LIMIT = 8;

export const PHASE14_SEALED_PATH_PARTS = [
  "phase1-1-evidence",
  "phase1-2-evidence",
  "phase1-3-evidence",
  "phase1-3-runtime-stability-run1",
  "phase1-ab-artifacts",
  "phase1-1-ab-artifacts",
  "phase1-2-ab-development",
  "phase1-2-ab-holdout",
  "phase1-runtime-preflight",
  "run6",
  "run11"
] as const;

export type Phase14FailureAxis =
  | "PLATFORM_PROCESS_CONTROL"
  | "CODEX_EXEC_COMPLETION"
  | "TRANSPORT_SIGNAL"
  | "PROTOCOL_OUTPUT";

export type Phase14FailureSymptom = "NONE" | "PROCESS_TIMEOUT" | "START_FAILURE" | "TERMINAL_FAILURE" | "OUTPUT_INVALID";

export type Phase14Track = "CANARY" | "ISOLATION" | "CERTIFICATION";

export type Phase14TreeEvidence = {
  /** Must be the same value emitted by preregistration and runtime callers. */
  algorithmVersion: string;
  digest: string;
  fileCount: number;
  byteCount: number;
};

export type Phase14SourceSnapshot = {
  snapshotRoot: string;
  sourceRoot: string;
  gitHead: string | null;
  gitHeadStatus: "AVAILABLE" | "UNAVAILABLE_NO_GIT";
  packageLockSha256: string | null;
  packageLockBytes: number | null;
  tree: Phase14TreeEvidence;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};

export type Phase14CanaryPreregistration = {
  protocolVersion: typeof PHASE14_PROTOCOL_VERSION;
  track: "CANARY";
  canaryId: string;
  productionAdapter: "CodexAdapter.runPlanner";
  readOnly: true;
  timeoutSeconds: typeof PHASE14_CANARY_TIMEOUT_SECONDS;
  cleanupBoundSeconds: typeof PHASE14_BOUNDED_CLEANUP_SECONDS;
  wallClockLimitMs: typeof PHASE14_CANARY_WALL_CLOCK_LIMIT_MS;
  model: string;
  reasoning: "low" | "medium" | "high";
  baseSha: string;
  fixtureTree: Phase14TreeEvidence;
  request: Phase14RequestTelemetry;
  promptSha256: string;
  schemaSha256: string;
  contextSha256: string;
  noRetry: true;
  noFallback: true;
  noHumanIntervention: true;
};

export type Phase14RequestTelemetry = {
  promptBytes: number;
  promptSha256: string;
  schemaBytes: number;
  schemaSha256: string;
  contextBytes: number;
  contextSha256: string;
};

export type Phase14Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
};

export type Phase14RuntimeEvent = {
  name: string;
  atMs: number;
  detail?: string;
};

export type Phase14ProcessTelemetry = {
  lastEvent: string | null;
  lastEventAtMs: number | null;
  largestInterEventGapMs: number | null;
  modelManagerTimeoutMarker: boolean;
  responseCompleted: boolean;
  turnCompleted: boolean;
  taskkillRequestedAtMs: number | null;
  taskkillCompletedAtMs: number | null;
  taskkillResult: string | null;
  stdioTeardown: boolean;
  stdioTeardownAtMs: number | null;
  knownPids: number[];
  remainingKnownPids: number[];
  processTreeConverged: boolean;
  terminalResultPersisted: boolean;
  evidencePersisted: boolean;
};

export type Phase14Sample = {
  protocolVersion: typeof PHASE14_PROTOCOL_VERSION;
  track: Phase14Track;
  id: string;
  order: number;
  runtimeLabel: string;
  model: string;
  reasoning: "low" | "medium" | "high" | null;
  executablePath: string;
  executableSha256: string | null;
  cliVersion: string | null;
  complete: boolean;
  protocolValid: boolean;
  semanticValid: boolean;
  integrityValid: boolean;
  fixtureClean: boolean;
  durationMs: number | null;
  outerWallClockMs: number | null;
  childProcessDurationMs: number | null;
  retryCount: number;
  fallbackCount: number;
  humanIntervention: boolean;
  usage: Phase14Usage | null;
  request: Phase14RequestTelemetry;
  process: Phase14ProcessTelemetry;
  failureSymptom: Phase14FailureSymptom;
  failureAxes: Phase14FailureAxis[];
  failureCode: string | null;
};

export type Phase14CanaryDecision = {
  status: "PASS" | "FAIL" | "BLOCKED";
  qualifiesForIsolation: boolean;
  boundedConvergence: boolean;
  wallClockWithinBound: boolean;
  terminalResultOrFailure: boolean;
  reason: string;
};

export type Phase14CertificationDecision = {
  status: "PASS" | "FAIL" | "BLOCKED";
  validCaseCount: number;
  caseCount: number;
  timedOutCount: number;
  fatalCount: number;
  retryCount: number;
  interventionCount: number;
  fixtureDriftCount: number;
  reason: string;
};

export type Phase14IsolationVariant = {
  id: "I-01" | "I-02" | "I-03" | "I-04";
  changedVariable: "schema" | "context" | "reasoning" | "cli";
  from: string;
  to: string;
  fixed: readonly string[];
};

const fixedIsolationVariables = [
  "machine",
  "proxy",
  "account",
  "model",
  "fixture",
  "baseSha",
  "promptSha256",
  "timeoutSeconds",
  "agentplatformSource"
] as const;

export const PHASE14_ISOLATION_MATRIX: readonly Phase14IsolationVariant[] = [
  { id: "I-01", changedVariable: "schema", from: "structured", to: "simplified", fixed: fixedIsolationVariables },
  { id: "I-02", changedVariable: "context", from: "full repository exploration", to: "bounded prepared context", fixed: fixedIsolationVariables },
  { id: "I-03", changedVariable: "reasoning", from: "medium", to: "low", fixed: fixedIsolationVariables },
  { id: "I-04", changedVariable: "cli", from: "pinned Codex CLI 0.151.0", to: "current qualified stable candidate", fixed: fixedIsolationVariables }
];

/** Fresh certification identifiers are intentionally distinct from P13. */
export const PHASE14_CERTIFICATION_CASE_IDS = Object.freeze(Array.from({ length: PHASE14_CERTIFICATION_CASE_COUNT }, (_, index) => `P14-CERT-${String(index + 1).padStart(2, "0")}`));

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Build hashes and byte telemetry from the exact material sent to Codex.  A
 * caller must provide the prepared context string (or a stable joined form),
 * so the recorded number cannot accidentally mean the whole repository.
 */
export const buildPhase14RequestTelemetry = (input: { prompt: string; schema: string; preparedContext: string }): Phase14RequestTelemetry => ({
  promptBytes: bytes(input.prompt),
  promptSha256: sha256Text(input.prompt),
  schemaBytes: bytes(input.schema),
  schemaSha256: sha256Text(input.schema),
  contextBytes: bytes(input.preparedContext),
  contextSha256: sha256Text(input.preparedContext)
});

/**
 * Return the canonical tree evidence used by both the preregistration writer
 * and the runtime writer.  `hashDirectory` remains the single digest
 * implementation; this wrapper only adds the count/byte telemetry required by
 * the Phase 1.4 evidence contract.
 */
export const capturePhase14TreeEvidence = (root: string): Phase14TreeEvidence => {
  const files = collectEvidenceFiles(root, []);
  return {
    algorithmVersion: CANONICAL_TREE_HASH_VERSION,
    digest: hashDirectory(root),
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.bytes, 0)
  };
};

const SOURCE_SNAPSHOT_DIRECTORIES = new Set(["src", "tests", "schemas", "docs", "scripts", "examples"]);
const SOURCE_SNAPSHOT_ROOT_FILES = new Set([
  "AGENTS.md",
  "README.md",
  "RECOVERY_DELIVERY.md",
  ".eslintrc.cjs",
  ".gitignore",
  "electron.vite.config.ts",
  "eslint.config.js",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.main.json",
  "tsconfig.renderer.json",
  "vitest.config.ts"
]);

const isSnapshotPathAllowed = (relative: string): boolean => {
  const parts = relative.replaceAll("\\", "/").split("/");
  if (parts.some((part) => forbiddenPhase14Part(part))) return false;
  return parts.length === 1 ? SOURCE_SNAPSHOT_ROOT_FILES.has(parts[0]) || SOURCE_SNAPSHOT_DIRECTORIES.has(parts[0]) : SOURCE_SNAPSHOT_DIRECTORIES.has(parts[0]);
};

/**
 * Freeze only source/config/docs/test inputs for Phase 1.4.  The snapshot is
 * intentionally independent from the app's checkout and excludes all prior
 * phase evidence, generated output, and dependency/build directories.
 */
export const createPhase14SourceSnapshot = (input: { sourceRoot: string; snapshotRoot: string }): Phase14SourceSnapshot => {
  const sourceRoot = path.resolve(input.sourceRoot);
  const snapshotRoot = assertFreshPhase14Output(input.snapshotRoot);
  const frozenSourceRoot = path.join(snapshotRoot, "source");
  mkdirSync(frozenSourceRoot, { recursive: true });

  // Deliberately use the filesystem API here; this is a zero-quota local copy
  // and never invokes a shell or a model process.
  const copy = (relative: string): void => {
    if (!isSnapshotPathAllowed(relative)) return;
    const source = path.join(sourceRoot, relative);
    const target = path.join(frozenSourceRoot, relative);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(source)) copy(path.join(relative, entry));
      return;
    }
    if (!stat.isFile()) return;
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  };
  for (const entry of readdirSync(sourceRoot)) copy(entry);

  const files = collectEvidenceFiles(frozenSourceRoot, []);
  const tree = capturePhase14TreeEvidence(frozenSourceRoot);
  const packageLock = files.find((file) => file.path === "pnpm-lock.yaml");
  const gitHead = existsSync(path.join(sourceRoot, ".git")) ? "RECORDED_EXTERNALLY" : null;
  const result: Phase14SourceSnapshot = {
    snapshotRoot,
    sourceRoot: frozenSourceRoot,
    gitHead,
    gitHeadStatus: gitHead ? "AVAILABLE" : "UNAVAILABLE_NO_GIT",
    packageLockSha256: packageLock?.sha256 ?? null,
    packageLockBytes: packageLock?.bytes ?? null,
    tree,
    files
  };
  // Keep the manifest beside (rather than inside) the hashed source tree so
  // writing it cannot alter the recorded source digest.
  writeFileSync(path.join(snapshotRoot, "snapshot-manifest.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
};

export const buildPhase14CanaryPreregistration = (input: {
  canaryId: string;
  model: string;
  reasoning: "low" | "medium" | "high";
  baseSha: string;
  fixtureTree: Phase14TreeEvidence;
  request: Phase14RequestTelemetry;
}): Phase14CanaryPreregistration => ({
  protocolVersion: PHASE14_PROTOCOL_VERSION,
  track: "CANARY",
  canaryId: input.canaryId,
  productionAdapter: "CodexAdapter.runPlanner",
  readOnly: true,
  timeoutSeconds: PHASE14_CANARY_TIMEOUT_SECONDS,
  cleanupBoundSeconds: PHASE14_BOUNDED_CLEANUP_SECONDS,
  wallClockLimitMs: PHASE14_CANARY_WALL_CLOCK_LIMIT_MS,
  model: input.model,
  reasoning: input.reasoning,
  baseSha: input.baseSha,
  fixtureTree: input.fixtureTree,
  request: input.request,
  promptSha256: input.request.promptSha256,
  schemaSha256: input.request.schemaSha256,
  contextSha256: input.request.contextSha256,
  noRetry: true,
  noFallback: true,
  noHumanIntervention: true
});

const eventAt = (event: Phase14RuntimeEvent): number => Number.isFinite(event.atMs) ? event.atMs : 0;

const hasMarker = (stdout: string, stderr: string, pattern: RegExp): boolean => pattern.test(`${stdout}\n${stderr}`);

/** Explicit transport evidence; timeout words alone are intentionally ignored. */
export const hasExplicitPhase14TransportError = (stdout: string, stderr: string): boolean => {
  const text = `${stdout}\n${stderr}`;
  return /(?:reconnect(?:ing|ed)?|fallback|websocket|connection|proxy|transport|socket).{0,120}(?:failed|failure|error|closed|refused|reset|unavailable)|(?:failed|failure|error|closed|refused|reset|unavailable).{0,120}(?:reconnect|fallback|websocket|connection|proxy|transport|socket)/i.test(text);
};

/**
 * Reduce process/event evidence into a stable, JSON-serializable telemetry
 * record.  PROCESS_TIMEOUT remains an event symptom; axis assignment happens
 * independently in classifyPhase14Failure.
 */
export const summarizePhase14Process = (input: {
  events?: readonly Phase14RuntimeEvent[];
  stdout?: string;
  stderr?: string;
  process?: ProcessResult | null;
  knownPids?: readonly number[];
  remainingKnownPids?: readonly number[];
  terminalResultPersisted?: boolean;
  evidencePersisted?: boolean;
  closeObserved?: boolean;
  stdoutClosed?: boolean;
  stderrClosed?: boolean;
  stdoutDestroyed?: boolean;
  stderrDestroyed?: boolean;
}): Phase14ProcessTelemetry => {
  const events = [...(input.events ?? [])].sort((a, b) => eventAt(a) - eventAt(b));
  const last = events.at(-1) ?? null;
  const gaps = events.slice(1).map((event, index) => Math.max(0, eventAt(event) - eventAt(events[index])));
  const result = input.process ?? null;
  const stdout = input.stdout ?? result?.stdout ?? "";
  const stderr = input.stderr ?? result?.stderr ?? "";
  const responseCompleted = hasMarker(stdout, stderr, /(?:^|[\r\n])\s*\{[^\r\n]*"type"\s*:\s*"response\.completed"/m) || /"type"\s*:\s*"response\.completed"/.test(stdout);
  const turnCompleted = /"type"\s*:\s*"turn\.completed"/.test(stdout);
  const taskkill = result?.termination?.taskkill ?? [];
  const taskkillRecord = taskkill.at(-1);
  const closeObserved = input.closeObserved ?? result?.closeObserved ?? false;
  const stdoutClosed = input.stdoutClosed ?? result?.stdoutClosed ?? false;
  const stderrClosed = input.stderrClosed ?? result?.stderrClosed ?? false;
  const stdioTeardown = Boolean(result?.termination?.settledWithoutClose) || events.some((event) => /stdio.*teardown/i.test(event.name)) || closeObserved && stdoutClosed && stderrClosed;
  const pidSet = [...new Set((input.knownPids ?? []).filter((pid): pid is number => Number.isInteger(pid) && pid > 0))];
  const remaining = [...new Set((input.remainingKnownPids ?? []).filter((pid): pid is number => Number.isInteger(pid) && pid > 0))];
  return {
    lastEvent: last?.name ?? null,
    lastEventAtMs: last?.atMs ?? null,
    largestInterEventGapMs: events.length > 1 ? Math.max(...gaps) : null,
    modelManagerTimeoutMarker: /model[- ]manager|refresh timeout|model manager.*timeout/i.test(`${stdout}\n${stderr}`),
    responseCompleted,
    turnCompleted,
    taskkillRequestedAtMs: taskkillRecord?.requestedAtMs ?? events.find((event) => /taskkill.*request/i.test(event.name))?.atMs ?? null,
    taskkillCompletedAtMs: taskkillRecord?.completedAtMs ?? events.find((event) => /taskkill.*(?:complete|result)/i.test(event.name))?.atMs ?? null,
    taskkillResult: taskkillRecord ? `${taskkillRecord.outcome}${taskkillRecord.exitCode === undefined ? "" : `:${taskkillRecord.exitCode ?? "null"}`}` : events.find((event) => /taskkill.*(?:complete|result)/i.test(event.name))?.detail ?? null,
    stdioTeardown,
    stdioTeardownAtMs: events.find((event) => /stdio.*teardown/i.test(event.name))?.atMs ?? (stdioTeardown && closeObserved && stdoutClosed && stderrClosed ? result?.endedAtMs ?? null : null),
    knownPids: pidSet,
    remainingKnownPids: remaining,
    processTreeConverged: remaining.length === 0 && stdioTeardown,
    terminalResultPersisted: input.terminalResultPersisted ?? false,
    evidencePersisted: input.evidencePersisted ?? false
  };
};

export const classifyPhase14Failure = (input: {
  symptom?: Phase14FailureSymptom;
  process: Pick<Phase14ProcessTelemetry, "processTreeConverged" | "terminalResultPersisted" | "evidencePersisted" | "stdioTeardown" | "remainingKnownPids">;
  codex: { responseCompleted: boolean; turnCompleted: boolean; terminal: boolean };
  transport: { failed: boolean; reconnectCount?: number; fallbackCount?: number };
  protocol: { terminalOutput: boolean; schemaValid: boolean; semanticValid: boolean; integrityValid: boolean };
}): { symptom: Phase14FailureSymptom; axes: Phase14FailureAxis[] } => {
  const symptom = input.symptom ?? "NONE";
  const axes = new Set<Phase14FailureAxis>();
  const processFailed = !input.process.processTreeConverged || !input.process.terminalResultPersisted || !input.process.evidencePersisted || !input.process.stdioTeardown && input.process.remainingKnownPids.length > 0;
  if (processFailed) axes.add("PLATFORM_PROCESS_CONTROL");
  // Completion is an execution/transport property.  A terminal process with
  // either explicit response.completed or turn.completed completed the Codex
  // request even when the returned protocol is invalid; protocol failures are
  // classified independently below.
  // The response/turn completion markers are the Codex execution signal.  Do
  // not derive completion from protocol validity (for example, a semantic
  // TaskSpec failure must remain solely PROTOCOL_OUTPUT).  `terminal` is kept
  // in the input for compatibility with existing adapters, but a valid
  // completion marker is authoritative for this axis.
  const codexCompleted = input.codex.responseCompleted || input.codex.turnCompleted;
  if (!codexCompleted) axes.add("CODEX_EXEC_COMPLETION");
  if (input.transport.failed) axes.add("TRANSPORT_SIGNAL");
  if (codexCompleted && (!input.protocol.terminalOutput || !input.protocol.schemaValid || !input.protocol.semanticValid || !input.protocol.integrityValid)) axes.add("PROTOCOL_OUTPUT");
  if (symptom === "START_FAILURE") axes.add("PLATFORM_PROCESS_CONTROL");
  if (symptom === "OUTPUT_INVALID") axes.add("PROTOCOL_OUTPUT");
  // A non-success result must remain classifiable even when an adapter did
  // not emit enough markers to identify a narrower axis.
  if (symptom !== "NONE" && axes.size === 0) axes.add("CODEX_EXEC_COMPLETION");
  return { symptom, axes: [...axes] };
};

export const evaluatePhase14Canary = (sample: Phase14Sample): Phase14CanaryDecision => {
  const duration = sample.durationMs ?? Number.POSITIVE_INFINITY;
  const terminalResultOrFailure = sample.process.terminalResultPersisted || sample.failureSymptom !== "NONE";
  const wallClockWithinBound = duration <= PHASE14_CANARY_WALL_CLOCK_LIMIT_MS;
  const boundedConvergence = sample.process.processTreeConverged && sample.process.stdioTeardown && sample.process.remainingKnownPids.length === 0;
  const qualifiesForIsolation = terminalResultOrFailure && wallClockWithinBound && boundedConvergence && sample.process.evidencePersisted && sample.fixtureClean && sample.humanIntervention === false && sample.retryCount === 0 && sample.fallbackCount === 0;
  let reason = "canary terminalized and process evidence converged within the bound";
  if (!terminalResultOrFailure) reason = "canary did not persist a terminal result or failure";
  else if (!wallClockWithinBound) reason = "canary exceeded the 900s hard timeout plus 10s cleanup bound";
  else if (!boundedConvergence) reason = "process tree or stdio did not converge in the bounded cleanup window";
  else if (!sample.process.evidencePersisted) reason = "canary evidence was not durably persisted";
  else if (!sample.fixtureClean) reason = "fixture was not Git-clean after the canary";
  return { status: qualifiesForIsolation ? "PASS" : terminalResultOrFailure ? "FAIL" : "BLOCKED", qualifiesForIsolation, boundedConvergence, wallClockWithinBound, terminalResultOrFailure, reason };
};

export const evaluatePhase14Certification = (samples: readonly Phase14Sample[]): Phase14CertificationDecision => {
  const timedOut = samples.filter((sample) => sample.failureSymptom === "PROCESS_TIMEOUT" || sample.durationMs === null || sample.durationMs > PHASE14_CERTIFICATION_CASE_LIMIT_SECONDS * 1000).length;
  const expectedIds = new Set(PHASE14_CERTIFICATION_CASE_IDS);
  const actualIds = new Set(samples.map((sample) => sample.id));
  const idMismatch = samples.length !== actualIds.size || actualIds.size !== expectedIds.size || [...expectedIds].some((id) => !actualIds.has(id));
  const fatal = samples.filter((sample) => sample.failureAxes.length > 0 || !sample.complete || !sample.protocolValid || !sample.semanticValid || !sample.integrityValid).length;
  const retries = samples.reduce((total, sample) => total + sample.retryCount, 0);
  const interventions = samples.filter((sample) => sample.humanIntervention).length;
  const drift = samples.filter((sample) => !sample.fixtureClean).length;
  const validCaseCount = samples.filter((sample) => sample.complete && sample.protocolValid && sample.semanticValid && sample.integrityValid && sample.fixtureClean && sample.failureAxes.length === 0 && sample.durationMs !== null && sample.durationMs <= PHASE14_CERTIFICATION_CASE_LIMIT_SECONDS * 1000 && sample.retryCount === 0 && !sample.humanIntervention).length;
  const pass = samples.length === PHASE14_CERTIFICATION_CASE_COUNT && !idMismatch && validCaseCount === PHASE14_CERTIFICATION_CASE_COUNT && timedOut === 0 && fatal === 0 && retries === 0 && interventions === 0 && drift === 0;
  const reason = pass ? "10/10 authoritative structured completions are valid, bounded, clean, and intervention-free" : samples.length !== PHASE14_CERTIFICATION_CASE_COUNT || idMismatch ? "certification requires one fresh complete set of the ten preregistered case IDs" : timedOut > 0 ? "a certification timeout prevents Runtime PASS" : fatal > 0 ? "one or more certification cases have fatal/runtime/protocol evidence" : retries > 0 || interventions > 0 ? "certification recorded app retry or human intervention" : drift > 0 ? "fixture Git cleanliness failed" : "certification criteria were not met";
  return { status: samples.length < PHASE14_CERTIFICATION_CASE_COUNT ? "BLOCKED" : pass ? "PASS" : "FAIL", validCaseCount, caseCount: samples.length, timedOutCount: timedOut, fatalCount: fatal, retryCount: retries, interventionCount: interventions, fixtureDriftCount: drift, reason };
};

export type Phase14SampleExecutor = (_input: {
  track: "ISOLATION" | "CERTIFICATION";
  id: string;
  order: number;
  variant?: Phase14IsolationVariant;
}) => Promise<Phase14Sample>;

export type Phase14IsolationRun = {
  samples: Phase14Sample[];
  strongCalls: number;
  stopped: boolean;
  stopReason: string | null;
  callLimit: number;
};

const shouldStopPhase14Isolation = (sample: Phase14Sample): string | null => {
  if (sample.failureAxes.includes("PLATFORM_PROCESS_CONTROL")) return "platform process-control regression";
  if (sample.failureCode && /auth|quota|unavailable/i.test(sample.failureCode)) return "account/model availability failure";
  if (sample.failureSymptom === "PROCESS_TIMEOUT" && (!sample.process.processTreeConverged || sample.process.remainingKnownPids.length > 0)) return "unbounded timeout convergence failure";
  return null;
};

/**
 * Execute at most eight injected isolation calls, in preregistered order.
 * The executor is deliberately injected so normal tests cannot reach Codex;
 * the production caller supplies the existing CodexAdapter path only after a
 * qualifying canary.
 */
export const runPhase14Isolation = async (input: { canary: Phase14CanaryDecision; execute: Phase14SampleExecutor; callLimit?: number }): Promise<Phase14IsolationRun> => {
  const callLimit = Math.min(PHASE14_ISOLATION_CALL_LIMIT, Math.max(0, input.callLimit ?? PHASE14_ISOLATION_CALL_LIMIT));
  if (!input.canary.qualifiesForIsolation) return { samples: [], strongCalls: 0, stopped: true, stopReason: "process-control canary did not qualify", callLimit };
  const samples: Phase14Sample[] = [];
  let stopReason: string | null = null;
  for (const variant of PHASE14_ISOLATION_MATRIX) {
    if (!isPhase14IsolationCallAllowed(samples.length) || samples.length >= callLimit) break;
    const sample = await input.execute({ track: "ISOLATION", id: variant.id, order: samples.length + 1, variant });
    samples.push(sample);
    stopReason = shouldStopPhase14Isolation(sample);
    if (stopReason) break;
  }
  return { samples, strongCalls: samples.length, stopped: stopReason !== null || samples.length >= callLimit, stopReason, callLimit };
};

export type Phase14CertificationRun = {
  samples: Phase14Sample[];
  decision: Phase14CertificationDecision;
  started: boolean;
};

/** Run a fresh ten-case certification only after isolation explicitly qualifies a candidate. */
export const runPhase14Certification = async (input: { candidateQualified: boolean; execute: Phase14SampleExecutor }): Promise<Phase14CertificationRun> => {
  if (!input.candidateQualified) return { samples: [], decision: evaluatePhase14Certification([]), started: false };
  const samples: Phase14Sample[] = [];
  for (const id of PHASE14_CERTIFICATION_CASE_IDS) {
    samples.push(await input.execute({ track: "CERTIFICATION", id, order: samples.length + 1 }));
  }
  return { samples, decision: evaluatePhase14Certification(samples), started: true };
};

const forbiddenPhase14Part = (part: string): boolean => {
  const lower = part.toLowerCase();
  return PHASE14_SEALED_PATH_PARTS.some((sealed) => lower === sealed || lower.startsWith(`${sealed}-`)) || /^phase1-(?:1|2|3)(?:-|$)/i.test(lower);
};

/** Create a fresh Phase 1.4 run directory and refuse every sealed/historical path. */
export const assertFreshPhase14Output = (outputPath: string): string => {
  const resolved = path.resolve(outputPath);
  if (resolved.split(/[\\/]+/).some(forbiddenPhase14Part)) throw new Error("Phase 1.4 output cannot target a sealed or historical evidence path");
  if (existsSync(resolved)) throw new Error("Phase 1.4 output already exists; refusing to reuse it");
  const parent = path.dirname(resolved);
  if (!existsSync(parent)) throw new Error("Phase 1.4 output parent must already exist");
  mkdirSync(resolved);
  return resolved;
};

export const assertPhase14OptIn = (env: Record<string, string | undefined> = process.env): { outputPath: string } => {
  if (env.RUN_PHASE1_4_RUNTIME !== "1") throw new Error("RUN_PHASE1_4_RUNTIME=1 is required for the Phase 1.4 real-runtime harness");
  if (!env.PHASE1_4_OUTPUT || env.PHASE1_4_OUTPUT.trim().length === 0) throw new Error("PHASE1_4_OUTPUT is required for the Phase 1.4 real-runtime harness");
  return { outputPath: assertExistingPhase14Output(env.PHASE1_4_OUTPUT) };
};

export const assertPhase14PrepareOptIn = (env: Record<string, string | undefined> = process.env): { outputPath: string } => {
  if (env.RUN_PHASE1_4_PREPARE !== "1") throw new Error("RUN_PHASE1_4_PREPARE=1 is required for the Phase 1.4 zero-quota prepare step");
  if (!env.PHASE1_4_OUTPUT || env.PHASE1_4_OUTPUT.trim().length === 0) throw new Error("PHASE1_4_OUTPUT is required for the Phase 1.4 zero-quota prepare step");
  return { outputPath: assertFreshPhase14Output(env.PHASE1_4_OUTPUT) };
};

/** Resolve an already-prepared run without creating or changing it. */
export const assertExistingPhase14Output = (outputPath: string): string => {
  const resolved = path.resolve(outputPath);
  if (resolved.split(/[\\/]+/).some(forbiddenPhase14Part)) throw new Error("Phase 1.4 output cannot target a sealed or historical evidence path");
  if (!existsSync(resolved)) throw new Error("Phase 1.4 prepared output does not exist; run the zero-quota prepare step first");
  if (!statSync(resolved).isDirectory()) throw new Error("Phase 1.4 prepared output must be a directory");
  return resolved;
};

/**
 * The real harness calls this only after the caller has written preregistration
 * and passed the canary gate.  The adapter remains the production
 * CodexAdapter-compatible PlannerAgentAdapter; test doubles can be injected for
 * offline protocol tests without changing the production path.
 */
export const runPhase14ArchitectRequest = async (adapter: PlannerAgentAdapter, input: PlannerInput): Promise<AgentExecution<TaskSpec>> => adapter.runPlanner(input);

export const isPhase14IsolationCallAllowed = (completedStrongCalls: number): boolean => completedStrongCalls < PHASE14_ISOLATION_CALL_LIMIT;

export const isPhase14CertificationSampleId = (value: string): boolean => (PHASE14_CERTIFICATION_CASE_IDS as readonly string[]).includes(value);
