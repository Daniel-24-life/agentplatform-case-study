import { ValidationIssue, ValidationResult, validateLegacyTaskSpecInstance, validateTaskSpecInstance } from "./schema-validation.js";
import {
  isPathInside,
  isRelativeSafePath,
  type Scope
} from "./paths.js";

export const TASK_SPEC_SCHEMA_VERSION = "2.0";

export type SchemaVersion = "2.0";
export type LegacySchemaVersion = "1.0";
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

export type TestCommand = {
  id: string;
  program: string;
  args: string[];
  cwd: string;
  timeout_seconds: number;
  required: boolean;
};

export type SpecScope = {
  allowed_paths: string[];
  forbidden_paths: string[];
};

export type AcceptanceCriterion = {
  id: string;
  text: string;
};

export type ExecutionPolicy = {
  planner_recommendation: "cheap" | "strong";
  planner_confidence: "low" | "medium" | "high";
  recommendation_reasons: string[];
  user_lock: "cheap" | "strong" | null;
};

export type Limits = {
  max_attempts: number;
  run_timeout_seconds: number;
  max_changed_files: number;
  max_diff_bytes: number;
};

export type TaskSpec = {
  schema_version: SchemaVersion;
  task_id: string;
  title: string;
  goal: string;
  base_sha: string;
  context_paths: string[];
  scope: SpecScope;
  acceptance_criteria: AcceptanceCriterion[];
  test_commands: TestCommand[];
  execution_policy: ExecutionPolicy;
  limits: Limits;
};

export type ExpectedTaskIdentity = { taskId: string; baseSha: string };

/** Validate the identity supplied by an approval/execution boundary. */
export const validateTaskSpecIdentity = (
  value: unknown,
  expected: ExpectedTaskIdentity
): ValidationResult<{ taskId: string; baseSha: string }> => {
  const candidate = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const issues: ValidationIssue[] = [];
  if (candidate.task_id !== expected.taskId) {
    issues.push({ path: "task_id", message: "TASK_ID_MISMATCH" });
  }
  if (candidate.base_sha !== expected.baseSha) {
    issues.push({ path: "base_sha", message: "BASE_SHA_MISMATCH" });
  }
  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value: { taskId: expected.taskId, baseSha: expected.baseSha } };
};

export const validateExpectedTaskIdentity = validateTaskSpecIdentity;
export const validateExpectedTaskSpecIdentity = validateTaskSpecIdentity;

/** Read-only shape for pre-v2 specs. It is never returned by validateTaskSpec. */
export type LegacyTaskSpec = Omit<TaskSpec, "schema_version" | "execution_policy" | "context_paths"> & {
  schema_version: LegacySchemaVersion;
  context_paths?: string[];
  worker: { adapter: "codex"; model: string; reasoning: "low" | "medium" | "high" | "xhigh" };
};

const addIssue = (
  issues: ValidationIssue[],
  pathLabel: string,
  message: string
): void => {
  issues.push({ path: pathLabel, message });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasDuplicate = (items: string[]): boolean => new Set(items).size !== items.length;

const isScope = (value: unknown, issues: ValidationIssue[]): value is Scope => {
  if (!isRecord(value)) {
    addIssue(issues, "scope", "scope must be an object");
    return false;
  }

  const allowed = Array.isArray(value.allowed_paths) ? value.allowed_paths : null;
  const forbidden = Array.isArray(value.forbidden_paths) ? value.forbidden_paths : null;

  if (!Array.isArray(allowed) || allowed.length < 1 || allowed.length > 100) {
    addIssue(issues, "scope.allowed_paths", "scope.allowed_paths must be 1..100 items");
    return false;
  }

  if (!Array.isArray(forbidden) || forbidden.length > 100) {
    addIssue(issues, "scope.forbidden_paths", "scope.forbidden_paths must be <= 100 items");
    return false;
  }

  if (hasDuplicate(allowed)) {
    addIssue(issues, "scope.allowed_paths", "scope.allowed_paths must not contain duplicates");
    return false;
  }
  if (hasDuplicate(forbidden)) {
    addIssue(issues, "scope.forbidden_paths", "scope.forbidden_paths must not contain duplicates");
    return false;
  }

  const allPaths = [...allowed, ...forbidden];
  if (allPaths.some((path) => !isRelativeSafePath(path))) {
    addIssue(issues, "scope", "scope paths must be safe relative paths");
    return false;
  }

  return true;
};

const collectDuplicateIds = (items: Array<{ id: string }>): string[] => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  items.forEach(({ id }) => {
    if (seen.has(id) && !duplicates.includes(id)) {
      duplicates.push(id);
    }
    seen.add(id);
  });
  return duplicates;
};

