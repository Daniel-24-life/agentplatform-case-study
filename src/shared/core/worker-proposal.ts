import { createHash } from "node:crypto";

import {
  type ValidationIssue,
  type ValidationResult,
  validateChangeSetInstance,
  validateWorkerProposalRequestInstance
} from "./schema-validation.js";
import { isPathAllowedInScope, isRelativeSafePath, type Scope } from "./paths.js";

export const WORKER_PROPOSAL_SCHEMA_VERSION = "1.0" as const;

/** Fixed input bounds for the bounded context sent to a worker. */
export const WORKER_PROPOSAL_CONTEXT_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024
} as const;

/** Hard ceilings for output limits. A request may choose smaller limits. */
export const WORKER_PROPOSAL_OUTPUT_LIMITS = {
  maxOperations: 200,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024
} as const;

export type WorkerProposalScope = Scope;

export type WorkerProposalAcceptanceCriterion = {
  id: string;
  text: string;
};

export type WorkerProposalLimits = {
  max_operations: number;
  max_file_bytes: number;
  max_total_bytes: number;
};

export type WorkerProposalContextFile = {
  path: string;
  byte_count: number;
  sha256: string;
  content: string;
};

export type WorkerProposalRequest = {
  schema_version: typeof WORKER_PROPOSAL_SCHEMA_VERSION;
  task_id: string;
  base_sha: string;
  task_spec_sha256: string;
  goal: string;
  scope: WorkerProposalScope;
  acceptance_criteria: WorkerProposalAcceptanceCriterion[];
  context_files: WorkerProposalContextFile[];
  limits: WorkerProposalLimits;
};

export type ChangeOperationType = "create_file" | "replace_file";

export type ChangeOperation = {
  type: ChangeOperationType;
  path: string;
  expected_sha256: string | null;
  content: string;
};

export type ChangeSetStatus = "completed" | "blocked" | "failed";

export type ChangeAcceptanceNote = {
  criterion_id: string;
  note: string;
};

export type ChangeSet = {
  schema_version: typeof WORKER_PROPOSAL_SCHEMA_VERSION;
  task_id: string;
  base_sha: string;
  task_spec_sha256: string;
  status: ChangeSetStatus;
  summary: string;
  operations: ChangeOperation[];
  acceptance_notes: ChangeAcceptanceNote[];
  risks: string[];
  blocker: string | null;
};

export type WorkerProposalIdentity = {
  taskId: string;
  baseSha: string;
  taskSpecSha256: string;
};

/**
 * Optional execution-boundary expectations. Both camelCase and wire-format
 * names are accepted so callers can pass a TaskSpec-derived object without
 * first copying it into another shape.
 */
export type WorkerProposalValidationContext = Partial<WorkerProposalIdentity> & {
  task_id?: string;
  base_sha?: string;
  task_spec_sha256?: string;
  request?: WorkerProposalRequest;
  scope?: WorkerProposalScope;
  limits?: WorkerProposalLimits;
};

const taskIdPattern = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;
const baseShaPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const criterionIdPattern = /^AC-[0-9]{2,3}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const addIssue = (issues: ValidationIssue[], path: string, message: string): void => {
  issues.push({ path, message });
};

const sha256OfUtf8 = (content: string): string =>
  createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

const utf8ByteLength = (content: string): number => Buffer.byteLength(content, "utf8");

const isWellFormedUtf8String = (content: string): boolean => {
  if (content.includes("\0")) return false;
  // JSON strings may contain lone UTF-16 surrogates. Buffer replaces those
  // with U+FFFD; rejecting a non-round-tripping value keeps the wire content
  // deterministic when it is written as UTF-8 by the platform.
  return Buffer.from(content, "utf8").toString("utf8") === content;
};

/**
 * A stricter repository-relative path check than the historical helper. In
 * particular, Windows ADS (`name:stream`), dot segments, NULs and trailing
 * space/dot names are not valid proposal targets.
 */
export const isWorkerProposalSafePath = (candidate: unknown): candidate is string => {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate !== candidate.trim()) {
    return false;
  }
  if (candidate.includes("\0") || candidate.includes(":")) return false;
  if (!isRelativeSafePath(candidate)) return false;

  const normalized = candidate.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    return false;
  }
  if (segments.some((segment) => /[ .]$/.test(segment))) return false;
  return true;
};

const pathCollisionKey = (candidate: string): string => candidate.replace(/\\/g, "/").toLowerCase();

