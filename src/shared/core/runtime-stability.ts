import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ERROR_CODES, type ErrorCode, type FailureClassification } from "./errors.js";
import { classifyFailureCode } from "./failure-taxonomy.js";
import { validateTaskSpec, type TaskSpec } from "./task-spec.js";
export type RuntimeUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
};

export const PHASE13_PARSER_VERSION = "phase1-3-transport-parser-v1";
export const PHASE13_SAMPLE_COUNT = 10;
export const PHASE13_HARD_TIMEOUT_SECONDS = 900;
export const PHASE13_STRONG_MODEL = "gpt-5.6-sol";
export const PHASE13_CHEAP_MODEL = "gpt-5.5";
export const PHASE13_REASONING = "medium" as const;
export const PHASE13_FIXTURE_COMMIT_MESSAGE = "Phase 1.3 synthetic runtime fixture";
export const PHASE13_FIXTURE_IDENTITY = { name: "AgentPlatform Phase 1.3", email: "phase13@example.invalid" } as const;
export const PHASE13_FIXTURE_COMMIT_DATE = "2000-01-01T00:00:00Z";
/** Updated from the deterministic synthetic fixture commit and asserted before every real run. */
export const PHASE13_EXPECTED_BASE_SHA = "1967975557059b69010fdb35254b601c314c75a6";
/** Stable identity of the tree hashing contract shared by preregistration and runtime. */
export const CANONICAL_TREE_HASH_VERSION = "agentplatform-tree-sha256-v1";

export type RuntimeCaseKind = "context_synthesis" | "cross_file_reasoning" | "evidence_risk_report";
export type RuntimeStabilityCase = {
  id: string;
  order: number;
  kind: RuntimeCaseKind;
  title: string;
  prompt: string;
  contextPaths: string[];
  acceptanceCriteria: string[];
  fixtureFiles: string[];
};

const readOnlyRules = [
  "This is a read-only Architect request. Do not edit, create, delete, or rename files.",
  "Do not run git add, commit, reset, checkout, merge, push, or any command that writes state.",
  "Do not invoke Workers, a Router, an Orchestrator, a worktree, or another model.",
  "Return exactly one TaskSpec JSON object using the existing task-spec schema.",
  "Use the requested task_id and base_sha exactly. Keep context_paths inside the listed repository files.",
  "The TaskSpec describes analysis only; its goal, criteria, and commands must not request repository writes."
];

const caseDefinition = (
  order: number,
  id: string,
  kind: RuntimeCaseKind,
  title: string,
  question: string,
  contextPaths: string[],
  acceptanceCriteria: string[],
  fixtureFiles: string[]
): RuntimeStabilityCase => ({
  id,
  order,
  kind,
  title,
  prompt: [
    `You are the read-only Architect for case ${id}.`,
    `Task title: ${title}.`,
    question,
    `Use base_sha "{{BASE_SHA}}" and task_id "${id}". The repository context paths are: ${contextPaths.join(", ")}.`,
    `The semantic acceptance points for this analysis are: ${acceptanceCriteria.join(" | ")}.`,
    ...readOnlyRules
  ].join("\n\n"),
  contextPaths,
  acceptanceCriteria,
  fixtureFiles
});

/**
 * The ten Phase 1.3 cases are intentionally independent from all Phase 1.2
 * DEV_*, HOLDOUT_* and PATH_REPORT tasks. Their order and mix are preregistered.
 */
