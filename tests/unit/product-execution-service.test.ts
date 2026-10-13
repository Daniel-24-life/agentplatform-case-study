import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductExecutionService } from "../../src/main/products/product-execution-service.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
import { ProductService } from "../../src/main/products/product-service.js";
import type { ProductPlan } from "../../src/shared/contracts/product-plan.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const databases: AppDatabase[] = [];
const goal = (request: string): ProductGoal => ({
  schemaVersion: "1.0", originalRequest: request, goal: "Deliver the product", scope: "A local workflow", assumptions: [],
  acceptanceCriteria: [{ id: "done", description: "The workflow is verifiable", verification: "platform", required: true }]
});

const openReady = async (clean = true) => {
  const database = new AppDatabase(":memory:"); databases.push(database);
  const products = new ProductService(database);
  const plans = new ProductPlanService(database, products);
  const created = await products.create({ requestId: "create", name: "Product", initialRequest: "Build a product" });
  const revised = await products.reviseGoal({ requestId: "revise", productId: created.product.id, expectedRevision: 1, goal: goal("Build a product") });
  const confirmed = await products.confirmDirection({ requestId: "direction", productId: created.product.id, expectedRevision: revised.product.revision, goalRevision: revised.goal.revision });
  const plan: ProductPlan = { schemaVersion: "1.0", productId: confirmed.product.id, goalRevision: confirmed.goal.revision, goalHash: confirmed.goal.hash, summary: "Ship workflow", workItems: [{ id: "first", title: "Implement workflow", objective: "Build the workflow", deliverable: "A usable workflow", acceptanceCriterionIds: ["done"], dependsOn: [] }] };
  const saved = await plans.save({ requestId: "save", productId: confirmed.product.id, expectedPlanRevision: 0, plan });
  await plans.confirm({ requestId: "plan-confirm", productId: confirmed.product.id, planRevision: saved.revision });
  database.createProject({ id: "repo", name: "Repository", repoPath: "C:/repo", repoRealPath: "C:/repo", lastSeenHead: "a".repeat(40) });
  const git = { inspect: async () => ({ root: "C:/repo", head: "b".repeat(40), branch: "main", clean }) };
  const service = new ProductExecutionService(database, products, plans, git);
  return { database, products, plans, service, productId: confirmed.product.id, revision: confirmed.product.revision, planRevision: saved.revision };
};

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("ProductExecutionService", () => {
  it("binds a registered repository and creates one draft task for a plan", async () => {
    const fixture = await openReady();
    const bound = await fixture.service.bindRepository({ requestId: "bind", productId: fixture.productId, expectedRevision: fixture.revision, repositoryId: "repo" });
    expect(bound.repositoryId).toBe("repo");
    const link = await fixture.service.createTask({ requestId: "task", productId: fixture.productId, planRevision: fixture.planRevision });
    expect(fixture.database.getTask(link.taskId)).toMatchObject({ status: "DRAFT", projectId: "repo", baseSha: "b".repeat(40) });
    expect(fixture.database.getTask(link.taskId)?.requestText).toContain("Implement workflow");
    expect(fixture.database.getTask(link.taskId)?.requestText).toContain("产品验收：");
    expect(fixture.database.getTask(link.taskId)?.requestText).not.toContain("schemaVersion");
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM product_task_links").get() as { n: number }).n).toBe(1);
    expect((await fixture.service.getState({ productId: fixture.productId })).taskStatus).toBe("DRAFT");
  });

  it("returns the same task for a different request and rejects request hash reuse", async () => {
    const fixture = await openReady();
    await fixture.service.bindRepository({ requestId: "bind", productId: fixture.productId, expectedRevision: fixture.revision, repositoryId: "repo" });
    const first = await fixture.service.createTask({ requestId: "task-one", productId: fixture.productId, planRevision: fixture.planRevision });
    expect(await fixture.service.createTask({ requestId: "task-two", productId: fixture.productId, planRevision: fixture.planRevision })).toEqual(first);
    await expect(fixture.service.createTask({ requestId: "task-one", productId: fixture.productId, planRevision: fixture.planRevision + 1 })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1);
  });

  it("rejects a dirty repository and rolls back task and receipt writes", async () => {
    const fixture = await openReady(false);
    await fixture.service.bindRepository({ requestId: "bind", productId: fixture.productId, expectedRevision: fixture.revision, repositoryId: "repo" });
    await expect(fixture.service.createTask({ requestId: "dirty", productId: fixture.productId, planRevision: fixture.planRevision })).rejects.toMatchObject({ code: "REPOSITORY_DIRTY" });
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(0);
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM product_execution_receipts").get() as { n: number }).n).toBe(1);
  });

  it("rolls back the task and link when the execution receipt fails", async () => {
    const fixture = await openReady();
    await fixture.service.bindRepository({ requestId: "bind", productId: fixture.productId, expectedRevision: fixture.revision, repositoryId: "repo" });
    fixture.database.db.exec("CREATE TRIGGER reject_execution_receipt BEFORE INSERT ON product_execution_receipts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    await expect(fixture.service.createTask({ requestId: "receipt-failure", productId: fixture.productId, planRevision: fixture.planRevision })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(0);
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM product_task_links").get() as { n: number }).n).toBe(0);
  });

  it("preserves a bound repository and task after reopening", async () => {
    const fixture = await openReady();
    await fixture.service.bindRepository({ requestId: "bind", productId: fixture.productId, expectedRevision: fixture.revision, repositoryId: "repo" });
    const link = await fixture.service.createTask({ requestId: "task", productId: fixture.productId, planRevision: fixture.planRevision });
    expect((await fixture.service.getState({ productId: fixture.productId })).link).toEqual(link);
  });
});
