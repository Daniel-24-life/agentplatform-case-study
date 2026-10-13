import { describe, expect, it } from "vitest";

import { validateTaskStatusTransition, TASK_STATUS_TRANSITIONS } from "../../src/shared/core/task-state.js";

describe("shared core task status transition matrix", () => {
  const expectedTransitions = {
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
  } as const;

  const transitionPairs = Object.entries(TASK_STATUS_TRANSITIONS) as Array<
    [keyof typeof TASK_STATUS_TRANSITIONS, readonly string[]]
  >;

  it("matches the approved transition contract", () => {
    expect(TASK_STATUS_TRANSITIONS).toEqual(expectedTransitions);
  });

  it("accepts every allowed pair and rejects every forbidden pair", () => {
    const statuses = Object.keys(expectedTransitions);
    transitionPairs.forEach(([from, nextStates]) => {
      statuses.forEach((to) => {
        const result = validateTaskStatusTransition(from, to);
        expect(result.valid).toBe(nextStates.includes(to as never));
      });
    });
  });

  it("rejects unknown transition source with controlled error", () => {
    const result = validateTaskStatusTransition("UNKNOWN", "BUILDING");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues[0]!.path).toBe("status");
      expect(result.issues[0]!.message).toContain("not a recognized task status");
    }
  });

  it("rejects unknown transition target with controlled error", () => {
    const result = validateTaskStatusTransition("DRAFT", "UNKNOWN");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues[0]!.message).toContain("not a recognized task status");
    }
  });
});
