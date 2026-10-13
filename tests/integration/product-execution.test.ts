import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductExecutionService } from "../../src/main/products/product-execution-service.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
import { ProductService } from "../../src/main/products/product-service.js";
import type { ProductPlan } from "../../src/shared/contracts/product-plan.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };
const roots: string[] = [];
const databases: AppDatabase[] = [];
const goal = (request: string): ProductGoal => ({ schemaVersion: "1.0", originalRequest: request, goal: "Deliver the product", scope: "A local workflow", assumptions: [], acceptanceCriteria: [{ id: "done", description: "The workflow is verifiable", verification: "platform", required: true }] });

async function ready(file = ":memory:") {
  const database = new AppDatabase(file); databases.push(database);
  const products = new ProductService(database);
  const plans = new ProductPlanService(database, products);
  const created = await products.create({ requestId: "create", name: "Product", initialRequest: "Build a product" });
  const revised = await products.reviseGoal({ requestId: "revise", productId: created.product.id, expectedRevision: 1, goal: goal("Build a product") });
  const confirmed = await products.confirmDirection({ requestId: "direction", productId: created.product.id, expectedRevision: revised.product.revision, goalRevision: revised.goal.revision });
  const plan: ProductPlan = { schemaVersion: "1.0", productId: confirmed.product.id, goalRevision: confirmed.goal.revision, goalHash: confirmed.goal.hash, summary: "Ship workflow", workItems: [{ id: "first", title: "Implement workflow", objective: "Build", deliverable: "Workflow", acceptanceCriterionIds: ["done"], dependsOn: [] }] };
  const saved = await plans.save({ requestId: "save", productId: confirmed.product.id, expectedPlanRevision: 0, plan });
  await plans.confirm({ requestId: "confirm-plan", productId: confirmed.product.id, planRevision: saved.revision });
  database.createProject({ id: "repo", name: "Repository", repoPath: "C:/repo", repoRealPath: "C:/repo", lastSeenHead: "a".repeat(40) });
  const service = new ProductExecutionService(database, products, plans, { inspect: async () => ({ root: "C:/repo", head: "b".repeat(40), branch: "main", clean: true }) });
  return { database, products, plans, service, productId: confirmed.product.id, productRevision: confirmed.product.revision, planRevision: saved.revision };
}

afterEach(() => { for (const database of databases.splice(0)) database.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("product execution persistence", () => {
  it("serializes concurrent creation to one task and one plan link", async () => {
    const fixture = await ready();
    await fixture.service.bindRepository({ requestId: "bind", productId: fixture.productId, expectedRevision: fixture.productRevision, repositoryId: "repo" });
    const results = await Promise.all([
      fixture.service.createTask({ requestId: "create-a", productId: fixture.productId, planRevision: fixture.planRevision }),
      fixture.service.createTask({ requestId: "create-b", productId: fixture.productId, planRevision: fixture.planRevision })
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1);
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM product_task_links").get() as { n: number }).n).toBe(1);
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM product_execution_receipts").get() as { n: number }).n).toBe(3);
  });

  it("rejects stale CAS and stale plan confirmation before creating a task", async () => {
    const fixture = await ready();
    await expect(fixture.service.bindRepository({ requestId: "stale-bind", productId: fixture.productId, expectedRevision: 1, repositoryId: "repo" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await fixture.service.bindRepository({ requestId: "bind", productId: fixture.productId, expectedRevision: fixture.productRevision, repositoryId: "repo" });
    await fixture.products.reviseGoal({ requestId: "new-goal", productId: fixture.productId, expectedRevision: fixture.productRevision + 1, goal: goal("Build a product") });
    await expect(fixture.service.createTask({ requestId: "stale-plan", productId: fixture.productId, planRevision: fixture.planRevision })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect((fixture.database.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(0);
  });

  it("preserves migration-8 product events and rolls back migration-9 DDL on failure", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-execution-migration-")); roots.push(root);
    const file = path.join(root, "app.db");
    const database = new AppDatabase(file);
    const products = new ProductService(database);
    const product = await products.create({ requestId: "product", name: "Product", initialRequest: "Build" });
    const event = database.db.prepare("SELECT * FROM product_events WHERE workspace_id=?").get(product.product.id);
    database.close(); databases.splice(databases.indexOf(database), 1);

    const downgrade = new DatabaseSync(file);
    downgrade.exec("ALTER TABLE product_workspaces DROP COLUMN deleted_at; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DELETE FROM migrations WHERE version>=9;");
    downgrade.close();
    const reopened = new AppDatabase(file);
    expect((reopened.db.prepare("SELECT * FROM product_events WHERE workspace_id=?").get(product.product.id))).toEqual(event);
    reopened.close();

    const failing = new DatabaseSync(file);
    failing.exec("ALTER TABLE product_workspaces DROP COLUMN deleted_at; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DELETE FROM migrations WHERE version>=9; CREATE VIEW product_task_links AS SELECT 1 AS product_id;");
    failing.close();
    expect(() => new AppDatabase(file)).toThrow();
    const check = new DatabaseSync(file);
    try {
      expect((check.prepare("SELECT MAX(version) AS version FROM migrations").get() as { version: number }).version).toBe(8);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_task_links'").all()).toEqual([]);
      expect(check.prepare("SELECT * FROM product_events WHERE workspace_id=?").get(product.product.id)).toEqual(event);
    } finally { check.close(); }
  });
});
