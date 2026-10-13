import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats
} from "node:fs";
import path from "node:path";

import { isPathAllowedInScope, type Scope } from "../../shared/core/paths.js";
import type { TaskSpec } from "../../shared/core/task-spec.js";
import {
  isWorkerProposalSafePath,
  type ChangeOperation as ChangeSetOperation,
  type ChangeOperationType as ChangeSetOperationType,
  type ChangeSet,
  type WorkerProposalLimits,
  validateChangeSet
} from "../../shared/core/worker-proposal.js";

export type ChangeSetApplyLimits = WorkerProposalLimits;

type TaskIdentityAndScope = {
  task_id: string;
  base_sha: string;
  scope: Scope;
  limits?: {
    max_changed_files?: number;
    max_diff_bytes?: number;
  };
};

/**
 * Inputs for a platform-owned apply. `managedWorktreeRoot` is deliberately
 * required: a path that merely happens to be named a worktree is not an
 * authority boundary.
 */
export type ChangeSetApplyOptions = {
  worktreeRoot: string;
  managedWorktreeRoot: string;
  taskSpec?: TaskIdentityAndScope | Pick<TaskSpec, "task_id" | "base_sha" | "scope" | "limits">;
  /** Alias used by callers that call the approved TaskSpec a `spec`. */
  spec?: TaskIdentityAndScope | Pick<TaskSpec, "task_id" | "base_sha" | "scope" | "limits">;
  taskId?: string;
  baseSha?: string;
  taskSpecSha256: string;
  limits?: ChangeSetApplyLimits;
};

export type ChangeSetApplyInput = ChangeSetApplyOptions & {
  changeSet: ChangeSet;
};

export type AppliedChange = {
  type: ChangeSetOperationType;
  path: string;
  bytes: number;
};

export type ChangeSetApplyResult = {
  applied: true;
  task_id: string;
  base_sha: string;
  task_spec_sha256: string;
  changed_paths: string[];
  operations: AppliedChange[];
  total_bytes: number;
};

export type ChangeSetApplyErrorCode =
  | "INVALID_APPLY_INPUT"
  | "MANAGED_ROOT_REQUIRED"
  | "MANAGED_ROOT_INVALID"
  | "WORKTREE_ROOT_INVALID"
  | "WORKTREE_OUTSIDE_MANAGED_ROOT"
  | "CHANGE_SET_INVALID"
  | "IDENTITY_MISMATCH"
  | "STATUS_NOT_COMPLETED"
  | "LIMIT_INVALID"
  | "OPERATION_LIMIT_EXCEEDED"
  | "FILE_LIMIT_EXCEEDED"
  | "TOTAL_LIMIT_EXCEEDED"
  | "UNSAFE_PATH"
  | "SCOPE_VIOLATION"
  | "DUPLICATE_PATH"
  | "CASE_COLLISION"
  | "TARGET_MISSING"
  | "TARGET_EXISTS"
  | "TARGET_SYMLINK"
  | "TARGET_NOT_REGULAR"
  | "TARGET_HASH_MISMATCH"
  | "TARGET_CHANGED_AFTER_VALIDATION"
  | "PARENT_MISSING"
  | "PARENT_NOT_DIRECTORY"
  | "PARENT_SYMLINK"
  | "CONTENT_INVALID"
  | "ATOMIC_WRITE_FAILED";

export class ChangeSetApplyError extends Error {
  readonly code: ChangeSetApplyErrorCode;
  readonly operationIndex?: number;

  constructor(code: ChangeSetApplyErrorCode, message: string, operationIndex?: number) {
    super(`${code}: ${message}`);
    this.name = "ChangeSetApplyError";
    this.code = code;
    this.operationIndex = operationIndex;
  }
}

