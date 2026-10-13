import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadAgentResultSchema,
  loadFinalGateSchema,
  loadTaskSpecSchema,
  validateAgentResultSchema,
  validateWorkerResultInstance,
  validateFinalGateInstance,
  validateTaskSpecInstance,
  validateFinalGateSchema,
  validateTaskSpecSchema,
  validateStructuredOutputCompatibility
} from "../../src/shared/core/schema-validation.js";

const loadSchema = (fileName: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", fileName), "utf8")) as Record<
    string,
    unknown
  >;
const loadTaskSpecFixture = (): Record<string, unknown> =>
  (() => { const legacy = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "examples", "task-spec.example.json"), "utf8")
  ) as Record<string, unknown>; delete legacy.worker; return { ...legacy, schema_version: "2.0", execution_policy: { planner_recommendation: "cheap", planner_confidence: "high", recommendation_reasons: ["bounded"], user_lock: null } }; })();

describe("shared core schema validation authority", () => {
  it.each([
    ["task-spec", loadTaskSpecSchema, validateTaskSpecSchema, "task-spec.schema.json"],
    ["agent-result", loadAgentResultSchema, validateAgentResultSchema, "agent-result.schema.json"],
    ["final-gate", loadFinalGateSchema, validateFinalGateSchema, "final-gate.schema.json"]
  ])("loads valid schema for %s", (_name, _loadSchemaFn, _validateFn, _fileName) => {
    const schemaResult = _loadSchemaFn();
    expect(schemaResult.valid).toBe(true);
  });

  it("loads schema independent of process.cwd", () => {
    const original = process.cwd();
    process.chdir(os.tmpdir());
    const taskSpecResult = loadTaskSpecSchema();
    process.chdir(original);

    expect(taskSpecResult.valid).toBe(true);
  });

  it("loads schema from explicit schemaRoot", () => {
    const explicit = path.join(process.cwd(), "schemas");
    const result = loadTaskSpecSchema({ schemaRoot: explicit });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.$id).toBe("https://agentplatform.local/schemas/task-spec.schema.json");
    }
  });

  it("flags schema-version drift", () => {
    const schema = loadSchema("task-spec.schema.json");
    schema.schema_version = "0.9";
    const result = validateTaskSpecSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.path).toBe("schema_version");
  });

  it("flags schema authority violations across each schema", () => {
    const taskSchema = loadSchema("task-spec.schema.json");
    const taskBad = { ...taskSchema, title: "Wrong title" };
    expect(validateTaskSpecSchema(taskBad).valid).toBe(false);

    const agentSchema = loadSchema("agent-result.schema.json");
    const agentBad = { ...agentSchema, $schema: "https://json-schema.org/draft-07/schema#" };
    expect(validateAgentResultSchema(agentBad).valid).toBe(false);

    const gateSchema = loadSchema("final-gate.schema.json");
    if (Array.isArray((gateSchema as { required: unknown }).required)) {
      const gateBad = {
        ...gateSchema,
        required: (gateSchema.required as string[]).filter((name) => name !== "criteria")
      };
      expect(validateFinalGateSchema(gateBad).valid).toBe(false);
    }
  });

  it("flags additionalProperties false violations", () => {
    const schema = loadSchema("agent-result.schema.json");
    schema.additionalProperties = true;
    const result = validateAgentResultSchema(schema);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path === "additionalProperties")).toBe(true);
  });

  it.each([
    ["task-spec", "task-spec.schema.json"],
    ["agent-result", "agent-result.schema.json"],
    ["final-gate", "final-gate.schema.json"]
  ])("enforces %s object and explicit const/enum type invariants", (_name, fileName) => {
    const schema = loadSchema(fileName);
    expect(validateStructuredOutputCompatibility(schema).valid).toBe(true);

    const missingType = structuredClone(schema);
    const status = fileName === "agent-result.schema.json"
      ? ((missingType.properties as Record<string, unknown>).status as Record<string, unknown>)
      : ((missingType.properties as Record<string, unknown>).schema_version as Record<string, unknown>);
    delete status.type;
    expect(validateStructuredOutputCompatibility(missingType).valid).toBe(false);

    const optionalProperty = structuredClone(schema);
    const required = optionalProperty.required as string[];
    required.pop();
    expect(validateStructuredOutputCompatibility(optionalProperty).valid).toBe(false);

    const permissiveObject = structuredClone(schema);
    const objectSchema = fileName === "final-gate.schema.json"
      ? ((((permissiveObject.properties as Record<string, unknown>).findings as Record<string, unknown>).items) as Record<string, unknown>)
      : permissiveObject;
    objectSchema.additionalProperties = true;
    expect(validateStructuredOutputCompatibility(permissiveObject).valid).toBe(false);
  });

  it("validates TaskSpec instances with strict Draft 2020-12 and rejects numeric coercion", () => {
    const schemaResult = loadTaskSpecSchema();
    expect(schemaResult.valid).toBe(true);

    const taskSpec = loadTaskSpecFixture();
    const badTaskSpec = JSON.parse(JSON.stringify(taskSpec)) as Record<string, unknown>;
    const acceptanceCriteria = badTaskSpec.acceptance_criteria as Array<{ id: string; text: string }>;
    acceptanceCriteria[0]!.id = "AC-01";

    const testCommands = badTaskSpec.test_commands as Array<{ timeout_seconds: number | string }>;
    testCommands[0]!.timeout_seconds = "120";

    const result = validateTaskSpecInstance(badTaskSpec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some((issue) => issue.path.includes("timeout_seconds") || issue.path.startsWith("test_commands"))
      ).toBe(true);
    }
  });

  it("validates WorkerResult instances strictly without mutation", () => {
    const workerResult = {
      schema_version: "1.0",
      task_id: "TASK-001",
      status: "completed",
      summary: "ok",
      changed_files: ["src/main/index.ts"],
      acceptance_notes: [{ criterion_id: "AC-01", note: "done" }],
      risks: [],
      blocker: null
    };
    const result = validateWorkerResultInstance(workerResult);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual(workerResult);
    }
  });

  it("validates FinalGateResult instances without adding defaults", () => {
    const finalGate = {
      schema_version: "1.0",
      task_id: "TASK-001",
      verdict: "PASS",
      summary: "ok",
      criteria: [{ criterion_id: "AC-01", status: "satisfied", evidence: "ok" }],
      findings: [],
      test_assessment: "all good",
      scope_assessment: "in scope",
      rework_instructions: []
    };
    const result = validateFinalGateInstance(finalGate);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual(finalGate);
      expect(result.value.rework_instructions).toEqual([]);
    }
  });
});
