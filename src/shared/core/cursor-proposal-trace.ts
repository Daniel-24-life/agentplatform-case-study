import path from "node:path";

import { validateChangeSetAgainstRequest, type ChangeSet, type WorkerProposalRequest } from "./worker-proposal.js";

export type CursorProposalTrace = {
  changeSet: ChangeSet;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};

const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_PREFIX_CHARACTERS = 256;
const ALLOWED_EVENT_TYPES = new Set(["system", "user", "thinking", "assistant", "tool_call", "result"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Parse one bounded Cursor Ask proposal trace; this function has no filesystem or process authority. */
export function parseCursorProposalTrace(stdout: string, request: WorkerProposalRequest, fixtureRoot: string): CursorProposalTrace {
  if (Buffer.byteLength(stdout, "utf8") > MAX_STREAM_BYTES) throw new Error("CURSOR_STREAM_TOO_LARGE");
  if (!path.posix.isAbsolute(fixtureRoot) || path.posix.normalize(fixtureRoot) !== fixtureRoot || fixtureRoot === "/") {
    throw new Error("CURSOR_FIXTURE_ROOT_INVALID");
  }
  const lines = stdout.split(/\r?\n/).filter(line => line.length > 0);
  const events = lines.map(line => {
    let event: unknown;
    try { event = JSON.parse(line) as unknown; } catch { throw new Error("CURSOR_NDJSON_INVALID"); }
    const value = record(event);
    if (!value || typeof value.type !== "string" || !ALLOWED_EVENT_TYPES.has(value.type)) {
      throw new Error("CURSOR_EVENT_INVALID");
    }
    return value;
  });
  const terminals = events.filter(event => event.type === "result");
  if (terminals.length !== 1 || events.at(-1) !== terminals[0]) throw new Error("CURSOR_TERMINAL_INVALID");

  const expectedPath = path.posix.join(fixtureRoot, "context.json");
  const started: string[] = [];
  const completed: string[] = [];
  for (const event of events.filter(value => value.type === "tool_call")) {
    const tool = record(event.tool_call);
    const read = record(tool?.readToolCall);
    const args = record(read?.args);
    const toolKinds = tool ? Object.keys(tool).filter(key => key.endsWith("ToolCall")) : [];
    const readPath = args?.path;
    if (!read || !args || Object.keys(args).join(",") !== "path" || toolKinds.join(",") !== "readToolCall" ||
        typeof readPath !== "string" || path.posix.resolve(fixtureRoot, readPath) !== expectedPath ||
        typeof event.call_id !== "string" || event.call_id.length === 0) {
      throw new Error("CURSOR_TOOL_OUT_OF_SCOPE");
    }
    if (event.subtype === "started") started.push(event.call_id);
    else if (event.subtype === "completed") completed.push(event.call_id);
    else throw new Error("CURSOR_TOOL_EVENT_INVALID");
  }
  if (started.length !== 1 || completed.length !== 1 || started[0] !== completed[0]) {
    throw new Error("CURSOR_READ_COUNT_INVALID");
  }

  const terminal = terminals[0]!;
  if (terminal.subtype !== "success" || terminal.is_error !== false || typeof terminal.result !== "string") {
    throw new Error("CURSOR_TERMINAL_UNSUCCESSFUL");
  }
  const brace = terminal.result.indexOf("{");
  if (brace < 0 || brace > MAX_PREFIX_CHARACTERS || terminal.result.slice(0, brace).includes("}")) {
    throw new Error("CURSOR_RESULT_FORMAT_INVALID");
  }
  const candidate = terminal.result.slice(brace);
  let parsed: unknown;
  try { parsed = JSON.parse(candidate) as unknown; } catch { throw new Error("CURSOR_RESULT_FORMAT_INVALID"); }
  if (!record(parsed) || JSON.stringify(parsed) !== candidate) throw new Error("CURSOR_RESULT_FORMAT_INVALID");
  const checked = validateChangeSetAgainstRequest(parsed, request);
  if (!checked.valid) throw new Error(`CURSOR_CHANGE_SET_INVALID:${checked.issues.map(issue => issue.path).join(",")}`);
  const usage = record(terminal.usage);
  return {
    changeSet: checked.value,
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    cachedInputTokens: count(usage?.cacheReadTokens)
  };
}
