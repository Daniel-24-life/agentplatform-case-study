import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductPlanningService } from "../../src/main/products/product-planning-service.js";
import { ProductService } from "../../src/main/products/product-service.js";
import type { ProductProposal } from "../../src/shared/contracts/product-planning.js";
import type { ProductPlanner, ProductPlannerInput } from "../../src/main/products/product-planner.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };
const roots: string[] = [];

const direction = (originalRequest: string): ProductGoal => ({
  schemaVersion: "1.0", originalRequest, goal: "Deliver the product direction", scope: "The local workflow",
  assumptions: [], acceptanceCriteria: [{ id: "done", description: "Can be checked", verification: "platform", required: true }]
});

class DeferredPlanner implements ProductPlanner {
  available = true;
  input: ProductPlannerInput | undefined;
  private resolve!: (_value: unknown) => void;
  private start!: () => void;
  readonly started = new Promise<void>(resolve => { this.start = resolve; });
  async run(input: ProductPlannerInput): Promise<unknown> {
    this.input = input;
    this.start();
    return new Promise(resolve => { this.resolve = resolve; });
  }
  finish(value: unknown): void { this.resolve(value); }
}

const validProposal = (input: ProductPlannerInput): ProductProposal => ({
  schemaVersion: "1.0", productId: input.context.productId, goalRevision: input.context.goalRevision,
  goalHash: input.context.goalHash, contextHash: input.contextHash, summary: "Direction",
  options: [{ id: "option-1", title: "Option", rationale: "Bounded", goal: direction(input.context.goal.originalRequest) }],
  recommendedOptionId: "option-1", questions: []
});

describe("product planning persistence and stale-result integration", () => {
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("reopens successful proposals and consumed grants without changing the product goal", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-planning-reopen-")); roots.push(root);
    const file = path.join(root, "app.db");
    const db = new AppDatabase(file);
    const products = new ProductService(db);
    const created = await products.create({ requestId: "persist-product", name: "Product", initialRequest: "Build product" });
    const run = vi.fn(async (input: ProductPlannerInput) => validProposal(input));
    const service = new ProductPlanningService(db, products, { available: true, run });
    const grant = await service.authorize({ requestId: "persist-grant", productId: created.product.id, expectedRevision: 1 });
    const input = { requestId: "persist-action", productId: created.product.id, grantId: grant.id, expectedRevision: 1 };
    const action = await service.requestProposal(input);
    expect(action.status).toBe("SUCCEEDED");
    expect(await products.getOverview({ productId: created.product.id })).toEqual(created);
    db.close();
    const reopened = new AppDatabase(file);
    try {
      const restored = new ProductPlanningService(reopened, new ProductService(reopened), { available: true, run });
      expect(await restored.requestProposal(input)).toEqual(action);
      expect((await restored.getState({ productId: created.product.id })).grant?.usedCalls).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { reopened.close(); }
  });

  it("rolls back all migration-7 changes on a schema conflict", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-planning-rollback-")); roots.push(root);
    const file = path.join(root, "app.db");
    const seeded = new AppDatabase(file); seeded.close();
    const fixture = new DatabaseSync(file);
    fixture.exec("ALTER TABLE product_workspaces DROP COLUMN deleted_at; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DROP TABLE product_plan_receipts; DROP TABLE product_plan_revisions; DROP TABLE product_planning_actions; DROP TABLE product_planning_grants; DELETE FROM migrations WHERE version>=7; CREATE VIEW product_planning_actions AS SELECT 1 AS id;");
    fixture.close();
    expect(() => new AppDatabase(file)).toThrow();
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='product_planning_grants'").all()).toEqual([]);
      expect((check.prepare("SELECT MAX(version) n FROM migrations").get() as { n: number }).n).toBe(6);
    } finally { check.close(); }
  });

  it("upgrades a genuine migration-6 database and preserves legacy and product rows", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-planning-migration-")); roots.push(root);
    const file = path.join(root, "app.db");
    const db = new AppDatabase(file);
    db.createProject({ id: "legacy-project", name: "Legacy", repoPath: "C:/legacy", repoRealPath: "C:/legacy", lastSeenHead: "a".repeat(40) });
    const products = new ProductService(db);
    const product = await products.create({ requestId: "migration-product", name: "Product", initialRequest: "Build product" });
    const legacy = { projects: db.db.prepare("SELECT * FROM projects ORDER BY id").all(), workspaces: db.db.prepare("SELECT * FROM product_workspaces ORDER BY id").all() };
    db.close();
    const version6 = new DatabaseSync(file);
    version6.exec("ALTER TABLE product_workspaces DROP COLUMN deleted_at; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DROP TABLE product_plan_receipts; DROP TABLE product_plan_revisions; DROP TABLE product_planning_actions; DROP TABLE product_planning_grants; DELETE FROM migrations WHERE version>=7;");
    version6.close();

    const upgraded = new AppDatabase(file);
    expect((upgraded.db.prepare("SELECT version FROM migrations ORDER BY version").all() as Array<{ version: number }>).at(-1)?.version).toBe(14);
    expect(upgraded.db.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(legacy.projects);
    expect(upgraded.db.prepare("SELECT * FROM product_workspaces ORDER BY id").all()).toEqual(legacy.workspaces);
    expect((await new ProductService(upgraded).getOverview({ productId: product.product.id })).goal.goal.originalRequest).toBe("Build product");
    upgraded.close();
    const reopened = new AppDatabase(file);
    expect((reopened.db.prepare("SELECT COUNT(*) n FROM migrations WHERE version=7").get() as { n: number }).n).toBe(1);
    expect((reopened.db.prepare("SELECT COUNT(*) n FROM product_planning_grants").get() as { n: number }).n).toBe(0);
    reopened.close();
  });

  it("rejects a result after the current goal changes while the adapter is suspended", async () => {
    const db = new AppDatabase(":memory:");
    const products = new ProductService(db);
    const created = await products.create({ requestId: "stale-product", name: "Product", initialRequest: "Build product" });
    const planner = new DeferredPlanner();
    const service = new ProductPlanningService(db, products, planner);
    try {
      const grant = await service.authorize({ requestId: "stale-grant", productId: created.product.id, expectedRevision: 1 });
      const pending = service.requestProposal({ requestId: "stale-action", productId: created.product.id, grantId: grant.id, expectedRevision: 1 });
      await planner.started;
      await vi.waitFor(async () => expect((await service.getState({ productId: created.product.id })).action?.status).toBe("RUNNING"));
      await products.reviseGoal({ requestId: "stale-revise", productId: created.product.id, expectedRevision: 1, goal: direction("Build product") });
      planner.finish(validProposal(planner.input!));
      expect(await pending).toMatchObject({ status: "FAILED", errorCode: "GOAL_STALE" });
      expect((await service.getState({ productId: created.product.id })).action?.status).toBe("FAILED");
    } finally { db.close(); }
  });
});
