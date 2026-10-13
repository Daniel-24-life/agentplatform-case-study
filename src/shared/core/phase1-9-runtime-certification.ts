import { buildTaskSpecPrompt } from "./task-spec-prompt.js";
import { validateTaskSpec, validateTaskSpecIdentity, type TaskSpec } from "./task-spec.js";
import { parseCodexTerminalEvents } from "./codex-terminal-events.js";

export const PHASE_1_9_CASE_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `P19-ARCH-${String(index + 1).padStart(2, "0")}`)
);
export const PHASE_1_9_TIMEOUT_MS = 300_000;
export const PHASE_1_9_CLEANUP_CEILING_MS = 10_000;
export const PHASE_1_9_MODEL = "gpt-5.6-sol";
export const PHASE_1_9_REASONING = "medium" as const;

export type Phase19CaseRegistration = {
  id: string;
  order: number;
  title: string;
  focus: string;
  fixtureFiles: readonly string[];
  contextPaths: readonly string[];
  baseSha: string;
  baseTree: string;
  contextSha256: string;
  contextBytes: number;
  prompt: string;
  promptSha256: string;
  schemaSha256: string;
};

export type Phase19Registration = {
  version: "phase1.9-codex-exec.v1";
  model: typeof PHASE_1_9_MODEL;
  reasoning: typeof PHASE_1_9_REASONING;
  timeoutMs: typeof PHASE_1_9_TIMEOUT_MS;
  cleanupCeilingMs: typeof PHASE_1_9_CLEANUP_CEILING_MS;
  retryCount: 0;
  humanInterventionCount: 0;
  cases: readonly Phase19CaseRegistration[];
};

export type Phase19ProcessStatus = "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "START_FAILED";
export type Phase19FixtureState = { head: string; tree: string; status: string };
export type Phase19Sample = {
  id: string;
  order: number;
  processStatus: Phase19ProcessStatus;
  exitCode: number | null;
  durationMs: number;
  cleanupDurationMs: number;
  stdout: string;
  taskSpec: unknown;
  before: Phase19FixtureState;
  after: Phase19FixtureState;
  processConverged: boolean;
  stdioConverged: boolean;
  artifactHashesValid: boolean;
  retryCount: number;
  humanIntervention: boolean;
};

export type Phase19SampleResult = {
  id: string;
  order: number;
  status: "PASS" | "FAIL";
  reasons: readonly string[];
  taskSpec?: TaskSpec;
};

export type Phase19RunDecision = {
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  calls: number;
  passed: number;
  failed: number;
  notRun: readonly string[];
  reasons: readonly string[];
};

export type Phase19ExecutionApproval = {
  execution_authorized: boolean;
  preparation_seal_sha256: string;
  output_root: string;
  max_requests: number;
  retry_count: number;
  stop_on_first_fatal: boolean;
};

/** Validate a separately reviewed execution packet. This is a guard only; it never launches a process. */
export function validatePhase19ExecutionApproval(
  approval: Phase19ExecutionApproval,
  expected: { preparationSealSha256: string; outputRoot: string; outputRootExists: boolean },
): readonly string[] {
  const errors: string[] = [];
  if (approval.execution_authorized !== true) errors.push("EXECUTION_NOT_AUTHORIZED");
  if (!/^[0-9a-f]{64}$/.test(expected.preparationSealSha256) || approval.preparation_seal_sha256 !== expected.preparationSealSha256) errors.push("PREPARATION_SEAL_MISMATCH");
  if (!pathIsAbsolute(approval.output_root) || approval.output_root !== expected.outputRoot) errors.push("OUTPUT_ROOT_MISMATCH");
  if (expected.outputRootExists) errors.push("OUTPUT_ROOT_NOT_FRESH");
  if (!Number.isInteger(approval.max_requests) || approval.max_requests < 1 || approval.max_requests > PHASE_1_9_CASE_IDS.length) errors.push("REQUEST_BUDGET_INVALID");
  if (approval.retry_count !== 0) errors.push("RETRY_NOT_ZERO");
  if (approval.stop_on_first_fatal !== true) errors.push("FIRST_FATAL_STOP_REQUIRED");
  return [...new Set(errors)];
}

const pathIsAbsolute = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");

