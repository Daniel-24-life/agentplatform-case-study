import { describe, expect, it } from "vitest";
import { WorkerRouter, type WorkerRouteRequest } from "../../src/main/router/worker-router.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

const spec = (recommendation: "cheap" | "strong" = "cheap", userLock: "cheap" | "strong" | null = null): TaskSpec => ({
  schema_version: "2.0", task_id: "TASK-ROUTE", title: "route", goal: "route", base_sha: "a".repeat(40),
  scope: { allowed_paths: ["src/**"], forbidden_paths: [] }, acceptance_criteria: [{ id: "AC-1", text: "ok" }],
  test_commands: [{ id: "test", program: "node", args: [], cwd: ".", timeout_seconds: 10, required: true }],
  execution_policy: { planner_recommendation: recommendation, planner_confidence: "high", recommendation_reasons: ["test"], user_lock: userLock },
  limits: { max_attempts: 3, run_timeout_seconds: 60, max_changed_files: 10, max_diff_bytes: 10000 },
});

const request = (overrides: Partial<WorkerRouteRequest> = {}): WorkerRouteRequest => ({ taskSpec: spec(), attemptNumber: 1, ...overrides });

describe("WorkerRouter", () => {
  const router = new WorkerRouter();

  it.each([
    ["cheap", "cheap-worker", false], ["strong", "codex", true],
  ] as const)("follows planner recommendation %s", (recommendation, adapterId, highTier) => {
    const result = router.decide(request({ taskSpec: spec(recommendation) }));
    expect(result).toMatchObject({ workerClass: recommendation, adapterId, highTier, escalation: false, userLocked: false });
  });

  it.each([["cheap", "cheap"], ["strong", "strong"]] as const)("honors user lock %s", (lock, workerClass) => {
    expect(router.decide(request({ taskSpec: spec("strong", lock) }))).toMatchObject({ workerClass, userLocked: true });
  });

  it("retries cheap once, then requests approved escalation", () => {
    const first = router.decide(request({ attemptNumber: 2, previousOutcome: { workerClass: "cheap", status: "failed" } }));
    expect(first).toMatchObject({ workerClass: "cheap", escalation: false });
    const second = router.decide(request({ attemptNumber: 3, previousOutcome: { workerClass: "cheap", status: "failed", requiresEscalation: true, escalationApproved: true } }));
    expect(second).toMatchObject({ workerClass: "strong", escalation: true, highTier: true });
  });

  it.each([
    ["worker_noop", "NOOP_RETRY", "NOOP_ESCALATION"],
    ["claimed_change_without_diff", "CLAIMED_CHANGE_RETRY", "CLAIMED_CHANGE_ESCALATION"],
  ] as const)("calibrates %s retry and repeated escalation", (failureKind, retryCode, escalationCode) => {
    const retry = router.decide(request({ attemptNumber: 2, previousOutcome: { workerClass: "cheap", status: "failed", failureKind } }));
    expect(retry).toMatchObject({ workerClass: "cheap", escalation: false });
    expect(retry.reasonCodes).toEqual(expect.arrayContaining(["CHEAP_RETRY", retryCode]));

    const escalation = router.decide(request({ attemptNumber: 3, previousOutcome: { workerClass: "cheap", status: "failed", failureKind } }));
    expect(escalation).toMatchObject({ blocked: true, requiresApproval: true, escalation: true });
    expect(escalation.reasonCodes).toEqual(expect.arrayContaining(["ESCALATION_REQUESTED", escalationCode]));
  });

  it("blocks an escalation until approval", () => {
    expect(router.decide(request({ attemptNumber: 3, previousOutcome: { workerClass: "cheap", status: "blocked", requiresEscalation: true } }))).toMatchObject({ blocked: true, requiresApproval: true, escalation: true });
  });

  it("never escalates a cheap user lock", () => {
    const result = router.decide(request({ taskSpec: spec("cheap", "cheap"), attemptNumber: 3, previousOutcome: { workerClass: "cheap", status: "failed", requiresEscalation: true } }));
    expect(result).toMatchObject({ workerClass: "cheap", userLocked: true, escalation: false });
  });

  it("blocks a cheap user lock after its single retry", () => {
    const result = router.decide(request({ taskSpec: spec("cheap", "cheap"), attemptNumber: 3, previousOutcome: { workerClass: "cheap", status: "failed" } }));
    expect(result).toMatchObject({ blocked: true, requiresApproval: false, escalation: false, userLocked: true });
    expect(result.reasonCodes).toContain("CHEAP_LOCK_RETRY_EXHAUSTED");
  });

  it("does not mark a strong user lock as escalation", () => {
    expect(router.decide(request({ taskSpec: spec("cheap", "strong"), attemptNumber: 2 }))).toMatchObject({ workerClass: "strong", escalation: false });
  });

  it("blocks cancelled outcomes without retrying", () => {
    const result = router.decide(request({ attemptNumber: 2, previousOutcome: { workerClass: "cheap", status: "cancelled" } }));
    expect(result).toMatchObject({ blocked: true, escalation: false });
    expect(result.reasonCodes).toContain("CANCELLED_OUTCOME");
  });

  it.each(["base_drift", "scope_violation", "evidence_invalid"])("blocks hard failure %s", (failureKind) => {
    expect(router.decide(request({ previousOutcome: { workerClass: "cheap", status: "failed", failureKind } }))).toMatchObject({ blocked: true, escalation: false });
  });

  it("blocks attempts beyond the configured limit", () => {
    expect(router.decide(request({ attemptNumber: 4 }))).toMatchObject({ blocked: true, reasonCodes: ["MAX_ATTEMPTS_REACHED"] });
  });
});