const DEFAULT_LIMITS: ChangeSetApplyLimits = {
  max_operations: 20,
  max_file_bytes: 64 * 1024,
  max_total_bytes: 256 * 1024
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TASK_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;
const RESERVED_WINDOWS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);
const DENIED_FILE_NAMES = new Set([".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (
  code: ChangeSetApplyErrorCode,
  message: string,
  operationIndex?: number
): never => {
  throw new ChangeSetApplyError(code, message, operationIndex);
};

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

const normalizedPath = (value: string): string => value.replaceAll("\\", "/");

const pathKey = (value: string): string => normalizedPath(value).toLocaleLowerCase("en-US");

const isInside = (child: string, root: string): boolean => {
  const childResolved = path.resolve(child);
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, childResolved);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  // Windows comparisons are case-insensitive. Lower-casing here also gives
  // deterministic case-collision behavior in Linux unit tests.
  const childKey = childResolved.toLocaleLowerCase("en-US");
  const rootKey = rootResolved.toLocaleLowerCase("en-US");
  const relativeKey = path.relative(rootKey, childKey);
  return relativeKey.length > 0 && !relativeKey.startsWith("..") && !path.isAbsolute(relativeKey);
};

const assertDirectory = (value: string, code: ChangeSetApplyErrorCode, label: string): Stats => {
  let stat: Stats | undefined;
  try {
    stat = lstatSync(value);
  } catch {
    return fail(code, `${label} does not exist`);
  }
  if (stat === undefined) return fail(code, `${label} does not exist`);
  if (stat.isSymbolicLink()) {
    fail(code, `${label} must not be a symbolic link`);
  }
  if (!stat.isDirectory()) {
    fail(code, `${label} must be a directory`);
  }
  return stat;
};

const assertManagedWorktree = (worktreeRoot: string, managedRoot: string): string => {
  if (typeof managedRoot !== "string" || managedRoot.trim().length === 0) {
    fail("MANAGED_ROOT_REQUIRED", "an explicit managed worktree root is required");
  }
  if (typeof worktreeRoot !== "string" || worktreeRoot.trim().length === 0) {
    fail("WORKTREE_ROOT_INVALID", "an explicit worktree root is required");
  }
  if (!path.isAbsolute(managedRoot) || !path.isAbsolute(worktreeRoot)) {
    fail("MANAGED_ROOT_INVALID", "managed and worktree roots must be absolute paths");
  }

  const managed = path.resolve(managedRoot);
  const worktree = path.resolve(worktreeRoot);
  assertDirectory(managed, "MANAGED_ROOT_INVALID", "managed root");
  assertDirectory(worktree, "WORKTREE_ROOT_INVALID", "worktree root");
  if (!isInside(worktree, managed)) {
    fail("WORKTREE_OUTSIDE_MANAGED_ROOT", "worktree root must be a descendant of managed root");
  }

  let managedReal: string | undefined;
  let worktreeReal: string | undefined;
  try {
    managedReal = path.resolve(realpathSync(managed));
    worktreeReal = path.resolve(realpathSync(worktree));
  } catch {
    return fail("WORKTREE_ROOT_INVALID", "managed and worktree roots must resolve to real directories");
  }
  if (managedReal === undefined || worktreeReal === undefined) {
    return fail("WORKTREE_ROOT_INVALID", "managed and worktree roots must resolve to real directories");
  }
  if (!isInside(worktreeReal, managedReal)) {
    fail("WORKTREE_OUTSIDE_MANAGED_ROOT", "resolved worktree root escapes managed root");
  }
  return worktree;
};

type PathInspection = {
  exists: boolean;
  target: string;
  parent: string;
  caseMismatch: boolean;
  parentMissing: boolean;
};

const listEntries = (directory: string): Dirent[] => {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return fail("PARENT_MISSING", `unable to inspect parent directory ${directory}`);
  }
};

/**
 * Walks the path one component at a time. This is intentionally stricter than
 * `existsSync(join(root, relative))`: it catches symlink ancestors and names
 * that differ only by case, even when tests run on a case-sensitive host.
 */
