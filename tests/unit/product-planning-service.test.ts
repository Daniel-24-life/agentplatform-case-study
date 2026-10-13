import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductPlanningService } from "../../src/main/products/product-planning-service.js";
import { ProductService } from "../../src/main/products/product-service.js";
import type { PlanningContext, ProductProposal } from "../../src/shared/contracts/product-planning.js";
import type { ProductPlannerInput, ProductPlanner } from "../../src/main/products/product-planner.js";
import { canonicalProductJson } from "../../src/shared/core/product-validation.js";
import { PlanningError } from "../../src/shared/contracts/product-planning.js";

const goalOption = (context: PlanningContext) => ({
  ...context.goal,
  goal: "Deliver the product direction",
  scope: "The local product workflow",
  acceptanceCriteria: [{ id: "done", description: "The direction can be checked", verification: "platform" as const, required: true }]
});

const proposal = (input: ProductPlannerInput): ProductProposal => ({
  schemaVersion: "1.0", productId: input.context.productId, goalRevision: input.context.goalRevision,
  goalHash: input.context.goalHash, contextHash: input.contextHash, summary: "A concrete direction",
  options: [{ id: "option-1", title: "First option", rationale: "It is bounded", goal: goalOption(input.context) }],
  recommendedOptionId: "option-1", questions: []
});

class FakePlanner implements ProductPlanner {
  available = true;
  calls: ProductPlannerInput[] = [];
  result: unknown = null;
  nextRun: (() => Promise<unknown>) | undefined;
  async run(input: ProductPlannerInput): Promise<unknown> {
    this.calls.push(input);
    if (this.nextRun) return this.nextRun();
    return this.result ?? proposal(input);
  }
}

async function fixture(planner: ProductPlanner = new FakePlanner()) {
  const database = new AppDatabase(":memory:");
  const products = new ProductService(database);
  const created = await products.create({ requestId: "create-product", name: "Product", initialRequest: "Build a product" });
  return { database, products, productId: created.product.id, service: new ProductPlanningService(database, products, planner), planner };
}

