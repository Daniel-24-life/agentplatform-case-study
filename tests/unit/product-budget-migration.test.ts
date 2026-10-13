import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function version12(reserved: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-budget-migration-")); roots.push(root);
  const file = path.join(root, "app.db");
  const store = new AppDatabase(file);
  store.createProject({ id: "repo", name: "repo", repoPath: root, repoRealPath: root, lastSeenHead: "a".repeat(40) });
  store.createTask({ id: "task", projectId: "repo", title: "task", requestText: "task", status: "DRAFT", baseSha: "a".repeat(40) });
  const product = await new ProductService(store).create({ requestId: "create", name: "product", initialRequest: "request" });
  // Reconstruct the genuine v12 column layout, not an already-upgraded table with a backdated version.
  const sql = (store.db.prepare("SELECT sql FROM sqlite_master WHERE name='product_run_actions'").get() as { sql: string }).sql
    .replace('"product_run_actions"', 'product_run_actions')
    .replace("reserved_model_calls BETWEEN 0 AND max_model_calls", "reserved_model_calls BETWEEN 0 AND 2")
    .replace(/\s*max_model_calls INTEGER NOT NULL DEFAULT 2 CHECK\(max_model_calls BETWEEN 2 AND 6\),/, "");
  store.db.exec("DROP TABLE product_preview_sessions; DROP TABLE product_run_actions; ALTER TABLE runs DROP COLUMN product_run_action_id; DELETE FROM migrations WHERE version>=13;");
  store.db.exec(sql);
  store.db.exec("CREATE UNIQUE INDEX product_run_actions_active_task ON product_run_actions(task_id) WHERE status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED'); CREATE INDEX product_run_actions_product_created ON product_run_actions(product_id,created_at DESC);");
  if (reserved > 2) store.db.exec("PRAGMA ignore_check_constraints=ON");
  store.db.prepare("INSERT INTO product_run_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("historical", "run", "requesthash", product.product.id, 1, "task", 1, "spechash", "approved", "FAILED", "review", reserved, "created", "finished", "TEST_FAILED");
  store.close();
  return file;
}

describe("shared product budget migration", () => {
  it("preserves historical reservations and freezes their original two-call cap across reopening", async () => {
    const file = await version12(2);
    const store = new AppDatabase(file);
    try {
      expect(store.db.prepare("SELECT reserved_model_calls,max_model_calls,error_code FROM product_run_actions WHERE id='historical'").get()).toMatchObject({ reserved_model_calls: 2, max_model_calls: 2, error_code: "TEST_FAILED" });
      expect(() => store.db.prepare("UPDATE product_run_actions SET reserved_model_calls=3 WHERE id='historical'").run()).toThrow();
      expect((store.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).some(row => row.name === "product_run_action_id")).toBe(true);
    } finally { store.close(); }
    const reopened = new AppDatabase(file);
    try { expect(reopened.db.prepare("SELECT max_model_calls FROM product_run_actions WHERE id='historical'").get()).toMatchObject({ max_model_calls: 2 }); }
    finally { reopened.close(); }
  });
  it("rolls back the whole migration if malformed legacy reservations cannot be copied", async () => {
    const file = await version12(7);
    expect(() => new AppDatabase(file)).toThrow();
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare("SELECT MAX(version) version FROM migrations").get()).toMatchObject({ version: 12 });
      expect((check.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).some(row => row.name === "product_run_action_id")).toBe(false);
      expect(check.prepare("SELECT reserved_model_calls FROM product_run_actions WHERE id='historical'").get()).toMatchObject({ reserved_model_calls: 7 });
    } finally { check.close(); }
  });
});
