import { describe, expect, it } from "vitest";
import { TASK_STATUSES } from "../../src/shared/core/task-state.js";
import { taskStatusViewModel } from "../../src/renderer/src/features/tasks/task-view-model.js";

describe("task UI view-model", () => {
  it("covers every TaskStatus with readable presentation metadata", () => {
    expect(TASK_STATUSES).toHaveLength(18);
    for (const status of TASK_STATUSES) {
      const model = taskStatusViewModel(status);
      expect(model.status).toBe(status);
      expect(model.label.length).toBeGreaterThan(0);
      expect(model.category.length).toBeGreaterThan(0);
      expect(model.stage.length).toBeGreaterThan(0);
      expect(model.stageIndex).toBeGreaterThanOrEqual(0);
      expect(model.stageIndex).toBeLessThanOrEqual(6);
      expect(["neutral", "info", "success", "warning", "danger"]).toContain(model.tone);
    }
  });

  it("offers actions only where the existing task actions are valid", () => {
    expect(taskStatusViewModel("DRAFT").nextAction).toBe("开始设计");
    expect(taskStatusViewModel("SPEC_READY").nextAction).toBe("检查并批准规范");
    expect(taskStatusViewModel("SPEC_APPROVED").nextAction).toBe("开始构建");
    expect(taskStatusViewModel("REWORK").nextAction).toBe("开始新的返工 Attempt");
    expect(taskStatusViewModel("BUILT").nextAction).toBe("运行测试");
    expect(taskStatusViewModel("GATE_READY").nextAction).toBe("开始最终审核");
    for (const status of ["DESIGNING", "BUILDING", "TESTING", "DETERMINISTIC_GATE", "REVIEWING"] as const) {
      expect(taskStatusViewModel(status).nextAction).toBeNull();
      expect(taskStatusViewModel(status).unavailableReason).toBeTruthy();
    }
  });

  it("marks terminal states as unavailable and preserves the merge boundary", () => {
    for (const status of ["SPEC_INVALID", "PASSED", "FAILED", "BLOCKED", "CANCELLED", "INTERRUPTED"] as const) {
      const model = taskStatusViewModel(status);
      expect(model.isTerminal).toBe(true);
      expect(model.nextAction).toBeNull();
      expect(model.unavailableReason).toBeTruthy();
    }
    expect(taskStatusViewModel("PASSED").unavailableReason).toContain("手动");
  });
});
