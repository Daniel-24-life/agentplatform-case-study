/** Pure, model-free decision rules for the Phase 1.6 bounded exec certification. */

export const BOUNDED_RUNTIME_CASE_COUNT = 10 as const;
export const BOUNDED_RUNTIME_TIMEOUT_MS = 300_000 as const;
export const BOUNDED_RUNTIME_CLEANUP_CEILING_MS = 10_000 as const;
export const BOUNDED_RUNTIME_CASE_IDS = Object.freeze(
  Array.from({ length: BOUNDED_RUNTIME_CASE_COUNT }, (_, index) => `P16-ARCH-${String(index + 1).padStart(2, "0")}`)
) as readonly string[];

export type BoundedRuntimeStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export type BoundedRuntimeFailureAxis =
  | "PLATFORM_PROCESS_CONTROL"
  | "CODEX_CONTROL_PLANE_COMPLETION"
  | "TRANSPORT_SIGNAL"
  | "PROTOCOL_OUTPUT"
  | "SCHEMA_VALIDATION"
  | "SEMANTIC_INTEGRITY"
  | "FIXTURE_INTEGRITY"
  | "AUTH_ACCOUNT_AVAILABILITY"
  | "PREREGISTRATION_DRIFT";

export interface BoundedRuntimeRegistrationCase {
  id: string;
  order: number;
}

export interface BoundedRuntimeRegistration {
  cases: readonly BoundedRuntimeRegistrationCase[];
  timeoutMs: number;
  cleanupCeilingMs: number;
  model: string;
  reasoning: "low" | "medium" | "high";
  retryCount: number;
  humanInterventionCount: number;
}

export interface BoundedRuntimeSample {
  id: string;
  order: number;
  durationMs: number | null;
  cleanupDurationMs: number | null;
  authoritativeTerminal: boolean;
  accountAvailable: boolean;
  protocolValid: boolean;
  transportClean: boolean;
  schemaValid: boolean;
  semanticValid: boolean;
  fixtureClean: boolean;
  baseShaValid: boolean;
  processConverged: boolean;
  stdioConverged: boolean;
  hashesValid: boolean;
  retryCount: number;
  humanIntervention: boolean;
  usageAvailable?: boolean;
  failureAxes?: readonly BoundedRuntimeFailureAxis[];
}

export interface BoundedRuntimeCaseEvaluation {
  id: string;
  order: number | null;
  status: "PASS" | "FAIL" | "NOT_RUN";
  failureAxes: readonly BoundedRuntimeFailureAxis[];
  reasons: readonly string[];
  usageAvailable: boolean | null;
}

export interface BoundedRuntimeDecision {
  status: BoundedRuntimeStatus;
  caseCount: number;
  registeredCaseCount: number;
  completedCaseCount: number;
  passedCaseCount: number;
  failedCaseCount: number;
  missingCaseIds: readonly string[];
  retryCount: number;
  interventionCount: number;
  cases: readonly BoundedRuntimeCaseEvaluation[];
  failureAxes: readonly BoundedRuntimeFailureAxis[];
  reasons: readonly string[];
}

const expected = BOUNDED_RUNTIME_CASE_IDS;
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const add = (axes: BoundedRuntimeFailureAxis[], reasons: string[], axis: BoundedRuntimeFailureAxis, reason: string): void => {
  if (!axes.includes(axis)) axes.push(axis);
  if (!reasons.includes(reason)) reasons.push(reason);
};