const inspectPath = (root: string, relative: string): PathInspection => {
  const segments = normalizedPath(relative).split("/");
  let current = root;
  let caseMismatch = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const entries = listEntries(current);
    const matches = entries.filter((entry) => entry.name.toLocaleLowerCase("en-US") === segment.toLocaleLowerCase("en-US"));
    if (matches.length > 1) {
      fail("CASE_COLLISION", `directory contains case-colliding entries for ${segment}`);
    }
    if (matches.length === 0) {
      const target = path.join(current, segment);
      return {
        exists: false,
        target,
        parent: current,
        caseMismatch,
        parentMissing: index < segments.length - 1
      };
    }

    const match = matches[0]!;
    if (match.name !== segment) {
      caseMismatch = true;
    }
    const next = path.join(current, match.name);
    let stat: Stats | undefined;
    try {
      stat = lstatSync(next);
    } catch {
      return fail("TARGET_MISSING", `path changed while being inspected: ${relative}`);
    }
    if (stat === undefined) return fail("TARGET_MISSING", `path changed while being inspected: ${relative}`);
    if (stat.isSymbolicLink()) {
      fail(index === segments.length - 1 ? "TARGET_SYMLINK" : "PARENT_SYMLINK", `symbolic link in path ${relative}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail("PARENT_NOT_DIRECTORY", `path ancestor is not a directory: ${next}`);
    }
    current = next;
  }

  return {
    exists: true,
    target: current,
    parent: path.dirname(current),
    caseMismatch,
    parentMissing: false
  };
};

const ensureSafeFilePath = (candidate: unknown): string => {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 500) {
    fail("UNSAFE_PATH", "operation path must be a non-empty bounded string");
  }
  const pathValue = candidate as string;
  const hasControlCharacter = [...pathValue].some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 31) || code === 127;
  });
  if (pathValue !== pathValue.trim() || hasControlCharacter) {
    fail("UNSAFE_PATH", "operation path contains whitespace padding or control characters");
  }
  if (!isWorkerProposalSafePath(pathValue)) {
    fail("UNSAFE_PATH", `operation path is not a safe relative path: ${pathValue}`);
  }
  const normalized = normalizedPath(pathValue);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    fail("UNSAFE_PATH", `operation path contains an unsafe segment: ${pathValue}`);
  }

  for (const segment of segments) {
    if (segment.includes(":" ) || /[*?<>|]/u.test(segment) || /[. ]$/u.test(segment)) {
      fail("UNSAFE_PATH", `operation path contains a Windows-unsafe segment: ${pathValue}`);
    }
    const stem = segment.split(".", 1)[0]!.toLocaleUpperCase("en-US");
    if (RESERVED_WINDOWS_NAMES.has(stem)) {
      fail("UNSAFE_PATH", `operation path uses a reserved Windows name: ${pathValue}`);
    }
    const lower = segment.toLocaleLowerCase("en-US");
    if (lower === ".git" || lower.startsWith(".env") || DENIED_FILE_NAMES.has(lower) || lower.endsWith(".pem") || lower.endsWith(".key") || lower.endsWith(".p12") || lower.endsWith(".pfx")) {
      fail("UNSAFE_PATH", `operation path is denied by the controlled-writer denylist: ${pathValue}`);
    }
  }
  return normalized;
};

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const encodeContent = (value: unknown, operationIndex: number): Buffer => {
  if (typeof value !== "string" || hasUnpairedSurrogate(value) || value.includes("\u0000")) {
    fail("CONTENT_INVALID", "operation content must be valid UTF-8 text without NUL", operationIndex);
  }
  return Buffer.from(value as string, "utf8");
};

const getScope = (taskSpec: TaskIdentityAndScope | undefined): Scope => {
  const scope = taskSpec?.scope;
  if (!isRecord(scope) || !Array.isArray(scope.allowed_paths) || !Array.isArray(scope.forbidden_paths)) {
    fail("INVALID_APPLY_INPUT", "a TaskSpec scope with allowed_paths and forbidden_paths is required");
  }
  return scope as Scope;
};

const pathAllowed = (candidate: string, scope: Scope): boolean => {
  const direct = isPathAllowedInScope(candidate, scope);
  if (direct.match) return true;
  // Windows path matching is case-insensitive. Keep the shared helper as the
  // authority for glob semantics, but retry with a lower-case view.
  const lowerScope: Scope = {
    allowed_paths: scope.allowed_paths.map((entry) => entry.toLocaleLowerCase("en-US")),
    forbidden_paths: scope.forbidden_paths.map((entry) => entry.toLocaleLowerCase("en-US"))
  };
  return isPathAllowedInScope(candidate.toLocaleLowerCase("en-US"), lowerScope).match;
};

const validLimits = (candidate: ChangeSetApplyLimits): boolean =>
  Number.isSafeInteger(candidate.max_operations) && candidate.max_operations >= 1 && candidate.max_operations <= 200 &&
  Number.isSafeInteger(candidate.max_file_bytes) && candidate.max_file_bytes >= 1 && candidate.max_file_bytes <= 1_048_576 &&
  Number.isSafeInteger(candidate.max_total_bytes) && candidate.max_total_bytes >= 1 && candidate.max_total_bytes <= 10 * 1024 * 1024;

const resolveLimits = (options: ChangeSetApplyOptions, taskSpec: TaskIdentityAndScope | undefined): ChangeSetApplyLimits => {
  const configured = options.limits ?? DEFAULT_LIMITS;
  if (!isRecord(configured) || !validLimits(configured as ChangeSetApplyLimits)) {
    fail("LIMIT_INVALID", "change-set limits are outside the bounded DG3-F range");
  }
  const limits: ChangeSetApplyLimits = { ...configured } as ChangeSetApplyLimits;
  if (taskSpec?.limits?.max_changed_files !== undefined) {
    if (!Number.isSafeInteger(taskSpec.limits.max_changed_files) || taskSpec.limits.max_changed_files < 1) {
      fail("LIMIT_INVALID", "TaskSpec max_changed_files is invalid");
    }
    limits.max_operations = Math.min(limits.max_operations, taskSpec.limits.max_changed_files);
  }
  if (taskSpec?.limits?.max_diff_bytes !== undefined) {
    if (!Number.isSafeInteger(taskSpec.limits.max_diff_bytes) || taskSpec.limits.max_diff_bytes < 1) {
      fail("LIMIT_INVALID", "TaskSpec max_diff_bytes is invalid");
    }
    limits.max_total_bytes = Math.min(limits.max_total_bytes, taskSpec.limits.max_diff_bytes);
  }
  return limits;
};

const validateIdentity = (changeSet: ChangeSet, options: ChangeSetApplyOptions, taskSpec: TaskIdentityAndScope | undefined): { taskId: string; baseSha: string; taskSpecSha256: string } => {
  const taskId = options.taskId ?? taskSpec?.task_id;
  const baseSha = options.baseSha ?? taskSpec?.base_sha;
  const taskSpecSha256 = options.taskSpecSha256;
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId) || typeof baseSha !== "string" || !GIT_SHA_PATTERN.test(baseSha) || typeof taskSpecSha256 !== "string" || !SHA256_PATTERN.test(taskSpecSha256)) {
    fail("INVALID_APPLY_INPUT", "task, base and TaskSpec identities must be bounded hashes/ids");
  }
  const expectedTaskId = taskId as string;
  const expectedBaseSha = baseSha as string;
  const expectedTaskSpecSha256 = taskSpecSha256 as string;
  if (changeSet.task_id !== expectedTaskId || changeSet.base_sha !== expectedBaseSha || changeSet.task_spec_sha256 !== expectedTaskSpecSha256) {
    fail("IDENTITY_MISMATCH", "change-set task/base/TaskSpec identity does not match the approved TaskSpec");
  }
  return { taskId: expectedTaskId, baseSha: expectedBaseSha, taskSpecSha256: expectedTaskSpecSha256 };
};

const validateChangeSetShape = (value: unknown): ChangeSet => {
  const result = validateChangeSet(value);
  if (!result.valid) {
    const summary = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    return fail("CHANGE_SET_INVALID", summary || "change-set schema/semantic validation failed");
  }
  const candidate = result.value;
  if (candidate.status !== "completed") {
    fail("STATUS_NOT_COMPLETED", "only a completed change-set may be applied");
  }
  return candidate;
};

type PreparedOperation = {
  operation: ChangeSetOperation;
  relativePath: string;
  target: string;
  parent: string;
  targetExisted: boolean;
  expectedHash: string | null;
  bytes: Buffer;
};

const validateOperation = (
  operation: unknown,
  index: number,
  worktreeRoot: string,
  scope: Scope,
  limits: ChangeSetApplyLimits,
  seenPaths: Set<string>
): PreparedOperation => {
  if (!isRecord(operation) || (operation.type !== "create_file" && operation.type !== "replace_file") || typeof operation.path !== "string" || !("expected_sha256" in operation) || typeof operation.content !== "string") {
    return fail("CHANGE_SET_INVALID", "operation must be a complete create_file or replace_file object", index);
  }
  const candidate = operation as Record<string, unknown>;
  const relativePath = ensureSafeFilePath(candidate.path);
  const key = pathKey(relativePath);
  if (seenPaths.has(key)) {
    fail("DUPLICATE_PATH", `operation path is duplicated or case-colliding: ${relativePath}`, index);
  }
  seenPaths.add(key);
  if (!pathAllowed(relativePath, scope)) {
    fail("SCOPE_VIOLATION", `operation path is outside the approved TaskSpec scope: ${relativePath}`, index);
  }

  const bytes = encodeContent(candidate.content, index);
  if (bytes.byteLength > limits.max_file_bytes) {
    fail("FILE_LIMIT_EXCEEDED", `operation content exceeds ${limits.max_file_bytes} bytes`, index);
  }

  const expectedHash = candidate.expected_sha256 as string | null;
  if (candidate.type === "replace_file") {
    if (typeof expectedHash !== "string" || !SHA256_PATTERN.test(expectedHash)) {
      fail("CHANGE_SET_INVALID", "replace_file requires a lowercase SHA-256 expected hash", index);
    }
  } else if (expectedHash !== null) {
    fail("CHANGE_SET_INVALID", "create_file requires expected_sha256 to be null", index);
  }

  const inspection = inspectPath(worktreeRoot, relativePath);
  if (inspection.caseMismatch) {
    fail("CASE_COLLISION", `operation path casing does not match the managed worktree: ${relativePath}`, index);
  }
  if (candidate.type === "replace_file") {
    if (!inspection.exists) {
      fail("TARGET_MISSING", `replace_file target does not exist: ${relativePath}`, index);
    }
    let stat: Stats | undefined;
    try {
      stat = lstatSync(inspection.target);
    } catch {
      return fail("TARGET_MISSING", `replace_file target disappeared: ${relativePath}`, index);
    }
    if (stat === undefined) return fail("TARGET_MISSING", `replace_file target disappeared: ${relativePath}`, index);
    if (stat.isSymbolicLink()) {
      fail("TARGET_SYMLINK", `replace_file target is a symbolic link: ${relativePath}`, index);
    }
    if (!stat.isFile()) {
      fail("TARGET_NOT_REGULAR", `replace_file target is not a regular file: ${relativePath}`, index);
    }
    let original: Buffer | undefined;
    try {
      original = readFileSync(inspection.target);
    } catch {
      return fail("TARGET_NOT_REGULAR", `replace_file target cannot be read: ${relativePath}`, index);
    }
    if (original === undefined) return fail("TARGET_NOT_REGULAR", `replace_file target cannot be read: ${relativePath}`, index);
    if (sha256(original) !== expectedHash) {
      fail("TARGET_HASH_MISMATCH", `replace_file expected hash does not match: ${relativePath}`, index);
    }
    return { operation: candidate as unknown as ChangeSetOperation, relativePath, target: inspection.target, parent: inspection.parent, targetExisted: true, expectedHash, bytes };
  }

  if (inspection.exists) {
    fail("TARGET_EXISTS", `create_file target already exists: ${relativePath}`, index);
  }
  if (inspection.parentMissing) {
    fail("PARENT_MISSING", `create_file parent directory is missing: ${relativePath}`, index);
  }
  assertDirectory(inspection.parent, "PARENT_NOT_DIRECTORY", `create_file parent ${inspection.parent}`);
  return { operation: candidate as unknown as ChangeSetOperation, relativePath, target: inspection.target, parent: inspection.parent, targetExisted: false, expectedHash: null, bytes };
};

const verifyUnchanged = (prepared: PreparedOperation, index: number): void => {
  const inspection = inspectPath(path.resolve(prepared.target, ".."), path.basename(prepared.target));
  if (prepared.targetExisted) {
    if (!inspection.exists || inspection.caseMismatch) {
      fail("TARGET_CHANGED_AFTER_VALIDATION", `target changed after validation: ${prepared.relativePath}`, index);
    }
    let stat: Stats | undefined;
    try {
      stat = lstatSync(inspection.target);
    } catch {
      return fail("TARGET_CHANGED_AFTER_VALIDATION", `target disappeared after validation: ${prepared.relativePath}`, index);
    }
    if (stat === undefined) return fail("TARGET_CHANGED_AFTER_VALIDATION", `target disappeared after validation: ${prepared.relativePath}`, index);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail("TARGET_CHANGED_AFTER_VALIDATION", `target type changed after validation: ${prepared.relativePath}`, index);
    }
    if (prepared.expectedHash === null || sha256(readFileSync(inspection.target)) !== prepared.expectedHash) {
      fail("TARGET_CHANGED_AFTER_VALIDATION", `target hash changed after validation: ${prepared.relativePath}`, index);
    }
  } else if (inspection.exists) {
    fail("TARGET_CHANGED_AFTER_VALIDATION", `create target appeared after validation: ${prepared.relativePath}`, index);
  }
};

const writeAdjacentTemp = (prepared: PreparedOperation): string => {
  const temp = path.join(prepared.parent, `.${path.basename(prepared.target)}.agentplatform-${randomBytes(16).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    let offset = 0;
    while (offset < prepared.bytes.byteLength) {
      offset += writeSync(descriptor, prepared.bytes, offset, prepared.bytes.byteLength - offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temp;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary write error.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // Best-effort cleanup of an attempt-local temporary file.
    }
    const message = error instanceof Error ? error.message : "unable to stage temporary file";
    return fail("ATOMIC_WRITE_FAILED", message);
  }
};

const cleanupTemps = (temps: readonly string[]): void => {
  temps.forEach((temp) => {
    try {
      unlinkSync(temp);
    } catch {
      // A successfully renamed temp no longer exists; cleanup is best effort.
    }
  });
};

type CommitRecord = {
  prepared: PreparedOperation;
  backup: string | null;
  installed: boolean;
};

const backupName = (prepared: PreparedOperation): string =>
  path.join(prepared.parent, `.${path.basename(prepared.target)}.agentplatform-${randomBytes(16).toString("hex")}.bak`);

/**
 * Move originals aside before publishing any staged content. Publishing uses
 * hard links, whose destination creation is atomic and fails if a target
 * appears after validation. This avoids rename-overwrite semantics for both
 * create and replace operations.
 */
const commitPrepared = (prepared: readonly PreparedOperation[], temps: readonly string[]): CommitRecord[] => {
  const records: CommitRecord[] = prepared.map((item) => ({ prepared: item, backup: null, installed: false }));
  try {
    records.forEach((record, index) => {
      verifyUnchanged(record.prepared, index);
      if (!record.prepared.targetExisted) return;
      const backup = backupName(record.prepared);
      renameSync(record.prepared.target, backup);
      record.backup = backup;
      const backupStat = lstatSync(backup);
      if (backupStat.isSymbolicLink() || !backupStat.isFile() || record.prepared.expectedHash === null || sha256(readFileSync(backup)) !== record.prepared.expectedHash) {
        fail("TARGET_CHANGED_AFTER_VALIDATION", `target changed while preparing commit: ${record.prepared.relativePath}`, index);
      }
    });

    records.forEach((record, index) => {
      try {
        // linkSync has no replace behavior: a concurrently-created destination
        // yields EEXIST instead of being overwritten. Staged files and targets
        // are adjacent, so they reside on the same filesystem.
        linkSync(temps[index]!, record.prepared.target);
        record.installed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "atomic publish failed";
        fail("ATOMIC_WRITE_FAILED", `${record.prepared.relativePath}: ${message}`, index);
      }
    });

    records.forEach((record) => {
      if (record.backup === null) return;
      try {
        unlinkSync(record.backup);
      } catch {
        // The new targets are already committed. A retained attempt-local
        // backup is safer than rolling back a fully published transaction.
      }
    });
    return records;
  } catch (error) {
    let rollbackFailure: unknown;
    [...records].reverse().forEach((record) => {
      try {
        if (record.installed) unlinkSync(record.prepared.target);
        if (record.backup !== null) renameSync(record.backup, record.prepared.target);
      } catch (rollbackError) {
        rollbackFailure ??= rollbackError;
      }
    });
    if (rollbackFailure !== undefined) {
      const detail = rollbackFailure instanceof Error ? rollbackFailure.message : "rollback failed";
      return fail("ATOMIC_WRITE_FAILED", `transaction rollback failed: ${detail}`);
    }
    throw error;
  }
};

const normalizeInput = (first: ChangeSetApplyInput | ChangeSet, second?: ChangeSetApplyOptions): ChangeSetApplyInput => {
  if (second !== undefined) {
    return { ...second, changeSet: first as ChangeSet };
  }
  if (isRecord(first) && "changeSet" in first) {
    return first as unknown as ChangeSetApplyInput;
  }
  return fail("INVALID_APPLY_INPUT", "applyChangeSet requires a change-set and apply options");
};

/**
 * Validate the entire change set, stage every file adjacent to its target, and
 * then atomically rename staged files into the managed worktree. No target is
 * touched until all operations have passed validation.
 */
export function applyChangeSet(first: ChangeSetApplyInput | ChangeSet, second?: ChangeSetApplyOptions): ChangeSetApplyResult {
  const input = normalizeInput(first, second);
  const worktreeRoot = assertManagedWorktree(input.worktreeRoot, input.managedWorktreeRoot);
  const changeSet = validateChangeSetShape(input.changeSet);
  const taskSpec = input.taskSpec ?? input.spec;
  const scope = getScope(taskSpec);
  const identity = validateIdentity(changeSet, input, taskSpec);
  const limits = resolveLimits(input, taskSpec);
  if (changeSet.operations.length > limits.max_operations) {
    fail("OPERATION_LIMIT_EXCEEDED", `change-set has ${changeSet.operations.length} operations; limit is ${limits.max_operations}`);
  }

  const seenPaths = new Set<string>();
  const prepared: PreparedOperation[] = [];
  let totalBytes = 0;
  changeSet.operations.forEach((operation, index) => {
    const item = validateOperation(operation, index, worktreeRoot, scope, limits, seenPaths);
    totalBytes += item.bytes.byteLength;
    if (totalBytes > limits.max_total_bytes) {
      fail("TOTAL_LIMIT_EXCEEDED", `change-set content exceeds ${limits.max_total_bytes} bytes`, index);
    }
    prepared.push(item);
  });

  // Stage only after every operation, path, scope, limit and hash has passed.
  const temps: string[] = [];
  try {
    prepared.forEach((item) => temps.push(writeAdjacentTemp(item)));
    commitPrepared(prepared, temps);
  } finally {
    cleanupTemps(temps);
  }

  const operations = prepared.map((item) => ({
    type: item.operation.type,
    path: item.relativePath,
    bytes: item.bytes.byteLength
  }));
  return {
    applied: true,
    task_id: identity.taskId,
    base_sha: identity.baseSha,
    task_spec_sha256: identity.taskSpecSha256,
    changed_paths: operations.map((operation) => operation.path),
    operations,
    total_bytes: totalBytes
  };
}

export const applyControlledChangeSet = applyChangeSet;

/** Small object wrapper for callers that keep a per-attempt writer service. */
export class ChangeSetApplier {
  private readonly applyOptions: ChangeSetApplyOptions;

  constructor(applyOptions: ChangeSetApplyOptions) {
    this.applyOptions = applyOptions;
  }

  apply(changeSet: ChangeSet): ChangeSetApplyResult {
    return applyChangeSet(changeSet, this.applyOptions);
  }
}
