import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodeBuddyArgs,
  buildCodeBuddyProposalArgs,
  CodeBuddyAdapter,
  CodeBuddyOutputError,
  parseCodeBuddyOutput,
  parseCodeBuddyUsage,
  resolveCodeBuddyExecutable
} from "../../src/main/adapters/codebuddy/codebuddy-adapter.js";
import { AgentOutputError, AgentRunError, type PlannerInput } from "../../src/main/adapters/agent-adapter.js";

const schemaPath = path.resolve("schemas/task-spec.schema.json");
const changeSetSchemaPath = path.resolve("schemas/change-set.schema.json");

const taskSpec = {
  schema_version: "2.0" as const,
  task_id: "TASK-001",
  title: "Read-only planning fixture",
  goal: "Return a small, valid TaskSpec without changing the fixture.",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  context_paths: ["src"],
  scope: { allowed_paths: ["src/**"], forbidden_paths: [".env"] },
  acceptance_criteria: [{ id: "AC-01", text: "The plan is schema-valid." }],
  test_commands: [{ id: "unit", program: "pnpm", args: ["test"], cwd: "tests", timeout_seconds: 60, required: true }],
  execution_policy: {
    planner_recommendation: "cheap" as const,
    planner_confidence: "high" as const,
    recommendation_reasons: ["bounded fixture"],
    user_lock: null
  },
  limits: { max_attempts: 1, run_timeout_seconds: 60, max_changed_files: 5, max_diff_bytes: 1024 }
};

type FakeResult = {
  stdout: unknown;
  exitCode?: number;
};

const makeFixture = (fake: FakeResult): {
  root: string;
  outputPath: string;
  capturePath: string;
  entryPath: string;
  input: PlannerInput;
} => {
  const root = mkdtempSync(path.join(tmpdir(), "codebuddy-adapter-"));
  const capturePath = path.join(root, "argv.json");
  const entryPath = path.join(root, "codebuddy-entry.cjs");
  const stdout = JSON.stringify(fake.stdout);
  writeFileSync(entryPath, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ entry: process.argv[1], args: process.argv.slice(2) }));`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.exitCode = ${fake.exitCode ?? 0};`
  ].join("\n"), "utf8");
  const outputPath = path.join(root, "artifacts", "task-spec.json");
  return {
    root,
    outputPath,
    capturePath,
    entryPath,
    input: {
      cwd: root,
      model: "glm-5.3",
      reasoning: "low",
      timeoutSeconds: 20,
      schemaPath,
      outputPath,
      prompt: "Return the TaskSpec for TASK-001.",
      runId: `codebuddy-test-${Math.random().toString(16).slice(2)}`
    }
  };
};

const adapterFor = (entryPath: string): CodeBuddyAdapter => new CodeBuddyAdapter({
  executableResolver: () => ({ nodePath: process.execPath, entryPath }),
  proxyResolver: () => ({})
});

const terminal = (structuredOutput: unknown, usage: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: structuredOutput,
  usage
});

const readInvocation = (capturePath: string): { entry: string; args: string[] } =>
  JSON.parse(readFileSync(capturePath, "utf8")) as { entry: string; args: string[] };

const proposalRequest = {
  schema_version: "1.0" as const,
  task_id: "TASK-001",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  task_spec_sha256: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  goal: "Apply the bounded worker proposal to the fixture.",
  scope: { allowed_paths: ["src/**"], forbidden_paths: [".env"] },
  acceptance_criteria: [{ id: "AC-01", text: "The proposed change is schema-valid." }],
  context_files: [{
    path: "src/fixture.ts",
    byte_count: Buffer.byteLength("export const marker = 'source-only';\n", "utf8"),
    sha256: "c58ebec66d70eba2b8c5e893f31ae0f1804c50b1283c1e443832c7a2486b8a1d",
    content: "export const marker = 'source-only';\n"
  }],
  limits: { max_operations: 2, max_file_bytes: 1024, max_total_bytes: 2048 }
};

const changeSet = {
  schema_version: "1.0" as const,
  task_id: proposalRequest.task_id,
  base_sha: proposalRequest.base_sha,
  task_spec_sha256: proposalRequest.task_spec_sha256,
  status: "completed" as const,
  summary: "Prepared a bounded fixture change.",
  operations: [{
    type: "replace_file" as const,
    path: "src/fixture.ts",
    expected_sha256: proposalRequest.context_files[0].sha256,
    content: "export const marker = 'proposed';\n"
  }],
  acceptance_notes: [{ criterion_id: "AC-01", note: "The change set passed the adapter validator." }],
  risks: [],
  blocker: null
};