/** Validate the frozen ten-case registration without inspecting any runtime result. */
export function validateBoundedRuntimeRegistration(registration: BoundedRuntimeRegistration): readonly string[] {
  const errors: string[] = [];
  const cases = registration.cases;
  if (cases.length !== BOUNDED_RUNTIME_CASE_COUNT) errors.push("REGISTRATION_CASE_COUNT");
  const ids = cases.map((item) => item.id);
  if (!unique(ids)) errors.push("REGISTRATION_DUPLICATE_CASE");
  if (ids.some((id, index) => id !== expected[index])) errors.push("REGISTRATION_ORDER_INVALID");
  if (cases.some((item, index) => item.order !== index + 1)) errors.push("REGISTRATION_ORDERS_INVALID");
  if (registration.timeoutMs !== BOUNDED_RUNTIME_TIMEOUT_MS) errors.push("REGISTRATION_TIMEOUT_INVALID");
  if (registration.cleanupCeilingMs !== BOUNDED_RUNTIME_CLEANUP_CEILING_MS) errors.push("REGISTRATION_CLEANUP_CEILING_INVALID");
  if (registration.model !== "gpt-5.6-sol") errors.push("REGISTRATION_MODEL_INVALID");
  if (registration.reasoning !== "medium") errors.push("REGISTRATION_REASONING_INVALID");
  if (registration.retryCount !== 0) errors.push("REGISTRATION_RETRY_NOT_ZERO");
  if (registration.humanInterventionCount !== 0) errors.push("REGISTRATION_INTERVENTION_NOT_ZERO");
  return errors;
}

function evaluateSample(sample: BoundedRuntimeSample | undefined, expectedId: string, expectedOrder: number): BoundedRuntimeCaseEvaluation {
  if (!sample) return { id: expectedId, order: null, status: "NOT_RUN", failureAxes: [], reasons: ["CASE_NOT_RUN"], usageAvailable: null };
  const axes: BoundedRuntimeFailureAxis[] = [...(sample.failureAxes ?? [])];
  const reasons: string[] = [];
  if (sample.id !== expectedId || sample.order !== expectedOrder) add(axes, reasons, "PREREGISTRATION_DRIFT", "CASE_ID_OR_ORDER_MISMATCH");
  if (!sample.authoritativeTerminal) add(axes, reasons, "CODEX_CONTROL_PLANE_COMPLETION", "AUTHORITATIVE_TERMINAL_MISSING");
  if (sample.durationMs === null || sample.durationMs < 0 || sample.durationMs > BOUNDED_RUNTIME_TIMEOUT_MS) add(axes, reasons, "TRANSPORT_SIGNAL", sample.durationMs === null ? "DURATION_MISSING" : sample.durationMs < 0 ? "DURATION_NEGATIVE" : "PROCESS_TIMEOUT");
  if (sample.cleanupDurationMs === null || sample.cleanupDurationMs < 0 || sample.cleanupDurationMs > BOUNDED_RUNTIME_CLEANUP_CEILING_MS) add(axes, reasons, "PLATFORM_PROCESS_CONTROL", sample.cleanupDurationMs === null ? "CLEANUP_DURATION_MISSING" : sample.cleanupDurationMs < 0 ? "CLEANUP_DURATION_NEGATIVE" : "CLEANUP_TIMEOUT");
  if (!sample.schemaValid) add(axes, reasons, "SCHEMA_VALIDATION", "TASKSPEC_SCHEMA_INVALID");
  if (!sample.semanticValid) add(axes, reasons, "SEMANTIC_INTEGRITY", "TASKSPEC_SEMANTICS_INVALID");
  if (!sample.accountAvailable) add(axes, reasons, "AUTH_ACCOUNT_AVAILABILITY", "ACCOUNT_UNAVAILABLE");
  if (!sample.protocolValid) add(axes, reasons, "PROTOCOL_OUTPUT", "PROTOCOL_INVALID");
  if (!sample.transportClean) add(axes, reasons, "TRANSPORT_SIGNAL", "TRANSPORT_NOT_CLEAN");
  if (!sample.fixtureClean || !sample.baseShaValid) add(axes, reasons, "FIXTURE_INTEGRITY", !sample.fixtureClean ? "FIXTURE_DIRTY" : "BASE_SHA_MISMATCH");
  if (!sample.hashesValid) add(axes, reasons, "FIXTURE_INTEGRITY", "EVIDENCE_HASH_INVALID");
  if (!sample.processConverged) add(axes, reasons, "PLATFORM_PROCESS_CONTROL", "PROCESS_TREE_NOT_CONVERGED");
  if (!sample.stdioConverged) add(axes, reasons, "PLATFORM_PROCESS_CONTROL", "STDIO_NOT_CONVERGED");
  if (sample.retryCount !== 0) add(axes, reasons, "TRANSPORT_SIGNAL", "RETRY_NOT_ZERO");
  if (sample.humanIntervention) add(axes, reasons, "TRANSPORT_SIGNAL", "HUMAN_INTERVENTION_OCCURRED");
  return { id: expectedId, order: sample.order, status: axes.length === 0 ? "PASS" : "FAIL", failureAxes: axes, reasons, usageAvailable: sample.usageAvailable ?? null };
}

