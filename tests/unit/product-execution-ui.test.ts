import { describe, expect, it } from "vitest";
import type { ProductPlanState } from "../../src/shared/contracts/product-plan.js";
import { canCreateProductTask } from "../../src/renderer/src/features/products/ProductExecutionPanel.js";

describe("product execution eligibility", () => {
  it("requires a current confirmed plan and no existing task", () => {
    const state = { productId: "p", repositoryId: "r", planRevision: 2, planCurrent: true, planConfirmed: true, link: null, taskStatus: null } as const;
    const plan: ProductPlanState = { saved: { productId: "p", revision: 2, hash: "h", plan: { schemaVersion: "1.0", productId: "p", goalRevision: 6, goalHash: "a".repeat(64), summary: "Build", workItems: [] }, createdAt: "", confirmedAt: "now" } , current: true, directionConfirmed: true };
    expect(canCreateProductTask(state, plan, false)).toBe(true);
    expect(canCreateProductTask(state, plan, true)).toBe(false);
    expect(canCreateProductTask({ ...state, repositoryId: null }, plan, false)).toBe(false);
    expect(canCreateProductTask({ ...state, planRevision: 6 }, plan, false)).toBe(false);
    expect(canCreateProductTask({ ...state, link: { productId: "p", planRevision: 2, taskId: "t", createdAt: "" } }, plan, false)).toBe(false);
  });
});
