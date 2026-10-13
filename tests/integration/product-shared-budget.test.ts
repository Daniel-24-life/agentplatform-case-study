import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
import { ProductExecutionService } from "../../src/main/products/product-execution-service.js";
import { ProductRunService } from "../../src/main/products/product-run-service.js";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

it("shares frozen historical reservations across request ids and restart without refund", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-shared-budget-"));
  const f = await createProductWorkflowFixture(root, { maxAttempts: 3 });
  const task = f.database.getTask(f.input.taskId)!;
  // Historical/reservation fixture, not invented actual model calls. It stays capped at two despite approved max_attempts=3.
  f.database.db.prepare("INSERT INTO product_run_actions(id,request_id,request_hash,product_id,plan_revision,task_id,spec_revision,spec_hash,spec_approved_at,status,stage,reserved_model_calls,max_model_calls,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("legacy", "old-request", "oldhash", f.input.productId, f.input.planRevision, task.id, task.specRevision, f.input.specHash, task.specApprovedAt, "RUNNING", "build", 2, 2, "2026-01-01T00:00:00.000Z");
  f.database.close();
  const database = new AppDatabase(path.join(root, "app.db"));
  const products = new ProductService(database), plans = new ProductPlanService(database, products);
  const execution = new ProductExecutionService(database, products, plans, f.git);
  let modelStages = 0;
  const denied = async () => { modelStages++; throw Error("Unexpected stage"); };
  const service = new ProductRunService(database, execution, { startBuild: denied, startTests: denied, startFinalGate: denied }, { assertReady: () => {}, invoke: async action => action() }, { cancel: () => ({ cancelled: false }) });
  try {
    expect(service.recoverInterrupted()).toBe(1);
    expect(await service.getState({ productId: f.input.productId })).toMatchObject({ status: "INTERRUPTED", usedModelCalls: 2, maxModelCalls: 2 });
    await expect(service.start({ ...f.input, requestId: "fresh-request" })).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    expect(() => service.assertTaskIdle(task.id, "build")).toThrow("共享模型预算已耗尽");
    expect(() => service.assertTaskIdle(task.id, "review")).toThrow("共享模型预算已耗尽");
    expect(() => service.assertTaskIdle(task.id)).not.toThrow();
    expect(modelStages).toBe(0);
    expect(database.db.prepare("SELECT COUNT(*) n FROM product_run_actions").get()).toMatchObject({ n: 1 });
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

it("counts an actual prior manual Worker once when product execution resumes with tests and review", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-manual-budget-"));
  const f = await createProductWorkflowFixture(root);
  try {
    await f.orchestrator.startBuild(f.input.taskId);
    expect(f.database.db.prepare("SELECT product_run_action_id FROM runs WHERE stage='builder'").get()).toMatchObject({ product_run_action_id: null });
    await f.runs.start(f.input);
    expect(await waitForProductRun(f)).toMatchObject({ status: "SUCCEEDED", reservedModelCalls: 1, usedModelCalls: 2, maxModelCalls: 2 });
    expect(() => f.runs.assertTaskIdle(f.input.taskId, "review")).toThrow("共享模型预算已耗尽");
    expect(f.database.db.prepare("SELECT COUNT(*) n FROM runs WHERE stage IN ('builder','reviewer')").get()).toMatchObject({ n: 2 });
  } finally { f.database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
