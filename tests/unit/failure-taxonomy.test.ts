import { describe, expect, it } from "vitest";
import { classifyFailureCode, classifyProcessResult } from "../../src/shared/core/failure-taxonomy.js";

describe("failure taxonomy", () => {
  it("prioritizes process status over late diagnostic text", () => {
    const result = classifyProcessResult({ status: "TIMED_OUT", stdout: "quota exhausted", stderr: "websocket timeout" });
    expect(result).toMatchObject({ code: "PROCESS_TIMEOUT", domain: "runtime" });
  });
  it.each([
    ["not authenticated", "CLI_NOT_AUTHENTICATED"], ["model unavailable", "MODEL_UNAVAILABLE"],
    ["quota exceeded", "QUOTA_EXHAUSTED"], ["429 too many requests", "RATE_LIMITED"],
    ["websocket connection reset", "TRANSPORT_FAILURE"]
  ])("maps %s to %s", (stderr, code) => {
    expect(classifyProcessResult({ status: "FAILED", stdout: "", stderr })).toMatchObject({ code });
  });
  it("uses stable defaults for unknown failures and process statuses", () => {
    expect(classifyProcessResult({ status: "FAILED", stdout: "", stderr: "unknown" })?.code).toBe("MODEL_RUNTIME_FAILED");
    expect(classifyFailureCode("TEST_FAILED")).toMatchObject({ domain: "task", retryable: true, failFast: false });
    expect(classifyProcessResult({ status: "CANCELLED", stdout: "", stderr: "" })).toMatchObject({ code: "PROCESS_CANCELLED", domain: "user", failFast: true });
  });
  it("prioritizes a terminal schema error over earlier transport retry messages", () => {
    const result = classifyProcessResult({ status: "FAILED", stdout: "Reconnecting after websocket timeout\ninvalid_json_schema: invalid schema for response_format", stderr: "" });
    expect(result).toMatchObject({ code: "OUTPUT_SCHEMA_INVALID", domain: "task", failFast: true });
  });
  it("distinguishes missing CLI from other process start failures", () => {
    expect(classifyProcessResult({ status: "START_FAILED", stdout: "", stderr: "spawn codex ENOENT" })?.code).toBe("CLI_NOT_FOUND");
    expect(classifyProcessResult({ status: "START_FAILED", stdout: "", stderr: "permission denied" })?.code).toBe("PROCESS_START_FAILED");
  });
  it("requires runtime preflight with a stable runtime gate code", () => {
    expect(classifyFailureCode("RUNTIME_PREFLIGHT_REQUIRED")).toMatchObject({ code: "RUNTIME_PREFLIGHT_REQUIRED", domain: "runtime", retryable: true, failFast: true });
  });
});
