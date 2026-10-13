import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canConfirmGoal, isGoalComplete, ProductGoalForm, ProductGoalPreview, ProductPanel, productTrashLabel, emptyGoal } from "../../src/renderer/src/features/products/ProductPanel.js";
import { App } from "../../src/renderer/src/App.js";

describe("product goal UI", () => {
  it("renders the saved goal fields and keeps the original request read-only", () => {
    const goal = { ...emptyGoal("原始需求"), goal: "目标", scope: "范围", acceptanceCriteria: [{ id: "c1", description: "可检查", verification: "user" as const, required: true }] };
    const html = renderToStaticMarkup(React.createElement(ProductGoalForm, { goal, onChange: () => undefined, onAddCriterion: () => undefined, onRemoveCriterion: () => undefined }));
    expect(html).toContain("原始需求");
    expect(html).toContain("readonly");
    expect(html).toContain("可检查");
    expect(html).toContain("添加验收标准");
  });

  it("only enables confirmation for a saved, complete, unchanged goal", () => {
    const goal = { ...emptyGoal(), goal: "目标", scope: "范围", acceptanceCriteria: [{ id: "c1", description: "检查", verification: "user" as const, required: true }] };
    expect(isGoalComplete(goal)).toBe(true);
    expect(canConfirmGoal(goal, goal, null, 1)).toBe(true);
    expect(canConfirmGoal(goal, { ...goal, goal: "修改后" }, null, 1)).toBe(false);
    expect(canConfirmGoal(goal, goal, 1, 1)).toBe(false);
    expect(isGoalComplete({ ...goal, goal: " " })).toBe(false);
    expect(isGoalComplete({ ...goal, assumptions: [""] })).toBe(false);
    expect(isGoalComplete({ ...goal, acceptanceCriteria: [...goal.acceptanceCriteria, { id: "blank", description: "", required: false, verification: "review" }] })).toBe(false);
  });

  it("starts on the product workspace and keeps the existing repository and execution navigation", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("app-shell--products");
    expect(html).toContain("你想做什么产品？");
    for (const label of ["项目", "任务", "运行环境", "Agents"]) expect(html).toContain(label);
    expect(html).not.toContain("先选择项目");
  });

  it("presents immutable history as business fields rather than editable inputs or raw JSON", () => {
    const snapshot = {
      revision: 2, hash: "a".repeat(64), createdAt: "2026-10-01T00:00:00Z",
      goal: { ...emptyGoal("原始需求"), goal: "产品目标", scope: "范围", acceptanceCriteria: [
        { id: "c1", description: "能够恢复数据", verification: "platform" as const, required: true }
      ] }
    };
    const html = renderToStaticMarkup(React.createElement(ProductGoalPreview, { snapshot }));
    for (const label of ["只读历史", "原始需求", "产品目标", "能够恢复数据", "平台检查"]) expect(html).toContain(label);
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("schemaVersion");
  });

  it("exposes a recoverable trash workflow without cleanup controls", () => {
    const html = renderToStaticMarkup(React.createElement(ProductPanel, { onOpenTask: () => undefined }));
    expect(html).toContain("回收站");
    expect(productTrashLabel).toBe("删除产品");
    expect(html).not.toContain("cleanup");
    expect(html).not.toContain("取消模型");
  });
});
