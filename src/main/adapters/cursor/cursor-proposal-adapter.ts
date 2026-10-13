import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { parseCursorProposalTrace } from "../../../shared/core/cursor-proposal-trace.js";
import { validateWorkerProposalRequest, type ChangeSet, type WorkerProposalRequest } from "../../../shared/core/worker-proposal.js";
import { classifyFailureCode, classifyProcessResult } from "../../../shared/core/failure-taxonomy.js";
import { ERROR_CODES } from "../../../shared/core/errors.js";
import { AgentOutputError, AgentRunError, type AgentExecution } from "../agent-adapter.js";
import { minimalEnvironment, type ProcessResult } from "../../process/runner.js";
import { prepareCursorProposalFixture } from "./cursor-context-transfer.js";

const execFileAsync = promisify(execFile);
const WSL = "C:\\Windows\\System32\\wsl.exe";
const PREFIX = ["--distribution", "Ubuntu", "--user", "agentplatform"];
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const KILL_AFTER_MS = 10_000;
const RUNTIME_PIN = {
  wsl: "1dd643e4e84c251c324e26e47f35fd6614461d79f7833d084fec519013e0ecc8",
  wrapper: "2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233",
  entry: "45d9b1df85d0165cb2e690f96fa5fbe4b59e8a71ddd22176a301ba7e5b18a0b9",
  node: "e0e46d3a1c0667117303412647cafcbcefb1be7612493015ec8fd6b7440162a4"
} as const;
const WRAPPER = `
import os,subprocess,sys
p=subprocess.Popen(sys.argv[1:],start_new_session=True)
print('AP_PGID:'+str(os.getpgid(p.pid)),file=sys.stderr,flush=True)
code=p.wait()
raise SystemExit(128-code if code<0 else code)`;
const INSPECT = `
import hashlib,json,os,pathlib,stat,sys
r=pathlib.Path(sys.argv[1]); c=r/'context.json'; s=r/'.cursor/sandbox.json'
print(json.dumps({'uid':os.getuid(),'files':sorted(str(p.relative_to(r)) for p in r.rglob('*') if p.is_file()),
 'owners':[p.stat().st_uid for p in (r,r/'.cursor',s,c)],
 'modes':[oct(stat.S_IMODE(p.stat().st_mode)) for p in (r,r/'.cursor',s,c)],
 'context':hashlib.sha256(c.read_bytes()).hexdigest(),
 'config':hashlib.sha256(s.read_bytes()).hexdigest(),
 'wsl':hashlib.sha256(pathlib.Path('/etc/wsl.conf').read_bytes()).hexdigest(),
 'wrapper':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/bin/agent').read_bytes()).hexdigest(),
 'entry':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/share/cursor-agent/versions/2026.09.28-64d2043/index.js').read_bytes()).hexdigest(),
 'node':hashlib.sha256(pathlib.Path('/home/agentplatform/.local/share/cursor-agent/versions/2026.09.28-64d2043/node').read_bytes()).hexdigest(),
 'mounts':any(os.path.ismount(p) for p in ('/mnt/c','/mnt/e')),
 'interop':pathlib.Path('/proc/sys/fs/binfmt_misc/WSLInterop').exists()}))`;
const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const windowsEnv = (): Record<string, string> => Object.fromEntries(
  Object.entries(minimalEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === "string")
);

async function probe(args: string[], accepted = [0]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await execFileAsync(WSL, args, { shell: false, windowsHide: true, env: windowsEnv(), timeout: 20_000, maxBuffer: 64 * 1024 });
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string };
    if (typeof failure.code === "number" && accepted.includes(failure.code)) {
      return { stdout: failure.stdout ?? "", exitCode: failure.code };
    }
    throw new Error("CURSOR_WSL_PROBE_FAILED", { cause: error });
  }
}

async function inspectFixture(workspace: string, contextSha256: string): Promise<void> {
  const result = await probe([...PREFIX, "--exec", "/usr/bin/python3", "-c", INSPECT, workspace]);
  let value: unknown;
  try { value = JSON.parse(result.stdout.trim()) as unknown; } catch { throw new Error("CURSOR_FIXTURE_INSPECTION_INVALID"); }
  const item = value as Record<string, unknown>;
  if (item.uid !== 1000 || JSON.stringify(item.files) !== JSON.stringify([".cursor/sandbox.json", "context.json"]) ||
      JSON.stringify(item.owners) !== JSON.stringify([0, 0, 0, 0]) ||
      JSON.stringify(item.modes) !== JSON.stringify(["0o555", "0o555", "0o444", "0o444"]) ||
      item.context !== contextSha256 ||
      item.config !== sha('{"type":"workspace_readonly","networkPolicy":{"default":"deny"}}\n') ||
      item.wsl !== RUNTIME_PIN.wsl || item.wrapper !== RUNTIME_PIN.wrapper ||
      item.entry !== RUNTIME_PIN.entry || item.node !== RUNTIME_PIN.node ||
      item.mounts !== false || item.interop !== false) {
    throw new Error("CURSOR_FIXTURE_DRIFT");
  }
}