export const phase13RuntimeCases: readonly RuntimeStabilityCase[] = [
  caseDefinition(1, "P13-ARCH-01", "context_synthesis", "Runtime ownership map", "Inspect the runtime configuration, domain boundaries, and operations notes. Synthesize the ownership map and identify which read-only evidence supports each boundary.", ["README.md", "docs/operations.md", "src/runtime/config.ts"], ["references each requested context path", "separates runtime ownership from domain behavior", "states one bounded risk with evidence"], ["README.md", "docs/operations.md", "src/runtime/config.ts"]),
  caseDefinition(2, "P13-ARCH-02", "context_synthesis", "Order lifecycle cross-reference", "Compare the order lifecycle description with the inventory invariants and the contract notes. Produce a structured analysis of the observable lifecycle and its assumptions.", ["docs/orders.md", "src/domain/orders.ts", "src/domain/inventory.ts", "tests/contracts.md"], ["cross-references order and inventory facts", "identifies the contract assumption", "does not invent an implementation change"], ["docs/orders.md", "src/domain/orders.ts", "src/domain/inventory.ts", "tests/contracts.md"]),
  caseDefinition(3, "P13-ARCH-03", "context_synthesis", "Configuration evidence index", "Read the configuration reference and the test evidence index. Explain how configuration keys map to observable checks and call out missing or ambiguous evidence.", ["README.md", "src/runtime/config.ts", "tests/evidence-index.md"], ["maps configuration keys to evidence", "identifies ambiguity without proposing edits", "keeps the conclusion traceable to paths"], ["README.md", "src/runtime/config.ts", "tests/evidence-index.md"]),
  caseDefinition(4, "P13-ARCH-04", "cross_file_reasoning", "Inventory reservation reasoning", "Reason across the inventory implementation, order implementation, and contract tests. Describe the reservation sequence, its invariants, and the read-only checks that would detect a mismatch.", ["src/domain/inventory.ts", "src/domain/orders.ts", "tests/contracts.md", "docs/orders.md"], ["describes the reservation sequence", "lists invariant evidence from at least three files", "proposes checks without changing files"], ["src/domain/inventory.ts", "src/domain/orders.ts", "tests/contracts.md", "docs/orders.md"]),
  caseDefinition(5, "P13-ARCH-05", "cross_file_reasoning", "Runtime failure path", "Trace a configuration failure from the runtime configuration through the service boundary and into the operational runbook. Distinguish observable failure from a remediation action.", ["src/runtime/config.ts", "src/runtime/service.ts", "docs/operations.md", "tests/evidence-index.md"], ["traces the failure across the files", "distinguishes diagnosis from remediation", "records a bounded operational risk"], ["src/runtime/config.ts", "src/runtime/service.ts", "docs/operations.md", "tests/evidence-index.md"]),
  caseDefinition(6, "P13-ARCH-06", "cross_file_reasoning", "Contract and documentation consistency", "Compare the public contract, domain code comments, and test evidence index. Report consistent claims, conflicting claims, and the minimum evidence needed to resolve each conflict.", ["README.md", "src/domain/orders.ts", "src/domain/inventory.ts", "tests/contracts.md", "tests/evidence-index.md"], ["reports both consistent and conflicting claims", "links each claim to a context path", "defines evidence needed without edits"], ["README.md", "src/domain/orders.ts", "src/domain/inventory.ts", "tests/contracts.md", "tests/evidence-index.md"]),
  caseDefinition(7, "P13-ARCH-07", "cross_file_reasoning", "Read-only boundary audit", "Audit the documented read-only boundary against runtime service and command notes. Identify commands or paths that deserve review and explain why the audit itself is non-mutating.", ["docs/operations.md", "src/runtime/service.ts", "src/runtime/config.ts", "README.md"], ["audits command and path boundaries", "flags risks with direct evidence", "does not request a write or a worker"], ["docs/operations.md", "src/runtime/service.ts", "src/runtime/config.ts", "README.md"]),
  caseDefinition(8, "P13-ARCH-08", "evidence_risk_report", "Evidence completeness report", "Prepare a long-form evidence report for this fixture: evidence sources, coverage, unknowns, and risks. Keep claims bounded by the available files.", ["README.md", "tests/contracts.md", "tests/evidence-index.md", "docs/operations.md"], ["enumerates evidence sources", "separates known facts from unknowns", "includes a risk and its evidence"], ["README.md", "tests/contracts.md", "tests/evidence-index.md", "docs/operations.md"]),
  caseDefinition(9, "P13-ARCH-09", "evidence_risk_report", "Release readiness risk report", "Review the fixture as a small release candidate. Provide structured conclusions about readiness, evidence gaps, and reversible follow-up checks without making any change.", ["README.md", "docs/operations.md", "src/runtime/service.ts", "tests/evidence-index.md"], ["states a bounded readiness conclusion", "lists evidence gaps", "keeps follow-up checks read-only and reversible"], ["README.md", "docs/operations.md", "src/runtime/service.ts", "tests/evidence-index.md"]),
  caseDefinition(10, "P13-ARCH-10", "evidence_risk_report", "Operational risk register", "Build an operational risk register from the configuration, service, order, and contract evidence. Rank risks by evidence strength and explain the uncertainty in each ranking.", ["src/runtime/config.ts", "src/runtime/service.ts", "src/domain/orders.ts", "tests/contracts.md", "docs/operations.md"], ["ranks risks with stated evidence strength", "references cross-file evidence", "does not recommend or perform repository writes"], ["src/runtime/config.ts", "src/runtime/service.ts", "src/domain/orders.ts", "tests/contracts.md", "docs/operations.md"])
];

