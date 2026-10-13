import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats
} from "node:fs";
import path from "node:path";

import { isPathAllowedInScope } from "../../shared/core/paths.js";
import {
  validateTaskSpec,
  type TaskSpec
} from "../../shared/core/task-spec.js";
import {
  isWorkerProposalSafePath,
  WORKER_PROPOSAL_CONTEXT_LIMITS,
  WORKER_PROPOSAL_SCHEMA_VERSION,
  type WorkerProposalContextFile,
  type WorkerProposalRequest
} from "../../shared/core/worker-proposal.js";

/**
 * The context limits are deliberately smaller than the general historical
 * bounded-context reader.  A worker proposal is an input to a model and is
 * therefore kept to a fixed, reviewable upper bound.
 */
export const PROPOSAL_CONTEXT_LIMITS = {
  maxFiles: WORKER_PROPOSAL_CONTEXT_LIMITS.maxFiles,
  maxBytesPerFile: WORKER_PROPOSAL_CONTEXT_LIMITS.maxFileBytes,
  maxTotalBytes: WORKER_PROPOSAL_CONTEXT_LIMITS.maxTotalBytes
} as const;

export type ProposalContextLimits = {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
};

export type ProposalContextFile = WorkerProposalContextFile;

/**
 * This alias keeps the bounded builder's public name local to WP-F2 while
 * using the WP-F1 request contract as the single wire shape.
 */
export type ProposalContextRequest = WorkerProposalRequest;

export class ProposalContextError extends Error {
  public readonly code: string;
  public readonly relativePath?: string;

  public constructor(code: string, message: string, relativePath?: string) {
    super(`${code}: ${message}`);
    this.name = "ProposalContextError";
    this.code = code;
    this.relativePath = relativePath;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

const normalizeRelative = (value: string): string => value.trim().replaceAll("\\", "/");

const isWindows = process.platform === "win32";

const comparisonPath = (value: string): string =>
  isWindows ? value.toLocaleLowerCase("en-US") : value;

/**
 * Secret path policy is intentionally fixed here, rather than being a task
 * supplied option.  A broader TaskSpec scope must not grant model visibility
 * to credentials accidentally.
 */
const isSecretPath = (relativePath: string): boolean => {
  const parts = relativePath.split("/");
  const lowerParts = parts.map((part) => part.toLocaleLowerCase("en-US"));
  const basename = lowerParts[lowerParts.length - 1] ?? "";

  if (lowerParts.some((part) => part === ".git" || part === ".ssh")) return true;
  if (basename.startsWith(".env")) return true;
  if ([".npmrc", ".pypirc", ".netrc"].includes(basename)) return true;

  if (
    basename === "id_rsa" ||
    basename === "id_dsa" ||
    basename === "id_ecdsa" ||
    basename === "id_ed25519" ||
    basename.startsWith("id_rsa.") ||
    basename.startsWith("id_dsa.") ||
    basename.startsWith("id_ecdsa.") ||
    basename.startsWith("id_ed25519.")
  ) return true;

  if (
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx") ||
    basename.endsWith(".jks")
  ) return true;

  // Common credential-file names are denied independent of extension.  The
  // matching is path based; content markers are checked separately below.
  return (
    /(^|[-_.])(credential|credentials|secret|secrets|password|passwd|token|tokens)([-_.]|$)/.test(basename) ||
    basename === "auth.json" ||
    basename === "authorization.json"
  );
};

const containsPrivateKeyMaterial = (content: string): boolean =>
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/.test(content) ||
  /-----BEGIN OPENSSH PRIVATE KEY-----/.test(content);

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("cannot canonicalize undefined or unsupported value");
};

export const canonicalTaskSpecJson = (taskSpec: TaskSpec): string => canonicalJson(taskSpec);

export const taskSpecCanonicalSha256 = (taskSpec: TaskSpec): string =>
  createHash("sha256").update(canonicalTaskSpecJson(taskSpec), "utf8").digest("hex");

type FileFingerprint = {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const fingerprint = (stat: Stats): FileFingerprint => ({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs
});

const sameFingerprint = (left: FileFingerprint, right: FileFingerprint): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const fail = (code: string, message: string, relativePath?: string): never => {
  throw new ProposalContextError(code, message, relativePath);
};

const assertManagedRoot = (managedWorktree: string): string => {
  if (typeof managedWorktree !== "string" || !path.isAbsolute(managedWorktree)) {
    return fail("WORKTREE_NOT_ABSOLUTE", "managed worktree must be an absolute path");
  }

  let stat: Stats;
  try {
    stat = lstatSync(managedWorktree);
  } catch {
    return fail("WORKTREE_UNREADABLE", "managed worktree cannot be read");
  }
  if (stat.isSymbolicLink()) return fail("WORKTREE_SYMLINK", "managed worktree must not be a symlink");
  if (!stat.isDirectory()) return fail("WORKTREE_NOT_DIRECTORY", "managed worktree must be a directory");

  try {
    return realpathSync(managedWorktree);
  } catch {
    return fail("WORKTREE_UNREADABLE", "managed worktree realpath cannot be resolved");
  }
};

const assertNoSymlinkAncestors = (root: string, relativePath: string): void => {
  let current = root;
  const segments = relativePath.split("/");
  segments.forEach((segment, index) => {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      fail("SYMLINK_PATH", "context path or ancestor is a symlink", relativePath);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail("NOT_DIRECTORY", "context path ancestor is not a directory", relativePath);
    }
  });
};

const readStableUtf8File = (
  root: string,
  relativePath: string,
  limits: ProposalContextLimits,
  bytesAlreadyRead: number
): ProposalContextFile => {
  if (isSecretPath(relativePath)) {
    return fail("SECRET_PATH", "context path is denied by the fixed secret denylist", relativePath);
  }

  const absolute = path.resolve(root, relativePath);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(rootWithSeparator)) {
    return fail("PATH_ESCAPE", "context path escapes the managed worktree", relativePath);
  }

