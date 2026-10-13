import { describe, expect, it } from "vitest";
import type { PlanningContext, ProductProposal } from "../../src/shared/contracts/product-planning.js";
import { assertPlanningInput, assertPlanningResponse, assertProposal } from "../../src/shared/core/planning-validation.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const goal = (originalRequest = "原始需求"): ProductGoal => ({
  schemaVersion: "1.0", originalRequest, goal: "明确目标", scope: "明确范围", assumptions: [],
  acceptanceCriteria: [{ id: "AC-1", description: "可验证", verification: "platform", required: true }]
});
const context: PlanningContext = { productId: "P1", workspaceRevision: 1, goalRevision: 2, goalHash: "a".repeat(64), goal: goal() };
const proposal = (): ProductProposal => ({
  schemaVersion: "1.0", productId: "P1", goalRevision: 2, goalHash: context.goalHash, contextHash: "b".repeat(64),
  summary: "方案", options: [{ id: "o1", title: "选项", rationale: "理由", goal: goal() }], recommendedOptionId: "o1", questions: []
});
const invalidProposal = (value: unknown): void => {
  try { assertProposal(value, context, "b".repeat(64)); throw new Error("invalid proposal accepted"); }
  catch (error) { expect(error).toMatchObject({ code: "INVALID_PROPOSAL" }); }
};

describe("product planning contracts", () => {
  it("validates bounded inputs, denies extra permissions and rejects unsafe revisions", () => {
    const input = { requestId: "r", productId: "P1", expectedRevision: 1 };
    expect(() => assertPlanningInput("authorize", input)).not.toThrow();
    for (const expectedRevision of [0, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertPlanningInput("authorize", { ...input, expectedRevision })).toThrow();
    }
    expect(() => assertPlanningInput("authorize", { ...input, maxCalls: 10 })).toThrow();
    expect(() => assertPlanningInput("authorize", { ...input, actor: "agent" })).toThrow();
  });
  it("binds product, revision, goal and context identities", () => {
    expect(() => assertProposal(proposal(), context, "b".repeat(64))).not.toThrow();
    for (const patch of [{ productId: "P2" }, { goalRevision: 1 }, { goalHash: "c".repeat(64) }, { contextHash: "c".repeat(64) }]) {
      invalidProposal({ ...proposal(), ...patch });
    }
  });
  it("rejects ambiguous options, changed original requests and uncheckable goals", () => {
    invalidProposal({ ...proposal(), recommendedOptionId: "missing" });
    invalidProposal({ ...proposal(), options: [proposal().options[0], proposal().options[0]] });
    invalidProposal({ ...proposal(), options: [{ ...proposal().options[0], goal: goal("other") }] });
    invalidProposal({ ...proposal(), options: [{ ...proposal().options[0], goal: { ...goal(), scope: " " } }] });
    invalidProposal({ ...proposal(), questions: [" "] });
    invalidProposal({ ...proposal(), grant: { maxCalls: 10 } });
  });
  it("bounds whole proposals in UTF8 bytes", () => {
    invalidProposal({ ...proposal(), options: [{ ...proposal().options[0], rationale: "中".repeat(12000) }, { ...proposal().options[0], id: "o2", rationale: "中".repeat(12000) }] });
  });
  it("rejects malformed envelopes, cross-product outputs and inconsistent terminal states", () => {
    for (const value of [{ ok: false, error: { code: "INVALID_INPUT", message: 12 } }, { ok: true, value: {}, extra: true }]) {
      expect(() => assertPlanningResponse("authorize", value)).toThrow();
    }
    const action = {
      id: "A1", productId: "P1", grantId: "G1", goalRevision: 2, goalHash: context.goalHash, contextHash: "b".repeat(64),
      status: "SUCCEEDED", proposal: proposal(), errorCode: null, createdAt: "now", finishedAt: "later"
    };
    expect(() => assertPlanningResponse("requestProposal", { ok: true, value: action }, { productId: "P1" })).not.toThrow();
    expect(() => assertPlanningResponse("requestProposal", { ok: true, value: action }, { productId: "P2" })).toThrow();
    expect(() => assertPlanningResponse("requestProposal", { ok: true, value: { ...action, proposal: null } })).toThrow();
    expect(() => assertPlanningResponse("requestProposal", { ok: true, value: { ...action, finishedAt: null } })).toThrow();
  });
});


it("accepts a complete plan only for the confirmed goal purpose and rejects mixed, stale or cyclic work", () => {
  const plan = {
    schemaVersion: "1.0" as const, productId: context.productId, goalRevision: context.goalRevision, goalHash: context.goalHash,
    summary: "Deliver the product", workItems: [{ id: "build", title: "Build", objective: "Implement", deliverable: "Runnable increment", acceptanceCriterionIds: ["AC-1"], dependsOn: [] as string[] }]
  };
  const value: ProductProposal = { ...proposal(), options: [{ ...proposal().options[0]!, plan }] };
  const planContext: PlanningContext = { ...context, purpose: "plan" };
  expect(() => assertProposal(value, planContext, value.contextHash)).not.toThrow();
  expect(() => assertProposal(value, context, value.contextHash)).toThrow();
  expect(() => assertProposal(proposal(), planContext, value.contextHash)).toThrow();
  for (const invalid of [
    { ...value, options: [...value.options, { ...proposal().options[0]!, id: "mixed" }] },
    { ...value, options: [{ ...value.options[0]!, goal: { ...context.goal, scope: "Changed direction" } }] },
    { ...value, options: [{ ...value.options[0]!, plan: { ...plan, goalHash: "c".repeat(64) } }] },
    { ...value, options: [{ ...value.options[0]!, plan: { ...plan, workItems: [{ ...plan.workItems[0]!, dependsOn: ["build"] }] } }] }
  ]) expect(() => assertProposal(invalid, planContext, value.contextHash)).toThrow();
  expect(() => assertPlanningInput("requestProposal", { requestId: "r", productId: "P1", expectedRevision: 1, grantId: "g", purpose: "plan" })).not.toThrow();
  expect(() => assertPlanningInput("requestProposal", { requestId: "r", productId: "P1", expectedRevision: 1, grantId: "g", purpose: "execute" })).toThrow();
});