export const phase13CaseOrder = phase13RuntimeCases.map((item) => item.id);

export const sha256Text = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const hashCaseDefinition = (item: RuntimeStabilityCase): string => sha256Text(JSON.stringify({
  id: item.id, order: item.order, kind: item.kind, title: item.title,
  prompt: item.prompt, contextPaths: item.contextPaths,
  acceptanceCriteria: item.acceptanceCriteria, fixtureFiles: item.fixtureFiles
}));

export const materializeCasePrompt = (item: RuntimeStabilityCase, baseSha: string): string => item.prompt.replaceAll("{{BASE_SHA}}", baseSha);

const forbiddenOutputPart = (part: string): boolean => {
  const lower = part.toLowerCase();
  return lower === "phase1" || lower === "phase1-3-evidence" || lower === "phase1-2-evidence" || lower === "phase1-1-evidence" || lower === "run6" || lower === "run11" || lower.startsWith("phase1-ab-artifacts") || lower.startsWith("phase1-1-ab-artifacts") || lower.startsWith("phase1-1-diagnostic") || lower.startsWith("phase1-2-ab-") || lower.startsWith("phase1-runtime-preflight") || /^phase1-(?:1|2)(?:-|$)/.test(lower);
};

export const assertFreshPhase13Output = (outputPath: string): string => {
  const resolved = path.resolve(outputPath);
  if (resolved.split(/[\\/]+/).some(forbiddenOutputPart)) throw new Error("Phase 1.3 output cannot target a sealed or historical evidence path");
  if (existsSync(resolved)) throw new Error("Phase 1.3 output already exists; refusing to reuse it");
  const parent = path.dirname(resolved);
  if (!existsSync(parent)) throw new Error("Phase 1.3 output parent must already exist");
  mkdirSync(resolved);
  return resolved;
};

export const assertPhase13OptIn = (env: Record<string, string | undefined> = process.env): { outputPath: string } => {
  if (env.RUN_PHASE1_3_RUNTIME !== "1") throw new Error("RUN_PHASE1_3_RUNTIME=1 is required for the Phase 1.3 runtime harness");
  if (!env.PHASE1_3_OUTPUT || env.PHASE1_3_OUTPUT.trim().length === 0) throw new Error("PHASE1_3_OUTPUT is required for the Phase 1.3 runtime harness");
  return { outputPath: assertFreshPhase13Output(env.PHASE1_3_OUTPUT) };
};

/**
 * Hashes repository content deterministically while excluding .git metadata.
 * Paths are UTF-8, relative to root, and use `/`; sorting is by JavaScript's
 * code-unit order (locale independent). Regular files hash raw bytes. Symlinks
 * are represented by their UTF-8 link target with an explicit marker; they are
 * never followed. This makes the policy deterministic and avoids platform
 * dependent link resolution.
 */
export const hashDirectory = (root: string): string => {
  const entries: Array<{ relative: string; digest: string; kind: "file" | "symlink" }> = [];
  const visit = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === ".git") continue;
      const child = path.join(current, entry.name);
      const childRelative = (relative ? `${relative}/${entry.name}` : entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isSymbolicLink()) entries.push({ relative: childRelative, kind: "symlink", digest: sha256Text(`symlink\0${readlinkSync(child)}`) });
      else if (entry.isFile()) entries.push({ relative: childRelative, kind: "file", digest: createHash("sha256").update(readFileSync(child)).digest("hex") });
    }
  };
  visit(root, "");
  entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  return sha256Text(entries.map((entry) => `${entry.kind}\0${entry.relative}\0${entry.digest}`).join("\n"));
};

export type EvidenceFileRecord = { path: string; bytes: number; sha256: string };