describe("ProductPlanningService", () => {
  it("persists quota exhaustion and consumes the dispatched grant without retry", async () => {
    const planner = new FakePlanner();
    planner.run = vi.fn(async () => { throw new PlanningError("QUOTA_EXHAUSTED", "safe quota message"); });
    const f = await fixture(planner);
    try {
      const grant = await f.service.authorize({ requestId: "quota-grant", productId: f.productId, expectedRevision: 1 });
      const input = { requestId: "quota-action", productId: f.productId, grantId: grant.id, expectedRevision: 1 };
      const action = await f.service.requestProposal(input);
      expect(action).toMatchObject({ status: "FAILED", errorCode: "QUOTA_EXHAUSTED", proposal: null });
      expect(await f.service.requestProposal(input)).toEqual(action);
      expect(planner.run).toHaveBeenCalledTimes(1);
      expect((await f.service.getState({ productId: f.productId })).grant?.usedCalls).toBe(1);
    } finally { f.database.close(); }
  });
  it("rejects stale revisions, conflicting request IDs and exhausted grants without extra calls", async () => {
    const planner = new FakePlanner();
    const f = await fixture(planner);
    try {
      await expect(f.service.authorize({ requestId: "stale", productId: f.productId, expectedRevision: 2 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      const grant = await f.service.authorize({ requestId: "grant", productId: f.productId, expectedRevision: 1 });
      expect(await f.service.authorize({ requestId: "grant", productId: f.productId, expectedRevision: 1 })).toEqual(grant);
      await expect(f.service.authorize({ requestId: "grant", productId: f.productId, expectedRevision: 2 })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
      const input = { requestId: "action", productId: f.productId, grantId: grant.id, expectedRevision: 1 };
      const action = await f.service.requestProposal(input);
      expect(await f.service.requestProposal(input)).toEqual(action);
      await expect(f.service.requestProposal({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
      await expect(f.service.requestProposal({ ...input, requestId: "extra" })).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
      expect(planner.calls).toHaveLength(1);
      expect((await f.service.getState({ productId: f.productId })).action?.proposal).toEqual(action.proposal);
    } finally { f.database.close(); }
  });

  it("rejects an oversized UTF8 context before reserving the call", async () => {
    const planner = new FakePlanner();
    const f = await fixture(planner);
    try {
      const overview = await f.products.getOverview({ productId: f.productId });
      await f.products.reviseGoal({ requestId: "large-goal", productId: f.productId, expectedRevision: 1, goal: { ...overview.goal.goal, scope: "中".repeat(6000) } });
      const grant = await f.service.authorize({ requestId: "large-grant", productId: f.productId, expectedRevision: 2 });
      await expect(f.service.requestProposal({ requestId: "large-action", productId: f.productId, grantId: grant.id, expectedRevision: 2 })).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
      expect((await f.service.getState({ productId: f.productId })).grant?.usedCalls).toBe(0);
      expect(planner.calls).toHaveLength(0);
    } finally { f.database.close(); }
  });

  it("rolls back the reserved budget if action persistence fails", async () => {
    const planner = new FakePlanner();
    const f = await fixture(planner);
    try {
      const grant = await f.service.authorize({ requestId: "rollback-grant", productId: f.productId, expectedRevision: 1 });
      f.database.db.exec("CREATE TRIGGER reject_action BEFORE INSERT ON product_planning_actions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
      await expect(f.service.requestProposal({ requestId: "rollback-action", productId: f.productId, grantId: grant.id, expectedRevision: 1 })).rejects.toThrow();
      expect((await f.service.getState({ productId: f.productId })).grant?.usedCalls).toBe(0);
      expect(planner.calls).toHaveLength(0);
    } finally { f.database.close(); }
  });

  it("authorizes once, rejects a second unused grant, and deduplicates dispatch", async () => {
    const planner = new FakePlanner();
    const f = await fixture(planner);
    try {
      const grant = await f.service.authorize({ requestId: "grant-1", productId: f.productId, expectedRevision: 1 });
      await expect(f.service.authorize({ requestId: "grant-2", productId: f.productId, expectedRevision: 1 })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
      const first = f.service.requestProposal({ requestId: "action-1", productId: f.productId, grantId: grant.id, expectedRevision: 1 });
      const second = f.service.requestProposal({ requestId: "action-1", productId: f.productId, grantId: grant.id, expectedRevision: 1 });
      const [a, b] = await Promise.all([first, second]);
      expect(a.id).toBe(b.id);
      expect(planner.calls).toHaveLength(1);
      expect(a.status).toBe("SUCCEEDED");
    } finally { f.database.close(); }
  });

  it("does not reserve a call when the planner is unavailable", async () => {
    const planner = new FakePlanner(); planner.available = false;
    const f = await fixture(planner);
    try {
      const grant = await f.service.authorize({ requestId: "grant-unavailable", productId: f.productId, expectedRevision: 1 });
      await expect(f.service.requestProposal({ requestId: "action-unavailable", productId: f.productId, grantId: grant.id, expectedRevision: 1 }))
        .rejects.toMatchObject({ code: "RUNTIME_NOT_QUALIFIED" });
      expect((f.database.db.prepare("SELECT used_calls FROM product_planning_grants WHERE id=?").get(grant.id) as { used_calls: number }).used_calls).toBe(0);
      expect(planner.calls).toHaveLength(0);
    } finally { f.database.close(); }
  });

  it("records an invalid proposal as failed while consuming the grant", async () => {
    const planner = new FakePlanner(); planner.result = { bad: true };
    const f = await fixture(planner);
    try {
      const grant = await f.service.authorize({ requestId: "grant-invalid", productId: f.productId, expectedRevision: 1 });
      const action = await f.service.requestProposal({ requestId: "action-invalid", productId: f.productId, grantId: grant.id, expectedRevision: 1 });
      expect(action.status).toBe("FAILED");
      expect(action.errorCode).toBe("INVALID_PROPOSAL");
      expect((f.database.db.prepare("SELECT used_calls FROM product_planning_grants WHERE id=?").get(grant.id) as { used_calls: number }).used_calls).toBe(1);
    } finally { f.database.close(); }
  });

  it("keeps a revoked suspended action running until the adapter settles", async () => {
    const planner = new FakePlanner();
    let release!: () => void;
    const suspended = new Promise<unknown>(resolve => { release = () => resolve({ bad: true }); });
    planner.nextRun = () => suspended;
    const f = await fixture(planner);
    try {
      const grant = await f.service.authorize({ requestId: "grant-revoke", productId: f.productId, expectedRevision: 1 });
      const pending = f.service.requestProposal({ requestId: "action-revoke", productId: f.productId, grantId: grant.id, expectedRevision: 1 });
      await vi.waitFor(async () => expect((await f.service.getState({ productId: f.productId })).action?.status).toBe("RUNNING"));
      await f.service.revoke({ productId: f.productId, grantId: grant.id });
      expect((await f.service.getState({ productId: f.productId })).action?.status).toBe("RUNNING");
      release();
      expect(await pending).toMatchObject({ status: "FAILED", errorCode: "GRANT_REVOKED" });
    } finally { f.database.close(); }
  });

  it("marks persisted running actions interrupted on startup", async () => {
    const f = await fixture();
    try {
      const grant = await f.service.authorize({ requestId: "grant-recover", productId: f.productId, expectedRevision: 1 });
      f.database.db.prepare("UPDATE product_planning_grants SET used_calls=1 WHERE id=?").run(grant.id);
      const storedGoal = (await f.products.getGoal({ productId: f.productId, revision: grant.goalRevision })).goal;
      const storedContext = { productId: f.productId, workspaceRevision: 1, goalRevision: grant.goalRevision, goalHash: grant.goalHash, goal: storedGoal };
      const contextHash = createHash("sha256").update(canonicalProductJson(storedContext), "utf8").digest("hex");
      f.database.db.prepare("INSERT INTO product_planning_actions (id,product_id,request_id,request_hash,grant_id,goal_revision,goal_hash,context_hash,context_json,status,proposal_json,error_code,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("action-recover", f.productId, "action-recover", "a".repeat(64), grant.id, grant.goalRevision, grant.goalHash, contextHash, JSON.stringify(storedContext), "RUNNING", null, null, new Date().toISOString(), null);
      const reopened = new ProductPlanningService(f.database, f.products, f.planner as ProductPlanner);
      expect((await reopened.getState({ productId: f.productId })).action).toMatchObject({ status: "INTERRUPTED", errorCode: "INTERRUPTED" });
    } finally { f.database.close(); }
  });

  it("sanitizes unexpected adapter failures", async () => {
    const planner = new FakePlanner(); planner.run = async () => { throw new Error("secret adapter path"); };
    const f = await fixture(planner);
    try {
      const grant = await f.service.authorize({ requestId: "grant-error", productId: f.productId, expectedRevision: 1 });
      await expect(f.service.requestProposal({ requestId: "action-error", productId: f.productId, grantId: grant.id, expectedRevision: 1 })).resolves.toMatchObject({ status: "FAILED", errorCode: "INTERNAL_ERROR" });
    } finally { f.database.close(); }
  });
});