export function buildPhase19Prompt(input: {
  taskId: string;
  baseSha: string;
  focus: string;
  contextPaths: string[];
  allowedPaths: string[];
}): string {
  const command = { id: "unit-tests", program: "pnpm", args: ["test"], cwd: ".", timeout_seconds: 300, required: true };
  return buildTaskSpecPrompt({
    taskId: input.taskId,
    baseSha: input.baseSha,
    request: `Create a read-only TaskSpec focused on ${input.focus}. Preserve the supplied task identity. Do not modify files or execute commands.`,
    contextPaths: input.contextPaths,
    allowedPaths: input.allowedPaths,
  }).replace(
    "test_commands are structured platform-owned declarations for the platform to execute later; do not execute them.",
    `test_commands MUST equal this JSON array exactly; preserve timeout_seconds as 300, never 3000; these are declarations for the platform to execute later, so do not execute them: ${JSON.stringify([command])}`,
  );
}

export function validatePhase19Registration(registration: Phase19Registration): readonly string[] {
  const errors: string[] = [];
  if (registration.version !== "phase1.9-codex-exec.v1") errors.push("REGISTRATION_VERSION_INVALID");
  if (registration.model !== PHASE_1_9_MODEL) errors.push("REGISTRATION_MODEL_INVALID");
  if (registration.reasoning !== PHASE_1_9_REASONING) errors.push("REGISTRATION_REASONING_INVALID");
  if (registration.timeoutMs !== PHASE_1_9_TIMEOUT_MS) errors.push("REGISTRATION_TIMEOUT_INVALID");
  if (registration.cleanupCeilingMs !== PHASE_1_9_CLEANUP_CEILING_MS) errors.push("REGISTRATION_CLEANUP_INVALID");
  if (registration.retryCount !== 0) errors.push("REGISTRATION_RETRY_NOT_ZERO");
  if (registration.humanInterventionCount !== 0) errors.push("REGISTRATION_INTERVENTION_NOT_ZERO");
  if (registration.cases.length !== PHASE_1_9_CASE_IDS.length) errors.push("REGISTRATION_CASE_COUNT_INVALID");
  const ids = registration.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) errors.push("REGISTRATION_DUPLICATE_CASE");
  if (PHASE_1_9_CASE_IDS.some((id, index) => ids[index] !== id)) errors.push("REGISTRATION_ORDER_INVALID");
  registration.cases.forEach((item, index) => {
    if (item.order !== index + 1) errors.push("REGISTRATION_CASE_ORDER_INVALID");
    if (!/^[0-9a-f]{40}$/.test(item.baseSha) || !/^[0-9a-f]{40}$/.test(item.baseTree)) errors.push("REGISTRATION_GIT_IDENTITY_INVALID");
    if (!/^[0-9a-f]{64}$/.test(item.contextSha256) || !/^[0-9a-f]{64}$/.test(item.promptSha256) || !/^[0-9a-f]{64}$/.test(item.schemaSha256)) errors.push("REGISTRATION_HASH_INVALID");
    if (!Number.isInteger(item.contextBytes) || item.contextBytes < 1) errors.push("REGISTRATION_CONTEXT_SIZE_INVALID");
    if (!item.prompt.includes(`task_id MUST be exactly: ${item.id}`) || !item.prompt.includes(`base_sha MUST be exactly: ${item.baseSha}`)) errors.push("REGISTRATION_PROMPT_IDENTITY_MISSING");
    const oldCommandPrompt = item.prompt.includes("test_commands are declarations for the platform to execute later; do not execute them");
    const newCommandPrompt = item.prompt.includes("test_commands MUST equal this JSON array exactly") && item.prompt.includes('"timeout_seconds":300');
    if (!oldCommandPrompt && !newCommandPrompt) errors.push("REGISTRATION_TEST_AUTHORITY_MISSING");
  });
  return [...new Set(errors)];
}

export function validatePhase19TaskSpec(value: unknown, expected: { taskId: string; baseSha: string }) {
  const schema = validateTaskSpec(value);
  if (!schema.valid) return { valid: false as const, reasons: schema.issues.map((issue) => `SCHEMA:${issue.path}:${issue.message}`) };
  const identity = validateTaskSpecIdentity(schema.value, expected);
  if (!identity.valid) return { valid: false as const, reasons: identity.issues.map((issue) => `IDENTITY:${issue.path}:${issue.message}`) };
  return { valid: true as const, value: schema.value, reasons: [] as string[] };
}