async function noResidual(workspace: string): Promise<boolean> {
  const result = await probe([...PREFIX, "--exec", "/usr/bin/pgrep", "-f", workspace], [0, 1]);
  return result.exitCode === 1;
}

async function preflightAccount(): Promise<void> {
  const version = await probe([...PREFIX, "--exec", "/home/agentplatform/.local/bin/agent", "--version"]);
  if (!version.stdout.includes("2026.09.28-64d2043")) throw new Error("CURSOR_VERSION_DRIFT");
  const status = await probe([...PREFIX, "--exec", "/usr/bin/env", "-u", "CURSOR_API_KEY", "-u", "CURSOR_API_ENDPOINT",
    "/home/agentplatform/.local/bin/agent", "status"]);
  if (!/logged in/i.test(status.stdout)) throw new Error("CURSOR_NOT_LOGGED_IN");
}

async function signalGroup(pgid: number, signal: "TERM" | "KILL"): Promise<void> {
  await probe([...PREFIX, "--exec", "/usr/bin/kill", `-${signal}`, "--", `-${pgid}`], [0, 1]);
}

export const buildCursorProposalPrompt = (): string =>
  "Read only context.json in this workspace. It contains a WorkerProposalRequest. Return exactly one compact ChangeSet JSON object and no other text. Required top-level keys: schema_version, task_id, base_sha, task_spec_sha256, status, summary, operations, acceptance_notes, risks, blocker. Copy schema_version as 1.0 and copy task_id, base_sha and task_spec_sha256 exactly from the request. Set status to completed when you can satisfy the goal; otherwise use blocked with no operations and a nonempty blocker. For every operation use exactly type, path, expected_sha256, content. type is create_file or replace_file. For replace_file copy the context file sha256 as expected_sha256 and provide the complete new UTF-8 content. For create_file use null expected_sha256. Use only allowed paths and respect limits. Give each acceptance criterion one acceptance_notes entry with criterion_id and note. Set risks to an array and blocker to null when completed. Do not use the keys op or acceptance_criteria. Do not use a shell, write files, delegate, or access another path. No Markdown.";

export type CursorProposalInput = {
  request: WorkerProposalRequest;
  runDirectory: string;
  runId: string;
  timeoutSeconds: number;
  outputPath: string;
  onSpawn?: (_pid: number | null) => void;
  onOutput?: (_stream: "stdout" | "stderr", _atMs: number, _bytes: number) => void;
};

type ActiveRun = { cancel: () => void };
const activeRuns = new Map<string, ActiveRun>();
export const cancelActiveCursorProposal = (runId: string): boolean => {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.cancel();
  return true;
};

