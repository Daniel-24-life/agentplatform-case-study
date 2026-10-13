import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "../../src/main/adapters/codex/codex-adapter.js";
import { runDeterministicGate } from "../../src/main/gate/deterministic-gate.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

const spec: TaskSpec = { schema_version: "1.0", task_id: "TASK-001", title: "t", goal: "g", base_sha: "a".repeat(40), scope: { allowed_paths: ["src/**"], forbidden_paths: ["src/private/**"] }, acceptance_criteria: [{ id: "AC-01", text: "ok" }], test_commands: [{ id: "unit", program: "node", args: [], cwd: "src", timeout_seconds: 10, required: true }], worker: { adapter: "codex", model: "gpt-5.3-codex", reasoning: "medium" }, limits: { max_attempts: 2, run_timeout_seconds: 100, max_changed_files: 10, max_diff_bytes: 1000 } };
describe("orchestration core", () => {
  it("constructs role sandbox arguments", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orchestration-core-"));
    const schemaPath = path.join(dir, "schema.json");
    const outputPath = path.join(dir, "output.json");
    writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: {}, required: [], additionalProperties: false }), "utf8");
    const base = { cwd: "C:/repo", model: "m", reasoning: "low" as const, schemaPath, outputPath, prompt: "p" };
    expect(buildCodexArgs({ ...base, role: "architect" })).toContain("read-only");
    expect(buildCodexArgs({ ...base, role: "builder" })).toContain("workspace-write");
    expect(buildCodexArgs({ ...base, role: "reviewer" })).toContain("never");
    expect(buildCodexArgs({ ...base, role: "builder" })).toContain('model_reasoning_effort="low"');
  });
  it("blocks hard gate failures", () => {
    const content = "ok";
    const gate = runDeterministicGate({ spec, baseSha: spec.base_sha, changedFiles: ["src/private/x.ts"], diff: "x".repeat(1001), tests: [{ id: "unit", required: true, result: { status: "FAILED", exitCode: 1, stdout: "", stderr: "", stdoutSha256: "", stderrSha256: "", durationMs: 1 } }], workerValid: true, artifacts: [{ content, sha256: createHash("sha256").update(content).digest("hex") }] });
    expect(gate.passed).toBe(false);
    expect(gate.failures).toContain("TEST_FAILED");
    expect(gate.failures.some((x) => x.startsWith("SCOPE_VIOLATION"))).toBe(true);
  });
});
describe("deterministic gate matrix", () => {
  const valid = () => ({ spec: structuredClone(spec), baseSha: spec.base_sha, changedFiles: ["src/a.ts"], diff: "x", tests: [{ id: "unit", required: true, result: { status: "SUCCEEDED" as "SUCCEEDED" | "FAILED", exitCode: 0, stdout: "", stderr: "", stdoutSha256: "", stderrSha256: "", durationMs: 1 } }], workerValid: true, artifacts: [] });
  it.each([["base", (v: ReturnType<typeof valid>) => { v.baseSha = "0".repeat(40); }, "BASE_SHA_CHANGED"], ["scope", (v: ReturnType<typeof valid>) => { v.changedFiles = ["private/a.ts"]; }, "SCOPE_VIOLATION:private/a.ts"], ["count", (v: ReturnType<typeof valid>) => { v.spec.limits.max_changed_files = 1; v.changedFiles = ["src/a.ts", "src/b.ts"]; }, "MAX_CHANGED_FILES"], ["bytes", (v: ReturnType<typeof valid>) => { v.spec.limits.max_diff_bytes = 1; v.diff = "xx"; }, "MAX_DIFF_BYTES"], ["test", (v: ReturnType<typeof valid>) => { v.tests[0]!.result.status = "FAILED"; }, "TEST_FAILED"], ["worker", (v: ReturnType<typeof valid>) => { v.workerValid = false; }, "OUTPUT_SCHEMA_INVALID"]] as const)("blocks %s", (_name, mutate, code) => { const value = valid(); mutate(value); expect(runDeterministicGate(value).failures).toContain(code); });
  it("requires one authoritative result for each approved required test", () => {
    const missing = valid();
    missing.tests = [];
    expect(runDeterministicGate(missing).failures).toContain("TEST_FAILED");

    const downgraded = valid();
    downgraded.tests[0]!.required = false;
    expect(runDeterministicGate(downgraded).failures).toContain("TEST_FAILED");

    const duplicate = valid();
    duplicate.tests.push(structuredClone(duplicate.tests[0]!));
    expect(runDeterministicGate(duplicate).failures).toContain("TEST_FAILED");
  });
  it("rejects unsafe Git paths even when the file scope otherwise matches", () => {
    expect(runDeterministicGate({ ...valid(), invalidPaths: ["src/escape-link"] }).failures).toContain("UNSAFE_GIT_PATH:src/escape-link");
  });
});
