import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import type { AgentExecution, PlannerAgentAdapter, PlannerInput } from "../../src/main/adapters/agent-adapter.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";
import { validateTaskSpec } from "../../src/shared/core/task-spec.js";
import { readBoundedContext } from "../../src/shared/core/bounded-context.js";
import { parseCodexTerminalEvents } from "../../src/shared/core/codex-terminal-events.js";
import { parseTransportObservation } from "../../src/shared/core/runtime-stability.js";
import type { BoundedRuntimeSample } from "../../src/shared/core/bounded-runtime-certification.js";
import type { CaseRegistration } from "./phase1-6-runtime-certification.js";

const execFileAsync = promisify(execFile);
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const sha256File = async (filePath: string): Promise<string> => createHash("sha256").update(await readFile(filePath)).digest("hex");
const redactError = (value: string): string => value
  .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
  .replace(/(authorization\s*[:=]\s*|bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
  .replace(/((?:api[_-]?key|token|cookie|password|passwd|secret|credential)\s*[:=]\s*)[^\s,;&]+/gi, "$1[REDACTED]")
  .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]@")
  .replace(/(https?:\/\/[^\s/@]+)@/gi, "$1[REDACTED]@");

type GitSnapshot = { sha: string; tree: string; status: string; diff: string };
export type Phase16ExecutorOptions = {
  adapter?: PlannerAgentAdapter;
  program?: string;
  schemaPath?: string;
  fixtureRoot?: string;
  repoForCase?: (_item: CaseRegistration) => string;
  now?: () => number;
  hashOnly?: boolean;
};

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync("git", args, { cwd, shell: false, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
};
const snapshot = async (cwd: string): Promise<GitSnapshot> => ({
  sha: await git(cwd, ["rev-parse", "HEAD"]),
  tree: await git(cwd, ["rev-parse", "HEAD^{tree}"]),
  status: await git(cwd, ["status", "--porcelain=v1"]),
  diff: await git(cwd, ["diff", "--no-ext-diff", "--binary"]),
});
const converged = (process: NonNullable<AgentExecution<unknown>["process"]>): boolean =>
  Boolean(process.closeObserved && (process.stdoutClosed || process.stdoutDestroyed) && (process.stderrClosed || process.stderrDestroyed));
const cleanupDuration = (process: NonNullable<AgentExecution<unknown>["process"]>): number => {
  if (!process.termination) return 0;
  const requested = process.termination.taskkill.map((item) => item.requestedAtMs).filter((value): value is number => typeof value === "number");
  if (requested.length === 0 || typeof process.endedAtMs !== "number") return process.termination.settledWithoutClose ? 10_001 : 0;
  return Math.max(0, process.endedAtMs - Math.min(...requested));
};

export async function verifyPhase16CaseArtifacts(outputPath: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(outputPath, "case-artifact-manifest.json"), "utf8")) as { version?: unknown; caseId?: unknown; baseSha?: unknown; baseTree?: unknown; artifacts?: unknown; stdoutSha256?: unknown; stderrSha256?: unknown };
    if (manifest.version !== "phase1.6-case-artifacts.v1" || typeof manifest.caseId !== "string" || !/^[0-9a-f]{40}$/.test(String(manifest.baseSha)) || !/^[0-9a-f]{40}$/.test(String(manifest.baseTree)) || !/^[0-9a-f]{64}$/.test(String(manifest.stdoutSha256)) || !/^[0-9a-f]{64}$/.test(String(manifest.stderrSha256)) || !manifest.artifacts || typeof manifest.artifacts !== "object") return false;
    const artifacts = manifest.artifacts as Record<string, unknown>;
    const names = Object.keys(artifacts);
    if (names.length !== 2 || !names.includes("task-spec.json") || !names.includes("execution-evidence.json") || names.some((name) => !["task-spec.json", "execution-evidence.json"].includes(name) || typeof artifacts[name] !== "string" || !/^[0-9a-f]{64}$/.test(artifacts[name] as string))) return false;
    for (const name of names) if (await sha256File(path.join(outputPath, name)) !== artifacts[name]) return false;
    const evidence = JSON.parse(await readFile(path.join(outputPath, "execution-evidence.json"), "utf8")) as { stdoutSha256?: unknown; stderrSha256?: unknown };
    return evidence.stdoutSha256 === manifest.stdoutSha256 && evidence.stderrSha256 === manifest.stderrSha256;
  } catch { return false; }
}

