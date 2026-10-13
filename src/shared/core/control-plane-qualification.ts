import { existsSync } from "node:fs";
import path from "node:path";

export const QUALIFICATION_PROTOCOL_VERSION = "phase1-5-control-plane-qualification-v1" as const;
export const QUALIFICATION_CALL_LIMIT = 4 as const;

export type QualificationCandidate = "APP_SERVER" | "BOUNDED_EXEC";
export type QualificationStatus = "QUALIFIED" | "NOT_QUALIFIED" | "BLOCKED";
export type RuntimeCertificationStatus = "NOT_RUN";
export type FailureAxis =
  | "PLATFORM_PROCESS_CONTROL"
  | "CODEX_CONTROL_PLANE_COMPLETION"
  | "TRANSPORT_SIGNAL"
  | "PROTOCOL_OUTPUT"
  | "SEMANTIC_INTEGRITY"
  | "AUTH_ACCOUNT_AVAILABILITY";

export interface QualificationUsage {
  available: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface QualificationSample {
  id: string;
  candidate: QualificationCandidate;
  duration: number | null;
  authoritative: boolean;
  schema: boolean;
  semantic: boolean;
  integrity: boolean;
  fixtureClean: boolean;
  retry: number;
  human: boolean;
  processConverged: boolean;
  stdioConverged: boolean;
  transportFallback: boolean;
  protocolAmbiguous: boolean;
  usage: QualificationUsage | null;
  accountAvailable: boolean;
  failureSymptom: string | null;
  axes: FailureAxis[];
}

export interface QualificationResult {
  status: QualificationStatus;
  runtimeCertification: RuntimeCertificationStatus;
  candidate: QualificationCandidate;
  validSampleCount: number;
  fatalSampleCount: number;
  reason: string;
}

const isValidSample = (sample: QualificationSample): boolean =>
  sample.duration !== null && sample.duration <= 300_000 &&
  sample.retry === 0 && !sample.human && !sample.transportFallback && !sample.protocolAmbiguous &&
  sample.accountAvailable && sample.authoritative && sample.schema && sample.semantic && sample.integrity && sample.fixtureClean &&
  sample.processConverged && sample.stdioConverged && sample.axes.length === 0;

const isFatal = (sample: QualificationSample): boolean => sample.axes.length > 0 ||
  !sample.authoritative || !sample.schema || !sample.semantic || !sample.integrity ||
  !sample.accountAvailable || !sample.fixtureClean || !sample.processConverged || !sample.stdioConverged ||
  sample.retry !== 0 || sample.human || sample.transportFallback || sample.protocolAmbiguous ||
  (sample.duration !== null && sample.duration > 300_000);

export function evaluateCandidate(candidate: QualificationCandidate, samples: QualificationSample[]): QualificationResult {
  const selected = samples.filter((sample) => sample.candidate === candidate);
  const valid = selected.filter(isValidSample);
  const fatal = selected.filter(isFatal);
  const authUnavailable = selected.some((sample) => !sample.accountAvailable || sample.axes.includes("AUTH_ACCOUNT_AVAILABILITY"));
  let status: QualificationStatus;
  let reason: string;
  if (authUnavailable) {
    status = "BLOCKED";
    reason = "account availability is unavailable";
  } else if (fatal.length > 0) {
    status = "NOT_QUALIFIED";
    reason = "one or more samples contain fatal qualification evidence";
  } else if (authUnavailable || valid.length === 0) {
    status = "BLOCKED";
    reason = authUnavailable ? "account availability is unavailable" : "no valid qualification sample exists";
  } else {
    status = "QUALIFIED";
    reason = "all available samples meet the qualification floor";
  }
  return { status, runtimeCertification: "NOT_RUN", candidate, validSampleCount: valid.length, fatalSampleCount: fatal.length, reason };
}

export interface QualificationPreregistrationInput {
  outputPath: string;
  historicalPaths?: string[];
  sealedPaths?: string[];
  calls?: readonly QualificationCandidate[];
  preparedAt?: string;
}

export interface QualificationPreregistration {
  protocolVersion: typeof QUALIFICATION_PROTOCOL_VERSION;
  outputPath: string;
  callLimit: typeof QUALIFICATION_CALL_LIMIT;
  order: QualificationCandidate[];
  preparedAt: string;
}

export function buildQualificationPreregistration(input: QualificationPreregistrationInput): QualificationPreregistration {
  const outputPath = path.resolve(input.outputPath);
  const forbidden = [...(input.historicalPaths ?? []), ...(input.sealedPaths ?? [])].map((value) => path.resolve(value));
  const isInside = (root: string): boolean => outputPath === root || outputPath.startsWith(`${root}${path.sep}`);
  if (existsSync(outputPath) || forbidden.some(isInside)) throw new Error("QUALIFICATION_OUTPUT_PATH_NOT_FRESH");
  const order = [...(input.calls ?? ["APP_SERVER", "BOUNDED_EXEC"])];
  if (order.length > QUALIFICATION_CALL_LIMIT) throw new Error("QUALIFICATION_CALL_LIMIT_EXCEEDED");
  const allowedOrder: QualificationCandidate[] = ["APP_SERVER", "BOUNDED_EXEC", "APP_SERVER", "BOUNDED_EXEC"];
  if (order.some((candidate, index) => candidate !== allowedOrder[index])) {
    throw new Error("QUALIFICATION_CALL_ORDER_INVALID");
  }
  return { protocolVersion: QUALIFICATION_PROTOCOL_VERSION, outputPath, callLimit: QUALIFICATION_CALL_LIMIT, order, preparedAt: input.preparedAt ?? new Date().toISOString() };
}

export const buildControlPlaneQualificationPreregistration = buildQualificationPreregistration;