  assertNoSymlinkAncestors(root, relativePath);

  let beforeStat: Stats;
  try {
    beforeStat = lstatSync(absolute);
  } catch {
    return fail("FILE_UNREADABLE", "context file does not exist or cannot be read", relativePath);
  }
  if (beforeStat.isSymbolicLink()) return fail("SYMLINK_PATH", "context file is a symlink", relativePath);
  if (!beforeStat.isFile()) return fail("NOT_REGULAR_FILE", "context path is not a regular file", relativePath);
  if (beforeStat.size > limits.maxBytesPerFile) {
    return fail("FILE_TOO_LARGE", `context file exceeds ${limits.maxBytesPerFile} bytes`, relativePath);
  }
  if (bytesAlreadyRead + beforeStat.size > limits.maxTotalBytes) {
    return fail("CONTEXT_TOO_LARGE", `context exceeds ${limits.maxTotalBytes} bytes`, relativePath);
  }

  let firstBytes: Buffer;
  try {
    firstBytes = readFileSync(absolute);
  } catch {
    return fail("FILE_UNREADABLE", "context file cannot be read", relativePath);
  }
  let afterReadStat: Stats;
  try {
    afterReadStat = lstatSync(absolute);
  } catch {
    return fail("FILE_DRIFT", "context file disappeared after it was read", relativePath);
  }
  if (afterReadStat.isSymbolicLink() || !afterReadStat.isFile()) {
    return fail("FILE_DRIFT", "context file changed type while it was read", relativePath);
  }
  if (!sameFingerprint(fingerprint(beforeStat), fingerprint(afterReadStat))) {
    return fail("FILE_DRIFT", "context file changed while it was read", relativePath);
  }
  if (firstBytes.byteLength > limits.maxBytesPerFile || bytesAlreadyRead + firstBytes.byteLength > limits.maxTotalBytes) {
    return fail("CONTEXT_TOO_LARGE", "context size changed while it was read", relativePath);
  }

  // A second bounded read closes the same-size/same-mtime race on filesystems
  // with coarse timestamps.  The second stat is intentionally adjacent to the
  // read and is part of the pre-provider drift check.
  let secondBytes: Buffer;
  let afterHashStat: Stats;
  try {
    secondBytes = readFileSync(absolute);
    afterHashStat = lstatSync(absolute);
  } catch {
    return fail("FILE_DRIFT", "context file disappeared while it was hashed", relativePath);
  }
  if (afterHashStat.isSymbolicLink() || !afterHashStat.isFile() || !sameFingerprint(fingerprint(afterReadStat), fingerprint(afterHashStat)) || !firstBytes.equals(secondBytes)) {
    return fail("FILE_DRIFT", "context file changed while it was hashed", relativePath);
  }

  let content: string;
  try {
    content = decoder.decode(firstBytes);
  } catch {
    return fail("NON_UTF8", "context file is not valid UTF-8", relativePath);
  }
  if (firstBytes.includes(0) || containsPrivateKeyMaterial(content)) {
    return fail("BINARY_OR_SECRET_CONTENT", "context file contains binary or private-key material", relativePath);
  }

  return {
    path: relativePath,
    byte_count: firstBytes.byteLength,
    sha256: createHash("sha256").update(firstBytes).digest("hex"),
    content
  };
};

export type ProposalContextInput = {
  taskSpec: TaskSpec;
  managedWorktree: string;
  limits?: Partial<ProposalContextLimits>;
};