const makeProposalFixture = (fake: FakeResult): {
  root: string;
  runDirectory: string;
  outputPath: string;
  capturePath: string;
  entryPath: string;
  input: {
    request: typeof proposalRequest;
    runDirectory: string;
    model: string;
    reasoning: "low";
    timeoutSeconds: number;
    schemaPath: string;
    outputPath: string;
    runId: string;
  };
} => {
  const root = mkdtempSync(path.join(tmpdir(), "codebuddy-proposal-"));
  const runDirectory = path.join(root, "run");
  const capturePath = path.join(root, "invocation.json");
  const entryPath = path.join(root, "codebuddy-entry.cjs");
  const stdout = JSON.stringify(fake.stdout);
  writeFileSync(entryPath, [
    "const fs = require('node:fs');",
    `const args = process.argv.slice(2);`,
    `const systemPromptFlag = args.indexOf('--system-prompt-file');`,
    `const systemPromptPath = systemPromptFlag >= 0 ? args[systemPromptFlag + 1] : null;`,
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ cwd: process.cwd(), entry: process.argv[1], args, systemPrompt: systemPromptPath ? fs.readFileSync(systemPromptPath, 'utf8') : null }));`,
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.exitCode = ${fake.exitCode ?? 0};`
  ].join("\n"), "utf8");
  const outputPath = path.join(root, "artifacts", "change-set.json");
  return {
    root,
    runDirectory,
    outputPath,
    capturePath,
    entryPath,
    input: {
      request: proposalRequest,
      runDirectory,
      model: "glm-5.3",
      reasoning: "low",
      timeoutSeconds: 20,
      schemaPath: changeSetSchemaPath,
      outputPath,
      runId: `codebuddy-proposal-test-${Math.random().toString(16).slice(2)}`
    }
  };
};

const readProposalInvocation = (capturePath: string): { cwd: string; entry: string; args: string[]; systemPrompt: string | null } =>
  JSON.parse(readFileSync(capturePath, "utf8")) as { cwd: string; entry: string; args: string[]; systemPrompt: string | null };

