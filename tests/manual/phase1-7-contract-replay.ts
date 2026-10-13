import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateExpectedTaskSpecIdentity, validateTaskSpec, type TaskSpec } from "../../src/shared/core/task-spec.js";

export const EVALUATION_CONSTRAINT_VERSION = "phase1.7-evaluation-constraints.v1" as const;
export const ISSUE_CODES = {
  IDENTITY: "EVAL_TASK_IDENTITY_MISMATCH",
  SCHEMA: "EVAL_TASKSPEC_INVALID",
  DUPLICATE_ID: "EVAL_DUPLICATE_ID",
  COMMAND: "EVAL_COMMAND_INVALID",
  RESULT_MISSING: "EVAL_RESULT_MISSING",
  ARTIFACT_TAMPERED: "EVAL_ARTIFACT_TAMPERED",
  FIXTURE_DRIFT: "EVAL_FIXTURE_DRIFT",
} as const;

export type EvaluationConstraint = {
  version: typeof EVALUATION_CONSTRAINT_VERSION;
  caseId: string;
  expectedTaskId: string;
  expectedBaseSha: string;
  requiredResultFields: readonly string[];
  artifactSha256: string;
};
export type ReplayIssue = { code: string; path: string; message: string };
export type ReplayInput = { taskSpec: unknown; result?: unknown; artifact?: string; fixtureSha256?: string };
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Copied, sealed P16-ARCH-01 TaskSpec; the Phase 1.6 executor is never called. */
export const P16_ARCH_01_CONSTRAINT: EvaluationConstraint = {
  version: EVALUATION_CONSTRAINT_VERSION, caseId: "P16-ARCH-01", expectedTaskId: "P16-ARCH-01",
  expectedBaseSha: "0000000000000000000000000000000000000000", requiredResultFields: ["id", "schemaValid"],
  artifactSha256: "7aa646106cc719b4a3037d4cc2bfdcfafbb99f9aa690a33ed0b62791e6eddfb1",
};
export const evaluationConstraintSha256 = (constraint: EvaluationConstraint): string => sha256(canonical(constraint));
export const replayRegistrationIdentity = (constraint: EvaluationConstraint) => ({ version: constraint.version, constraintSha256: evaluationConstraintSha256(constraint), artifactSha256: constraint.artifactSha256 });

export function validateEvaluationConstraint(value: unknown): value is EvaluationConstraint {
  return isRecord(value) && value.version === EVALUATION_CONSTRAINT_VERSION && typeof value.caseId === "string" &&
    typeof value.expectedTaskId === "string" && typeof value.expectedBaseSha === "string" && Array.isArray(value.requiredResultFields) &&
    typeof value.artifactSha256 === "string";
}

export function replayP16Arch01(input: ReplayInput, constraint = P16_ARCH_01_CONSTRAINT): { valid: boolean; issues: ReplayIssue[] } {
  const issues: ReplayIssue[] = [];
  if (!validateEvaluationConstraint(constraint)) return { valid: false, issues: [{ code: ISSUE_CODES.FIXTURE_DRIFT, path: "constraint", message: "evaluation constraint is invalid or drifted" }] };
  const raw = isRecord(input.taskSpec) ? input.taskSpec : undefined;
  const rawCommands = raw && Array.isArray(raw.test_commands) ? raw.test_commands : [];
  const rawIds = rawCommands.filter(isRecord).map((x) => x.id).filter((x): x is string => typeof x === "string");
  if (new Set(rawIds).size !== rawIds.length) issues.push({ code: ISSUE_CODES.DUPLICATE_ID, path: "taskSpec.test_commands", message: "test command ids must be unique" });
  for (const command of rawCommands) {
    if (isRecord(command) && typeof command.program === "string" && (command.program.includes(" ") || typeof command.cwd !== "string" || !command.cwd || command.cwd.startsWith("/") || command.cwd.includes("..") || /^[A-Za-z]:/.test(command.cwd))) {
      issues.push({ code: ISSUE_CODES.COMMAND, path: "test_commands", message: "structured command or cwd is unsafe" });
    }
  }
  const specCheck = validateTaskSpec(input.taskSpec);
  if (!specCheck.valid) issues.push({ code: ISSUE_CODES.SCHEMA, path: "taskSpec", message: specCheck.issues.map((x) => x.message).join("; ") });
  const spec = specCheck.valid ? specCheck.value : undefined;
  if (spec && !validateExpectedTaskSpecIdentity(spec, { taskId: constraint.expectedTaskId, baseSha: constraint.expectedBaseSha }).valid) {
    issues.push({ code: ISSUE_CODES.IDENTITY, path: "taskSpec", message: "task id or base sha does not match the authoritative constraint" });
  }
  if (spec) {
    const ids = spec.test_commands.map((x) => x.id);
    if (new Set(ids).size !== ids.length) issues.push({ code: ISSUE_CODES.DUPLICATE_ID, path: "taskSpec.test_commands", message: "test command ids must be unique" });
    for (const command of spec.test_commands) {
      if (command.program.includes(" ") || !Array.isArray(command.args) || !command.cwd || command.cwd.startsWith("/") || command.cwd.includes("..") || /^[A-Za-z]:/.test(command.cwd)) {
        issues.push({ code: ISSUE_CODES.COMMAND, path: `test_commands.${command.id}`, message: "structured command or cwd is unsafe" });
      }
    }
  }
  if (!input.result) issues.push({ code: ISSUE_CODES.RESULT_MISSING, path: "result", message: "replay result is required" });
  else if (!isRecord(input.result) || constraint.requiredResultFields.some((field) => !(field in input.result!))) issues.push({ code: ISSUE_CODES.RESULT_MISSING, path: "result", message: "required result fields are missing" });
  if (input.artifact !== undefined && sha256(input.artifact) !== constraint.artifactSha256) issues.push({ code: ISSUE_CODES.ARTIFACT_TAMPERED, path: "artifact", message: "artifact hash mismatch" });
  if (input.fixtureSha256 !== undefined && input.fixtureSha256 !== constraint.artifactSha256) issues.push({ code: ISSUE_CODES.FIXTURE_DRIFT, path: "fixture", message: "fixture hash drift" });
  return { valid: issues.length === 0, issues };
}

export function readCopiedTaskSpec(path: string): TaskSpec {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const checked = validateTaskSpec(value);
  if (!checked.valid) throw new Error(`${ISSUE_CODES.SCHEMA}: ${checked.issues.map((x) => x.message).join("; ")}`);
  return checked.value;
}