const addPathCollisionIssues = (
  paths: unknown[],
  pathLabel: string,
  issues: ValidationIssue[]
): void => {
  const exact = new Map<string, number>();
  const folded = new Map<string, { path: string; index: number }>();

  paths.forEach((entry, index) => {
    if (typeof entry !== "string") return;
    const previousExact = exact.get(entry);
    if (previousExact !== undefined) {
      addIssue(issues, `${pathLabel}[${index}]`, `duplicate path also appears at index ${previousExact}`);
    } else {
      exact.set(entry, index);
    }

    const key = pathCollisionKey(entry);
    const previousFolded = folded.get(key);
    if (previousFolded !== undefined && previousFolded.path !== entry) {
      addIssue(
        issues,
        `${pathLabel}[${index}]`,
        `Windows case-insensitive path collision with ${pathLabel}[${previousFolded.index}]`
      );
    } else if (previousFolded === undefined) {
      folded.set(key, { path: entry, index });
    }
  });
};

const validateIdentityFields = (
  candidate: Record<string, unknown>,
  issues: ValidationIssue[],
  context?: WorkerProposalValidationContext
): void => {
  const taskId = candidate.task_id;
  const baseSha = candidate.base_sha;
  const taskSpecSha = candidate.task_spec_sha256;

  if (typeof taskId !== "string" || !taskIdPattern.test(taskId)) {
    addIssue(issues, "task_id", "task_id invalid");
  }
  if (typeof baseSha !== "string" || !baseShaPattern.test(baseSha)) {
    addIssue(issues, "base_sha", "base_sha must be a lowercase SHA-1 or SHA-256");
  }
  if (typeof taskSpecSha !== "string" || !sha256Pattern.test(taskSpecSha)) {
    addIssue(issues, "task_spec_sha256", "task_spec_sha256 must be a lowercase SHA-256");
  }

  const expectedTaskId = context?.taskId ?? context?.task_id;
  const expectedBaseSha = context?.baseSha ?? context?.base_sha;
  const expectedTaskSpecSha = context?.taskSpecSha256 ?? context?.task_spec_sha256;
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    addIssue(issues, "task_id", "TASK_ID_MISMATCH");
  }
  if (expectedBaseSha !== undefined && baseSha !== expectedBaseSha) {
    addIssue(issues, "base_sha", "BASE_SHA_MISMATCH");
  }
  if (expectedTaskSpecSha !== undefined && taskSpecSha !== expectedTaskSpecSha) {
    addIssue(issues, "task_spec_sha256", "TASK_SPEC_SHA256_MISMATCH");
  }
};

const validateAcceptanceCriteria = (
  criteria: unknown,
  pathLabel: string,
  issues: ValidationIssue[]
): string[] => {
  if (!Array.isArray(criteria)) return [];
  const ids: string[] = [];
  criteria.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const id = entry.id;
    if (typeof id === "string") {
      ids.push(id);
      if (!criterionIdPattern.test(id)) {
        addIssue(issues, `${pathLabel}[${index}].id`, "criterion id invalid");
      }
    }
  });
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) addIssue(issues, `${pathLabel}[${index}].id`, `duplicate criterion id ${id}`);
    seen.add(id);
  });
  return ids;
};

const validateScope = (value: unknown, issues: ValidationIssue[]): WorkerProposalScope | undefined => {
  if (!isRecord(value)) return undefined;
  const allowed = Array.isArray(value.allowed_paths) ? value.allowed_paths : [];
  const forbidden = Array.isArray(value.forbidden_paths) ? value.forbidden_paths : [];

  allowed.forEach((entry, index) => {
    if (!isWorkerProposalSafePath(entry)) addIssue(issues, `scope.allowed_paths[${index}]`, "unsafe relative path");
  });
  forbidden.forEach((entry, index) => {
    if (!isWorkerProposalSafePath(entry)) addIssue(issues, `scope.forbidden_paths[${index}]`, "unsafe relative path");
  });
  addPathCollisionIssues(allowed, "scope.allowed_paths", issues);
  addPathCollisionIssues(forbidden, "scope.forbidden_paths", issues);

  return {
    allowed_paths: allowed.filter((entry): entry is string => typeof entry === "string"),
    forbidden_paths: forbidden.filter((entry): entry is string => typeof entry === "string")
  };
};