describe("CodeBuddy read-only planner adapter", () => {
  it("builds fixed safe arguments and projects the supplied schema", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codebuddy-args-"));
    const projectedSource = path.join(dir, "schema.json");
    writeFileSync(projectedSource, JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "ignored",
      type: "object",
      properties: { name: { type: "string", minLength: 1, default: "ignored" } },
      required: ["name"],
      additionalProperties: false,
      uniqueItems: true
    }), "utf8");
    const args = buildCodeBuddyArgs({ model: "glm-5.3", reasoning: "low", schemaPath: projectedSource, prompt: "p" });
    const valueAfter = (flag: string): string => args[args.indexOf(flag) + 1] ?? "<missing>";

    expect(args.slice(0, 4)).toEqual(["--print", "--output-format", "json", "--model"]);
    expect(valueAfter("--model")).toBe("glm-5.3");
    expect(valueAfter("--effort")).toBe("low");
    expect(valueAfter("--permission-mode")).toBe("plan");
    expect(valueAfter("--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(valueAfter("--mcp-config")).toBe("{}");
    expect(args).toContain("--no-session-persistence");
    expect(valueAfter("--max-turns")).toBe("1");
    expect(valueAfter("--setting-sources")).toBe("");
    expect(valueAfter("--system-prompt")).toContain("read-only planner");
    expect(JSON.parse(valueAfter("--json-schema"))).toEqual({
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
      additionalProperties: false
    });
    expect(args.at(-1)).toBe("p");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("-y");
    expect(args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
  });

  it("runs the JavaScript entry through node, accepts an object terminal result, maps usage, and writes output", async () => {
    const fixture = makeFixture({ stdout: terminal(taskSpec, {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      cached_input_tokens: 3
    }) });
    const execution = await adapterFor(fixture.entryPath).runPlanner(fixture.input);
    expect(execution.output).toEqual(taskSpec);
    expect(execution.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 3 });
    expect(JSON.parse(readFileSync(fixture.outputPath, "utf8"))).toEqual(taskSpec);

    const invocation = readInvocation(fixture.capturePath);
    expect(path.resolve(invocation.entry)).toBe(path.resolve(fixture.entryPath));
    expect(invocation.args.at(0)).toBe("--print");
    expect(invocation.args.at(-1)).toBe(fixture.input.prompt);
  });

  it("accepts an array whose terminal result carries structured_output", async () => {
    const fixture = makeFixture({ stdout: [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "ignored prose" }] } },
      terminal(taskSpec, { input_tokens: 2, output_tokens: 4, total_tokens: 6, cache_read_input_tokens: 1 })
    ] });
    const execution = await adapterFor(fixture.entryPath).runPlanner(fixture.input);
    expect(execution.output.task_id).toBe("TASK-001");
    expect(execution.usage).toEqual({ inputTokens: 2, outputTokens: 4, totalTokens: 6, cachedInputTokens: 1 });
  });

  it("maps only explicit terminal usage and ignores malformed counters", () => {
    expect(parseCodeBuddyUsage(JSON.stringify(terminal(taskSpec, {
      input_tokens: 10, output_tokens: 2, total_tokens: 12, cache_read_input_tokens: 5, ignored: 99
    })))).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 5 });
    expect(parseCodeBuddyUsage(JSON.stringify(terminal(taskSpec, { input_tokens: -1, output_tokens: "2" })))).toBeNull();
    expect(parseCodeBuddyUsage("not json")).toBeNull();
  });

  it("treats a provider terminal error as a provider-neutral runtime error even when exit is zero", async () => {
    const fixture = makeFixture({ stdout: {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "account denied model",
      usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4 }
    } });
    await expect(adapterFor(fixture.entryPath).runPlanner(fixture.input)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentRunError);
      expect(error).not.toBeInstanceOf(AgentOutputError);
      expect((error as AgentRunError).result.status).toBe("SUCCEEDED");
      expect((error as Error).message).toContain("account denied model");
      return true;
    });
  });

  it("reports non-zero provider processes through the provider-neutral runtime error", async () => {
    const fixture = makeFixture({ stdout: "provider crashed", exitCode: 9 });
    await expect(adapterFor(fixture.entryPath).runPlanner(fixture.input)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentRunError);
      expect(error).not.toBeInstanceOf(AgentOutputError);
      expect((error as AgentRunError).result.status).toBe("FAILED");
      expect((error as AgentRunError).result.exitCode).toBe(9);
      return true;
    });
  });

  it.each([
    ["malformed JSON", "not json"],
    ["missing terminal result", [{ type: "assistant", message: { content: [] } }]],
    ["successful result without structured_output", { type: "result", subtype: "success", is_error: false }],
    ["invalid TaskSpec identity", terminal({ ...taskSpec, task_id: "bad" })],
    ["invalid TaskSpec schema", terminal({ ...taskSpec, limits: { ...taskSpec.limits, max_attempts: 0 } })]
  ])("rejects %s as provider-neutral output error", async (_name, stdout) => {
    const fixture = makeFixture({ stdout });
    await expect(adapterFor(fixture.entryPath).runPlanner(fixture.input)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentOutputError);
      expect(error).not.toBeInstanceOf(AgentRunError);
      expect((error as AgentOutputError).result.status).toBe("SUCCEEDED");
      return true;
    });
  });

  it("extracts only the terminal result object from object and array output", () => {
    const objectOutput = parseCodeBuddyOutput(JSON.stringify(terminal(taskSpec)));
    expect(objectOutput.kind).toBe("success");
    expect(objectOutput.structuredOutput).toEqual(taskSpec);
    const arrayOutput = parseCodeBuddyOutput(JSON.stringify([{ type: "message" }, terminal(taskSpec)]));
    expect(arrayOutput.kind).toBe("success");
    expect(arrayOutput.structuredOutput).toEqual(taskSpec);
  });

  it("builds a fixed proposal invocation with a projected change-set schema and no request content in argv", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codebuddy-proposal-args-"));
    const systemPromptPath = path.join(dir, "system-prompt.txt");
    const args = buildCodeBuddyProposalArgs({
      model: "glm-5.3",
      reasoning: "low",
      schemaPath: changeSetSchemaPath,
      systemPromptPath
    });
    const valueAfter = (flag: string): string => args[args.indexOf(flag) + 1] ?? "<missing>";

    expect(valueAfter("--model")).toBe("glm-5.3");
    expect(valueAfter("--effort")).toBe("low");
    expect(valueAfter("--permission-mode")).toBe("plan");
    expect(valueAfter("--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(valueAfter("--mcp-config")).toBe("{}");
    expect(args).toContain("--no-session-persistence");
    expect(valueAfter("--max-turns")).toBe("1");
    expect(valueAfter("--system-prompt-file")).toBe(systemPromptPath);
    expect(args).not.toContain("--system-prompt");
    expect(JSON.parse(valueAfter("--json-schema"))).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: expect.objectContaining({ task_id: { type: "string", pattern: expect.any(String) } })
    });
    expect(args.at(-1)).toBe("Return exactly one change-set JSON object.");
    expect(args.join("\n")).not.toContain("source-only");
    expect(args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
  });

  it("runs a proposal from an empty run directory, loads the bounded request from a system-prompt file, and writes the validated artifact", async () => {
    const fixture = makeProposalFixture({ stdout: terminal(changeSet, {
      input_tokens: 13,
      output_tokens: 8,
      total_tokens: 21,
      cached_input_tokens: 2
    }) });
    const execution = await adapterFor(fixture.entryPath).runProposal(fixture.input);
    expect(execution.output).toEqual(changeSet);
    expect(execution.usage).toEqual({ inputTokens: 13, outputTokens: 8, totalTokens: 21, cachedInputTokens: 2 });
    expect(JSON.parse(readFileSync(fixture.outputPath, "utf8"))).toEqual(changeSet);

    const invocation = readProposalInvocation(fixture.capturePath);
    expect(path.resolve(invocation.entry)).toBe(path.resolve(fixture.entryPath));
    expect(path.resolve(invocation.cwd)).toBe(path.resolve(fixture.runDirectory));
    expect(invocation.systemPrompt).toContain("WORKER_PROPOSAL_REQUEST_JSON");
    expect(invocation.systemPrompt).toContain("source-only");
    expect(invocation.args.join("\n")).not.toContain("source-only");
    expect(invocation.args.at(-1)).toBe("Return exactly one change-set JSON object.");
  });

  it("rejects an existing provider run directory before launching or overwriting files", async () => {
    const fixture = makeProposalFixture({ stdout: terminal(changeSet) });
    mkdirSync(fixture.runDirectory);
    const sentinel = path.join(fixture.runDirectory, "sentinel.txt");
    writeFileSync(sentinel, "keep\n", "utf8");

    await expect(adapterFor(fixture.entryPath).runProposal(fixture.input)).rejects.toThrow();
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
    expect(existsSync(fixture.capturePath)).toBe(false);
    expect(existsSync(path.join(fixture.runDirectory, "codebuddy-system-prompt.txt"))).toBe(false);
  });

  it.each([
    ["task identity", { ...changeSet, task_id: "TASK-DRIFT" }],
    ["base identity", { ...changeSet, base_sha: "fedcba9876543210fedcba9876543210fedcba98" }],
    ["TaskSpec identity", { ...changeSet, task_spec_sha256: "1111111111111111111111111111111111111111111111111111111111111111" }],
    ["file byte limit", { ...changeSet, operations: [{ ...changeSet.operations[0], content: "x".repeat(1025) }] }],
    ["operation count limit", { ...changeSet, operations: [changeSet.operations[0], changeSet.operations[0], changeSet.operations[0]] }]
  ])("rejects proposal output with %s before writing an artifact", async (_name, invalidOutput) => {
    const fixture = makeProposalFixture({ stdout: terminal(invalidOutput) });
    await expect(adapterFor(fixture.entryPath).runProposal(fixture.input)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CodeBuddyOutputError);
      expect((error as Error).message).toContain("OUTPUT_SCHEMA_INVALID");
      return true;
    });
    expect(() => readFileSync(fixture.outputPath, "utf8")).toThrow();
  });

  it("resolves only node.exe plus the expected JavaScript package entry", () => {
    const root = path.join(tmpdir(), "codebuddy-install");
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const nodePath = path.join(root, nodeName);
    const entryPath = path.join(root, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
    const expected = new Set([path.normalize(nodePath), path.normalize(entryPath)]);
    const fileExists = (candidate: string): boolean => expected.has(path.normalize(candidate));
    const resolved = resolveCodeBuddyExecutable({
      env: { Path: path.join(root, "bin") },
      fileExists
    });
    expect(path.normalize(resolved.nodePath)).toBe(path.normalize(nodePath));
    expect(path.normalize(resolved.entryPath)).toBe(path.normalize(entryPath));

    expect(() => resolveCodeBuddyExecutable({
      env: { PATH: path.join(root, "bin") },
      fileExists: (candidate) => path.normalize(candidate) === path.normalize(path.join(root, nodeName))
    })).toThrow("CodeBuddy node.exe and JavaScript entry were not found in PATH");
    expect(() => resolveCodeBuddyExecutable({
      env: { PATH: path.join(root, "bin") },
      fileExists: (candidate) => path.normalize(candidate) === path.normalize(entryPath)
    })).toThrow("CodeBuddy node.exe and JavaScript entry were not found in PATH");
  });
});