export async function runCursorProcess(
  input: CursorProposalInput,
  workspace: string,
  linuxOverride?: string[]
): Promise<{ result: ProcessResult; fullStdout: string }> {
  const { spawn } = await import("node:child_process");
  if (activeRuns.has(input.runId)) throw new Error("CURSOR_RUN_ID_ACTIVE");
  mkdirSync(input.runDirectory, { recursive: true });
  const stdoutPath = path.join(input.runDirectory, "stdout.log");
  const stderrPath = path.join(input.runDirectory, "stderr.log");
  writeFileSync(stdoutPath, "", { flag: "wx" });
  writeFileSync(stderrPath, "", { flag: "wx" });
  const started = Date.now();
  const prompt = buildCursorProposalPrompt();
  const linux = linuxOverride ?? ["/usr/bin/timeout", "--signal=TERM", "--kill-after=10s", `${input.timeoutSeconds}s`,
    "/usr/bin/env", "-u", "CURSOR_API_KEY", "-u", "CURSOR_API_ENDPOINT", "/home/agentplatform/.local/bin/agent",
    "--print", "--mode", "ask", "--sandbox", "enabled", "--output-format", "stream-json", "--model", "auto",
    "--workspace", workspace, "--trust", prompt];
  const args = [...PREFIX, "--cd", workspace, "--exec", "/usr/bin/python3", "-c", WRAPPER, ...linux];
  const child = spawn(WSL, args, { shell: false, windowsHide: true, env: windowsEnv(), stdio: ["ignore", "pipe", "pipe"] });
  try { input.onSpawn?.(child.pid ?? null); } catch (error) {
    try { child.kill(); } catch { /* callback failure is authoritative */ }
    throw error;
  }
  let pgid: number | null = null;
  const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
  let stderrPrefix = "";
  let stdoutBytes = 0, stderrBytes = 0, cancelled = false, timedOut = false, outputLimit = false, launchError = false;
  let stopRequested = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = (reason: "CANCELLED" | "TIMED_OUT" | "OUTPUT_LIMIT"): void => {
    if (stopRequested) return;
    stopRequested = true;
    cancelled = reason === "CANCELLED";
    timedOut = reason === "TIMED_OUT";
    outputLimit = reason === "OUTPUT_LIMIT";
    if (pgid !== null) void signalGroup(pgid, "TERM").catch(() => undefined);
    forceTimer = setTimeout(() => {
      if (pgid !== null) void signalGroup(pgid, "KILL").catch(() => undefined);
      try { child.kill(); } catch { /* reported through convergence check */ }
    }, KILL_AFTER_MS);
  };
  activeRuns.set(input.runId, { cancel: () => stop("CANCELLED") });
  const capture = (kind: "stdout" | "stderr", chunk: Buffer): void => {
    const next = (kind === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
    if (kind === "stdout") stdoutBytes = next; else stderrBytes = next;
    if (next > MAX_STREAM_BYTES) { stop("OUTPUT_LIMIT"); return; }
    appendFileSync(kind === "stdout" ? stdoutPath : stderrPath, chunk);
    input.onOutput?.(kind, Date.now(), chunk.length);
    if (kind === "stdout") stdoutChunks.push(chunk);
    else {
      stderrChunks.push(chunk);
      stderrPrefix += chunk.toString("utf8");
      const match = /AP_PGID:(\d+)\r?\n/.exec(stderrPrefix);
      if (match && pgid === null) { pgid = Number(match[1]); if (stopRequested) void signalGroup(pgid, "TERM").catch(() => undefined); }
      if (stderrPrefix.length > 1024) stderrPrefix = stderrPrefix.slice(-1024);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  const timer = setTimeout(() => stop("TIMED_OUT"), (input.timeoutSeconds + 20) * 1000);
  const closed = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once("error", () => { launchError = true; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  activeRuns.delete(input.runId);
  const stdoutBytesRaw = Buffer.concat(stdoutChunks);
  const stderrBytesRaw = Buffer.concat(stderrChunks);
  const stdout = stdoutBytesRaw.toString("utf8");
  const stderr = stderrBytesRaw.toString("utf8");
  const converged = await noResidual(workspace).catch(() => false);
  const status: ProcessResult["status"] = launchError ? "START_FAILED" : !converged || pgid === null ? "FAILED" : cancelled ? "CANCELLED" :
    timedOut || closed.code === 124 || closed.code === 137 ? "TIMED_OUT" :
      outputLimit || closed.code !== 0 ? "FAILED" : "SUCCEEDED";
  const result: ProcessResult = { exitCode: closed.code, status, stdout: stdout.slice(-65536), stderr: stderr.slice(-65536),
    stdoutSha256: sha(stdoutBytesRaw), stderrSha256: sha(stderrBytesRaw), durationMs: Date.now() - started, pid: child.pid ?? null,
    closeObserved: true, startedAtMs: started, endedAtMs: Date.now() };
  return { result, fullStdout: stdout };
}

export class CursorProposalAdapter {
  readonly id = "cursor-proposal";

  async runProposal(input: CursorProposalInput): Promise<AgentExecution<ChangeSet>> {
    const checked = validateWorkerProposalRequest(input.request);
    if (!checked.valid) throw new Error(`CURSOR_PROPOSAL_REQUEST_INVALID:${checked.issues.map(issue => issue.path).join(",")}`);
    if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 600) {
      throw new Error("CURSOR_TIMEOUT_INVALID");
    }
    await preflightAccount();
    const fixture = await prepareCursorProposalFixture(checked.value);
    await inspectFixture(fixture.workspace, fixture.contextSha256);
    if (!await noResidual(fixture.workspace)) throw new Error("CURSOR_RESIDUAL_PROCESS");
    const { result, fullStdout } = await runCursorProcess(input, fixture.workspace);
    const fixtureSafe = await inspectFixture(fixture.workspace, fixture.contextSha256).then(() => true, () => false);
    if (!fixtureSafe || !await noResidual(fixture.workspace)) {
      throw new AgentRunError("CURSOR_FIXTURE_OR_PROCESS_DRIFT", { ...result, status: "FAILED" }, classifyFailureCode(ERROR_CODES.MODEL_RUNTIME_FAILED));
    }
    if (result.status !== "SUCCEEDED") {
      throw new AgentRunError("CURSOR_PROCESS_FAILED", result,
        classifyProcessResult(result) ?? classifyFailureCode(ERROR_CODES.MODEL_RUNTIME_FAILED));
    }
    try {
      const trace = parseCursorProposalTrace(fullStdout, checked.value, fixture.workspace);
      writeFileSync(input.outputPath, `${JSON.stringify(trace.changeSet, null, 2)}\n`, { flag: "wx" });
      return { output: trace.changeSet, process: result, usage: {
        inputTokens: trace.inputTokens, outputTokens: trace.outputTokens,
        totalTokens: trace.inputTokens === null || trace.outputTokens === null ? null : trace.inputTokens + trace.outputTokens,
        cachedInputTokens: trace.cachedInputTokens
      } };
    } catch (error) {
      throw new AgentOutputError("CURSOR_CHANGE_SET_INVALID", result,
        classifyFailureCode(ERROR_CODES.OUTPUT_SCHEMA_INVALID), { cause: error });
    }
  }
}
