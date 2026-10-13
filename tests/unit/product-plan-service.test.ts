import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPlanError, type ProductPlan } from "../../src/shared/contracts/product-plan.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";
const goal = (originalRequest: string): ProductGoal => ({
  schemaVersion: "1.0", originalRequest, goal: "Deliver the product", scope: "A local workflow",
  assumptions: [], acceptanceCriteria: [{ id: "done", description: "The workflow is verifiable", verification: "platform", required: true }]
});

const open = (): { database: AppDatabase; products: ProductService; plans: ProductPlanService } => {
  const database = new AppDatabase(":memory:");
  const products = new ProductService(database);
  return { database, products, plans: new ProductPlanService(database, products) };
};

const setup = async () => {
  const fixture = open();
  const created = await fixture.products.create({ requestId: "create", name: "Product", initialRequest: "Build a product" });
  const revised = await fixture.products.reviseGoal({ requestId: "revise", productId: created.product.id, expectedRevision: 1, goal: goal("Build a product") });
  const confirmed = await fixture.products.confirmDirection({ requestId: "direction", productId: created.product.id, expectedRevision: revised.product.revision, goalRevision: revised.goal.revision });
  const plan: ProductPlan = {
    schemaVersion: "1.0", productId: confirmed.product.id, goalRevision: confirmed.goal.revision, goalHash: confirmed.goal.hash,
    summary: "Ship the first workflow", workItems: [{ id: "first", title: "Implement workflow", objective: "Build the workflow", deliverable: "A usable local workflow", acceptanceCriterionIds: ["done"], dependsOn: [] }]
  };
  return { ...fixture, product: confirmed, plan };
};

const setupUnconfirmed = async () => {
  const fixture = open();
  const created = await fixture.products.create({ requestId: "create", name: "Product", initialRequest: "Build a product" });
  const revised = await fixture.products.reviseGoal({ requestId: "revise", productId: created.product.id, expectedRevision: 1, goal: goal("Build a product") });
  const plan: ProductPlan = {
    schemaVersion: "1.0", productId: created.product.id, goalRevision: revised.goal.revision, goalHash: revised.goal.hash,
    summary: "Ship the first workflow", workItems: [{ id: "first", title: "Implement workflow", objective: "Build the workflow", deliverable: "A usable local workflow", acceptanceCriterionIds: ["done"], dependsOn: [] }]
  };
  return { ...fixture, product: revised, plan };
};

