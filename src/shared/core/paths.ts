import path from "node:path";

const disallowParentSegmentPattern = /(^|[\\/])\.\.([\\/]|$)/;

export const isRelativePath = (candidate: string): boolean => {
  if (candidate.length === 0) {
    return false;
  }
  if (candidate.startsWith("/") || candidate.startsWith("\\")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(candidate)) {
    return false;
  }
  if (candidate.includes("..") && disallowParentSegmentPattern.test(candidate)) {
    return false;
  }
  return true;
};

const normalizePathValue = (candidate: string): string =>
  candidate.trim().replace(/\\/g, "/");

export const isRelativeSafePath = (candidate: string): boolean => {
  if (candidate.trim().length === 0) {
    return false;
  }
  if (!isRelativePath(candidate)) {
    return false;
  }

  const normalized = normalizePathValue(candidate);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return false;
  }
  if (segments.some((segment) => segment === "..")) {
    return false;
  }

  return true;
};

export type RepoPathCheckResult = {
  valid: boolean;
  reason?: string;
};

export type Scope = {
  allowed_paths: string[];
  forbidden_paths: string[];
};

export type ScopeCheckResult = {
  match: boolean;
  matchedPattern?: string;
  reason?: string;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export const globToRegExp = (pattern: string): RegExp => {
  const normalized = normalizePathValue(pattern);
  if (normalized.length === 0) {
    return /^$/;
  }

  const segments = normalized.split("/");
  let regex = "^";
  let needsSlash = false;

  segments.forEach((segment, index) => {
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;

    if (segment === "**") {
      if (isFirst && isLast) {
        regex += "(?:[^/]+(?:/[^/]*)*)?";
        needsSlash = false;
        return;
      }
      if (isFirst) {
        regex += "(?:[^/]+/)*";
        needsSlash = false;
        return;
      }
      if (isLast) {
        regex += "(?:/.*)?";
        needsSlash = false;
        return;
      }
      regex += "(?:/[^/]+)*";
      needsSlash = true;
      return;
    }

    const segmentRegex = segment
      .split("")
      .map((char) => {
        if (char === "*") {
          return "[^/]*";
        }
        if (char === "?") {
          return "[^/]";
        }
        return escapeRegExp(char);
      })
      .join("");

    if (needsSlash) {
      regex += "\\/";
    }
    regex += segmentRegex;
    needsSlash = true;
  });

  regex += "$";
  return new RegExp(regex);
};

export const matchPathByPattern = (candidatePath: string, pattern: string): boolean => {
  if (!isRelativeSafePath(candidatePath) || !isRelativeSafePath(pattern)) {
    return false;
  }
  return globToRegExp(pattern).test(normalizePathValue(candidatePath));
};

export const isPathInside = (
  childPath: string,
  repositoryRoot: string
): RepoPathCheckResult => {
  if (!isRelativeSafePath(childPath)) {
    return { valid: false, reason: "Path must be safe repository-relative path." };
  }

  const normalizedRoot = path.resolve(repositoryRoot);
  const candidate = path.resolve(normalizedRoot, childPath);
  const rel = path.relative(normalizedRoot, candidate);

  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { valid: false, reason: "Path escapes repository root." };
  }

  return { valid: true };
};

export const isPathAllowedInScope = (
  candidatePath: string,
  scope: Scope
): ScopeCheckResult => {
  if (!isRelativeSafePath(candidatePath)) {
    return { match: false, reason: "Path must be safe relative path." };
  }
  if (!Array.isArray(scope.allowed_paths) || scope.allowed_paths.length === 0) {
    return { match: false, reason: "Scope has no allowed paths." };
  }

  const normalizedCandidate = normalizePathValue(candidatePath);
  const hasAllowed = scope.allowed_paths.some((pattern) => {
    return typeof pattern === "string" && matchPathByPattern(normalizedCandidate, pattern);
  });

  if (!hasAllowed) {
    return { match: false, reason: "Path is not allowed by scope." };
  }

  const forbiddenHit = scope.forbidden_paths?.find((pattern) => {
    return typeof pattern === "string" && matchPathByPattern(normalizedCandidate, pattern);
  });
  if (forbiddenHit) {
    return { match: false, reason: `Path is forbidden by scope pattern ${forbiddenHit}.` };
  }

  return { match: true };
};
