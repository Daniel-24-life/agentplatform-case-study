import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  validateContextPaths,
  validateTaskSpec,
  validateLegacyTaskSpecReadOnly,
  validateTaskSpecIdentity,
  validateExpectedTaskSpecIdentity
} from "../../src/shared/core/task-spec.js";
import { loadTaskSpecSchema } from "../../src/shared/core/schema-validation.js";

const exampleTaskSpec = JSON.parse(
  readFileSync(join(process.cwd(), "examples", "task-spec.example.json"), "utf8")
) as Record<string, unknown>;
const v2TaskSpec = (() => {
  const rest = { ...exampleTaskSpec };
  delete rest.worker;
  return {
    ...rest,
    schema_version: "2.0",
    execution_policy: {
      planner_recommendation: "cheap",
      planner_confidence: "high",
      recommendation_reasons: ["bounded change"],
      user_lock: null
    }
  } as Record<string, unknown>;
})();
const legacyTaskSpec: Record<string, unknown> = {
  schema_version: "1.0",
  task_id: "TASK-LEGACY01",
  title: "Legacy fixture",
  goal: "Validate the historical read-only contract.",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  context_paths: ["src"],
  scope: { allowed_paths: ["src/**"], forbidden_paths: [".env"] },
  acceptance_criteria: [{ id: "AC-01", text: "The legacy contract validates." }],
  test_commands: [{ id: "unit", program: "pnpm", args: ["test"], cwd: ".", timeout_seconds: 60, required: true }],
  worker: { adapter: "codex", model: "gpt-5.3-codex", reasoning: "low" },
  limits: { max_attempts: 2, run_timeout_seconds: 60, max_changed_files: 10, max_diff_bytes: 1024 }
};

describe("shared core task-spec", () => {
  const withCustomScope = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...v2TaskSpec,
    ...overrides,
    scope: {
      ...exampleTaskSpec.scope,
      ...overrides.scope
    }
  }) as Record<string, unknown>;

  it("validates example task spec", () => {
    const result = validateTaskSpec(v2TaskSpec);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.schema_version).toBe("2.0");
      expect(result.value.execution_policy.planner_recommendation).toBe("cheap");
    }
  });

  it("checks schema authority for task-spec schema file", () => {
    const schemaResult = loadTaskSpecSchema();
    expect(schemaResult.valid).toBe(true);
    if (schemaResult.valid) {
      expect(schemaResult.value["title"]).toBe("AgentPlatform TaskSpec");
      expect(
        (schemaResult.value["required"] as string[] | undefined)?.includes("task_id")
      ).toBe(true);
    }
  });

  it("rejects malformed task fields", () => {
    const malformed = {
      ...v2TaskSpec,
      task_id: "bad-id",
      test_commands: [
        {
          id: "unit",
          program: "pnpm",
          args: [],
          cwd: ".",
          timeout_seconds: 10,
          required: true
        },
        {
          id: "unit",
          program: "pnpm",
          args: [],
          cwd: "src/main",
          timeout_seconds: 10,
          required: true
        }
      ]
    } as Record<string, unknown>;
    const result = validateTaskSpec(malformed);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const issuePaths = result.issues.map((issue) => issue.path);
      expect(issuePaths).toContain("task_id");
    }
  });

  it("enforces unique acceptance criterion ids", () => {
    const duplicated = withCustomScope({
      acceptance_criteria: [
        { id: "AC-01", text: "A" },
        { id: "AC-01", text: "B" }
      ]
    });
    const result = validateTaskSpec(duplicated);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues[0]!.message).toContain("acceptance criterion ids must be unique");
    }
  });

  it("enforces test command id uniqueness", () => {
    const duplicated = withCustomScope({
      test_commands: [
        {
          id: "unit",
          program: "pnpm",
          args: ["test"],
          cwd: "src/shared/core",
          timeout_seconds: 120,
          required: true
        },
        {
          id: "unit",
          program: "pnpm",
          args: ["test"],
          cwd: "src/shared/core",
          timeout_seconds: 120,
          required: true
        }
      ]
    });
    const result = validateTaskSpec(duplicated);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "test_commands")).toBe(true);
    }
  });

  it("allows read-only context paths outside write scope", () => {
    const value = withCustomScope({ context_paths: ["schemas/task-spec.schema.json"] });
    expect(validateTaskSpec(value).valid).toBe(true);
  });

  it("allows test cwd outside write scope when it remains repository-relative", () => {
    const value = withCustomScope({
      test_commands: [{ id: "unit", program: "pnpm", args: ["test"], cwd: ".", timeout_seconds: 120, required: true }]
    });
    expect(validateTaskSpec(value).valid).toBe(true);
  });

  it("validates expected task identity with stable mismatch messages", () => {
    const expected = { taskId: "TASK-EXPECTED", baseSha: "a".repeat(40) };
    expect(validateTaskSpecIdentity({ task_id: expected.taskId, base_sha: expected.baseSha }, expected).valid).toBe(true);
    const result = validateTaskSpecIdentity({ task_id: "TASK-OTHER", base_sha: "b".repeat(40) }, expected);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.message)).toEqual(["TASK_ID_MISMATCH", "BASE_SHA_MISMATCH"]);
    expect(validateExpectedTaskSpecIdentity({ task_id: expected.taskId, base_sha: expected.baseSha }, expected).valid).toBe(true);
  });

  it.each(["", "/tmp", "../outside", "C:\\\\repo"])("rejects unsafe test command cwd %s", (cwd) => {
    const value = withCustomScope({ test_commands: [{ id: "unit", program: "pnpm", args: ["test"], cwd, timeout_seconds: 60, required: true }] });
    expect(validateTaskSpec(value).valid).toBe(false);
  });

  it("accepts structured commands and rejects shell-shaped programs", () => {
    expect(validateTaskSpec(withCustomScope({ test_commands: [{ id: "unit", program: "pnpm", args: ["test"], cwd: ".", timeout_seconds: 60, required: true }] })).valid).toBe(true);
    expect(validateTaskSpec(withCustomScope({ test_commands: [{ id: "unit", program: "pnpm test", args: [], cwd: ".", timeout_seconds: 60, required: true }] })).valid).toBe(false);
  });

  it("rejects boundary-escaping paths", () => {
    const check = validateContextPaths("C:\\repo\\example", [
      "src/main",
      "../outside",
      "safe/../invalid"
    ]);

    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.issues).toHaveLength(2);
      expect(check.issues.some((issue) => issue.path === "paths[1]")).toBe(true);
      expect(check.issues.some((issue) => issue.path === "paths[2]")).toBe(true);
    }
  });

  it("reads v1 TaskSpec without rewriting it", () => {
    const result = validateLegacyTaskSpecReadOnly(legacyTaskSpec);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toEqual(legacyTaskSpec);
  });

  it("strictly rejects legacy TaskSpec extra fields and unsafe paths", () => {
    const extra = { ...legacyTaskSpec, unexpected: true };
    expect(validateLegacyTaskSpecReadOnly(extra).valid).toBe(false);
    const unsafe = JSON.parse(JSON.stringify(legacyTaskSpec)) as Record<string, unknown>;
    (unsafe.scope as Record<string, unknown>).allowed_paths = ["../outside"];
    expect(validateLegacyTaskSpecReadOnly(unsafe).valid).toBe(false);
  });

  it("allows the v2 maximum of three attempts", () => {
    const value = withCustomScope({ limits: { ...v2TaskSpec.limits as Record<string, unknown>, max_attempts: 3 } });
    expect(validateTaskSpec(value).valid).toBe(true);
  });
});