describe("ProductPlanService", () => {
  const databases: AppDatabase[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  it("saves immutable plans, confirms only after direction confirmation, and reopens state", async () => {
    const fixture = await setup(); databases.push(fixture.database);
    expect(await fixture.plans.getState({ productId: fixture.product.product.id })).toEqual({ saved: null, current: false, directionConfirmed: true });
    const saved = await fixture.plans.save({ requestId: "save", productId: fixture.product.product.id, expectedPlanRevision: 0, plan: fixture.plan });
    expect(saved.revision).toBe(1);
    expect((await fixture.plans.getState({ productId: fixture.product.product.id })).current).toBe(true);
    const confirmed = await fixture.plans.confirm({ requestId: "confirm", productId: fixture.product.product.id, planRevision: 1 });
    expect(confirmed.confirmedAt).toBeTypeOf("string");
    expect((fixture.database.db.prepare("SELECT confirmed_at FROM product_plan_revisions").get() as { confirmed_at: string | null }).confirmed_at).toBe(confirmed.confirmedAt);
  });

  it("enforces CAS and request idempotency before changing revisions", async () => {
    const fixture = await setup(); databases.push(fixture.database);
    const input = { requestId: "same", productId: fixture.product.product.id, expectedPlanRevision: 0, plan: fixture.plan };
    const first = await fixture.plans.save(input);
    expect(await fixture.plans.save(input)).toEqual(first);
    await expect(fixture.plans.save({ ...input, requestId: "stale", expectedPlanRevision: 0 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(fixture.plans.save({ ...input, requestId: "same", plan: { ...fixture.plan, summary: "Different" } })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS count FROM product_plan_revisions").get() as { count: number }).count).toBe(1);
  });

  it("requires current direction confirmation before confirming a plan", async () => {
    const fixture = await setupUnconfirmed(); databases.push(fixture.database);
    const saved = await fixture.plans.save({ requestId: "save", productId: fixture.product.product.id, expectedPlanRevision: 0, plan: fixture.plan });
    await expect(fixture.plans.confirm({ requestId: "confirm", productId: fixture.product.product.id, planRevision: saved.revision })).rejects.toMatchObject({ code: "DIRECTION_NOT_CONFIRMED" });
  });

  it("rejects confirmation when direction is no longer current and rolls back receipt writes", async () => {
    const fixture = await setup(); databases.push(fixture.database);
    await fixture.plans.save({ requestId: "save", productId: fixture.product.product.id, expectedPlanRevision: 0, plan: fixture.plan });
    const changed = await fixture.products.reviseGoal({ requestId: "new-goal", productId: fixture.product.product.id, expectedRevision: fixture.product.product.revision, goal: goal("Build a product") });
    expect(changed.goal.revision).toBe(3);
    await expect(fixture.plans.confirm({ requestId: "confirm-stale", productId: fixture.product.product.id, planRevision: 1 })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS count FROM product_plan_receipts").get() as { count: number }).count).toBe(1);
  });

  it("rolls back plan and receipt together on a database failure", async () => {
    const fixture = await setup(); databases.push(fixture.database);
    fixture.database.db.exec("CREATE TRIGGER reject_plan_receipt BEFORE INSERT ON product_plan_receipts BEGIN SELECT RAISE(ABORT, 'reject'); END;");
    await expect(fixture.plans.save({ requestId: "rollback", productId: fixture.product.product.id, expectedPlanRevision: 0, plan: fixture.plan })).rejects.toBeInstanceOf(ProductPlanError);
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS count FROM product_plan_revisions").get() as { count: number }).count).toBe(0);
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS count FROM product_plan_receipts").get() as { count: number }).count).toBe(0);
  });

  it("rolls back confirmation if its receipt cannot be persisted", async () => {
    const fixture = await setup(); databases.push(fixture.database);
    await fixture.plans.save({ requestId: "save", productId: fixture.product.product.id, expectedPlanRevision: 0, plan: fixture.plan });
    fixture.database.db.exec("CREATE TRIGGER reject_confirmation BEFORE INSERT ON product_plan_receipts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    await expect(fixture.plans.confirm({ requestId: "confirm", productId: fixture.product.product.id, planRevision: 1 })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await fixture.plans.getState({ productId: fixture.product.product.id })).saved?.confirmedAt).toBeNull();
    expect((fixture.database.db.prepare("SELECT COUNT(*) n FROM product_plan_receipts").get() as { n: number }).n).toBe(1);
  });

  it("rejects corrupted snapshot and receipt data", async () => {
    const fixture = await setup(); databases.push(fixture.database);
    await fixture.plans.save({ requestId: "save", productId: fixture.product.product.id, expectedPlanRevision: 0, plan: fixture.plan });
    fixture.database.db.prepare("UPDATE product_plan_revisions SET payload_json='{}' WHERE revision=1").run();
    await expect(fixture.plans.getState({ productId: fixture.product.product.id })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const clean = await setup(); databases.push(clean.database);
    await clean.plans.save({ requestId: "receipt", productId: clean.product.product.id, expectedPlanRevision: 0, plan: clean.plan });
    clean.database.db.prepare("UPDATE product_plan_receipts SET result_json='{}' WHERE request_id='receipt'").run();
    await expect(clean.plans.save({ requestId: "receipt", productId: clean.product.product.id, expectedPlanRevision: 0, plan: clean.plan })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