const validateLimits = (value: unknown, issues: ValidationIssue[]): WorkerProposalLimits | undefined => {
  if (!isRecord(value)) return undefined;
  const limits = value as Partial<WorkerProposalLimits>;
  const maxOperations = limits.max_operations;
  const maxFileBytes = limits.max_file_bytes;
  const maxTotalBytes = limits.max_total_bytes;

  if (
    typeof maxOperations !== "number" ||
    !Number.isInteger(maxOperations) ||
    maxOperations < 1 ||
    maxOperations > WORKER_PROPOSAL_OUTPUT_LIMITS.maxOperations
  ) {
    addIssue(issues, "limits.max_operations", "max_operations is outside the supported bound");
  }
  if (
    typeof maxFileBytes !== "number" ||
    !Number.isInteger(maxFileBytes) ||
    maxFileBytes < 1 ||
    maxFileBytes > WORKER_PROPOSAL_OUTPUT_LIMITS.maxFileBytes
  ) {
    addIssue(issues, "limits.max_file_bytes", "max_file_bytes is outside the supported bound");
  }
  if (
    typeof maxTotalBytes !== "number" ||
    !Number.isInteger(maxTotalBytes) ||
    maxTotalBytes < 1 ||
    maxTotalBytes > WORKER_PROPOSAL_OUTPUT_LIMITS.maxTotalBytes
  ) {
    addIssue(issues, "limits.max_total_bytes", "max_total_bytes is outside the supported bound");
  }

  return {
    max_operations: typeof maxOperations === "number" ? maxOperations : 0,
    max_file_bytes: typeof maxFileBytes === "number" ? maxFileBytes : 0,
    max_total_bytes: typeof maxTotalBytes === "number" ? maxTotalBytes : 0
  };
};

const validateContextFiles = (value: unknown, issues: ValidationIssue[]): void => {
  if (!Array.isArray(value)) return;
  if (value.length > WORKER_PROPOSAL_CONTEXT_LIMITS.maxFiles) {
    addIssue(issues, "context_files", `at most ${WORKER_PROPOSAL_CONTEXT_LIMITS.maxFiles} context files are allowed`);
  }

  const paths: unknown[] = [];
  let totalBytes = 0;
  value.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const candidate = entry as Partial<WorkerProposalContextFile>;
    paths.push(candidate.path);
    if (!isWorkerProposalSafePath(candidate.path)) {
      addIssue(issues, `context_files[${index}].path`, "unsafe relative path");
    }
    if (typeof candidate.content !== "string") return;
    if (!isWellFormedUtf8String(candidate.content)) {
      addIssue(issues, `context_files[${index}].content`, "content must be NUL-free, well-formed UTF-8 text");
    }

    const actualBytes = utf8ByteLength(candidate.content);
    totalBytes += actualBytes;
    if (actualBytes > WORKER_PROPOSAL_CONTEXT_LIMITS.maxFileBytes) {
      addIssue(issues, `context_files[${index}].content`, "context file exceeds per-file byte limit");
    }
    if (candidate.byte_count !== actualBytes) {
      addIssue(issues, `context_files[${index}].byte_count`, "byte_count does not match UTF-8 content");
    }
    if (typeof candidate.sha256 !== "string" || candidate.sha256 !== sha256OfUtf8(candidate.content)) {
      addIssue(issues, `context_files[${index}].sha256`, "sha256 does not match UTF-8 content");
    }
  });

  addPathCollisionIssues(paths, "context_files", issues);
  if (totalBytes > WORKER_PROPOSAL_CONTEXT_LIMITS.maxTotalBytes) {
    addIssue(issues, "context_files", "context files exceed aggregate byte limit");
  }
};

const resolveIdentityContext = (
  context: WorkerProposalValidationContext | undefined
): WorkerProposalValidationContext | undefined => {
  if (!context) return undefined;
  if (!context.request) return context;
  return {
    ...context,
    taskId: context.taskId ?? context.request.task_id,
    baseSha: context.baseSha ?? context.request.base_sha,
    taskSpecSha256: context.taskSpecSha256 ?? context.request.task_spec_sha256,
    scope: context.scope ?? context.request.scope,
    limits: context.limits ?? context.request.limits
  };
};

const validOrIssues = <T>(
  schemaResult: ValidationResult<Record<string, unknown>>,
  validate: (_candidate: Record<string, unknown>, _issues: ValidationIssue[]) => T
): ValidationResult<T> => {
  if (!schemaResult.valid) return schemaResult;
  const issues: ValidationIssue[] = [];
  const value = validate(schemaResult.value, issues);
  return issues.length > 0 ? { valid: false, issues } : { valid: true, value };
};

export const validateWorkerProposalRequest = (
  value: unknown,
  context?: WorkerProposalValidationContext
): ValidationResult<WorkerProposalRequest> =>
  validOrIssues(validateWorkerProposalRequestInstance(value), (candidate, issues) => {
    validateIdentityFields(candidate, issues, context);
    validateScope(candidate.scope, issues);
    validateAcceptanceCriteria(candidate.acceptance_criteria, "acceptance_criteria", issues);
    validateContextFiles(candidate.context_files, issues);
    validateLimits(candidate.limits, issues);
    return candidate as unknown as WorkerProposalRequest;
  });