/** Lists the complete run evidence inventory, excluding only aggregate self-reference and Git metadata. */
export const collectEvidenceFiles = (root: string, excludedRelativePaths: readonly string[] = ["aggregate-manifest.json"]): EvidenceFileRecord[] => {
  const excluded = new Set(excludedRelativePaths.map((item) => path.normalize(item)));
  const files: EvidenceFileRecord[] = [];
  const visit = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const child = path.join(current, entry.name);
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile() && !excluded.has(path.normalize(childRelative))) {
        const content = readFileSync(child);
        files.push({ path: childRelative.replaceAll(path.sep, "/"), bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") });
      }
    }
  };
  visit(root, "");
  return files;
};

export type GitStatusReader = (_cwd: string) => Promise<string>;
export type GitDiffReader = (_cwd: string) => Promise<string>;
export type GitHeadReader = (_cwd: string) => Promise<string>;
export type FixtureIntegrity = { treeHash: string; gitStatus: string; gitDiff: string; headSha: string; headMatchesBaseSha: boolean; clean: boolean };

export const captureFixtureIntegrity = async (root: string, readGitStatus: GitStatusReader, readGitDiff: GitDiffReader = async () => "", readGitHead: GitHeadReader = async () => "", expectedBaseSha?: string): Promise<FixtureIntegrity> => {
  const gitStatus = await readGitStatus(root);
  const gitDiff = await readGitDiff(root);
  const headSha = await readGitHead(root);
  const headMatchesBaseSha = expectedBaseSha === undefined || headSha.trim() === expectedBaseSha;
  return { treeHash: hashDirectory(root), gitStatus, gitDiff, headSha, headMatchesBaseSha, clean: gitStatus.trim().length === 0 && gitDiff.trim().length === 0 && headMatchesBaseSha };
};

export type TransportObservation = {
  parserVersion: string;
  reconnectCount: number;
  fallbackCount: number;
  status: "CLEAN" | "DEGRADED" | "FAILED" | "UNKNOWN";
  evidence: Array<{ signal: "reconnect" | "fallback"; line: number; hash: string; text: string }>;
};

const transportLines = (text: string): string[] => text.split(/\r?\n/);

/** Parses explicit CLI log language only; duration is never used as a signal. */
export const parseTransportObservation = (stdout: string, stderr: string, runtimeFailed = false): TransportObservation => {
  const evidence: TransportObservation["evidence"] = [];
  let reconnectCount = 0;
  let fallbackCount = 0;
  const lines = [...transportLines(stdout), ...transportLines(stderr)];
  lines.forEach((text, index) => {
    if (/\breconnecting\b/i.test(text)) {
      reconnectCount += 1;
      evidence.push({ signal: "reconnect", line: index + 1, hash: sha256Text(text), text: text.slice(-512) });
    }
    if (/(?:websocket[^\r\n]*https[^\r\n]*(?:fallback|falling back)|websocket[^\r\n]*(?:fallback|falling back)[^\r\n]*https|(?:fallback|falling back)[^\r\n]*https)/i.test(text)) {
      fallbackCount += 1;
      evidence.push({ signal: "fallback", line: index + 1, hash: sha256Text(text), text: text.slice(-512) });
    }
  });
  return { parserVersion: PHASE13_PARSER_VERSION, reconnectCount, fallbackCount, status: runtimeFailed ? "FAILED" : reconnectCount + fallbackCount > 0 ? "DEGRADED" : "CLEAN", evidence };
};

export type ProtocolValidation = { valid: boolean; schemaValid: boolean; semanticValid: boolean; issues: string[]; spec: TaskSpec | null };

/**
 * Detect affirmative mutation/orchestration language.  Architect prompts are
 * intentionally full of negations ("do not edit", "no Worker"); matching a
 * bare keyword therefore creates false semantic failures.  A keyword is
 * ignored when its local clause is explicitly negated.
 */
const affirmativeIntent = (text: string, pattern: RegExp): boolean => {
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 100), match.index ?? 0);
    if (!/(?:\b(?:no|not|never|without|avoid|禁止|不要|不得|不)\b|\bdo\s+not\b|\bmust\s+not\b|\bshould\s+not\b|\bdoes\s+not\b)[^.!?]{0,42}$/i.test(before)) return true;
  }
  return false;
};