export const validateTaskSpec = (value: unknown): ValidationResult<TaskSpec> => {
  const schemaResult = validateTaskSpecInstance(value);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  const candidate = schemaResult.value as TaskSpec;
  const issues: ValidationIssue[] = [];

  if (!isScope(candidate.scope, issues)) {
    return { valid: false, issues };
  }

  if (candidate.context_paths.length > 50) {
    addIssue(issues, "context_paths", "context_paths must contain at most 50 entries");
  }
  if (candidate.context_paths.some((entry) => !isRelativeSafePath(entry))) {
    addIssue(issues, "context_paths", "context_paths must be valid relative paths");
  }

  const duplicateCriteria = collectDuplicateIds(candidate.acceptance_criteria);
  if (duplicateCriteria.length > 0) {
    addIssue(
      issues,
      "acceptance_criteria",
      `acceptance criterion ids must be unique: ${duplicateCriteria.join(", ")}`
    );
  }

  const duplicateTests = collectDuplicateIds(candidate.test_commands);
  if (duplicateTests.length > 0) {
    addIssue(
      issues,
      "test_commands",
      `test command ids must be unique: ${duplicateTests.join(", ")}`
    );
  }

  candidate.test_commands.forEach((command, index) => {
    if (!isRelativeSafePath(command.cwd)) {
      addIssue(issues, `test_commands[${index}].cwd`, "TEST_COMMAND_CWD_UNSAFE");
    }
    if (!Array.isArray(command.args)) {
      addIssue(issues, `test_commands[${index}].args`, "TEST_COMMAND_ARGS_NOT_ARRAY");
    }
    if (/\s/.test(command.program)) {
      addIssue(issues, `test_commands[${index}].program`, "TEST_COMMAND_PROGRAM_SHELL_SHAPED");
    }
  });


  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return { valid: true, value: candidate };
};

/**
 * Compatibility reader for v1 artifacts. This deliberately does not migrate or
 * rewrite the value; callers must create and approve a new v2 revision to edit it.
 */
export const validateLegacyTaskSpecReadOnly = (value: unknown): ValidationResult<LegacyTaskSpec> => {
  const schemaResult = validateLegacyTaskSpecInstance(value);
  if (!schemaResult.valid) return schemaResult;
  const candidate = schemaResult.value as unknown as LegacyTaskSpec;
  const issues: ValidationIssue[] = [];
  if (!isScope(candidate.scope, issues)) return { valid: false, issues };
  if (candidate.context_paths?.some((entry) => !isRelativeSafePath(entry))) addIssue(issues, "context_paths", "context_paths must be valid relative paths");
  if (collectDuplicateIds(candidate.acceptance_criteria).length > 0) addIssue(issues, "acceptance_criteria", "acceptance criterion ids must be unique");
  if (collectDuplicateIds(candidate.test_commands).length > 0) addIssue(issues, "test_commands", "test command ids must be unique");
  return issues.length > 0 ? { valid: false, issues } : { valid: true, value: candidate };
};

export const isLegacyTaskSpec = (value: unknown): value is LegacyTaskSpec =>
  isRecord(value) && value.schema_version === "1.0" && "worker" in value;

export const validateContextPaths = (
  repositoryRoot: string,
  repoPaths: string[]
): ValidationResult<string[]> => {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(repoPaths)) {
    return { valid: false, issues: [{ path: "paths", message: "paths must be array" }] };
  }

  const validPaths: string[] = [];
  repoPaths.forEach((entry, index) => {
    if (typeof entry !== "string" || !isRelativeSafePath(entry)) {
      addIssue(issues, `paths[${index}]`, "path must be safe relative path");
      return;
    }

    const check = isPathInside(entry, repositoryRoot);
    if (!check.valid) {
      addIssue(issues, `paths[${index}]`, check.reason ?? "path must stay inside repository root");
      return;
    }

    validPaths.push(entry);
  });

  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return { valid: true, value: validPaths };
};
