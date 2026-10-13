import { describe, expect, it } from "vitest";
import { parseCodexEvent, parseCodexTerminalEvents } from "../../src/shared/core/codex-terminal-events.js";

describe("Codex terminal events", () => {
  it("requires an explicit completion event", () => {
    expect(parseCodexTerminalEvents('{"type":"response.completed"}\n')).toMatchObject([{ kind: "completed" }]);
    expect(parseCodexTerminalEvents("")).toEqual([]);
  });
  it("keeps failures distinct from completion and process exit", () => {
    expect(parseCodexEvent({ type: "turn.failed", error: "bad output" })).toMatchObject({ kind: "failed", error: "bad output" });
    expect(parseCodexEvent({ type: "process.exit", code: 0 }).kind).toBe("progress");
  });
  it("extracts usage events", () => {
    expect(parseCodexEvent({ type: "response.completed", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })).toMatchObject({ kind: "completed", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
    expect(parseCodexEvent({ method: "turn/completed", usage: { input_tokens: 1 } })).toMatchObject({ kind: "completed", usage: { inputTokens: 1 } });
    expect(parseCodexEvent({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } } } })).toMatchObject({ kind: "usage", usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });
  });
  it("marks malformed JSONL and malformed objects", () => {
    expect(parseCodexTerminalEvents("not-json")).toMatchObject([{ kind: "malformed" }]);
    expect(parseCodexEvent({ answer: 1 })).toMatchObject({ kind: "malformed" });
  });
});