/** Evaluate only recorded samples; absent registered cases remain NOT_RUN. */
export function evaluateBoundedRuntimeCertification(input: { registration: BoundedRuntimeRegistration; samples: readonly BoundedRuntimeSample[] }): BoundedRuntimeDecision {
  const registrationErrors = validateBoundedRuntimeRegistration(input.registration);
  const byId = new Map<string, BoundedRuntimeSample>();
  const duplicateSampleIds = new Set<string>();
  const unknownSampleIds = new Set<string>();
  for (const sample of input.samples) {
    if (!expected.includes(sample.id)) unknownSampleIds.add(sample.id);
    if (byId.has(sample.id)) duplicateSampleIds.add(sample.id);
    else byId.set(sample.id, sample);
  }
  const cases = expected.map((id, index) => evaluateSample(byId.get(id), id, index + 1));
  const missingCaseIds = cases.filter((item) => item.status === "NOT_RUN").map((item) => item.id);
  const failureAxes: BoundedRuntimeFailureAxis[] = [];
  const reasons: string[] = [];
  for (const error of registrationErrors) add(failureAxes, reasons, "PREREGISTRATION_DRIFT", error);
  if (duplicateSampleIds.size > 0) add(failureAxes, reasons, "PREREGISTRATION_DRIFT", "DUPLICATE_SAMPLE");
  if (unknownSampleIds.size > 0) add(failureAxes, reasons, "PREREGISTRATION_DRIFT", "UNKNOWN_SAMPLE");
  for (const item of cases) {
    for (const axis of item.failureAxes) if (!failureAxes.includes(axis)) failureAxes.push(axis);
    for (const reason of item.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  }
  const retryCount = input.samples.reduce((total, sample) => total + sample.retryCount, 0);
  const interventionCount = input.samples.filter((sample) => sample.humanIntervention).length;
  if (missingCaseIds.length > 0) reasons.push("CASES_MISSING");
  if (input.samples.length === 0) return { status: registrationErrors.length > 0 ? "BLOCKED" : "NOT_RUN", caseCount: 10, registeredCaseCount: input.registration.cases.length, completedCaseCount: 0, passedCaseCount: 0, failedCaseCount: 0, missingCaseIds, retryCount, interventionCount, cases, failureAxes, reasons: reasons.length ? reasons : ["NO_CASES_RECORDED"] };
  const hasRuntimeFailure = failureAxes.some((axis) => axis !== "PREREGISTRATION_DRIFT" && axis !== "AUTH_ACCOUNT_AVAILABILITY");
  const hasBlockedFailure = failureAxes.some((axis) => axis === "PREREGISTRATION_DRIFT" || axis === "AUTH_ACCOUNT_AVAILABILITY");
  const status: BoundedRuntimeStatus = hasRuntimeFailure ? "FAIL" : registrationErrors.length > 0 || missingCaseIds.length > 0 || hasBlockedFailure ? "BLOCKED" : "PASS";
  return { status, caseCount: 10, registeredCaseCount: input.registration.cases.length, completedCaseCount: cases.filter((item) => item.status !== "NOT_RUN").length, passedCaseCount: cases.filter((item) => item.status === "PASS").length, failedCaseCount: cases.filter((item) => item.status === "FAIL").length, missingCaseIds, retryCount, interventionCount, cases, failureAxes, reasons: reasons.length ? reasons : ["ALL_CASES_MEET_RUNTIME_CERTIFICATION_RULES"] };
}

export const evaluateBoundedRuntime = evaluateBoundedRuntimeCertification;
