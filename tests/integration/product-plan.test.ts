import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
import { ProductService } from "../../src/main/products/product-service.js";
import type { ProductPlan } from "../../src/shared/contracts/product-plan.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };
const roots: string[] = [];
const goal = (originalRequest: string): ProductGoal => ({
  schemaVersion: "1.0", originalRequest, goal: "Deliver the product", scope: "A local workflow", assumptions: [],
  acceptanceCriteria: [{ id: "done", description: "The workflow is verifiable", verification: "platform", required: true }]
});

const createPlan = async (database: AppDatabase): Promise<{ productId: string; plan: ProductPlan }> => {
  const products = new ProductService(database);
  const created = await products.create({ requestId: "create", name: "Product", initialRequest: "Build a product" });
  const revised = await products.reviseGoal({ requestId: "revise", productId: created.product.id, expectedRevision: 1, goal: goal("Build a product") });
  const confirmed = await products.confirmDirection({ requestId: "direction", productId: created.product.id, expectedRevision: revised.product.revision, goalRevision: revised.goal.revision });
  return {
    productId: confirmed.product.id,
    plan: { schemaVersion: "1.0", productId: confirmed.product.id, goalRevision: confirmed.goal.revision, goalHash: confirmed.goal.hash, summary: "First increment", workItems: [{ id: "first", title: "Implement", objective: "Build", deliverable: "Workflow", acceptanceCriterionIds: ["done"], dependsOn: [] }] }
  };
};

describe("product plan migration and persistence", () => {
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("upgrades a migration-7 database and preserves legacy and product rows", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-plan-migration-")); roots.push(root);
    const file = path.join(root, "app.db");
    const database = new AppDatabase(file);
    database.createProject({ id: "legacy", name: "Legacy", repoPath: "C:/legacy", repoRealPath: "C:/legacy", lastSeenHead: "a".repeat(40) });
    const products = new ProductService(database);
    const product = await products.create({ requestId: "product", name: "Product", initialRequest: "Build" });
    const legacyProject = database.db.prepare("SELECT * FROM projects WHERE id='legacy'").all();
    const legacyProduct = database.db.prepare("SELECT * FROM product_workspaces WHERE id=?").all(product.product.id);
    database.close();
    const version7 = new DatabaseSync(file);
    version7.exec("ALTER TABLE product_workspaces DROP COLUMN deleted_at; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DROP TABLE product_plan_receipts; DROP TABLE product_plan_revisions; DELETE FROM migrations WHERE version>=8;");
    version7.close();

    const upgraded = new AppDatabase(file);
    expect((upgraded.db.prepare("SELECT MAX(version) AS version FROM migrations").get() as { version: number }).version).toBe(14);
    expect(upgraded.db.prepare("SELECT * FROM projects WHERE id='legacy'").all()).toEqual(legacyProject);
    expect(upgraded.db.prepare("SELECT * FROM product_workspaces WHERE id=?").all(product.product.id)).toEqual(legacyProduct);
    expect((await new ProductService(upgraded).getOverview({ productId: product.product.id })).goal.goal.originalRequest).toBe("Build");
    upgraded.close();
  });

  it("reopens a saved plan and keeps its historical revision and receipt", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-plan-reopen-")); roots.push(root);
    const file = path.join(root, "app.db");
    const database = new AppDatabase(file);
    const { productId, plan } = await createPlan(database);
    const first = await new ProductPlanService(database, new ProductService(database)).save({ requestId: "save", productId, expectedPlanRevision: 0, plan });
    database.close();
    const reopened = new AppDatabase(file);
    try {
      const service = new ProductPlanService(reopened, new ProductService(reopened));
      expect(await service.getState({ productId })).toMatchObject({ saved: first, current: true, directionConfirmed: true });
      expect(await service.save({ requestId: "save", productId, expectedPlanRevision: 0, plan })).toEqual(first);
    } finally { reopened.close(); }
  });

  it("rolls back all migration-8 DDL when the migration fails", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-plan-rollback-")); roots.push(root);
    const file = path.join(root, "app.db");
    const database = new AppDatabase(file); database.close();
    const fixture = new DatabaseSync(file);
    fixture.exec("ALTER TABLE product_workspaces DROP COLUMN deleted_at; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DROP TABLE product_plan_receipts; DROP TABLE product_plan_revisions; DELETE FROM migrations WHERE version>=8; CREATE VIEW product_plan_revisions AS SELECT 1 AS revision;");
    fixture.close();
    expect(() => new AppDatabase(file)).toThrow();
    const check = new DatabaseSync(file);
    try {
      expect((check.prepare("SELECT MAX(version) AS version FROM migrations").get() as { version: number }).version).toBe(7);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_plan_receipts'").all()).toEqual([]);
    } finally { check.close(); }
  });
});