const semanticIssues = (spec: TaskSpec, item: CaseRegistration): string[] => {
  const issues: string[] = [];
  if (spec.task_id !== item.id) issues.push("task_id");
  if (spec.base_sha !== item.baseSha) issues.push("base_sha");
  const required = new Set(item.contextPaths);
  if (spec.context_paths.some((p) => p === "**/*" || p.includes("\\") || p.split("/").includes(".."))) issues.push("unsafe_context_path");
  if ([...required].some((p) => !spec.context_paths.some((actual) => actual === p || actual.startsWith(`${p}/`) || p.startsWith(`${actual}/`)))) issues.push("context_paths");
  if (!spec.scope.forbidden_paths.includes("**/*")) issues.push("forbidden_scope_must_be_all");
  if (spec.test_commands.some((command) => {
    if (command.program !== "git") return true;
    if (command.args.length === 2 && command.args[0] === "rev-parse") return !["HEAD", "--verify", "--show-toplevel"].includes(command.args[1]);
    if (command.args[0] === "status") return !command.args.slice(1).every((arg) => ["--short", "--porcelain", "--branch", "--porcelain=v1"].includes(arg) || /^--porcelain(?:=v[0-9]+)?$/.test(arg));
    if (command.args[0] === "diff") return !(command.args[1] === "--exit-code" && command.args.slice(2).every((arg) => !/[;&|<>]/.test(arg)));
    return true;
  })) issues.push("unsafe_test_command");
  return issues;
};

const emptySample = (item: CaseRegistration, order: number): BoundedRuntimeSample => ({
  id: item.id, order, durationMs: null, cleanupDurationMs: null, authoritativeTerminal: false,
  accountAvailable: false, protocolValid: false, transportClean: false, schemaValid: false, semanticValid: false,
  fixtureClean: false, baseShaValid: false, processConverged: false, stdioConverged: false, hashesValid: false,
  retryCount: 0, humanIntervention: false, usageAvailable: false,
});

