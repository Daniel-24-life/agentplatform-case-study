import { describe, expect, it } from "vitest";
import { controlledTasks, pairConsistent, taskSpecFor } from "../manual/phase1-controlled-tasks.js";

describe("Phase 1.1 controlled A/B harness", () => {
  it("defines exactly three scoped fixtures with multiple acceptance criteria", () => {
    expect(controlledTasks.map((task) => task.id)).toEqual(["STRING_NORMALIZE", "RETRY_POLICY", "PATH_REPORT"]);
    for (const task of controlledTasks) { const spec = taskSpecFor(task, "a".repeat(40)); expect(spec.goal).toBe(task.goal); expect(spec.scope.allowed_paths).toEqual([task.file]); expect(spec.scope.forbidden_paths).toContain("verify.mjs"); expect(spec.acceptance_criteria.length).toBeGreaterThan(1); expect(spec.limits.max_attempts).toBe(2); expect(JSON.stringify(spec)).not.toContain("baseline"); expect(JSON.stringify(spec)).not.toContain("variant"); }
  });
  it("uses actual hashes rather than an unconditional consistency result", () => {
    const common = { specHash: "s", testsHash: "t", acceptanceHash: "a", base: { canonicalSha: "b" } };
    expect(pairConsistent(common as never, common as never)).toBe(true);
    expect(pairConsistent(common as never, { ...common, testsHash: "other" } as never)).toBe(false);
  });
});
