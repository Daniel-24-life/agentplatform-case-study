import { ValidationIssue, ValidationResult, validateWorkerResultInstance } from "./schema-validation.js";
import { isRelativeSafePath } from "./paths.js";

export type WorkerStatus = "completed" | "blocked" | "failed";
export type WorkerResult = {
  schema_version: "1.0";
  task_id: string;
  status: WorkerStatus;
  summary: string;
  changed_files: string[];
  acceptance_notes: WorkerAcceptanceNote[];
  risks: string[];
  blocker: string | null;
};

export type WorkerAcceptanceNote = {
  criterion_id: string;
  note: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateWorkerResult = (
  value: unknown,
  context: { taskId: string }
): ValidationResult<WorkerResult> => {
  if (!context || typeof context.taskId !== "string" || context.taskId.length === 0) {
    return {
      valid: false,
      issues: [{ path: "context.taskId", message: "context.taskId is required" }]
    };
  }

  const schemaResult = validateWorkerResultInstance(value);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  const issues: ValidationIssue[] = [];
  const result = schemaResult.value as WorkerResult;

  if (result.task_id !== context.taskId) {
    addIssue(issues, "task_id", "task_id must match task context");
  }
  if (!taskIdPattern.test(result.task_id)) {
    addIssue(issues, "task_id", "task_id invalid");
  }

  if (!result.changed_files.every((entry) => isRelativeSafePath(entry))) {
    addIssue(issues, "changed_files", "changed_files entries must be safe relative paths");
  }
  if (new Set(result.changed_files).size !== result.changed_files.length) {
    addIssue(issues, "changed_files", "changed_files must be unique");
  }

  result.acceptance_notes.forEach((note, index) => {
    if (!isRecord(note) || !criterionIdPattern.test(note.criterion_id)) {
      addIssue(issues, `acceptance_notes[${index}]`, "acceptance note invalid");
      return;
    }
    if (typeof note.note !== "string" || note.note.length < 1 || note.note.length > 2000) {
      addIssue(issues, `acceptance_notes[${index}].note`, "note must be 1..2000 chars");
    }
  });

  const dupNotes = result.acceptance_notes
    .map((note) => note.criterion_id)
    .filter((id, index, list) => list.indexOf(id) !== index);
  if (dupNotes.length > 0) {
    addIssue(issues, "acceptance_notes", `criterion_id values must be unique: ${[...new Set(dupNotes)].join(", ")}`);
  }

  if (result.status === "blocked" && (typeof result.blocker !== "string" || result.blocker.length === 0)) {
    addIssue(issues, "blocker", "blocked status requires blocker text");
  }
  if (result.status !== "blocked" && typeof result.blocker === "string") {
    addIssue(issues, "blocker", "blocker can only be provided for blocked status");
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return { valid: true, value: result };
};