/** Creates the bounded Phase 1.6 executor. The default adapter is production CodexAdapter; tests should inject a fake. */
export function createPhase16CaseExecutor(options: Phase16ExecutorOptions = {}): (_item: CaseRegistration, _outputPath: string) => Promise<BoundedRuntimeSample> {
  const adapter = options.adapter ?? new CodexAdapter(options.program ?? "codex");
  const schemaPath = options.schemaPath ?? path.resolve(process.cwd(), "schemas/task-spec.schema.json");
  const now = options.now ?? (() => Date.now());
  const hashOnly = options.hashOnly ?? true;
  return async (item, outputPath): Promise<BoundedRuntimeSample> => {
    const started = now();
    const sample = emptySample(item, Number(item.id.slice(-2)));
    let before: GitSnapshot | undefined;
    let after: GitSnapshot | undefined;
    let execution: AgentExecution<TaskSpec> | undefined;
    let processResult: AgentExecution<TaskSpec>["process"] | undefined;
    let caughtError: unknown;
    const repo = (item as CaseRegistration & { repo?: string }).repo ?? options.repoForCase?.(item) ?? (options.fixtureRoot ? path.join(options.fixtureRoot, item.id, "repo") : outputPath);
    try {
      before = await snapshot(repo);
      const context = readBoundedContext(repo, item.contextPaths);
      const prompt = `${item.prompt}\n\nBounded context (read-only; do not modify files):\n${context.items.map((entry) => `--- ${entry.path} ---\n${entry.content}`).join("\n")}`;
      const input: PlannerInput = { cwd: repo, model: "gpt-5.6-sol", reasoning: "medium", timeoutSeconds: 300, schemaPath, outputPath: path.join(outputPath, "task-spec.json"), prompt, hashOnlyLogs: hashOnly, runId: `phase16-${item.id}` };
      execution = await adapter.runPlanner(input);
      processResult = execution.process;
    } catch (error) {
      caughtError = error;
      processResult = (error as { result?: AgentExecution<TaskSpec>["process"] }).result;
      if (!processResult) processResult = (error as { process?: AgentExecution<TaskSpec>["process"] }).process;
    }
    try { after = await snapshot(repo); } catch { /* preserve failure evidence */ }
    const process = processResult;
    const stdout = process?.stdout ?? "";
    const stderr = process?.stderr ?? "";
    const events = parseCodexTerminalEvents(stdout);
    const transport = parseTransportObservation(stdout, stderr, Boolean(process && process.status !== "SUCCEEDED"));
    const safeTransport = { ...transport, evidence: transport.evidence.map((entry) => ({ ...entry, text: redactError(entry.text) })) };
    const checked = execution ? validateTaskSpec(execution.output) : { valid: false as const, issues: [] };
    const issues = checked.valid ? semanticIssues(checked.value, item) : ["schema"];
    // semantic diagnostics are retained in the booleans below; no model explanation is used.
    const contextHash = (() => { try { return readBoundedContext(repo, item.contextPaths).sha256; } catch { return ""; } })();
    const schemaHash = await readFile(schemaPath, "utf8").then(sha256).catch(() => "");
    const fixtureClean = Boolean(before && after && after.status === before.status && after.diff === before.diff && after.sha === before.sha && after.tree === before.tree && after.status === "");
    sample.durationMs = process?.durationMs ?? Math.max(0, now() - started);
    sample.cleanupDurationMs = process ? cleanupDuration(process) : Math.max(0, now() - started);
    sample.authoritativeTerminal = process?.status === "SUCCEEDED" && events.some((e) => e.kind === "completed") && !events.some((e) => e.kind === "failed" || e.kind === "malformed");
    sample.accountAvailable = process?.status !== "START_FAILED" && !/(?:quota|unauthori[sz]ed|authentication|login required|account unavailable|not logged in)/i.test(`${process?.stderr ?? ""}\n${process?.stdout ?? ""}`);
    sample.protocolValid = sample.authoritativeTerminal;
    sample.transportClean = transport.status === "CLEAN";
    sample.schemaValid = checked.valid;
    sample.semanticValid = checked.valid && issues.length === 0;
    sample.fixtureClean = fixtureClean;
    sample.baseShaValid = Boolean(before && after && before.sha === item.baseSha && after.sha === item.baseSha && before.tree === item.baseTree && after.tree === item.baseTree);
    sample.processConverged = Boolean(process && converged(process));
    sample.stdioConverged = Boolean(process && (process.stdoutClosed || process.stdoutDestroyed) && (process.stderrClosed || process.stderrDestroyed));
    sample.hashesValid = false;
    sample.usageAvailable = execution?.usage !== null && execution?.usage !== undefined;
    const safeError = caughtError instanceof Error ? { name: caughtError.name, message: redactError(caughtError.message).slice(0, 1000) } : caughtError === undefined ? null : { name: "UnknownError", message: redactError(String(caughtError)).slice(0, 1000) };
    const evidence = {
      id: item.id, process: process ? { status: process.status, exitCode: process.exitCode, durationMs: process.durationMs, pid: process.pid ?? null, termination: process.termination ?? null, closeObserved: process.closeObserved ?? false, stdoutClosed: process.stdoutClosed ?? false, stderrClosed: process.stderrClosed ?? false, stdoutDestroyed: process.stdoutDestroyed ?? false, stderrDestroyed: process.stderrDestroyed ?? false } : null,
      stdoutSha256: process?.stdoutSha256 ?? null, stderrSha256: process?.stderrSha256 ?? null,
      terminalEvents: events.map((event) => ({ kind: event.kind, error: event.error ? redactError(event.error) : null, usage: event.usage ?? null })), transport: safeTransport,
      schema: { valid: checked.valid, issues: checked.valid ? [] : checked.issues }, semantic: { valid: checked.valid && issues.length === 0, issues },
      fixture: { before: before ?? null, after: after ?? null }, hashes: { context: { expected: item.contextHash, actual: contextHash }, prompt: { expected: item.promptHash, actual: sha256(item.prompt) }, schema: { expected: item.authoritativeSchemaHash, actual: schemaHash }, baseSha: { expected: item.baseSha, before: before?.sha ?? null, after: after?.sha ?? null }, baseTree: { expected: item.baseTree, before: before?.tree ?? null, after: after?.tree ?? null } },
      usage: { available: sample.usageAvailable, value: execution?.usage ?? null }, error: safeError,
    };
    await mkdir(outputPath, { recursive: true });
    const resultPath = path.join(outputPath, "task-spec.json");
    if (execution) { try { await stat(resultPath); } catch { /* missing adapter result remains invalid */ } }
    const evidencePath = path.join(outputPath, "execution-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const artifacts: Record<string, string> = {};
    for (const filePath of [resultPath, evidencePath]) {
      try { await stat(filePath); artifacts[path.basename(filePath)] = await sha256File(filePath); } catch { /* absent result is recorded as invalid */ }
    }
    const manifest = { version: "phase1.6-case-artifacts.v1", caseId: item.id, baseSha: item.baseSha, baseTree: item.baseTree, artifacts, stdoutSha256: process?.stdoutSha256 ?? sha256(stdout), stderrSha256: process?.stderrSha256 ?? sha256(stderr) };
    const manifestPath = path.join(outputPath, "case-artifact-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    sample.hashesValid = contextHash === item.contextHash && sha256(item.prompt) === item.promptHash && schemaHash === item.authoritativeSchemaHash && await verifyPhase16CaseArtifacts(outputPath);
    if (hashOnly) for (const logName of ["stdout.log", "stderr.log"]) { try { await unlink(path.join(outputPath, logName)); } catch { /* absent is expected */ } }
    return sample;
  };
}

export const createBoundedCodexCaseExecutor = createPhase16CaseExecutor;