export function evaluatePhase19Sample(registration: Phase19Registration, sample: Phase19Sample): Phase19SampleResult {
  const item = registration.cases.find((candidate) => candidate.id === sample.id);
  const reasons: string[] = [];
  if (!item || item.order !== sample.order) reasons.push("CASE_ID_OR_ORDER_MISMATCH");
  if (sample.processStatus !== "SUCCEEDED" || sample.exitCode !== 0) reasons.push(sample.processStatus === "TIMED_OUT" ? "PROCESS_TIMEOUT" : sample.processStatus === "CANCELLED" ? "PROCESS_CANCELLED" : "PROCESS_NOT_SUCCESSFUL");
  if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0 || sample.durationMs > registration.timeoutMs) reasons.push("PROCESS_DURATION_INVALID");
  if (!Number.isFinite(sample.cleanupDurationMs) || sample.cleanupDurationMs < 0 || sample.cleanupDurationMs > registration.cleanupCeilingMs) reasons.push("PROCESS_CLEANUP_INVALID");
  const events = parseCodexTerminalEvents(sample.stdout);
  const terminal = events.filter((event) => event.kind === "completed" || event.kind === "failed");
  if (events.length === 0 || events.some((event) => event.kind === "malformed") || terminal.length !== 1 || terminal[0]?.kind !== "completed") reasons.push("AUTHORITATIVE_TERMINAL_INVALID");
  if (!item) return { id: sample.id, order: sample.order, status: "FAIL", reasons };
  const task = validatePhase19TaskSpec(sample.taskSpec, { taskId: item.id, baseSha: item.baseSha });
  if (!task.valid) reasons.push(...task.reasons);
  if (sample.before.head !== item.baseSha || sample.before.tree !== item.baseTree || sample.before.status !== "") reasons.push("FIXTURE_BASE_INVALID");
  if (sample.after.head !== item.baseSha || sample.after.tree !== item.baseTree || sample.after.status !== "" || sample.after.head !== sample.before.head || sample.after.tree !== sample.before.tree || sample.after.status !== sample.before.status) reasons.push("FIXTURE_MUTATED");
  if (!sample.processConverged) reasons.push("PROCESS_TREE_NOT_CONVERGED");
  if (!sample.stdioConverged) reasons.push("STDIO_NOT_CONVERGED");
  if (!sample.artifactHashesValid) reasons.push("EVIDENCE_HASH_INVALID");
  if (sample.retryCount !== 0) reasons.push("RETRY_NOT_ZERO");
  if (sample.humanIntervention) reasons.push("HUMAN_INTERVENTION_OCCURRED");
  return { id: item.id, order: item.order, status: reasons.length === 0 ? "PASS" : "FAIL", reasons: [...new Set(reasons)], ...(task.valid ? { taskSpec: task.value } : {}) };
}

export function evaluatePhase19Run(registration: Phase19Registration, samples: readonly Phase19Sample[]): Phase19RunDecision {
  const registrationErrors = validatePhase19Registration(registration);
  if (registrationErrors.length > 0) return { status: "BLOCKED", calls: 0, passed: 0, failed: 0, notRun: PHASE_1_9_CASE_IDS, reasons: registrationErrors };
  if (samples.length === 0) return { status: "NOT_RUN", calls: 0, passed: 0, failed: 0, notRun: PHASE_1_9_CASE_IDS, reasons: ["NO_SAMPLES"] };
  const evaluated = samples.map((sample) => evaluatePhase19Sample(registration, sample));
  const firstFailure = evaluated.findIndex((result) => result.status === "FAIL");
  const reasons = new Set<string>();
  if (new Set(samples.map((sample) => sample.id)).size !== samples.length) reasons.add("DUPLICATE_SAMPLE");
  if (firstFailure >= 0 && firstFailure < samples.length - 1) reasons.add("SAMPLES_CONTINUE_AFTER_FATAL");
  samples.forEach((sample, index) => {
    if (sample.id !== PHASE_1_9_CASE_IDS[index]) reasons.add("SAMPLE_ORDER_INVALID");
    evaluated[index].reasons.forEach((reason) => reasons.add(reason));
  });
  const notRun = PHASE_1_9_CASE_IDS.slice(samples.length);
  if (reasons.size > 0) return { status: "FAIL", calls: samples.length, passed: evaluated.filter((item) => item.status === "PASS").length, failed: evaluated.filter((item) => item.status === "FAIL").length, notRun, reasons: [...reasons] };
  if (samples.length < PHASE_1_9_CASE_IDS.length) return { status: "BLOCKED", calls: samples.length, passed: evaluated.length, failed: 0, notRun, reasons: ["REGISTERED_CASES_NOT_COMPLETE"] };
  return { status: "PASS", calls: samples.length, passed: samples.length, failed: 0, notRun: [], reasons: [] };
}
