import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProductService } from "../../src/main/products/product-service.js";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductError } from "../../src/shared/core/product-validation.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const roots: string[] = [];
const databases: AppDatabase[] = [];
const open = (): { root: string; database: AppDatabase; service: ProductService } => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-products-unit-"));
  roots.push(root);
  const database = new AppDatabase(path.join(root, "app.db"));
  databases.push(database);
  return { root, database, service: new ProductService(database) };
};

const goal = (originalRequest: string): ProductGoal => ({
  schemaVersion: "1.0",
  originalRequest,
  goal: "Ship the requested product increment",
  scope: "The first local product workflow",
  assumptions: ["The user reviews the direction"],
  acceptanceCriteria: [{ id: "core", description: "The direction is persisted and reviewable", verification: "platform", required: true }]
});

describe("ProductService", () => {
  afterEach(() => { for (const database of databases.splice(0)) { try { database.close(); } catch { /* already closed */ } } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("creates, confirms, revises, and reads immutable goal history", async () => {
    const { service } = open();
    const created = await service.create({ requestId: "create-1", name: "Desk product", initialRequest: "Make a desk product" });
    expect(created.product.revision).toBe(1);
    expect(created.goal.revision).toBe(1);
    const prepared = await service.reviseGoal({ requestId: "prepare-1", productId: created.product.id, expectedRevision: 1, goal: goal("Make a desk product") });
    const confirmed = await service.confirmDirection({ requestId: "confirm-1", productId: created.product.id, expectedRevision: prepared.product.revision, goalRevision: 2 });
    expect(confirmed.product.revision).toBe(3);
    expect(confirmed.product.confirmedGoalRevision).toBe(2);
    const revised = await service.reviseGoal({ requestId: "revise-1", productId: created.product.id, expectedRevision: 3, goal: goal("Make a desk product") });
    expect(revised.product.revision).toBe(4);
    expect(revised.product.goalRevision).toBe(3);
    expect(revised.product.confirmedGoalRevision).toBeNull();
    const history = await service.getGoalHistory({ productId: created.product.id });
    expect(history.items.map(item => [item.revision, item.confirmedAt !== null])).toEqual([[1, false], [2, true], [3, false]]);
    expect((await service.readEvents({ productId: created.product.id })).items.map(event => event.type)).toEqual(["PRODUCT_CREATED", "GOAL_REVISED", "DIRECTION_CONFIRMED", "GOAL_REVISED"]);
  });

  it("returns the original receipt exactly and rejects a conflicting request id", async () => {
    const { database, service } = open();
    const input = { requestId: "same-request", name: "Product", initialRequest: "Initial request" };
    const first = await service.create(input);
    await service.reviseGoal({ requestId: "later", productId: first.product.id, expectedRevision: 1, goal: goal("Initial request") });
    const duplicate = await service.create(input);
    expect(duplicate).toEqual(first);
    await expect(service.create({ ...input, name: "Different" })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    database.close();
  });

  it("rolls back goal, revision, event, and receipt when a database trigger aborts", async () => {
    const { database, service } = open();
    const created = await service.create({ requestId: "create-rollback", name: "Product", initialRequest: "Initial request" });
    database.db.exec("CREATE TRIGGER abort_product_revision BEFORE UPDATE OF revision ON product_workspaces WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT, 'test abort'); END;");
    await expect(service.reviseGoal({ requestId: "rollback", productId: created.product.id, expectedRevision: 1, goal: goal("Initial request") })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((database.db.prepare("SELECT revision,event_sequence FROM product_workspaces WHERE id=?").get(created.product.id) as { revision: number; event_sequence: number })).toEqual({ revision: 1, event_sequence: 1 });
    expect((database.db.prepare("SELECT COUNT(*) n FROM product_goal_revisions").get() as { n: number }).n).toBe(1);
    expect((database.db.prepare("SELECT COUNT(*) n FROM product_events").get() as { n: number }).n).toBe(1);
    expect((database.db.prepare("SELECT COUNT(*) n FROM product_command_receipts WHERE request_id='rollback'").get() as { n: number }).n).toBe(0);
    database.close();
  });

  it("rejects incomplete confirmation and stale compare-and-set requests", async () => {
    const { database, service } = open();
    const created = await service.create({ requestId: "create-invalid", name: "Product", initialRequest: "Initial request" });
    await expect(service.confirmDirection({ requestId: "confirm-invalid", productId: created.product.id, expectedRevision: 1, goalRevision: 1 })).rejects.toMatchObject({ code: "DIRECTION_INCOMPLETE" });
    expect((database.db.prepare("SELECT COUNT(*) n FROM product_command_receipts").get() as { n: number }).n).toBe(1);
    await expect(service.reviseGoal({ requestId: "stale", productId: created.product.id, expectedRevision: 99, goal: goal("Initial request") })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    database.close();
  });

  it("surfaces tampered stored goals as data corruption", async () => {
    const { database, service } = open();
    const created = await service.create({ requestId: "create-corrupt", name: "Product", initialRequest: "Initial request" });
    database.db.prepare("UPDATE product_goal_revisions SET payload_json=? WHERE revision=1").run("{}");
    await expect(service.getOverview({ productId: created.product.id })).rejects.toBeInstanceOf(ProductError);
    await expect(service.getOverview({ productId: created.product.id })).rejects.toMatchObject({ code: "DATA_CORRUPT" });
    database.close();
  });

  it("accepts only one writer at the same revision and creates no receipt for the losing command", async () => {
    const { database, service } = open();
    const created = await service.create({ requestId: "race-create", name: "Product", initialRequest: "Initial request" });
    const input = { productId: created.product.id, expectedRevision: 1, goal: goal("Initial request") };
    const results = await Promise.allSettled([
      service.reviseGoal({ ...input, requestId: "writer-one" }),
      new ProductService(database).reviseGoal({ ...input, requestId: "writer-two" })
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "REVISION_CONFLICT" } });
    expect((await service.getOverview({ productId: created.product.id })).product.revision).toBe(2);
    expect((await service.readEvents({ productId: created.product.id })).items.map(event => event.sequence)).toEqual([1, 2]);
    expect(database.db.prepare("SELECT request_id FROM product_command_receipts WHERE request_id='writer-two'").get()).toBeUndefined();
    await expect(service.create({ requestId: "too-large", name: "Product", initialRequest: "x".repeat(33000) })).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    expect((database.db.prepare("SELECT COUNT(*) n FROM product_workspaces").get() as { n: number }).n).toBe(1);
  });
});
