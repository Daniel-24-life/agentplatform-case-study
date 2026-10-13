import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { minimalEnvironment } from "../../process/runner.js";

export type AppServerClientOptions = {
  program: string;
  prefixArgs?: string[];
  proxyEnv?: Record<string, string>;
  lineLimitBytes?: number;
  outputLimitBytes?: number;
  timeoutMs?: number;
};

export type AppServerEvent = { method: string; params?: unknown };
export type AppServerProcessDiagnostics = {
  pid: number | null;
  closeObserved: boolean;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  terminationRequested: boolean;
  forceIssued: boolean;
};
export type AppServerResult = {
  threadId: string;
  turnId: string;
  terminal: unknown;
  events: AppServerEvent[];
  process: AppServerProcessDiagnostics;
};

const DEFAULT_LINE_LIMIT = 256 * 1024;
const DEFAULT_OUTPUT_LIMIT = 4 * DEFAULT_LINE_LIMIT;
const GRACEFUL_CLOSE_MS = 250;
const TERMINATION_GRACE_MS = 1_500;
const FORCE_SETTLE_MS = 500;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class CodexAppServerError extends Error {
  constructor(message: string) { super(message); this.name = "CodexAppServerError"; }
}

type PendingRequest = { resolve: (_value: unknown) => void; reject: (_error: Error) => void; timer: ReturnType<typeof setTimeout> };
type TerminalWaiter = { threadId: string; turnId: string; resolve: (_value: unknown) => void; reject: (_error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: AppServerEvent[] = [];
  private terminalWaiter: TerminalWaiter | undefined;
  private buffer = "";
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private nextId = 1;
  private closed = false;
  private closeObserved = false;
  private stdoutClosed = false;
  private stderrClosed = false;
  private terminationRequested = false;
  private forceIssued = false;
  private readonly options: Required<AppServerClientOptions>;

  constructor(options: AppServerClientOptions) {
    this.options = { prefixArgs: [], proxyEnv: {}, lineLimitBytes: DEFAULT_LINE_LIMIT, outputLimitBytes: DEFAULT_OUTPUT_LIMIT, timeoutMs: 120_000, ...options };
    if (!path.isAbsolute(this.options.program)) throw new CodexAppServerError("codex executable must be absolute");
    if (this.options.lineLimitBytes < 1 || this.options.outputLimitBytes < 1 || this.options.timeoutMs < 1) throw new CodexAppServerError("app-server limits must be positive");
  }

  getProcessDiagnostics(): AppServerProcessDiagnostics {
    return { pid: this.child?.pid ?? null, closeObserved: this.closeObserved, stdoutClosed: this.stdoutClosed, stderrClosed: this.stderrClosed, terminationRequested: this.terminationRequested, forceIssued: this.forceIssued };
  }

  private async start(): Promise<void> {
    if (this.closed) throw new CodexAppServerError("client is closed");
    if (this.child) return;
    const child = spawn(this.options.program, [...this.options.prefixArgs, "app-server", "--stdio", "--disable", "multi_agent", "-c", "agents.enabled=false"], {
      shell: false, windowsHide: true, env: minimalEnvironment(this.options.proxyEnv), stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.byteLength;
      if (this.stderrBytes > this.options.outputLimitBytes) this.protocolFailure(new CodexAppServerError("oversize stderr"));
    });
    child.stdout.once("close", () => { this.stdoutClosed = true; });
    child.stderr.once("close", () => { this.stderrClosed = true; });
    child.once("error", (error) => this.protocolFailure(new CodexAppServerError(`process error: ${error.message}`)));
    child.once("close", (code) => {
      this.closeObserved = true; this.resolveClose?.(); this.resolveClose = undefined;
      if (!this.closed) this.protocolFailure(new CodexAppServerError(`early process exit: ${code}`), false);
    });
  }

  private consume(chunk: Buffer): void {
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > this.options.outputLimitBytes) { this.protocolFailure(new CodexAppServerError("oversize output")); return; }
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer) > this.options.lineLimitBytes && !this.buffer.includes("\n")) { this.protocolFailure(new CodexAppServerError("oversize line")); return; }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, ""); this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.options.lineLimitBytes) { this.protocolFailure(new CodexAppServerError("oversize line")); return; }
      if (line.trim()) {
        let message: unknown;
        try { message = JSON.parse(line) as unknown; } catch { this.protocolFailure(new CodexAppServerError("malformed JSON message")); return; }
        this.handle(message);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(message: unknown): void {
    if (!isRecord(message)) { this.protocolFailure(new CodexAppServerError("malformed message")); return; }
    if (typeof message.id === "string" || typeof message.id === "number") {
      const id = String(message.id); const pending = this.pending.get(id);
      if (!pending) { this.protocolFailure(new CodexAppServerError("unknown response id")); return; }
      this.pending.delete(id); clearTimeout(pending.timer);
      if ("error" in message) pending.reject(new CodexAppServerError(`remote error: ${JSON.stringify(message.error)}`)); else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") { this.protocolFailure(new CodexAppServerError("message has neither id nor method")); return; }
    this.events.push({ method: message.method, params: message.params });
    const waiter = this.terminalWaiter; if (!waiter) return;
    if (message.method === "error" && isRecord(message.params) && message.params.threadId === waiter.threadId && message.params.turnId === waiter.turnId) {
      this.rejectTerminal(new CodexAppServerError(`turn failed: ${JSON.stringify(message.params.error)}`)); return;
    }
    if (message.method !== "turn/completed" || !isRecord(message.params) || !isRecord(message.params.turn)) return;
    if (message.params.threadId === waiter.threadId && message.params.turn.id === waiter.turnId) {
      clearTimeout(waiter.timer); this.terminalWaiter = undefined; waiter.resolve(message.params);
    }
  }

  private writeMessage(message: unknown): void {
    if (!this.child?.stdin.writable) throw new CodexAppServerError("stdio unavailable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async request(method: string, params: unknown, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    await this.start(); const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexAppServerError(`${method} timeout`)); void this.close(); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.writeMessage({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new CodexAppServerError(String(error))); }
    });
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo: { name: "agentplatform", version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.writeMessage({ jsonrpc: "2.0", method: "initialized", params: {} }); return result;
  }

  async accountRead(): Promise<unknown> {
    return this.request("account/read", { refreshToken: false });
  }

  async threadStart(params: { cwd: string; model: string; reasoning?: "low" | "medium" | "high" | "xhigh" }): Promise<unknown> {
    const { reasoning, ...thread } = params;
    return this.request("thread/start", {
      ...thread,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      ...(reasoning ? { config: { model_reasoning_effort: reasoning } } : {})
    });
  }

  async turnStart(threadId: string, text: string, outputSchema?: unknown): Promise<AppServerResult> {
    const started = await this.request("turn/start", { threadId, input: [{ type: "text", text }], ...(outputSchema === undefined ? {} : { outputSchema }) });
    if (!isRecord(started) || !isRecord(started.turn) || typeof started.turn.id !== "string") throw new CodexAppServerError("turn/start returned no turn id");
    const turnId = started.turn.id;
    const terminal = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.terminalWaiter = undefined; void this.interruptAndClose(threadId, turnId); reject(new CodexAppServerError("turn completion timeout")); }, this.options.timeoutMs);
      this.terminalWaiter = { threadId, turnId, resolve, reject, timer };
    });
    return { threadId, turnId, terminal, events: [...this.events], process: this.getProcessDiagnostics() };
  }

  async cancel(threadId: string, turnId: string): Promise<void> {
    try { await this.request("turn/interrupt", { threadId, turnId }); } finally { await this.close(); }
  }

  private async interruptAndClose(threadId: string, turnId: string): Promise<void> {
    try { await this.request("turn/interrupt", { threadId, turnId }, Math.min(1_000, this.options.timeoutMs)); } catch { /* Host cleanup below is authoritative. */ }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed && !this.child) return;
    this.closed = true; this.rejectAll(new CodexAppServerError("closed")); const child = this.child; if (!child) return;
    this.terminationRequested = true; try { child.stdin.end(); } catch { /* Continue cleanup. */ }
    await Promise.race([this.closePromise ?? Promise.resolve(), delay(GRACEFUL_CLOSE_MS)]);
    if (!this.closeObserved) { await this.terminateTree(child, false); await Promise.race([this.closePromise ?? Promise.resolve(), delay(TERMINATION_GRACE_MS)]); }
    if (!this.closeObserved) { this.forceIssued = true; await this.terminateTree(child, true); await Promise.race([this.closePromise ?? Promise.resolve(), delay(FORCE_SETTLE_MS)]); }
    if (!this.closeObserved) { try { child.kill(); child.stdout.destroy(); child.stderr.destroy(); } catch { /* Best effort. */ } }
    this.child = undefined;
  }

  private async terminateTree(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
    if (!child.pid) return;
    if (process.platform !== "win32") { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Best effort. */ } return; }
    await new Promise<void>((resolve) => {
      let command: ChildProcess | undefined;
      const timer = setTimeout(() => { try { command?.kill(); } catch { /* Best effort. */ } resolve(); }, 250);
      try {
        command = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { shell: false, windowsHide: true, stdio: "ignore" });
        command.once("error", () => { clearTimeout(timer); resolve(); }); command.once("close", () => { clearTimeout(timer); resolve(); });
      } catch { clearTimeout(timer); resolve(); }
    });
  }

  private rejectTerminal(error: Error): void { const waiter = this.terminalWaiter; if (!waiter) return; clearTimeout(waiter.timer); this.terminalWaiter = undefined; waiter.reject(error); }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); this.rejectTerminal(error); }
  private protocolFailure(error: Error, close = true): void { this.rejectAll(error); if (close) void this.close(); }
}
