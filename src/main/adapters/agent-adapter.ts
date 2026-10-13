import type { ReasoningLevel, TaskSpec } from "../../shared/core/task-spec.js";
import type { FinalGateResult } from "../../shared/core/final-gate.js";
import { validateFinalGateResult } from "../../shared/core/final-gate.js";
import type { WorkerResult } from "../../shared/core/worker-result.js";
import type { ProcessResult } from "../process/runner.js";
import type { FailureClassification } from "../../shared/core/failure-taxonomy.js";

/** Provider-neutral failure raised when an agent process does not complete. */
export class AgentRunError extends Error {
  readonly result: ProcessResult;
  readonly classification: FailureClassification;

  constructor(message: string, result: ProcessResult, classification: FailureClassification, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRunError";
    this.result = result;
    this.classification = classification;
  }
}

/** Provider-neutral failure raised when a successful process emits invalid output. */
export class AgentOutputError extends Error {
  readonly result: ProcessResult;
  readonly classification: FailureClassification;

  constructor(message: string, result: ProcessResult, classification: FailureClassification, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentOutputError";
    this.result = result;
    this.classification = classification;
  }
}

export type AgentCommandInput = {
  cwd: string;
  model: string;
  reasoning?: ReasoningLevel;
  timeoutSeconds?: number;
  schemaPath: string;
  outputPath: string;
  prompt: string;
  hashOnlyLogs?: boolean;
  runId?: string;
  onSpawn?: (_pid: number | null) => void;
  onOutput?: (_stream: "stdout" | "stderr", _atMs: number, _bytes: number) => void;
};

export type PlannerInput = AgentCommandInput;
export type WorkerInput = AgentCommandInput & { taskId: string };
export type ReviewerInput = AgentCommandInput & {
  context: Parameters<typeof validateFinalGateResult>[1];
};

export type AgentExecution<T> = {
  output: T;
  process: ProcessResult;
  /** Token counts reported by the provider; null when the provider reports none. */
  usage: AgentUsage | null;
};

export type AgentUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
};

export interface AgentAdapter {
  readonly id: string;
}

export interface PlannerAgentAdapter extends AgentAdapter {
  runPlanner(_input: PlannerInput): Promise<AgentExecution<TaskSpec>>;
}

export interface WorkerAgentAdapter extends AgentAdapter {
  runWorker(_input: WorkerInput): Promise<AgentExecution<WorkerResult>>;
}

export interface ReviewerAgentAdapter extends AgentAdapter {
  runReviewer(_input: ReviewerInput): Promise<AgentExecution<FinalGateResult>>;
}