const writeIntent = (text: string): boolean =>
  affirmativeIntent(text, /\b(?:edit|modify|delete|remove|rename|commit|push|merge|reset|checkout|add)\b/gi) ||
  affirmativeIntent(text, /\b(?:invoke|use|delegate|start|spawn|run)\s+(?:a\s+)?(?:Worker|worker|Router|Orchestrator|worktree)\b/gi) ||
  affirmativeIntent(text, /\b(?:write|create)\s+(?:the\s+|a\s+|any\s+)?(?:file|directory|branch|commit|worktree|repository)\b/gi);

const isAllowedReadOnlyGitCommand = (args: readonly string[]): boolean => {
  const [subcommand, ...rest] = args;
  if (subcommand === "status") return rest.every((arg) => ["--short", "--porcelain", "--branch"].includes(arg));
  if (subcommand === "diff") {
    if (rest[0] !== "--exit-code") return false;
    return rest.slice(1).every((arg) => arg.length > 0 && !/[;&|<>]/.test(arg));
  }
  if (subcommand === "rev-parse") return rest.length === 1 && ["HEAD", "--verify", "--show-toplevel"].includes(rest[0]);
  return false;
};

export const validateReadOnlyArchitectResponse = (value: unknown, item: RuntimeStabilityCase, baseSha: string, fixtureFiles: readonly string[]): ProtocolValidation => {
  const checked = validateTaskSpec(value);
  if (!checked.valid) return { valid: false, schemaValid: false, semanticValid: false, issues: checked.issues.map((issue) => `${issue.path}: ${issue.message}`), spec: null };
  const spec = checked.value;
  const issues: string[] = [];
  if (spec.task_id !== item.id) issues.push(`task_id must be ${item.id}`);
  if (spec.base_sha !== baseSha) issues.push("base_sha does not match frozen fixture SHA");
  const allowedContext = new Set(fixtureFiles);
  for (const contextPath of spec.context_paths) if (![...allowedContext].some((known) => contextPath === known || known.startsWith(`${contextPath}/`) || contextPath.startsWith(`${known}/`))) issues.push(`context path is outside frozen fixture: ${contextPath}`);
  for (const requiredPath of item.contextPaths) if (!spec.context_paths.some((actual) => actual === requiredPath || actual.startsWith(`${requiredPath}/`) || requiredPath.startsWith(`${actual}/`))) issues.push(`missing preregistered context path: ${requiredPath}`);
  const text = JSON.stringify({ title: spec.title, goal: spec.goal, criteria: spec.acceptance_criteria, commands: spec.test_commands, reasons: spec.execution_policy.recommendation_reasons });
  if (writeIntent(text)) issues.push("TaskSpec contains write or orchestration intent");
  if (spec.test_commands.some((command) => command.program === "git" ? !isAllowedReadOnlyGitCommand(command.args) : command.args.some((arg) => /[;&|<>]|(?:commit|push|reset|checkout|add|rm|mv|touch)/i.test(arg)))) issues.push("TaskSpec test command has write-capable intent");
  return { valid: issues.length === 0, schemaValid: true, semanticValid: issues.length === 0, issues, spec };
};

export type RuntimeFailureClass = "none" | "preflight" | "transport/runtime" | "user" | "model/auth/quota" | "task-protocol/schema" | "write/integrity" | "unclassified";

export type RuntimeSample = {
  id: string;
  order: number;
  complete: boolean;
  durationMs: number | null;
  protocolValid: boolean;
  semanticValid: boolean;
  integrityValid: boolean;
  transport: TransportObservation;
  failureCode: string | null;
  failureClass: RuntimeFailureClass;
  fatal: boolean;
  retryCount: number;
  humanIntervention: boolean;
  usage: RuntimeUsage | null;
  artifactHashes: Record<string, string | null>;
};

export const classifyRuntimeFailure = (code: string | null, kind: "preflight" | "transport" | "protocol" | "write" | "user" | "none" = "none"): { failureClass: RuntimeFailureClass; fatal: boolean } => {
  if (!code || kind === "none") return { failureClass: "none", fatal: false };
  if (kind === "write") return { failureClass: "write/integrity", fatal: true };
  if (kind === "protocol") return { failureClass: "task-protocol/schema", fatal: true };
  if (kind === "preflight") return { failureClass: "preflight", fatal: true };
  if (kind === "user") return { failureClass: "user", fatal: true };
  const classification: FailureClassification = classifyFailureCode(code as ErrorCode);
  if (code === ERROR_CODES.CLI_NOT_AUTHENTICATED || code === ERROR_CODES.MODEL_UNAVAILABLE || code === ERROR_CODES.QUOTA_EXHAUSTED) return { failureClass: "model/auth/quota", fatal: true };
  if (classification.domain === "runtime") return { failureClass: "transport/runtime", fatal: true };
  return { failureClass: "unclassified", fatal: true };
};

