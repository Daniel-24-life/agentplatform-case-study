export type TerminalEventKind = "completed" | "failed" | "usage" | "malformed" | "progress";
export type CodexTerminalEvent = { kind: TerminalEventKind; raw: unknown; error?: string; usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } };
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
export function parseCodexEvent(value: unknown): CodexTerminalEvent {
  if (!object(value)) return { kind: "malformed", raw: value, error: "event is not an object" };
  const type = typeof value.type === "string" ? value.type : typeof value.method === "string" ? value.method : "";
  const tokenUsage = object(value.params) && object(value.params.tokenUsage) ? value.params.tokenUsage : null;
  const usage = object(value.usage) ? value.usage : object(value.response) && object(value.response.usage) ? value.response.usage : tokenUsage && object(tokenUsage.total) ? tokenUsage.total : tokenUsage;
  const parsedUsage = usage ? (() => { const n = (snake: string, camel: string): number | null => { const candidate = usage[camel] ?? usage[snake]; return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null; }; return { inputTokens: n("input_tokens", "inputTokens"), outputTokens: n("output_tokens", "outputTokens"), totalTokens: n("total_tokens", "totalTokens") }; })() : undefined;
  if (/^(response|turn)[./](completed|done|succeeded)$/.test(type) || type === "completed") return { kind: "completed", raw: value, usage: parsedUsage };
  if (/^(response|turn)[./](failed|error|cancelled)$/.test(type) || type === "error" || type === "failed") return { kind: "failed", raw: value, error: typeof value.error === "string" ? value.error : undefined };
  if (parsedUsage) return { kind: "usage", raw: value, usage: parsedUsage };
  return { kind: type ? "progress" : "malformed", raw: value, error: type ? undefined : "missing event type" };
}
export function parseCodexTerminalEvents(stdout: string): CodexTerminalEvent[] {
  return stdout.split(/\r?\n/).filter(line => line.trim()).map(line => { try { return parseCodexEvent(JSON.parse(line) as unknown); } catch { return { kind: "malformed", raw: line, error: "invalid JSON" }; } });
}
export const parseCodexExecJsonl = parseCodexTerminalEvents;
