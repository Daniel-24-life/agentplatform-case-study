import { describe, expect, it } from "vitest";

import { validateFinalGateResult as validateFinalGateResultCore } from "../../src/shared/core/final-gate.js";
import { validateWorkerResult } from "../../src/shared/core/worker-result.js";

type FinalGateContext = Parameters<typeof validateFinalGateResultCore>[1];

const defaultFinalGateContext: FinalGateContext = {
  taskId: "TASK-001",
  validCriterionIds: ["AC-01", "AC-02", "AC-03"],
  deterministicGatePassed: true,
  requiredTestsPassed: true,
  scopePassed: true
};

const validateFinalGateResult = (
  value: unknown,
  context: Partial<FinalGateContext> = {}
) => validateFinalGateResultCore(value, { ...defaultFinalGateContext, ...context });

describe("shared core worker result semantics", () => {
  const validWorkerResult = {
    schema_version: "1.0",
    task_id: "TASK-001",
    status: "completed",
    summary: "implemented repository health screen",
    changed_files: ["src/main/git/inspect.ts"],
    acceptance_notes: [{ criterion_id: "AC-01", note: "implemented" }],
    risks: [],
    blocker: null
  };

  it("accepts a valid WorkerResult", () => {
    const result = validateWorkerResult(validWorkerResult, { taskId: "TASK-001" });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.status).toBe("completed");
    }
  });

  it("requires blocker text for blocked status", () => {
    const blocked = { ...validWorkerResult, status: "blocked", blocker: null };
    const result = validateWorkerResult(blocked, { taskId: "TASK-001" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "blocker")).toBe(true);
    }
  });

  it("rejects a Windows-relative blocker path escape in changed_files", () => {
    const escaped = { ...validWorkerResult, changed_files: ["../outside"] };
    const result = validateWorkerResult(escaped, { taskId: "TASK-001" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some(
          (issue) => issue.path === "changed_files" || issue.path.startsWith("changed_files")
        )
      ).toBe(true);
    }
  });

  it("rejects task_id mismatch in worker result context", () => {
    const result = validateWorkerResult(validWorkerResult, { taskId: "TASK-999" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "task_id")).toBe(true);
    }
  });

  it("requires task context", () => {
    const result = validateWorkerResult(validWorkerResult, { taskId: "" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "context.taskId")).toBe(true);
    }
  });

  it("rejects blocker on completed status", () => {
    const blocked = { ...validWorkerResult, blocker: "not allowed" };
    const result = validateWorkerResult(blocked, { taskId: "TASK-001" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "blocker")).toBe(true);
    }
  });

  it("rejects duplicate acceptance note criterion ids", () => {
    const duplicated = {
      ...validWorkerResult,
      acceptance_notes: [
        { criterion_id: "AC-01", note: "one" },
        { criterion_id: "AC-01", note: "two" }
      ]
    };
    const result = validateWorkerResult(duplicated, { taskId: "TASK-001" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues[0]!.path).toBe("acceptance_notes");
    }
  });
});

describe("shared core final gate semantics", () => {
  const validFinalGate = {
    schema_version: "1.0",
    task_id: "TASK-001",
    verdict: "PASS",
    summary: "all acceptance criteria are satisfied",
    criteria: [
      { criterion_id: "AC-01", status: "satisfied", evidence: "ok" },
      { criterion_id: "AC-02", status: "satisfied", evidence: "ok" },
      { criterion_id: "AC-03", status: "satisfied", evidence: "ok" }
    ],
    findings: [{ severity: "low", message: "minor issue", file: "src/main/index.ts", line: 8 }],
    test_assessment: "all tests passed",
    scope_assessment: "scope respected",
    rework_instructions: []
  };

  it("accepts PASS only with satisfied criteria and no blocking findings", () => {
    const result = validateFinalGateResult(validFinalGate, {
      taskId: "TASK-001",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.verdict).toBe("PASS");
    }
  });

  it("rejects PASS when criteria are unsatisfied", () => {
    const unsatisfied = {
      ...validFinalGate,
      verdict: "PASS",
      criteria: [
        { criterion_id: "AC-01", status: "unsatisfied", evidence: "not done" },
        { criterion_id: "AC-02", status: "satisfied", evidence: "ok" },
        { criterion_id: "AC-03", status: "satisfied", evidence: "ok" }
      ]
    };
    const result = validateFinalGateResult(unsatisfied, {
      taskId: "TASK-001",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "verdict")).toBe(true);
    }
  });

  it("rejects PASS when criteria are incomplete against valid criterion set", () => {
    const incomplete = {
      ...validFinalGate,
      criteria: [{ criterion_id: "AC-01", status: "satisfied", evidence: "ok" }]
    };
    const result = validateFinalGateResult(incomplete, {
      taskId: "TASK-001",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "criteria")).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("missing criteria"))).toBe(true);
    }
  });

  it("rejects final gate with criterion ids outside configured set", () => {
    const invalid = {
      ...validFinalGate,
      criteria: [
        { criterion_id: "AC-01", status: "satisfied", evidence: "ok" },
        { criterion_id: "AC-02", status: "satisfied", evidence: "ok" },
        { criterion_id: "AC-99", status: "satisfied", evidence: "ok" }
      ]
    };
    const result = validateFinalGateResult(invalid, {
      taskId: "TASK-001",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "criteria")).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("unexpected criteria"))).toBe(true);
    }
  });

  it("rejects final gate result for mismatched task_id context", () => {
    const result = validateFinalGateResult(validFinalGate, {
      taskId: "TASK-999",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "task_id")).toBe(true);
    }
  });

  it("rejects PASS with high findings", () => {
    const withBlockingFinding = {
      ...validFinalGate,
      verdict: "PASS",
      findings: [
        { severity: "high", message: "runtime bug", file: "src/main/index.ts", line: 20 }
      ],
      rework_instructions: ["none"]
    };
    const result = validateFinalGateResult(withBlockingFinding, {
      taskId: "TASK-001",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "verdict")).toBe(true);
    }
  });

  it("rejects REWORK without unsatisfied criteria, non-low findings, or rework instructions", () => {
    const rework = {
      ...validFinalGate,
      verdict: "REWORK",
      criteria: [
        { criterion_id: "AC-01", status: "satisfied", evidence: "ok" },
        { criterion_id: "AC-02", status: "satisfied", evidence: "ok" },
        { criterion_id: "AC-03", status: "satisfied", evidence: "ok" }
      ]
    };
    const result = validateFinalGateResult(rework, {
      taskId: "TASK-001",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.issues.some((issue) => issue.path === "verdict")
      ).toBe(true);
    }
  });

  it("allows REWORK with satisfied criteria when non-low finding exists", () => {
    const withNonLowFinding = {
      ...validFinalGate,
      verdict: "REWORK",
      findings: [
        { severity: "high", message: "runtime issue", file: "src/main/index.ts", line: 11 }
      ]
    };
    const result = validateFinalGateResult(withNonLowFinding, {
      taskId: "TASK-001",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(true);
  });

  it("requires final gate context", () => {
    const result = validateFinalGateResult(validFinalGate, {
      taskId: "",
      validCriterionIds: ["AC-01", "AC-02", "AC-03"]
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "context.taskId")).toBe(true);
    }
  });

  it.each([
    ["deterministicGatePassed", false],
    ["requiredTestsPassed", false],
    ["scopePassed", false]
  ] as const)("rejects PASS when %s is false", (field, value) => {
    const result = validateFinalGateResult(validFinalGate, { [field]: value });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "verdict")).toBe(true);
    }
  });
});
