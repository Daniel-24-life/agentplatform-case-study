import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
const roots: string[] = [];
const dbs: AppDatabase[] = [];
function open() { const root = mkdtempSync(path.join(os.tmpdir(), "product-trash-")); roots.push(root); const db = new AppDatabase(path.join(root, "db")); dbs.push(db); return { db, service: new ProductService(db) }; }
afterEach(() => { for (const db of dbs.splice(0))
    try {
        db.close();
    }
    catch (error) {
        void (error as unknown);
    } for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
describe("product trash and restore", () => {
    it("trashes idempotently, rejects conflicting and stale requests, paginates recycle bin, and preserves history", async () => {
        const { service, db } = open();
        const a = await service.create({ requestId: "a", name: "A", initialRequest: "a" });
        const b = await service.create({ requestId: "b", name: "B", initialRequest: "b" });
        const trashed = await service.trash({ requestId: "t", productId: a.product.id, expectedRevision: 1 });
        expect(trashed.product.deletedAt).toEqual(expect.any(String));
        expect(await service.trash({ requestId: "t", productId: a.product.id, expectedRevision: 1 })).toEqual(trashed);
        await expect(service.trash({ requestId: "t", productId: b.product.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
        await expect(service.restore({ requestId: "stale", productId: a.product.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
        await expect(service.reviseGoal({ requestId: "deleted-write", productId: a.product.id, expectedRevision: 2, goal: a.goal.goal })).rejects.toMatchObject({ code: "PRODUCT_DELETED" });
        expect((await service.list({ limit: 1 })).nextCursor).toBeNull();
        expect((await service.list()).items.map(x => x.id)).toEqual([b.product.id]);
        expect((await service.list({ deleted: true, limit: 1 })).nextCursor).toBeNull();
        expect((await service.list({ deleted: true })).items.map(x => x.id)).toEqual([a.product.id]);
        const restored = await service.restore({ requestId: "r", productId: a.product.id, expectedRevision: 2 });
        expect(restored.product.deletedAt).toBeNull();
        expect((await service.readEvents({ productId: a.product.id })).items.map(x => x.type)).toEqual(["PRODUCT_CREATED", "PRODUCT_TRASHED", "PRODUCT_RESTORED"]);
        db.close();
        const reopened = new AppDatabase(path.join(roots[0], "db"));
        dbs.push(reopened);
        expect((await new ProductService(reopened).getOverview({ productId: a.product.id })).product.deletedAt).toBeNull();
    });
    it("rejects active task, run, and planning work", async () => { const { service, db } = open(); const p = await service.create({ requestId: "p", name: "P", initialRequest: "p" }); const now = new Date().toISOString(); db.db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("pr", "p", "/x", "/x", now, "h"); db.db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("task", "pr", "t", "r", "BUILDING", "h", null, null, now, now, 0); const cycle = (db.db.prepare("SELECT current_cycle_id FROM product_workspaces WHERE id=?").get(p.product.id) as {
        current_cycle_id: string;
    }).current_cycle_id; db.db.prepare("INSERT INTO product_task_links VALUES(?,?,?,?,?)").run(p.product.id, cycle, 1, "task", now); await expect(service.trash({ requestId: "x", productId: p.product.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "PRODUCT_BUSY" }); db.db.prepare("UPDATE tasks SET status='DRAFT'").run(); db.db.prepare("INSERT INTO product_run_actions (id,request_id,request_hash,product_id,plan_revision,task_id,spec_revision,spec_hash,spec_approved_at,status,stage,reserved_model_calls,created_at,finished_at,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("run", "req", "hash", p.product.id, 1, "task", 1, "h", now, "RUNNING", "build", 1, now, null, null); for (const status of ["PAUSE_REQUESTED", "CANCEL_REQUESTED"]) {
        db.db.prepare("UPDATE product_run_actions SET status=?").run(status);
        await expect(service.trash({ requestId: `run-${status}`, productId: p.product.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "PRODUCT_BUSY" });
    } db.db.prepare("UPDATE product_run_actions SET status='FAILED'").run(); db.db.prepare("INSERT INTO product_planning_grants (id,product_id,request_id,request_hash,goal_revision,goal_hash,max_calls,used_calls,timeout_seconds,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("grant", p.product.id, "plan-req", "hash", 1, "goal-hash", 1, 0, 300, null, now); db.db.prepare("INSERT INTO product_planning_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("action", p.product.id, "plan-req", "hash", "grant", 1, "goal-hash", "ctx-hash", "{}", "RUNNING", null, null, now, null); await expect(service.trash({ requestId: "planning", productId: p.product.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "PRODUCT_BUSY" }); });
    it("rolls back trash event, revision, and receipt", async () => { const { service, db } = open(); const p = await service.create({ requestId: "p", name: "P", initialRequest: "p" }); db.db.exec("CREATE TRIGGER abort_trash BEFORE INSERT ON product_command_receipts WHEN NEW.command_type='trash' BEGIN SELECT RAISE(ABORT,'stop'); END;"); await expect(service.trash({ requestId: "t", productId: p.product.id, expectedRevision: 1 })).rejects.toMatchObject({ code: "INTERNAL_ERROR" }); expect((db.db.prepare("SELECT revision,event_sequence,deleted_at FROM product_workspaces").get() as {
        revision: number;
        event_sequence: number;
        deleted_at: null;
    })).toEqual({ revision: 1, event_sequence: 1, deleted_at: null }); expect(db.db.prepare("SELECT * FROM product_command_receipts WHERE request_id='t'").get()).toBeUndefined(); });
});
