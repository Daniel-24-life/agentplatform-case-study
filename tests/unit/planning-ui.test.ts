import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isProductPlanBoundToGoal, ProposalOptions } from "../../src/renderer/src/features/products/PlanningPanel.js";
import type { ProductOverview } from "../../src/shared/contracts/products.js";
import type { ProductPlan } from "../../src/shared/contracts/product-plan.js";
import type { ProductProposal } from "../../src/shared/contracts/product-planning.js";

const proposal: ProductProposal = {
  schemaVersion: "1.0", productId: "P1", goalRevision: 1, goalHash: "a".repeat(64), contextHash: "b".repeat(64),
  summary: "提供两个方向", recommendedOptionId: "local", questions: ["是否需要多人协作？"],
  options: ["local", "shared"].map(id => ({
    id, title: id === "local" ? "个人本地工具" : "团队协作工具", rationale: "范围清楚，可以验证", goal: {
      schemaVersion: "1.0", originalRequest: "解决产品问题", goal: "完成核心流程", scope: "首个可运行版本",
      assumptions: [], acceptanceCriteria: [{ id: "usable", description: "用户完成核心流程", verification: "user", required: true }]
    }
  }))
};
const overview = { product: { id: "P1" }, goal: { revision: 1, hash: "a".repeat(64) } } as ProductOverview;

describe("product proposal presentation", () => {
  it("shows comparable candidates and exactly one recommendation without confirming a direction", () => {
    const html = renderToStaticMarkup(React.createElement(ProposalOptions, { proposal, disabled: false, onUseGoal: () => undefined }));
    for (const text of ["个人本地工具", "团队协作工具", "是否需要多人协作", "尚未成为已确认", "将此方案填入草稿", "用户完成核心流程"]) expect(html).toContain(text);
    expect(html.match(/主 Agent 推荐/g)).toHaveLength(1);
    expect(html).not.toContain("启动开发");
  });

  it("disables candidate adoption when the saved goal is dirty or unavailable", () => {
    const html = renderToStaticMarkup(React.createElement(ProposalOptions, { proposal, disabled: true, onUseGoal: () => undefined }));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("only treats a plan bound to the current goal as importable", () => {
    const plan: ProductPlan = { schemaVersion: "1.0", productId: "P1", goalRevision: 1, goalHash: "a".repeat(64), summary: "x", workItems: [] };
    expect(isProductPlanBoundToGoal(plan, overview)).toBe(true);
    expect(isProductPlanBoundToGoal({ ...plan, goalRevision: 2 }, overview)).toBe(false);
  });
});
