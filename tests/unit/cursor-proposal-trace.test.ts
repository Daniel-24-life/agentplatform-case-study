import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseCursorProposalTrace } from "../../src/shared/core/cursor-proposal-trace.js";
import type { WorkerProposalRequest } from "../../src/shared/core/worker-proposal.js";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const root = "/opt/agentplatform-cursor-proposal-test";
const request: WorkerProposalRequest = {
  schema_version: "1.0", task_id: "CURSOR-TEST", base_sha: "b".repeat(40), task_spec_sha256: "a".repeat(64),
  goal: "Replace the fixture value.", scope: { allowed_paths: ["src/**"], forbidden_paths: [] },
  acceptance_criteria: [{ id: "AC-01", text: "The file contains ready." }],
  context_files: [{ path: "src/message.txt", byte_count: 7, sha256: sha("before\n"), content: "before\n" }],
  limits: { max_operations: 1, max_file_bytes: 1024, max_total_bytes: 1024 }
};
const changeSet = {
  schema_version: "1.0", task_id: request.task_id, base_sha: request.base_sha,
  task_spec_sha256: request.task_spec_sha256, status: "completed",
  summary: "Replace the bounded fixture value.",
  operations: [{ type: "replace_file", path: "src/message.txt", expected_sha256: sha("before\n"), content: "ready\n" }],
  acceptance_notes: [{ criterion_id: "AC-01", note: "Proposed complete content." }], risks: [], blocker: null
};
const events = (result = `Done. ${JSON.stringify(changeSet)}`): Record<string, unknown>[] => [
  { type: "system", subtype: "init" },
  { type: "user" },
  { type: "tool_call", subtype: "started", call_id: "read-1", tool_call: { readToolCall: { args: { path: "context.json" } } } },
  { type: "tool_call", subtype: "completed", call_id: "read-1", tool_call: { readToolCall: { args: { path: "context.json" } } } },
  { type: "result", subtype: "success", is_error: false, result, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 } }
];
const stream = (items: Record<string, unknown>[]): string => `${items.map(item => JSON.stringify(item)).join("\n")}\n`;

describe("Cursor proposal trace", () => {
  it("accepts one context read and one validated canonical ChangeSet", () => {
    const parsed = parseCursorProposalTrace(stream(events()), request, root);
    expect(parsed.changeSet).toEqual(changeSet);
    expect(parsed.inputTokens).toBe(100);
    expect(parsed.outputTokens).toBe(20);
    expect(parsed.cachedInputTokens).toBe(5);
  });

  it("rejects tools outside the isolated context file and duplicate reads", () => {
    const wrong = events();
    wrong[2] = { ...wrong[2], tool_call: { readToolCall: { args: { path: "../other" } } } };
    expect(() => parseCursorProposalTrace(stream(wrong), request, root)).toThrow("CURSOR_TOOL_OUT_OF_SCOPE");
    const shell = events();
    shell[2] = { ...shell[2], tool_call: { shellToolCall: { args: { command: "pwd" } } } };
    expect(() => parseCursorProposalTrace(stream(shell), request, root)).toThrow("CURSOR_TOOL_OUT_OF_SCOPE");
    const second = events();
    second.splice(4, 0,
      { type: "tool_call", subtype: "started", call_id: "read-2", tool_call: { readToolCall: { args: { path: "context.json" } } } },
      { type: "tool_call", subtype: "completed", call_id: "read-2", tool_call: { readToolCall: { args: { path: "context.json" } } } });
    expect(() => parseCursorProposalTrace(stream(second), request, root)).toThrow("CURSOR_READ_COUNT_INVALID");
  });

  it("rejects terminal, JSON and proposal identity failures", () => {
    expect(() => parseCursorProposalTrace(stream(events().slice(0, -1)), request, root)).toThrow("CURSOR_TERMINAL_INVALID");
    const failed = events();
    failed[4] = { ...failed[4], is_error: true };
    expect(() => parseCursorProposalTrace(stream(failed), request, root)).toThrow("CURSOR_TERMINAL_UNSUCCESSFUL");
    expect(() => parseCursorProposalTrace(stream(events(`${JSON.stringify(changeSet)} trailing`)), request, root)).toThrow("CURSOR_RESULT_FORMAT_INVALID");
    expect(() => parseCursorProposalTrace(stream(events(`${JSON.stringify(changeSet)}${JSON.stringify(changeSet)}`)), request, root)).toThrow("CURSOR_RESULT_FORMAT_INVALID");
    expect(() => parseCursorProposalTrace(stream(events(JSON.stringify({ ...changeSet, task_id: "WRONG-TASK" }))), request, root)).toThrow("CURSOR_CHANGE_SET_INVALID");
  });
});