const validateOperations = (
  value: unknown,
  issues: ValidationIssue[],
  context: WorkerProposalValidationContext | undefined
): void => {
  if (!Array.isArray(value)) return;
  const operations = value as unknown[];
  const limits = context?.limits;
  const maxOperations = limits?.max_operations ?? WORKER_PROPOSAL_OUTPUT_LIMITS.maxOperations;
  const maxFileBytes = limits?.max_file_bytes ?? WORKER_PROPOSAL_OUTPUT_LIMITS.maxFileBytes;
  const maxTotalBytes = limits?.max_total_bytes ?? WORKER_PROPOSAL_OUTPUT_LIMITS.maxTotalBytes;

  if (operations.length > maxOperations) {
    addIssue(issues, "operations", `operation count exceeds max_operations (${maxOperations})`);
  }

  const paths: unknown[] = [];
  let totalBytes = 0;
  operations.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const operation = entry as Partial<ChangeOperation>;
    paths.push(operation.path);
    if (!isWorkerProposalSafePath(operation.path)) {
      addIssue(issues, `operations[${index}].path`, "unsafe relative path");
    }
    if (typeof operation.content !== "string") return;
    if (!isWellFormedUtf8String(operation.content)) {
      addIssue(issues, `operations[${index}].content`, "content must be NUL-free, well-formed UTF-8 text");
    }
    const bytes = utf8ByteLength(operation.content);
    totalBytes += bytes;
    if (bytes > maxFileBytes) {
      addIssue(issues, `operations[${index}].content`, `content exceeds max_file_bytes (${maxFileBytes})`);
    }

    if (operation.type === "create_file" && operation.expected_sha256 !== null) {
      addIssue(issues, `operations[${index}].expected_sha256`, "create_file requires expected_sha256 to be null");
    }
    if (operation.type === "replace_file") {
      if (typeof operation.expected_sha256 !== "string" || !sha256Pattern.test(operation.expected_sha256)) {
        addIssue(issues, `operations[${index}].expected_sha256`, "replace_file requires a lowercase SHA-256");
      }
    }
  });

  addPathCollisionIssues(paths, "operations", issues);
  if (totalBytes > maxTotalBytes) {
    addIssue(issues, "operations", `aggregate content exceeds max_total_bytes (${maxTotalBytes})`);
  }

  const scope = context?.scope;
  if (scope) {
    operations.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.path !== "string") return;
      const allowed = isPathAllowedInScope(entry.path, scope);
      if (!allowed.match) {
        addIssue(issues, `operations[${index}].path`, allowed.reason ?? "path is outside scope");
      }
    });
  }
};

const validateChangeAcceptanceNotes = (
  value: unknown,
  issues: ValidationIssue[],
  context: WorkerProposalValidationContext | undefined
): void => {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  const expected = context?.request?.acceptance_criteria.map((criterion) => criterion.id) ?? [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const criterionId = entry.criterion_id;
    if (typeof criterionId !== "string") return;
    if (seen.has(criterionId)) {
      addIssue(issues, `acceptance_notes[${index}].criterion_id`, `duplicate acceptance note ${criterionId}`);
    }
    seen.add(criterionId);
    if (expected.length > 0 && !expected.includes(criterionId)) {
      addIssue(issues, `acceptance_notes[${index}].criterion_id`, "criterion_id is not in the approved request");
    }
  });
};

export const validateChangeSet = (
  value: unknown,
  context?: WorkerProposalValidationContext
): ValidationResult<ChangeSet> => {
  const resolvedContext = resolveIdentityContext(context);
  return validOrIssues(validateChangeSetInstance(value), (candidate, issues) => {
    validateIdentityFields(candidate, issues, resolvedContext);
    validateOperations(candidate.operations, issues, resolvedContext);
    validateChangeAcceptanceNotes(candidate.acceptance_notes, issues, resolvedContext);

    const status = candidate.status;
    const blocker = candidate.blocker;
    if (status === "blocked" && (typeof blocker !== "string" || blocker.trim().length === 0)) {
      addIssue(issues, "blocker", "blocked status requires blocker text");
    }
    if (status !== "blocked" && blocker !== null) {
      addIssue(issues, "blocker", "blocker can only be provided for blocked status");
    }
    if (status !== "completed" && Array.isArray(candidate.operations) && candidate.operations.length > 0) {
      addIssue(issues, "operations", "blocked or failed change sets must not contain operations");
    }

    return candidate as unknown as ChangeSet;
  });
};

export const validateChangeSetAgainstRequest = (
  value: unknown,
  request: WorkerProposalRequest
): ValidationResult<ChangeSet> => validateChangeSet(value, { request });

// Compatibility aliases keep the role-specific names discoverable at call
// sites while the shorter validate* functions remain the canonical API.
export const validateWorkerProposalRequestInstanceSemantics = validateWorkerProposalRequest;
export const validateChangeSetInstanceSemantics = validateChangeSet;
