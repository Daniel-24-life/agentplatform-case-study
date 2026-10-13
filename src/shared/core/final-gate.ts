import { ValidationIssue, ValidationResult, validateFinalGateInstance } from "./schema-validation.js";

export type FinalVerdict = "PASS" | "REWORK" | "BLOCKED";
export type CriterionStatus = "satisfied" | "unsatisfied" | "uncertain";
export type FindingSeverity = "critical" | "high" | "medium" | "low";

export type CriterionAssessment = {
  criterion_id: string;
  status: CriterionStatus;
  evidence: string;
};

export type Finding = {
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  message: string;
};

export type FinalGateResult = {
  schema_version: "1.0";
  task_id: string;
  verdict: FinalVerdict;
  summary: string;
  criteria: CriterionAssessment[];
  findings: Finding[];
  test_assessment: string;
  scope_assessment: string;
  rework_instructions: string[];
};

const taskIdPattern = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;
const criterionIdPattern = /^AC-[0-9]{2,3}$/;

const addIssue = (
  issues: ValidationIssue[],
  pathLabel: string,
  message: string
): void => {
  issues.push({ path: pathLabel, message });
};

const hasDuplicate = (items: string[]): boolean => new Set(items).size !== items.length;

export const validateFinalGateResult = (
  value: unknown,
  context: {
    taskId: string;
    validCriterionIds: readonly string[];
    deterministicGatePassed: boolean;
    requiredTestsPassed: boolean;
    scopePassed: boolean;
  }
): ValidationResult<FinalGateResult> => {
  if (!context || typeof context.taskId !== "string" || context.taskId.length === 0) {
    return {
      valid: false,
      issues: [{ path: "context.taskId", message: "context.taskId is required" }]
    };
  }
  if (!Array.isArray(context.validCriterionIds)) {
    return {
      valid: false,
      issues: [{ path: "context.validCriterionIds", message: "context.validCriterionIds is required" }]
    };
  }
  if (context.validCriterionIds.length === 0) {
    return {
      valid: false,
      issues: [{ path: "context.validCriterionIds", message: "context.validCriterionIds must not be empty" }]
    };
  }
  if (new Set(context.validCriterionIds).size !== context.validCriterionIds.length) {
    return {
      valid: false,
      issues: [{ path: "context.validCriterionIds", message: "context.validCriterionIds must be unique" }]
    };
  }
  for (const field of ["deterministicGatePassed", "requiredTestsPassed", "scopePassed"] as const) {
    if (typeof context[field] !== "boolean") {
      return {
        valid: false,
        issues: [{ path: `context.${field}`, message: `context.${field} is required` }]
      };
    }
  }

  const schemaResult = validateFinalGateInstance(value);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  const issues: ValidationIssue[] = [];
  const result = schemaResult.value as FinalGateResult;
  const expectedCriteria = context.validCriterionIds;

  if (result.task_id !== context.taskId) {
    addIssue(issues, "task_id", "task_id must match task context");
  }
  if (!taskIdPattern.test(result.task_id)) {
    addIssue(issues, "task_id", "task_id invalid");
  }

  if (result.criteria.some((criterion) => !criterionIdPattern.test(criterion.criterion_id))) {
    addIssue(issues, "criteria", "criterion_id must match AC-xx");
  }

  const criterionIds = result.criteria.map((criterion) => criterion.criterion_id);
  if (hasDuplicate(criterionIds)) {
    addIssue(issues, "criteria", "criterion_id values must be unique");
  }

  if (expectedCriteria.length > 0) {
    const expectedSet = new Set(expectedCriteria);
    const actualSet = new Set(criterionIds);
    const missing = [...expectedSet].filter((criterionId) => !actualSet.has(criterionId));
    const extra = [...actualSet].filter((criterionId) => !expectedSet.has(criterionId));
    if (missing.length > 0) {
      addIssue(issues, "criteria", `missing criteria: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      addIssue(issues, "criteria", `unexpected criteria: ${extra.join(", ")}`);
    }
  }

  if (result.verdict === "PASS") {
    const hasUnmet = result.criteria.some((criterion) => criterion.status !== "satisfied");
    const hasBlockingFinding = result.findings.some(
      (finding) => finding.severity === "critical" || finding.severity === "high" || finding.severity === "medium"
    );
    if (hasUnmet || hasBlockingFinding) {
      addIssue(issues, "verdict", "PASS requires satisfied criteria only and no blocking findings");
    }
    if (!context.deterministicGatePassed || !context.requiredTestsPassed || !context.scopePassed) {
      addIssue(
        issues,
        "verdict",
        "PASS requires a passing deterministic gate, required tests, and scope check"
      );
    }
  }

  if (result.verdict === "REWORK") {
    const hasGap = result.criteria.some((criterion) => criterion.status !== "satisfied");
    const hasNonLowFinding = result.findings.some((finding) => finding.severity !== "low");
    const hasReworkInstruction = result.rework_instructions.length > 0;

    if (!hasGap && !hasNonLowFinding && !hasReworkInstruction) {
      addIssue(
        issues,
        "verdict",
        "REWORK requires at least one unsatisfied criterion, non-low finding, or rework instruction"
      );
    }
  }

  if (result.verdict === "PASS" && result.rework_instructions.length) {
    addIssue(issues, "verdict", "PASS verdict must not include rework_instructions");
  }

  if (result.verdict === "BLOCKED" && result.rework_instructions.length > 0) {
    addIssue(issues, "verdict", "BLOCKED verdict does not allow rework_instructions");
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    value: {
      schema_version: result.schema_version,
      task_id: result.task_id,
      verdict: result.verdict,
      summary: result.summary,
      criteria: result.criteria,
      findings: result.findings,
      test_assessment: result.test_assessment,
      scope_assessment: result.scope_assessment,
      rework_instructions: [...result.rework_instructions]
    }
  };
};