const resolveLimits = (overrides?: Partial<ProposalContextLimits>): ProposalContextLimits => {
  const limits = { ...PROPOSAL_CONTEXT_LIMITS, ...overrides };
  if (
    !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 ||
    !Number.isSafeInteger(limits.maxBytesPerFile) || limits.maxBytesPerFile < 1 ||
    !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes < 1 ||
    limits.maxFiles > PROPOSAL_CONTEXT_LIMITS.maxFiles ||
    limits.maxBytesPerFile > PROPOSAL_CONTEXT_LIMITS.maxBytesPerFile ||
    limits.maxTotalBytes > PROPOSAL_CONTEXT_LIMITS.maxTotalBytes
  ) {
    throw new ProposalContextError("INVALID_LIMITS", "proposal context limits must be non-negative integers within the fixed DG3-F bounds");
  }
  return limits;
};

const validateAndNormalizeContextPaths = (taskSpec: TaskSpec, limits: ProposalContextLimits): string[] => {
  const paths = taskSpec.context_paths;
  if (!Array.isArray(paths)) return fail("CONTEXT_PATHS_INVALID", "TaskSpec context_paths must be an array");
  if (paths.length > limits.maxFiles) return fail("TOO_MANY_FILES", `context_paths exceeds ${limits.maxFiles} files`);

  for (const pattern of [...taskSpec.scope.allowed_paths, ...taskSpec.scope.forbidden_paths]) {
    if (!isWorkerProposalSafePath(pattern)) {
      fail("SCOPE_INVALID", "TaskSpec scope contains an unsafe path pattern", pattern);
    }
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  paths.forEach((candidate, index) => {
    if (typeof candidate !== "string" || !isWorkerProposalSafePath(candidate)) {
      fail("UNSAFE_PATH", `context_paths[${index}] must be a safe relative path`, typeof candidate === "string" ? candidate : undefined);
    }
    const relativePath = normalizeRelative(candidate);
    if (isSecretPath(relativePath)) fail("SECRET_PATH", "context path is denied by the fixed secret denylist", relativePath);
    const key = comparisonPath(relativePath);
    if (seen.has(key)) fail("DUPLICATE_PATH", "context_paths contains duplicate or case-colliding paths", relativePath);
    seen.add(key);

    const scopeCheck = isPathAllowedInScope(relativePath, taskSpec.scope);
    if (!scopeCheck.match) fail("SCOPE_VIOLATION", scopeCheck.reason ?? "context path is outside TaskSpec scope", relativePath);
    normalized.push(relativePath);
  });
  return normalized;
};

/**
 * Build the bounded proposal request from an already-approved TaskSpec.
 * Every selected file is checked before it is copied into the request, and
 * any failure aborts the whole request before a provider can be launched.
 */
export const buildProposalContext = ({ taskSpec, managedWorktree, limits: overrides }: ProposalContextInput): ProposalContextRequest => {
  const taskSpecCheck = validateTaskSpec(taskSpec);
  if (!taskSpecCheck.valid) {
    const detail = taskSpecCheck.issues.map((issue) => `${issue.path}:${issue.message}`).join(", ");
    return fail("TASK_SPEC_INVALID", `approved TaskSpec failed validation: ${detail}`);
  }

  const limits = resolveLimits(overrides);
  const root = assertManagedRoot(managedWorktree);
  const contextPaths = validateAndNormalizeContextPaths(taskSpecCheck.value, limits);
  const contextFiles: ProposalContextFile[] = [];
  let totalBytes = 0;
  for (const relativePath of contextPaths) {
    const item = readStableUtf8File(root, relativePath, limits, totalBytes);
    totalBytes += item.byte_count;
    contextFiles.push(item);
  }

  return {
    schema_version: WORKER_PROPOSAL_SCHEMA_VERSION,
    task_id: taskSpecCheck.value.task_id,
    base_sha: taskSpecCheck.value.base_sha,
    task_spec_sha256: taskSpecCanonicalSha256(taskSpecCheck.value),
    goal: taskSpecCheck.value.goal,
    scope: {
      allowed_paths: [...taskSpecCheck.value.scope.allowed_paths],
      forbidden_paths: [...taskSpecCheck.value.scope.forbidden_paths]
    },
    acceptance_criteria: taskSpecCheck.value.acceptance_criteria.map((criterion) => ({ ...criterion })),
    context_files: contextFiles,
    limits: {
      max_operations: taskSpecCheck.value.limits.max_changed_files,
      max_file_bytes: limits.maxBytesPerFile,
      max_total_bytes: limits.maxTotalBytes
    }
  };
};

/** Compatibility names used by the proposal adapter and focused callers. */
export const buildWorkerProposalRequest = buildProposalContext;
export const createProposalContext = buildProposalContext;
