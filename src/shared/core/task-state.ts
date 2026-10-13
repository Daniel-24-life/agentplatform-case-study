import { ValidationResult } from "./schema-validation.js";

export const TASK_STATUSES = [
  "DRAFT","DESIGNING","SPEC_READY","SPEC_INVALID","SPEC_APPROVED","PREPARING_WORKTREE","BUILDING","BUILT","TESTING","DETERMINISTIC_GATE","GATE_READY","REVIEWING","PASSED","REWORK","FAILED","BLOCKED","CANCELLED","INTERRUPTED"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  DRAFT: ["DESIGNING"],
  DESIGNING: ["SPEC_READY", "SPEC_INVALID", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  SPEC_READY: ["SPEC_APPROVED", "DRAFT", "CANCELLED"],
  SPEC_INVALID: [],
  SPEC_APPROVED: ["PREPARING_WORKTREE", "BLOCKED", "CANCELLED"],
  PREPARING_WORKTREE: ["BUILDING", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  BUILDING: ["BUILT", "REWORK", "BLOCKED", "FAILED", "CANCELLED", "INTERRUPTED"],
  BUILT: ["TESTING", "BLOCKED", "FAILED", "CANCELLED"],
  TESTING: ["DETERMINISTIC_GATE", "BLOCKED", "FAILED", "CANCELLED", "INTERRUPTED"],
  DETERMINISTIC_GATE: ["GATE_READY", "REWORK", "BLOCKED", "FAILED", "CANCELLED", "INTERRUPTED"],
  GATE_READY: ["REVIEWING", "BLOCKED", "CANCELLED"],
  REVIEWING: ["PASSED", "REWORK", "BLOCKED", "CANCELLED", "INTERRUPTED"],
  PASSED: [],
  REWORK: ["PREPARING_WORKTREE", "BLOCKED", "CANCELLED"],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
  INTERRUPTED: []
};

export const isTerminalTaskStatus = (status: TaskStatus): boolean => {
  return status === "PASSED" || status === "FAILED" || status === "BLOCKED" || status === "CANCELLED" || status === "SPEC_INVALID" || status === "INTERRUPTED";
};

export const validateTaskStatusTransition = (current: unknown,next: unknown): ValidationResult<TaskStatus> => {
  if (typeof current !== "string" || !TASK_STATUSES.includes(current as TaskStatus)) return {valid:false,issues:[{path:"status",message:`${current} is not a recognized task status`}]};
  if (typeof next !== "string" || !TASK_STATUSES.includes(next as TaskStatus)) return {valid:false,issues:[{path:"status",message:`${next} is not a recognized task status`}]};
  const allowed=TASK_STATUS_TRANSITIONS[current as TaskStatus];
  if(allowed.includes(next as TaskStatus))return{valid:true,value:next as TaskStatus};
  return{valid:false,issues:[{path:"status",message:`${current} -> ${next} is not an allowed transition`}]};
};
