import type { ReasoningLevel, TaskSpec } from "../../shared/core/task-spec.js";

export type WorkerClass = "cheap" | "strong";

export type WorkerProfile = {
  adapterId: string;
  model: string;
  reasoning: ReasoningLevel;
  highTier: boolean;
};

export type WorkerProfiles = {
  cheap: WorkerProfile;
  strong: WorkerProfile;
};

export type PreviousOutcome = {
  workerClass?: WorkerClass;
  status?: "succeeded" | "failed" | "blocked" | "cancelled";
  failureKind?: string;
  hardFailure?: boolean;
  requiresEscalation?: boolean;
  escalationApproved?: boolean;
};

export type WorkerRouteRequest = {
  taskSpec: TaskSpec;
  attemptNumber: number;
  previousOutcome?: PreviousOutcome;
};

export type WorkerRouteDecision = WorkerProfile & {
  workerClass: WorkerClass;
  escalation: boolean;
  reasonCodes: string[];
  userLocked: boolean;
  /** A blocked decision is an audit result, never an instruction to run a worker. */
  blocked?: boolean;
  requiresApproval?: boolean;
};

const HARD_FAILURES = new Set([
  "base_drift",
  "scope_violation",
  "evidence_invalid",
  "evidence_corrupt",
  "path_escape",
  "security_violation",
  "invalid_task",
  "cli_not_found",
  "cli_not_authenticated",
  "model_unavailable",
  "quota_exhausted",
  "rate_limited",
  "transport_failure",
  "process_timeout",
  "process_cancelled",
  "run_interrupted",
  "process_start_failed",
  "model_runtime_failed",
]);

export const DEFAULT_WORKER_PROFILES: WorkerProfiles = {
  cheap: { adapterId: "cheap-worker", model: "gpt-5.5", reasoning: "low", highTier: false },
  strong: { adapterId: "codex", model: "gpt-5.6-sol", reasoning: "medium", highTier: true },
};

const NON_RUNTIME_FAILURE_CODES = new Map<string, { retry: string; escalation: string }>([
  ["worker_noop", { retry: "NOOP_RETRY", escalation: "NOOP_ESCALATION" }],
  ["claimed_change_without_diff", { retry: "CLAIMED_CHANGE_RETRY", escalation: "CLAIMED_CHANGE_ESCALATION" }],
]);

const blockedDecision = (profile: WorkerProfile, codes: string[], locked = false, workerClass: WorkerClass = "cheap"): WorkerRouteDecision => ({
  ...profile,
  workerClass,
  escalation: false,
  reasonCodes: codes,
  userLocked: locked,
  blocked: true,
});

export class WorkerRouter {
  private readonly profiles: WorkerProfiles;

  constructor(profiles: Partial<WorkerProfiles> = {}) {
    this.profiles = { ...DEFAULT_WORKER_PROFILES, ...profiles };
  }

  decide(request: WorkerRouteRequest): WorkerRouteDecision {
    const { taskSpec, attemptNumber, previousOutcome } = request;
    const policy = taskSpec.execution_policy;
    const locked = policy?.user_lock ?? null;
    const reasons: string[] = [];

    if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
      return blockedDecision(this.profiles.cheap, ["INVALID_ATTEMPT_NUMBER"], locked !== null);
    }
    if (!policy || (policy.planner_recommendation !== "cheap" && policy.planner_recommendation !== "strong")) {
      return blockedDecision(this.profiles.cheap, ["INVALID_EXECUTION_POLICY"], locked !== null);
    }
    if (attemptNumber > taskSpec.limits.max_attempts) {
      return blockedDecision(this.profiles.cheap, ["MAX_ATTEMPTS_REACHED"], locked !== null);
    }

    const failureKind = previousOutcome?.failureKind?.toLowerCase();
    if (previousOutcome?.hardFailure || (failureKind !== undefined && HARD_FAILURES.has(failureKind))) {
      reasons.push("HARD_FAILURE");
      if (failureKind) reasons.push(`HARD_FAILURE_${failureKind.toUpperCase()}`);
      return blockedDecision(this.profiles.cheap, reasons, locked !== null);
    }
    if (previousOutcome?.status === "cancelled") {
      return blockedDecision(this.profiles.cheap, ["CANCELLED_OUTCOME"], locked !== null);
    }

    if (locked !== null) {
      reasons.push("USER_LOCKED");
      if (locked === "cheap") {
        if (previousOutcome?.workerClass === "cheap" && attemptNumber >= 3) {
          return { ...this.profiles.cheap, workerClass: "cheap", escalation: false, reasonCodes: [...reasons, "CHEAP_LOCK_RETRY_EXHAUSTED"], userLocked: true, blocked: true, requiresApproval: false };
        }
        if (previousOutcome?.workerClass === "cheap" && attemptNumber > 1) reasons.push("CHEAP_RETRY");
        return { ...this.profiles.cheap, workerClass: "cheap", escalation: false, reasonCodes: reasons, userLocked: true };
      }
      reasons.push("USER_LOCKED_STRONG");
      return { ...this.profiles.strong, workerClass: "strong", escalation: false, reasonCodes: reasons, userLocked: true };
    }

    const failedCheap = previousOutcome?.workerClass === "cheap" && previousOutcome.status !== "succeeded";
    const failureReasons = failureKind ? NON_RUNTIME_FAILURE_CODES.get(failureKind) : undefined;
    if (failedCheap && attemptNumber === 2 && !previousOutcome?.requiresEscalation) {
      return {
        ...this.profiles.cheap,
        workerClass: "cheap",
        escalation: false,
        reasonCodes: ["CHEAP_RETRY", ...(failureReasons ? [failureReasons.retry] : [])],
        userLocked: false,
      };
    }

    if (failedCheap && (attemptNumber > 2 || previousOutcome?.requiresEscalation)) {
      reasons.push("ESCALATION_REQUESTED");
      if (failureReasons) reasons.push(failureReasons.escalation);
      if (!previousOutcome?.escalationApproved) {
        return { ...this.profiles.strong, workerClass: "strong", escalation: true, reasonCodes: [...reasons, "ESCALATION_REQUIRES_APPROVAL"], userLocked: false, blocked: true, requiresApproval: true };
      }
      return { ...this.profiles.strong, workerClass: "strong", escalation: true, reasonCodes: [...reasons, "ESCALATION_APPROVED"], userLocked: false };
    }

    const workerClass = policy.planner_recommendation;
    reasons.push(workerClass === "cheap" ? "PLANNER_RECOMMENDS_CHEAP" : "PLANNER_RECOMMENDS_STRONG");
    reasons.push("PROFILE_RESOLVED");
    return { ...this.profiles[workerClass], workerClass, escalation: false, reasonCodes: reasons, userLocked: false };
  }

  route(request: WorkerRouteRequest): WorkerRouteDecision {
    return this.decide(request);
  }
}
