import { describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";

async function recordedHistory() {
  const database = new AppDatabase(":memory:");
  const products = new ProductService(database);
  const plans = new ProductPlanService(database, products);
  database.createProject({ id: "repo", name: "fixture", repoPath: "E:/fixture", repoRealPath: "E:/fixture", lastSeenHead: "a".repeat(40) });
  const first = await products.create({ requestId: "first", name: "History", initialRequest: "Measure recorded history" });
  const other = await products.create({ requestId: "other", name: "Other", initialRequest: "Separate product" });
  let overview = first;
  for (let revision = 1; revision <= 2; revision++) {
    overview = await products.reviseGoal({ requestId: `goal-${revision}`, productId: first.product.id, expectedRevision: overview.product.revision,
      goal: { ...overview.goal.goal, goal: `Increment ${revision}`, scope: "fixture", acceptanceCriteria: [{ id: "criterion", description: "Recorded fact", verification: "platform", required: true }] } });
    overview = await products.confirmDirection({ requestId: `direction-${revision}`, productId: first.product.id, expectedRevision: overview.product.revision, goalRevision: overview.goal.revision });
    const plan = await plans.save({ requestId: `plan-${revision}`, productId: first.product.id, expectedPlanRevision: revision - 1,
      plan: { schemaVersion: "1.0", productId: first.product.id, goalRevision: overview.goal.revision, goalHash: overview.goal.hash, summary: "Recorded increment",
        workItems: [{ id: "work", title: "Work", objective: "Verify", deliverable: "Recorded fact", acceptanceCriterionIds: ["criterion"], dependsOn: [] }] } });
    await plans.confirm({ requestId: `confirm-${revision}`, productId: first.product.id, planRevision: plan.revision });
  }
  const now = new Date().toISOString();
  for (const [taskId, product, revision, status] of [["T1", first, 1, "PASSED"], ["T2", first, 2, "FAILED"], ["T3", other, 1, "PASSED"]] as const) {
    database.createTask({ id: taskId, projectId: "repo", title: "Recorded task", requestText: "fixture", baseSha: "a".repeat(40), status });
    // Synthetic historical database facts; these do not certify a real execution.
    database.db.prepare("UPDATE tasks SET spec_approved_at=? WHERE id=?").run(now, taskId);
    const cycle = database.db.prepare("SELECT current_cycle_id FROM product_workspaces WHERE id=?").get(product.product.id)!.current_cycle_id;
    database.db.prepare("INSERT INTO product_task_links(product_id,cycle_id,plan_revision,task_id,created_at) VALUES(?,?,?,?,?)").run(product.product.id, cycle!, revision, taskId, now);
  }
  for (const [id, taskId, number, status] of [["A1", "T1", 1, "REWORK"], ["A2", "T1", 2, "PASS"], ["A3", "T2", 1, "FAILED"], ["A4", "T2", 2, "CANCELLED"], ["A5", "T2", 3, "INTERRUPTED"], ["A6", "T3", 1, "PASS"]] as const) {
    database.createAttempt({ id, taskId, number, status, branch: id, worktreePath: `E:/fixture/${id}`, createdAt: now });
  }
  const addRun = (id: string, taskId: string | undefined, attemptId: string, adapter: string, durationMs: number | null, usageJson: string | null) => {
    database.createRun({ id, taskId, attemptId, stage: adapter === "test-runner" ? "test" : "builder", adapter, model: "fixture", reasoning: "low", workerClass: null,
      cwd: "E:/fixture", pid: null, status: "SUCCEEDED", exitCode: 0, startedAt: now, endedAt: now, errorCode: null, durationMs, isEscalation: false, isHighTier: adapter !== "test-runner", usageJson });
  };
  addRun("R1", "T1", "A1", "codex", 0, JSON.stringify({ inputTokens: 0 }));
  addRun("R2", undefined, "A2", "codex", null, JSON.stringify({ outputTokens: 5 }));
  addRun("R3", "T1", "A2", "test-runner", 100, JSON.stringify({ inputTokens: 99999 }));
  database.db.prepare("UPDATE runs SET is_high_tier=1 WHERE id='R3'").run();
  addRun("R4", "T2", "A3", "codex", null, "null");
  addRun("R5", "T3", "A6", "codex", 900, JSON.stringify({ inputTokens: 999 }));
  database.appendEvent({ id: "upgrade", taskId: "T1", runId: null, sequence: 1, type: "ESCALATION_APPROVED", payloadJson: JSON.stringify({ approved: true, attempt: 2 }), createdAt: now });
  return { database, products, first, other, addRun, now };
}

describe("product history metrics", () => {
  it("returns null denominators for an empty product without writing", async () => {
    const database = new AppDatabase(":memory:"); const products = new ProductService(database);
    try {
      const created = await products.create({ requestId: "metrics-create", name: "Metrics", initialRequest: "Measure" });
      const before = Number((database.db.prepare("SELECT COUNT(*) n FROM product_events").get() as { n: number }).n);
      expect(await products.getMetrics({ productId: created.product.id })).toMatchObject({ productId: created.product.id, scope: "PRODUCT_HISTORY", taskCount: 0, passedTaskCount: 0, technicalCompletionRate: null, recordedDurationMs: null, usageCoverage: null, inputTokens: null, outputTokens: null, totalTokens: null });
      expect(Number((database.db.prepare("SELECT COUNT(*) n FROM product_events").get() as { n: number }).n)).toBe(before);
      await expect(products.getMetrics({ productId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await products.trash({ requestId: "metrics-trash", productId: created.product.id, expectedRevision: created.product.revision });
      await expect(products.getMetrics({ productId: created.product.id })).rejects.toMatchObject({ code: "PRODUCT_DELETED" });
    } finally { database.close(); }
  });

  it("counts distinct historical tasks, actual approval events, repairs and partial usage without cross-product or action inflation", async () => {
    const f = await recordedHistory();
    try {
      const before = f.database.db.prepare("SELECT total_changes() n").get()!.n;
      const metrics = await f.products.getMetrics({ productId: f.first.product.id });
      expect(metrics).toMatchObject({ taskCount: 2, passedTaskCount: 1, technicalCompletionRate: .5,
        directionConfirmations: 2, planConfirmations: 2, specApprovals: 2, escalationApprovals: 1, keyConfirmationCount: 7,
        attemptCount: 5, repairAttemptCount: 3, failedAttemptCount: 2, runCount: 4, agentRunCount: 3,
        durationAvailableRuns: 2, recordedDurationMs: 100, usageAvailableRuns: 2, usageCoverage: 2 / 3, inputTokens: 0, outputTokens: 5, totalTokens: null });
      expect(f.database.db.prepare("SELECT total_changes() n").get()!.n).toBe(before);
      expect(f.database.taskRunMetrics("T1")).toMatchObject({ agentRunCount: 2, usageAvailableRuns: 2, inputTokens: 0, outputTokens: 5, totalTokens: null, highTierTotalTokens: null, highTierInputTokens: 0, highTierOutputTokens: 5, highTierCalls: 2 });
      expect(await f.products.getMetrics({ productId: f.other.product.id })).toMatchObject({ taskCount: 1, runCount: 1, inputTokens: 999, recordedDurationMs: 900 });
      for (const id of ["action-one", "action-two"]) {
        f.database.db.prepare(`INSERT INTO product_run_actions(id,request_id,request_hash,product_id,plan_revision,task_id,spec_revision,spec_hash,spec_approved_at,status,stage,reserved_model_calls,max_model_calls,created_at,finished_at)
          VALUES(?,?,?,?,?,?,?,?,?,'SUCCEEDED','review',2,2,?,?)`).run(id, id, "a".repeat(64), f.first.product.id, 1, "T1", 1, "a".repeat(64), f.now, f.now, f.now);
      }
      expect(await f.products.getMetrics({ productId: f.first.product.id })).toEqual(metrics);
      f.database.updateRun("R1", { usageJson: JSON.stringify({ inputTokens: 7 }) });
      expect(await f.products.getMetrics({ productId: f.first.product.id })).toMatchObject({ inputTokens: 7, outputTokens: 5, totalTokens: null });
    } finally { f.database.close(); }
  });

  it("rejects contradictory direct and Attempt task ownership rather than counting a run in both products", async () => {
    const f = await recordedHistory();
    try {
      f.addRun("corrupt", "T3", "A2", "codex", 1, null);
      for (const productId of [f.first.product.id, f.other.product.id]) await expect(f.products.getMetrics({ productId })).rejects.toMatchObject({ code: "DATA_CORRUPT" });
    } finally { f.database.close(); }
  });

  it("does not report an unsafe accumulated duration", async () => {
    const f = await recordedHistory();
    try {
      f.database.db.prepare("UPDATE runs SET duration_ms=? WHERE id IN ('R1','R2')").run(Number.MAX_SAFE_INTEGER);
      await expect(f.products.getMetrics({ productId: f.first.product.id })).rejects.toMatchObject({ code: "DATA_CORRUPT" });
    } finally { f.database.close(); }
  });
});
