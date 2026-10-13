import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateCursorReadonlyTrace, type CursorReadonlyTraceInput } from "../../src/shared/core/cursor-readonly-qualification.js";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const marker = "AP_TEST_MARKER_42";
const fixtureRoot = "/opt/agentplatform-test-fixture";
const fixtureSha = "a".repeat(64);

const events = (result = `Reading the file. ${JSON.stringify({ status: "ok", marker })}`): Record<string, unknown>[] => [
  { type: "system", subtype: "init" },
  { type: "user" },
  { type: "tool_call", subtype: "started", call_id: "read-1", tool_call: { readToolCall: { args: { path: "marker.txt" } } } },
  { type: "tool_call", subtype: "completed", call_id: "read-1", tool_call: { readToolCall: { args: { path: "marker.txt" }, result: "redacted" } } },
  { type: "result", subtype: "success", is_error: false, result }
];

const trace = (items: Record<string, unknown>[]): string => `${items.map(item => JSON.stringify(item)).join("\n")}\n`;
const base = (items = events()): CursorReadonlyTraceInput => ({
  stdout: trace(items),
  stderrBytes: 0,
  exitCode: 0,
  durationMs: 10_000,
  processConverged: true,
  fixtureRoot,
  expectedFixtureSha256: fixtureSha,
  fixtureSha256Before: fixtureSha,
  fixtureSha256After: fixtureSha,
  expectedMarkerFileSha256: sha(`${marker}\n`)
});

describe("Cursor bounded read-only trace", () => {
  it("accepts one approved read and an unambiguous canonical JSON tail", () => {
    expect(evaluateCursorReadonlyTrace(base())).toEqual({ status: "PASS", reasons: [], readCalls: 1, prefixCharacters: 18 });
  });

  it("rejects wrong paths, additional reads and other tool types", () => {
    const wrongPath = events();
    wrongPath[2] = { ...wrongPath[2], tool_call: { readToolCall: { args: { path: "../elsewhere" } } } };
    expect(evaluateCursorReadonlyTrace(base(wrongPath)).reasons).toContain("TOOL_NOT_APPROVED_READ");

    const extraRead = events();
    extraRead.splice(4, 0,
      { type: "tool_call", subtype: "started", call_id: "read-2", tool_call: { readToolCall: { args: { path: "marker.txt" } } } },
      { type: "tool_call", subtype: "completed", call_id: "read-2", tool_call: { readToolCall: { args: { path: "marker.txt" } } } });
    expect(evaluateCursorReadonlyTrace(base(extraRead)).reasons).toContain("READ_CALL_COUNT_INVALID");

    const shell = events();
    shell.splice(4, 0, { type: "tool_call", subtype: "started", call_id: "shell-1", tool_call: { shellToolCall: { args: { command: "pwd" } } } });
    expect(evaluateCursorReadonlyTrace(base(shell)).reasons).toContain("TOOL_NOT_APPROVED_READ");

    const mixed = events();
    mixed[2] = { ...mixed[2], tool_call: { readToolCall: { args: { path: "marker.txt" } }, writeToolCall: { args: { path: "marker.txt" } } } };
    expect(evaluateCursorReadonlyTrace(base(mixed)).reasons).toContain("TOOL_NOT_APPROVED_READ");
  });

  it("rejects missing, repeated, late and unsuccessful terminal results", () => {
    expect(evaluateCursorReadonlyTrace(base(events().slice(0, -1))).reasons).toContain("TERMINAL_INVALID");
    const repeated = events();
    repeated.push({ ...repeated.at(-1)! });
    expect(evaluateCursorReadonlyTrace(base(repeated)).reasons).toContain("TERMINAL_INVALID");
    const late = events();
    late.push({ type: "assistant" });
    expect(evaluateCursorReadonlyTrace(base(late)).reasons).toContain("TERMINAL_INVALID");
    const failed = events();
    failed[4] = { ...failed[4], is_error: true };
    expect(evaluateCursorReadonlyTrace(base(failed)).reasons).toContain("TERMINAL_UNSUCCESSFUL");
  });

  it("rejects ambiguous JSON, noncanonical fields, excess prefix and wrong marker", () => {
    for (const text of [
      `Intro ${JSON.stringify({ status: "ok", marker })} trailing`,
      `Intro ${JSON.stringify({ status: "ok", marker })}${JSON.stringify({ status: "ok", marker })}`,
      `Intro {"status":"ok","status":"ok","marker":"${marker}"}`,
      `Intro ${JSON.stringify({ status: "ok", marker, extra: true })}`,
      `${"x".repeat(257)}${JSON.stringify({ status: "ok", marker })}`
    ]) expect(evaluateCursorReadonlyTrace(base(events(text))).reasons).toContain("RESULT_FORMAT_INVALID");
    expect(evaluateCursorReadonlyTrace(base(events(JSON.stringify({ status: "ok", marker: "wrong" })))).reasons).toContain("MARKER_MISMATCH");
  });

  it("rejects process failure, fixture drift and output overflow", () => {
    expect(evaluateCursorReadonlyTrace({ ...base(), exitCode: 1 }).reasons).toContain("PROCESS_NOT_CONVERGED");
    expect(evaluateCursorReadonlyTrace({ ...base(), processConverged: false }).reasons).toContain("PROCESS_NOT_CONVERGED");
    expect(evaluateCursorReadonlyTrace({ ...base(), fixtureSha256After: "b".repeat(64) }).reasons).toContain("FIXTURE_DRIFT");
    expect(evaluateCursorReadonlyTrace({ ...base(), stderrBytes: 2 * 1024 * 1024 + 1 }).reasons).toContain("OUTPUT_LIMIT_INVALID");
  });

  const sealedStdout = path.resolve("cursor-wsl-readonly-run2", "stdout.ndjson");
  it.skipIf(!existsSync(sealedStdout))("replays the immutable Phase 1.17 trace under the new contract", () => {
    const bytes = readFileSync(sealedStdout);
    expect(sha(bytes)).toBe("6d847289f6684f155d2da5fc2c69442af40c86dcb5991d19212acedc7dd4206c");
    const digest = "9cdf07e7b03369d9a1f492694e30bca486eaa53ad8f03cb65d2a6abb4791eaba";
    expect(evaluateCursorReadonlyTrace({
      stdout: bytes.toString("utf8"), stderrBytes: 132, exitCode: 0, durationMs: 28_770, processConverged: true,
      fixtureRoot: "/opt/agentplatform-cursor-readonly-run2", expectedFixtureSha256: digest,
      fixtureSha256Before: digest, fixtureSha256After: digest,
      expectedMarkerFileSha256: "1a0eb34281adcf5f0dfeb320dc13500573bcd1b69cea34d97e557725afa63430"
    })).toEqual({ status: "PASS", reasons: [], readCalls: 1, prefixCharacters: 23 });
  });
});
