import { describe, expect, it } from "vitest";
import type { ProductPlan } from "../../src/shared/contracts/product-plan.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";
import { assertProductPlanInput, assertProductPlanResponse, validateProductPlan } from "../../src/shared/core/product-plan-validation.js";

const goal: ProductGoal = { schemaVersion: "1.0", originalRequest: "Build", goal: "Useful product", scope: "First workflow", assumptions: [],
  acceptanceCriteria: [{ id: "usable", description: "Works", verification: "platform", required: true }, { id: "optional", description: "Convenient", verification: "user", required: false }] };
const identity = { productId: "P1", goalRevision: 1, goalHash: "a".repeat(64) };
const makePlan = (): ProductPlan => ({ schemaVersion: "1.0", ...identity, summary: "First increment", workItems: [
  { id: "w1", title: "Implement", objective: "Core workflow", deliverable: "Runnable product", acceptanceCriterionIds: ["usable"], dependsOn: [] },
  { id: "w2", title: "Check", objective: "Validate", deliverable: "Evidence", acceptanceCriterionIds: ["usable"], dependsOn: ["w1"] }
] });

describe("product plan authority", () => {
  it("accepts covered criteria and a bounded dependency chain", () => {
    expect(() => validateProductPlan(makePlan(), goal, identity)).not.toThrow();
  });
  it("rejects cyclic, missing, duplicate and self-referenced dependencies", () => {
    for (const dependencies of [["w2"], ["missing"], ["w1"]]) {
      const plan = makePlan(); plan.workItems[0]!.dependsOn = dependencies;
      expect(() => validateProductPlan(plan, goal, identity)).toThrow();
    }
    const plan = makePlan(); plan.workItems[1]!.dependsOn = ["w1", "w1"];
    expect(() => validateProductPlan(plan, goal, identity)).toThrow();
  });
  it("rejects unknown criteria, missing required coverage and duplicate work IDs", () => {
    for (const ids of [["missing"], ["optional"]]) {
      const plan = makePlan(); plan.workItems.forEach(item => { item.acceptanceCriterionIds = ids; });
      expect(() => validateProductPlan(plan, goal, identity)).toThrow();
    }
    const plan = makePlan(); plan.workItems[1]!.id = "w1";
    expect(() => validateProductPlan(plan, goal, identity)).toThrow();
  });
  it("rejects old goal identities and blank deliverables", () => {
    expect(() => validateProductPlan({ ...makePlan(), goalRevision: 2 }, goal, identity)).toThrow();
    const plan = makePlan(); plan.workItems[0]!.deliverable = " ";
    expect(() => validateProductPlan(plan, goal, identity)).toThrow();
  });
  it("bounds UTF8 plan bytes and forbids unknown execution fields", () => {
    const plan = makePlan(); plan.summary = "中".repeat(12000); plan.workItems[0]!.objective = "中".repeat(12000);
    expect(() => validateProductPlan(plan, goal, identity)).toThrow();
    expect(() => assertProductPlanInput("save", { requestId: "R1", productId: "P1", expectedPlanRevision: 0, plan: { ...makePlan(), command: "run" } })).toThrow();
  });
  it("rejects malformed and cross-product response envelopes", () => {
    expect(() => assertProductPlanResponse("getState", { ok: true, value: {} })).toThrow();
    expect(() => assertProductPlanResponse("getState", { ok: true, value: { saved: null, current: true, directionConfirmed: false } })).toThrow();
    const saved = { productId: "P1", revision: 1, hash: "b".repeat(64), plan: makePlan(), createdAt: "now", confirmedAt: null };
    expect(() => assertProductPlanResponse("save", { ok: true, value: saved }, { productId: "P2" })).toThrow();
    expect(() => assertProductPlanResponse("save", { ok: true, value: saved }, { productId: "P1" })).not.toThrow();
  });
});
