import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
import type { ArtifactRecord, AttemptRecord, EventRecord, RunRecord } from "../../src/shared/contracts/records.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };
const roots: string[] = [];

const makeGoal = (request: string): ProductGoal => ({
  schemaVersion: "1.0",
  originalRequest: request,
  goal: "Deliver a useful product increment",
  scope: "A local first workflow",
  assumptions: [],
  acceptanceCriteria: [{ id: "done", description: "The workflow can be checked", verification: "platform", required: true }]
});

describe("product foundation persistence", () => {
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("upgrades a real version-5 database without changing legacy rows and reopens idempotently", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-products-integration-"));
    roots.push(root);
    const file = path.join(root, "app.db");
    const database = new AppDatabase(file);
    database.createProject({ id: "legacy-project", name: "legacy", repoPath: "C:/legacy", repoRealPath: "C:/legacy", lastSeenHead: "a".repeat(40) });
    const task = database.createTask({ id: "legacy-task", projectId: "legacy-project", title: "old task", requestText: "old", status: "DRAFT", baseSha: "b".repeat(40) });
    const attempt: AttemptRecord = { id: "legacy-attempt", taskId: task.id, number: 1, branch: "legacy-branch", worktreePath: "C:/managed/legacy", status: "READY", createdAt: new Date().toISOString() };
    database.createAttempt(attempt);
    const run: RunRecord = { id: "legacy-run", taskId: task.id, attemptId: attempt.id, stage: "BUILDING", adapter: "codex", model: "model", reasoning: "low", workerClass: null, cwd: attempt.worktreePath, pid: null, status: "COMPLETED", exitCode: 0, startedAt: attempt.createdAt, endedAt: attempt.createdAt, errorCode: null, failureDomain: null, durationMs: 1, isEscalation: false, isHighTier: false, usageJson: null };
    database.createRun(run);
    const event: EventRecord = { id: "legacy-event", taskId: task.id, runId: run.id, sequence: 1, type: "STATUS_CHANGED", payloadJson: JSON.stringify({ from: "DRAFT", to: "READY" }), createdAt: attempt.createdAt };
    database.appendEvent(event);
    const artifact: ArtifactRecord = { id: "legacy-artifact", runId: run.id, kind: "stdout", path: "C:/managed/legacy/stdout.log", sha256: "c".repeat(64), sizeBytes: 4 };
    database.createArtifact(artifact);
    const legacyRows = {
      projects: database.db.prepare("SELECT * FROM projects ORDER BY id").all(),
      tasks: database.db.prepare("SELECT * FROM tasks ORDER BY id").all(),
      attempts: database.db.prepare("SELECT * FROM attempts ORDER BY id").all(),
      runs: database.db.prepare("SELECT * FROM runs ORDER BY id").all(),
      artifacts: database.db.prepare("SELECT * FROM artifacts ORDER BY id").all(),
      events: database.db.prepare("SELECT * FROM events ORDER BY id").all()
    };
    database.close();

    // Remove planning and product tables from the current schema and rewind
    // their markers. This creates a genuine version-5 fixture
    // while retaining the real legacy tables and rows.
    const version5 = new DatabaseSync(file);
    version5.exec("PRAGMA foreign_keys=ON; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DROP TABLE product_plan_receipts; DROP TABLE product_plan_revisions; DROP TABLE product_planning_actions; DROP TABLE product_planning_grants; DROP TABLE product_events; DROP TABLE product_command_receipts; DROP TABLE product_decisions; DROP TABLE product_goal_revisions; DROP TABLE product_cycles; DROP TABLE product_workspaces; DELETE FROM migrations WHERE version>=6;");
    version5.close();

    const upgraded = new AppDatabase(file);
    expect((upgraded.db.prepare("SELECT version FROM migrations ORDER BY version").all() as Array<{ version: number }>).map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect({
      projects: upgraded.db.prepare("SELECT * FROM projects ORDER BY id").all(),
      tasks: upgraded.db.prepare("SELECT * FROM tasks ORDER BY id").all(),
      attempts: upgraded.db.prepare("SELECT * FROM attempts ORDER BY id").all(),
      runs: upgraded.db.prepare("SELECT * FROM runs ORDER BY id").all(),
      artifacts: upgraded.db.prepare("SELECT * FROM artifacts ORDER BY id").all(),
      events: upgraded.db.prepare("SELECT * FROM events ORDER BY id").all()
    }).toEqual(legacyRows);
    const created = await new ProductService(upgraded).create({ requestId: "persist-create", name: "Persistent product", initialRequest: "Build a local product" });
    const productId = created.product.id;
    expect(upgraded.getTask(task.id)?.requestText).toBe("old");
    upgraded.close();

    const reopened = new AppDatabase(file);
    const persisted = new ProductService(reopened);
    expect((await persisted.getOverview({ productId })).goal.goal.originalRequest).toBe("Build a local product");
    expect((await persisted.list()).items.map(item => item.id)).toContain(productId);
    expect((reopened.db.prepare("SELECT version FROM migrations ORDER BY version").all() as Array<{ version: number }>).at(-1)?.version).toBe(14);
    reopened.close();

    const repeated = new AppDatabase(file);
    expect((repeated.db.prepare("SELECT COUNT(*) n FROM product_workspaces").get() as { n: number }).n).toBe(1);
    expect((repeated.db.prepare("SELECT COUNT(*) n FROM migrations WHERE version=6").get() as { n: number }).n).toBe(1);
    repeated.close();
  });

  it("keeps an aborted migration at the prior migration version", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-products-migration-rollback-"));
    roots.push(root);
    const file = path.join(root, "broken.db");
    const seeded = new AppDatabase(file);
    seeded.createProject({ id: "legacy-project", name: "legacy", repoPath: "C:/legacy", repoRealPath: "C:/legacy", lastSeenHead: "a".repeat(40) });
    seeded.createTask({ id: "legacy-task", projectId: "legacy-project", title: "old task", requestText: "old", status: "DRAFT", baseSha: "b".repeat(40) });
    const legacyRows = {
      projects: seeded.db.prepare("SELECT * FROM projects ORDER BY id").all(),
      tasks: seeded.db.prepare("SELECT * FROM tasks ORDER BY id").all()
    };
    seeded.close();
    const legacy = new DatabaseSync(file);
    legacy.exec("PRAGMA foreign_keys=ON; DROP TABLE product_preview_sessions; ALTER TABLE runs DROP COLUMN product_run_action_id; DROP TABLE product_delivery_receipts; DROP TABLE product_deliveries; DROP TABLE product_run_actions; DROP TABLE product_execution_receipts; DROP TABLE product_task_links; DROP TABLE product_plan_receipts; DROP TABLE product_plan_revisions; DROP TABLE product_planning_actions; DROP TABLE product_planning_grants; DROP TABLE product_events; DROP TABLE product_command_receipts; DROP TABLE product_decisions; DROP TABLE product_goal_revisions; DROP TABLE product_cycles; DROP TABLE product_workspaces; DELETE FROM migrations WHERE version>=6; CREATE TABLE product_workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_project_id TEXT, current_cycle_id TEXT, revision INTEGER NOT NULL, event_sequence INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);");
    legacy.close();

    expect(() => new AppDatabase(file)).toThrow();
    const check = new DatabaseSync(file);
    expect((check.prepare("SELECT version FROM migrations ORDER BY version").all() as Array<{ version: number }>).map(row => row.version)).toEqual([1, 2, 3, 4, 5]);
    expect((check.prepare("SELECT type FROM sqlite_master WHERE name='product_cycles'").all() as Array<{ type: string }>)).toEqual([]);
    expect({
      projects: check.prepare("SELECT * FROM projects ORDER BY id").all(),
      tasks: check.prepare("SELECT * FROM tasks ORDER BY id").all()
    }).toEqual(legacyRows);
    check.close();
  });

  it("uses bounded cursors and preserves confirmation history across a revision", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-products-page-"));
    roots.push(root);
    const database = new AppDatabase(path.join(root, "app.db"));
    const service = new ProductService(database);
    const created = await service.create({ requestId: "page-create", name: "Paged product", initialRequest: "Page this product" });
    const confirmed = await service.reviseGoal({ requestId: "page-revise", productId: created.product.id, expectedRevision: 1, goal: makeGoal("Page this product") });
    await service.confirmDirection({ requestId: "page-confirm", productId: created.product.id, expectedRevision: confirmed.product.revision, goalRevision: 2 });
    expect((await service.getGoalHistory({ productId: created.product.id, limit: 1 })).nextCursor).toBe(1);
    expect((await service.getGoalHistory({ productId: created.product.id, afterRevision: 1 })).items[0]?.revision).toBe(2);
    expect((await service.readEvents({ productId: created.product.id, limit: 2 })).nextCursor).toBe(2);
    expect((await service.readEvents({ productId: created.product.id, afterSequence: 2 })).items.at(-1)?.type).toBe("DIRECTION_CONFIRMED");
    database.close();
  });
});
