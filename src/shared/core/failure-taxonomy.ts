import { ERROR_CODES, type ErrorCode, type FailureClassification, type FailureDomain } from "./errors.js";
export type { FailureClassification, FailureDomain } from "./errors.js";
export type ProcessFailureInput = { status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "START_FAILED"; stdout: string; stderr: string };

const runtime = (code: ErrorCode, retryable: boolean, failFast: boolean, summary: string): FailureClassification => ({ code, domain: "runtime", retryable, failFast, diagnosticSummary: summary });
const task = (code: ErrorCode, summary: string): FailureClassification => ({ code, domain: "task", retryable: false, failFast: true, diagnosticSummary: summary });

export const classifyFailureCode = (code: ErrorCode): FailureClassification => {
  switch (code) {
    case ERROR_CODES.CLI_NOT_FOUND: return runtime(code, false, true, "Codex CLI was not found");
    case ERROR_CODES.CLI_NOT_AUTHENTICATED: return runtime(code, false, true, "Codex CLI is not authenticated");
    case ERROR_CODES.MODEL_UNAVAILABLE: return runtime(code, false, true, "The requested model is unavailable");
    case ERROR_CODES.QUOTA_EXHAUSTED: return runtime(code, false, true, "The account quota is exhausted");
    case ERROR_CODES.RATE_LIMITED: return runtime(code, true, true, "The service rate limited the request");
    case ERROR_CODES.TRANSPORT_FAILURE: return runtime(code, true, true, "The model transport failed");
    case ERROR_CODES.PROCESS_TIMEOUT: return runtime(code, true, true, "The model process timed out");
    case ERROR_CODES.PROCESS_CANCELLED: return { ...runtime(code, false, true, "The model process was cancelled"), domain: "user" };
    case ERROR_CODES.RUN_INTERRUPTED: return runtime(code, false, true, "The run was interrupted");
    case ERROR_CODES.PROCESS_START_FAILED: return runtime(code, false, true, "The model process could not start");
    case ERROR_CODES.REPOSITORY_DIRTY:
    case ERROR_CODES.BASE_SHA_CHANGED:
    case ERROR_CODES.WORKTREE_CREATE_FAILED:
    case ERROR_CODES.OUTPUT_SCHEMA_INVALID:
    case ERROR_CODES.SCOPE_VIOLATION:
    case ERROR_CODES.EVIDENCE_CORRUPT: return task(code, `Task failed: ${code}`);
    case ERROR_CODES.WORKER_NOOP:
    case ERROR_CODES.CLAIMED_CHANGE_WITHOUT_DIFF: return { code, domain: "task", retryable: true, failFast: false, diagnosticSummary: `Task evidence failed: ${code}` };
    case ERROR_CODES.TEST_FAILED:
    case ERROR_CODES.TASK_FAILED: return { code, domain: "task", retryable: true, failFast: false, diagnosticSummary: `Task failed: ${code}` };
    case ERROR_CODES.MODEL_RUNTIME_FAILED: return runtime(code, true, true, "The model process failed");
    case ERROR_CODES.RUNTIME_PREFLIGHT_REQUIRED: return runtime(code, true, true, "Runtime preflight is required before this workflow can run");
    default: return task(code, `Task failed: ${code}`);
  }
};

const feature = (text: string, patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(text));
export const classifyProcessResult = (result: ProcessFailureInput): FailureClassification | null => {
  if (result.status === "SUCCEEDED") return null;
  if (result.status === "TIMED_OUT") return classifyFailureCode(ERROR_CODES.PROCESS_TIMEOUT);
  if (result.status === "CANCELLED") return classifyFailureCode(ERROR_CODES.PROCESS_CANCELLED);
  if (result.status === "START_FAILED") return /(?:ENOENT|not found)/i.test(`${result.stderr}\n${result.stdout}`) ? classifyFailureCode(ERROR_CODES.CLI_NOT_FOUND) : classifyFailureCode(ERROR_CODES.PROCESS_START_FAILED);
  const text = `${result.stderr}\n${result.stdout}`;
  if (feature(text, [/not authenticated/i, /login required/i, /sign[ -]?in required/i, /unauthenticated/i])) return classifyFailureCode(ERROR_CODES.CLI_NOT_AUTHENTICATED);
  if (feature(text, [/quota exhausted/i, /quota exceeded/i, /insufficient quota/i, /usage limit/i])) return classifyFailureCode(ERROR_CODES.QUOTA_EXHAUSTED);
  if (feature(text, [/rate limit/i, /too many requests/i, /\b429\b/i])) return classifyFailureCode(ERROR_CODES.RATE_LIMITED);
  if (feature(text, [/model .*?(not found|unavailable|does not exist)/i, /unknown model/i, /invalid model/i])) return classifyFailureCode(ERROR_CODES.MODEL_UNAVAILABLE);
  if (feature(text, [/invalid schema for response_format/i, /invalid_json_schema/i])) return classifyFailureCode(ERROR_CODES.OUTPUT_SCHEMA_INVALID);
  if (feature(text, [/websocket/i, /transport/i, /connection reset/i, /timed? out/i, /network error/i, /https? .*?(failed|error)/i])) return classifyFailureCode(ERROR_CODES.TRANSPORT_FAILURE);
  return classifyFailureCode(ERROR_CODES.MODEL_RUNTIME_FAILED);
};

export const failureDomain = (code: ErrorCode): FailureDomain => classifyFailureCode(code).domain;
