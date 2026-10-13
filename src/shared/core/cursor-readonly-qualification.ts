import { createHash } from "node:crypto";
import path from "node:path";

export type CursorReadonlyTraceInput = {
  stdout: string;
  stderrBytes: number;
  exitCode: number | null;
  durationMs: number;
  processConverged: boolean;
  fixtureRoot: string;
  expectedFixtureSha256: string;
  fixtureSha256Before: string;
  fixtureSha256After: string;
  expectedMarkerFileSha256: string;
};

export type CursorReadonlyTraceDecision = {
  status: "PASS" | "FAIL";
  reasons: readonly string[];
  readCalls: number;
  prefixCharacters: number | null;
};

const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_MS = 200_000;
const MAX_PREFIX_CHARACTERS = 256;
const ALLOWED_EVENT_TYPES = new Set(["system", "user", "thinking", "assistant", "tool_call", "result"]);
const SHA256 = /^[0-9a-f]{64}$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Evaluate one bounded Cursor Ask trace. This function has no process or filesystem authority. */
export function evaluateCursorReadonlyTrace(input: CursorReadonlyTraceInput): CursorReadonlyTraceDecision {
  const reasons: string[] = [];
  const fail = (reason: string): void => { if (!reasons.includes(reason)) reasons.push(reason); };
  let readCalls = 0;
  let prefixCharacters: number | null = null;

  if (input.exitCode !== 0 || !input.processConverged) fail("PROCESS_NOT_CONVERGED");
  if (!Number.isInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > MAX_DURATION_MS) fail("PROCESS_DURATION_INVALID");
  if (Buffer.byteLength(input.stdout, "utf8") > MAX_STREAM_BYTES ||
      !Number.isInteger(input.stderrBytes) || input.stderrBytes < 0 || input.stderrBytes > MAX_STREAM_BYTES) fail("OUTPUT_LIMIT_INVALID");
  if (![input.expectedFixtureSha256, input.fixtureSha256Before, input.fixtureSha256After, input.expectedMarkerFileSha256].every(value => SHA256.test(value)) ||
      input.fixtureSha256Before !== input.expectedFixtureSha256 || input.fixtureSha256After !== input.expectedFixtureSha256) fail("FIXTURE_DRIFT");
  if (!path.posix.isAbsolute(input.fixtureRoot) || path.posix.normalize(input.fixtureRoot) !== input.fixtureRoot || input.fixtureRoot === "/") fail("FIXTURE_ROOT_INVALID");

  const lines = input.stdout.split(/\r?\n/).filter(line => line.length > 0);
  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const event = record(JSON.parse(line) as unknown);
      if (!event || typeof event.type !== "string") { fail("EVENT_INVALID"); continue; }
      events.push(event);
      if (!ALLOWED_EVENT_TYPES.has(event.type)) fail("EVENT_TYPE_UNEXPECTED");
    } catch {
      fail("NDJSON_INVALID");
    }
  }
  const terminalEvents = events.filter(event => event.type === "result");
  if (terminalEvents.length !== 1 || events.at(-1) !== terminalEvents[0]) fail("TERMINAL_INVALID");

  const expectedReadPath = path.posix.join(input.fixtureRoot, "marker.txt");
  const readStarted: Record<string, unknown>[] = [];
  const readCompleted: Record<string, unknown>[] = [];
  for (const event of events.filter(item => item.type === "tool_call")) {
    const tool = record(event.tool_call);
    const read = record(tool?.readToolCall);
    const args = record(read?.args);
    const readPath = args?.path;
    const toolKinds = tool ? Object.keys(tool).filter(key => key.endsWith("ToolCall")) : [];
    const resolved = typeof readPath === "string" && input.fixtureRoot !== "/"
      ? path.posix.resolve(input.fixtureRoot, readPath) : null;
    if (!read || !args || Object.keys(args).join(",") !== "path" || toolKinds.join(",") !== "readToolCall" ||
        resolved !== expectedReadPath || typeof event.call_id !== "string" || event.call_id.length === 0) {
      fail("TOOL_NOT_APPROVED_READ");
      continue;
    }
    if (event.subtype === "started") readStarted.push(event);
    else if (event.subtype === "completed") readCompleted.push(event);
    else fail("TOOL_EVENT_INVALID");
  }
  readCalls = readStarted.length;
  if (readStarted.length !== 1 || readCompleted.length !== 1 || readStarted[0]?.call_id !== readCompleted[0]?.call_id) fail("READ_CALL_COUNT_INVALID");

  const terminal = terminalEvents[0];
  if (terminal) {
    if (terminal.subtype !== "success" || terminal.is_error !== false || typeof terminal.result !== "string") {
      fail("TERMINAL_UNSUCCESSFUL");
    } else {
      const resultText = terminal.result;
      const brace = resultText.indexOf("{");
      prefixCharacters = brace < 0 ? null : brace;
      if (brace < 0 || brace > MAX_PREFIX_CHARACTERS || resultText.slice(0, brace).includes("}")) {
        fail("RESULT_FORMAT_INVALID");
      } else {
        const candidate = resultText.slice(brace);
        try {
          const parsed = record(JSON.parse(candidate) as unknown);
          if (!parsed || Object.keys(parsed).join(",") !== "status,marker" ||
              parsed.status !== "ok" || typeof parsed.marker !== "string" ||
              parsed.marker.includes("\n") || parsed.marker.includes("\r") ||
              candidate !== JSON.stringify(parsed)) {
            fail("RESULT_FORMAT_INVALID");
          } else if (sha256(`${parsed.marker}\n`) !== input.expectedMarkerFileSha256) {
            fail("MARKER_MISMATCH");
          }
        } catch {
          fail("RESULT_FORMAT_INVALID");
        }
      }
    }
  }

  return { status: reasons.length === 0 ? "PASS" : "FAIL", reasons, readCalls, prefixCharacters };
}
