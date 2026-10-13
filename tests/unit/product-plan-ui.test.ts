import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createProductPlanDraft, ProductPlanPreview, removeProductWorkItem, sameProductPlan } from "../../src/renderer/src/features/products/ProductPlanPanel.js";
import { canonicalProductJson } from "../../src/shared/core/product-validation.js";
import type { ProductOverview } from "../../src/shared/contracts/products.js";

const overview: ProductOverview = {
  product: { id: "P1", name: "产品", repositoryId: null, revision: 4, goalRevision: 3, confirmedGoalRevision: 3, createdAt: "now", updatedAt: "now" },
  goal: { revision: 3, hash: "a".repeat(64), createdAt: "now", goal: {
    schemaVersion: "1.0", originalRequest: "需求", goal: "交付可靠流程", scope: "完成页面与验证", assumptions: [],
    acceptanceCriteria: [{ id: "ac1", description: "保存可重开", verification: "platform", required: true }, { id: "ac2", description: "用户可检查", verification: "review", required: false }]
  } }
};

describe("product plan candidates", () => {
  it("compares saved and draft business fields independently of JSON property order", () => {
    const plan = createProductPlanDraft(overview);
    expect(sameProductPlan(plan, JSON.parse(canonicalProductJson(plan)))).toBe(true);
    expect(sameProductPlan(plan, { ...plan, summary: "Changed" })).toBe(false);
  });
  it("binds the current goal and required coverage without altering saved goals", () => {
    const plan = createProductPlanDraft(overview);
    expect(plan.goalRevision).toBe(3); expect(plan.goalHash).toBe(overview.goal.hash);
    expect(plan.workItems[0]?.acceptanceCriterionIds).toEqual(["ac1"]);
    expect(plan.workItems[0]?.objective).toBe("交付可靠流程");
    expect(plan.workItems[0]?.deliverable).toBe("完成页面与验证");
    expect(overview.goal.revision).toBe(3);
  });
  it("removes incoming dependencies when deleting a local work item", () => {
    const plan = createProductPlanDraft(overview);
    plan.workItems.push({ ...plan.workItems[0]!, id: "w2", dependsOn: ["w1"] });
    expect(removeProductWorkItem(plan, "w1").workItems).toMatchObject([{ id: "w2", dependsOn: [] }]);
    expect(plan.workItems).toHaveLength(2);
  });
  it("renders old snapshots as readable, immutable business fields", () => {
    const html = renderToStaticMarkup(React.createElement(ProductPlanPreview, { plan: createProductPlanDraft(overview) }));
    for (const text of ["交付可靠流程", "完成页面与验证", "目标", "交付物", "依赖"]) expect(html).toContain(text);
    expect(html).not.toContain("<textarea"); expect(html).not.toContain("schemaVersion");
  });
});