export type RuntimeDecision = {
  status: "PASS" | "PARTIAL" | "FAIL" | "BLOCKED";
  transport: "CLEAN" | "DEGRADED" | "FAILED" | "UNKNOWN";
  product: "NOT_EVALUATED";
  completed: number;
  fatalCount: number;
  degradedEvents: number;
  longRequests: number;
  reason: string;
};

export const evaluateRuntimeStability = (input: { preflightPassed: boolean; samples: readonly RuntimeSample[]; stopped?: boolean; evidenceValid?: boolean }): RuntimeDecision => {
  const completed = input.samples.filter((sample) => sample.complete).length;
  const fatalCount = input.samples.filter((sample) => sample.fatal).length;
  const degradedEvents = input.samples.reduce((total, sample) => total + sample.transport.reconnectCount + sample.transport.fallbackCount, 0);
  const longRequests = input.samples.filter((sample) => (sample.durationMs ?? 0) > 600_000).length;
  const failedTransport = input.samples.some((sample) => sample.failureClass === "transport/runtime" || sample.transport.status === "FAILED");
  const transport = !input.preflightPassed || failedTransport ? "FAILED" : degradedEvents > 0 ? "DEGRADED" : input.samples.every((sample) => sample.transport.parserVersion === PHASE13_PARSER_VERSION) ? "CLEAN" : "UNKNOWN";
  if (!input.preflightPassed) return { status: "BLOCKED", transport, product: "NOT_EVALUATED", completed, fatalCount, degradedEvents, longRequests, reason: "runtime preflight failed" };
  if (input.evidenceValid === false) return { status: "BLOCKED", transport: "UNKNOWN", product: "NOT_EVALUATED", completed, fatalCount, degradedEvents, longRequests, reason: "evidence integrity failed" };
  if (input.stopped || completed < PHASE13_SAMPLE_COUNT) return { status: "BLOCKED", transport, product: "NOT_EVALUATED", completed, fatalCount, degradedEvents, longRequests, reason: "fewer than ten complete samples or global stop" };
  if (fatalCount > 0 || input.samples.some((sample) => !sample.protocolValid || !sample.semanticValid || !sample.integrityValid) || input.samples.some((sample) => (sample.durationMs ?? 0) > 900_000)) return { status: "FAIL", transport, product: "NOT_EVALUATED", completed, fatalCount, degradedEvents, longRequests, reason: "fatal, protocol, integrity, or over-timeout failure" };
  if (degradedEvents > 1 || longRequests > 1) return { status: "FAIL", transport, product: "NOT_EVALUATED", completed, fatalCount, degradedEvents, longRequests, reason: "more than one degraded event or long request" };
  if (degradedEvents === 1 || longRequests === 1) return { status: "PARTIAL", transport, product: "NOT_EVALUATED", completed, fatalCount, degradedEvents, longRequests, reason: "one allowed degraded event or 600-900 second request" };
  return { status: "PASS", transport, product: "NOT_EVALUATED", completed, fatalCount, degradedEvents, longRequests, reason: "ten clean, complete, protocol-valid read-only requests" };
};

export const shouldStopRuntimeRun = (samples: readonly RuntimeSample[], latest?: RuntimeSample): { stop: boolean; reason?: string } => {
  if (!latest) return { stop: false };
  if (!latest.integrityValid || latest.failureClass === "write/integrity") return { stop: true, reason: "fixture evidence integrity or write attempt failed" };
  if (["model/auth/quota", "user", "preflight"].includes(latest.failureClass)) return { stop: true, reason: `global stop class: ${latest.failureClass}` };
  if (samples.filter((sample) => sample.fatal).length >= 2) return { stop: true, reason: "two fatal samples" };
  return { stop: false };
};

export const writeJsonAtomic = (target: string, value: unknown): void => {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
};

export const removeRuntimeFixture = (fixturePath: string): void => { if (fixturePath && existsSync(fixturePath)) rmSync(fixturePath, { recursive: true, force: true }); };
