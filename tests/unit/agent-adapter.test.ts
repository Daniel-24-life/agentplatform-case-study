import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexArgs, CodexAdapter, CodexOutputError, CodexRunError, parseCodexUsage } from "../../src/main/adapters/codex/codex-adapter.js";
import { CheapWorkerAdapter } from "../../src/main/adapters/cheap-worker/cheap-worker-adapter.js";
import { AgentOutputError, AgentRunError, type PlannerAgentAdapter, type ReviewerAgentAdapter, type WorkerAgentAdapter } from "../../src/main/adapters/agent-adapter.js";
import type { ProcessResult } from "../../src/main/process/runner.js";

const input = {
  cwd: "C:/worktree",
  model: "gpt-5.5",
  reasoning: "low" as const,
  schemaPath: "C:/artifacts/schema.json",
  outputPath: "C:/artifacts/final.json",
  prompt: "do the task"
};

describe("agent adapter boundaries", () => {
  const withSchema = (schema: Record<string, unknown>) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-adapter-"));
    const schemaPath = path.join(dir, "authority.json");
    const outputPath = path.join(dir, "result.json");
    writeFileSync(schemaPath, JSON.stringify(schema), "utf8");
    return { ...input, schemaPath, outputPath };
  };
  it("extracts the last explicit cumulative Codex usage event", () => {
    expect(parseCodexUsage([
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 18, output_tokens: 4, total_tokens: 22, cached_input_tokens: 3 } })
    ].join("\n"))).toEqual({ inputTokens: 18, outputTokens: 4, totalTokens: 22, cachedInputTokens: 3 });
  });

  it("returns null for absent, malformed, or unsupported usage", () => {
    expect(parseCodexUsage("not json\n{" + '"type":"message","usage":{"input_tokens":9}}')).toBeNull();
    expect(parseCodexUsage(JSON.stringify({ type: "turn.completed", usage: { input_tokens: -1, output_tokens: "2" } }))).toBeNull();
    expect(parseCodexUsage(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4 } }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: NaN } }))).toEqual({ inputTokens: 4, outputTokens: null, totalTokens: null, cachedInputTokens: null });
  });

  it("keeps timeout status primary while bounding diagnostic output", () => {
    const result: ProcessResult = {
      status: "TIMED_OUT", exitCode: null, durationMs: 1,
      stdout: `${"o".repeat(6000)}stdout-tail`, stderr: `${"e".repeat(6000)}stderr-tail`,
      stdoutSha256: "", stderrSha256: ""
    };
    const error = new CodexRunError(result);
    expect(error.message.startsWith("TIMED_OUT\n")).toBe(true);
    expect(error.message).toContain("stderr: ");
    expect(error.message).toContain("stdout: ");
    expect(error.message).toContain("stderr-tail");
    expect(error.message).toContain("stdout-tail");
    expect(error.message.length).toBeLessThanOrEqual(8300);
  });

  it("keeps Codex runtime and output errors compatible with neutral error bases", () => {
    const result: ProcessResult = { status: "FAILED", exitCode: 1, stdout: "", stderr: "", durationMs: 1, stdoutSha256: "", stderrSha256: "" };
    expect(new CodexRunError(result)).toBeInstanceOf(AgentRunError);
    expect(new CodexOutputError({ ...result, status: "SUCCEEDED", exitCode: 0 }, new Error("invalid output"))).toBeInstanceOf(AgentOutputError);
  });

  it("retains process evidence when structured planner output is invalid", async () => {
    const configured = { ...withSchema({ type: "object", properties: {}, required: [], additionalProperties: false }), cwd: process.cwd() };
    const script = "const fs=require('node:fs');const i=process.argv.indexOf('--output-last-message');fs.writeFileSync(process.argv[i+1], '{}');process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:3,total_tokens:10}}));";
    const adapter = new CodexAdapter(process.execPath, ["-e", script, "--"], () => ({}));
    let caught: unknown;
    try { await adapter.runPlanner(configured); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CodexOutputError);
    const error = caught as CodexOutputError;
    expect(error.code).toBe("OUTPUT_SCHEMA_INVALID");
    expect(error.result.status).toBe("SUCCEEDED");
    expect(error.result.stdout).toContain("turn.completed");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toContain("task_id");
  });

  it("uses read-only sandbox for planner and reviewer", () => {
    const configured = withSchema({ type: "object", properties: {}, required: [], additionalProperties: false });
    const planner = buildCodexArgs({ ...configured, role: "architect" });
    const reviewer = buildCodexArgs({ ...configured, role: "reviewer" });
    expect(planner).toContain("read-only");
    expect(reviewer).toContain("read-only");
    expect(planner).not.toContain("workspace-write");
    expect(reviewer).not.toContain("workspace-write");
  });

  it("uses workspace-write only for workers and keeps argv structured", () => {
    const configured = withSchema({ type: "object", properties: {}, required: [], additionalProperties: false });
    const args = buildCodexArgs({ ...configured, role: "builder" });
    expect(args).toContain("workspace-write");
    expect(args.slice(0, 10)).toEqual(["--ask-for-approval", "never", "--disable", "multi_agent", "exec", "--ephemeral", "--ignore-rules", "-c", "agents.enabled=false", "-C"]);
    expect(args.indexOf("--ask-for-approval")).toBeLessThan(args.indexOf("exec"));
    expect(args.indexOf("--disable")).toBeLessThan(args.indexOf("exec"));
    expect(args.filter((arg) => arg === "--ask-for-approval")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--disable")).toHaveLength(1);
    expect(args).not.toContain("cmd /c");
    expect(args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
  });

  it("projects the authoritative schema without mutating it", () => {
    const configured = withSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "task-spec",
      title: "Authority",
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 20, pattern: "^[a-z]+$", default: "x" },
        nested: { $ref: "#/$defs/nested" }
      },
      required: ["name"],
      additionalProperties: false,
      uniqueItems: true,
      $defs: { nested: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } } }
    });
    const original = readFileSync(configured.schemaPath, "utf8");
    const args = buildCodexArgs({ ...configured, role: "architect" });
    const derivedPath = args[args.indexOf("--output-schema") + 1];
    const projected = JSON.parse(readFileSync(derivedPath, "utf8")) as Record<string, unknown>;
    expect(readFileSync(configured.schemaPath, "utf8")).toBe(original);
    expect(projected).not.toHaveProperty("$schema");
    expect(projected).not.toHaveProperty("$id");
    expect(projected).not.toHaveProperty("uniqueItems");
    expect((projected.properties as Record<string, Record<string, unknown>>).name).toEqual({ type: "string", pattern: "^[a-z]+$" });
    expect((projected.properties as Record<string, Record<string, unknown>>).nested.$ref).toBe("#/$defs/nested");
    expect(projected.$defs).toEqual({ nested: { type: "array", minItems: 1, items: { type: "string" } } });
  });

  it("exposes role-specific capabilities", () => {
    const codex: PlannerAgentAdapter & WorkerAgentAdapter & ReviewerAgentAdapter = new CodexAdapter();
    const cheap: WorkerAgentAdapter = new CheapWorkerAdapter();
    expect(codex.id).toBe("codex");
    expect(cheap.id).toBe("cheap-worker");
    expect("runPlanner" in cheap).toBe(false);
    expect("runReviewer" in cheap).toBe(false);
  });
});
