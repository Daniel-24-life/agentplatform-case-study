import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";
import { ProductRunService } from "../../src/main/products/product-run-service.js";
import { ProductExecutionService } from "../../src/main/products/product-execution-service.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
import { ProductService } from "../../src/main/products/product-service.js";
import type { ProductPlan } from "../../src/shared/contracts/product-plan.js";
import type { ProductGoal } from "../../src/shared/contracts/products.js";

const databases: AppDatabase[] = [];
const goal = (): ProductGoal => ({ schemaVersion: "1.0", originalRequest: "Build", goal: "Deliver", scope: "Local", assumptions: [], acceptanceCriteria: [{ id: "done", description: "Works", verification: "platform", required: true }] });
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

async function fixture(taskStatus: "SPEC_APPROVED" | "BUILT" | "GATE_READY" = "SPEC_APPROVED", gateFails = false, maxAttempts = 1) {
  const database = new AppDatabase(":memory:"); databases.push(database);
  const products = new ProductService(database);
  const plans = new ProductPlanService(database, products);
  const created = await products.create({ requestId: "create", name: "Product", initialRequest: "Build" });
  const revised = await products.reviseGoal({ requestId: "revise", productId: created.product.id, expectedRevision: 1, goal: goal() });
  const confirmed = await products.confirmDirection({ requestId: "direction", productId: created.product.id, expectedRevision: revised.product.revision, goalRevision: revised.goal.revision });
  const plan: ProductPlan = { schemaVersion: "1.0", productId: confirmed.product.id, goalRevision: confirmed.goal.revision, goalHash: confirmed.goal.hash, summary: "Ship", workItems: [{ id: "one", title: "One", objective: "One", deliverable: "One", acceptanceCriterionIds: ["done"], dependsOn: [] }] };
  const saved = await plans.save({ requestId: "save", productId: confirmed.product.id, expectedPlanRevision: 0, plan });
  await plans.confirm({ requestId: "plan", productId: confirmed.product.id, planRevision: saved.revision });
  database.createProject({ id: "repo", name: "Repo", repoPath: "C:/repo", repoRealPath: "C:/repo", lastSeenHead: "a".repeat(40) });
  const execution = new ProductExecutionService(database, products, plans, { inspect: async () => ({ root: "C:/repo", head: "b".repeat(40), branch: "main", clean: true }) });
  await execution.bindRepository({ requestId: "bind", productId: confirmed.product.id, expectedRevision: confirmed.product.revision, repositoryId: "repo" });
  const link = await execution.createTask({ requestId: "task", productId: confirmed.product.id, planRevision: saved.revision });
  const raw = JSON.stringify(JSON.parse(readFileSync(join(process.cwd(), "examples", "task-spec.example.json"), "utf8")));
  const spec = JSON.parse(raw) as Record<string, unknown>; spec.task_id = link.taskId; spec.base_sha = "b".repeat(40); spec.schema_version = "2.0"; delete spec.worker; spec.execution_policy = { planner_recommendation: "cheap", planner_confidence: "high", recommendation_reasons: ["test"], user_lock: null }; (spec.limits as Record<string, unknown>).max_attempts = maxAttempts;
  const specJson = JSON.stringify(spec);
  database.saveSpec(link.taskId, specJson); database.approveSpec(link.taskId, specJson);
  for (const status of ["DESIGNING", "SPEC_READY", "SPEC_APPROVED"] as const) database.transitionTask(link.taskId, status);
  if (taskStatus !== "SPEC_APPROVED") {
    database.transitionTask(link.taskId, "PREPARING_WORKTREE"); database.transitionTask(link.taskId, "BUILDING"); database.transitionTask(link.taskId, "BUILT");
  }
  if (taskStatus === "GATE_READY") {
    database.transitionTask(link.taskId, "TESTING"); database.transitionTask(link.taskId, "DETERMINISTIC_GATE"); database.transitionTask(link.taskId, "GATE_READY");
  }
  const calls: string[] = [];
  const orchestrator = {
    startBuild: async (taskId: string) => { calls.push("build"); await new Promise(resolve => setTimeout(resolve, 5)); database.transitionTask(taskId, "PREPARING_WORKTREE"); database.transitionTask(taskId, "BUILDING"); database.transitionTask(taskId, "BUILT"); return database.getTask(taskId)!; },
    startTests: async (taskId: string) => { calls.push("tests"); database.transitionTask(taskId, "TESTING"); database.transitionTask(taskId, "DETERMINISTIC_GATE"); database.transitionTask(taskId, gateFails ? "REWORK" : "GATE_READY"); return database.getTask(taskId)!; },
    startFinalGate: async (taskId: string) => { calls.push("review"); database.transitionTask(taskId, "REVIEWING"); database.transitionTask(taskId, "PASSED"); return database.getTask(taskId)!; }
  };
  const service = new ProductRunService(database, execution, orchestrator, { assertReady: () => undefined, invoke: async <T>(action: () => Promise<T>) => action() }, { cancel: () => ({ cancelled: true }) });
  return { database, service, execution, orchestrator, products, plans, productId: confirmed.product.id, planRevision: saved.revision, taskId: link.taskId, specRevision: database.getTask(link.taskId)!.specRevision, specHash: sha(specJson), calls };
}

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("ProductRunService", () => {
  it("drives build, tests, and review with two model reservations", async () => {
    const f = await fixture();
    const action = await f.service.start({ requestId: "run", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash });
    await vi.waitFor(async () => expect((await f.service.getState({ productId: f.productId }))?.status).toBe("SUCCEEDED"));
    expect(f.calls).toEqual(["build", "tests", "review"]);
    expect((await f.service.getState({ productId: f.productId }))?.reservedModelCalls).toBe(2);
    expect(action.status).toBe("RUNNING");
  });

  it("deduplicates request ids and rejects a second active task action", async () => {
    const f = await fixture();
    const input = { requestId: "run", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash };
    const first = await f.service.start(input);
    await expect(f.service.start({ ...input, requestId: "other" })).rejects.toMatchObject({ code: "TASK_BUSY" });
    expect((await f.service.start(input)).id).toBe(first.id);
  });

  it("does not call reviewer after deterministic gate failure", async () => {
    const f = await fixture("SPEC_APPROVED", true, 1);
    await f.service.start({ requestId: "run", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash });
    await vi.waitFor(async () => expect((await f.service.getState({ productId: f.productId }))?.status).toBe("FAILED"));
    expect(f.calls).toEqual(["build", "tests"]);
  });
  it("continues an eligible engineering REWORK into the next Attempt", async () => {
    const f = await fixture("SPEC_APPROVED", false, 2);
    let builds = 0;
    f.orchestrator.startBuild = async taskId => {
      f.calls.push("build");
      builds += 1;
      const attempt = builds;
      f.database.createAttempt({ id: `attempt-${attempt}`, taskId, number: attempt, branch: `branch-${attempt}`, worktreePath: `C:/worktree-${attempt}`, status: "ACTIVE", createdAt: new Date().toISOString() });
      f.database.transitionTask(taskId, "PREPARING_WORKTREE");
      f.database.transitionTask(taskId, "BUILDING");
      f.database.transitionTask(taskId, attempt === 1 ? "REWORK" : "BUILT");
      return f.database.getTask(taskId)!;
    };
    await f.service.start({ requestId: "repair", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash });
    await vi.waitFor(async () => expect((await f.service.getState({ productId: f.productId }))?.status).toBe("SUCCEEDED"));
    const action = await f.service.getState({ productId: f.productId });
    expect(builds).toBe(2);
    expect(f.calls).toEqual(["build", "build", "tests", "review"]);
    expect(action).toMatchObject({ reservedModelCalls: 3, maxModelCalls: 4, usedModelCalls: 3 });
    expect(f.database.getLatestAttempt(f.taskId)?.number).toBe(2);
  });
  it("schedules only one driver for concurrent identical requests", async () => {
    const f = await fixture();
    const input = { requestId: "same", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash };
    const [first, second] = await Promise.all([f.service.start(input), f.service.start(input)]);
    expect(second.id).toBe(first.id);
    await vi.waitFor(async () => expect((await f.service.getState({ productId: f.productId }))?.status).toBe("SUCCEEDED"));
    expect(f.calls).toEqual(["build", "tests", "review"]);
  });
  it.each(["pause", "cancel"] as const)("%s waits for the active stage and blocks all subsequent stages", async kind => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const build = f.orchestrator.startBuild;
    f.orchestrator.startBuild = async id => { await barrier; return build(id); };
    const action = await f.service.start({ requestId: "control", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash });
    expect((await f.service[kind]({ productId: f.productId, actionId: action.id })).status).toBe(kind === "pause" ? "PAUSE_REQUESTED" : "CANCEL_REQUESTED");
    expect(() => f.service.assertTaskIdle(f.taskId)).toThrow();
    release();
    await vi.waitFor(async () => expect((await f.service.getState({ productId: f.productId }))?.status).toBe(kind === "pause" ? "PAUSED" : "CANCELLED"));
    expect(f.calls).toEqual(["build"]);
    f.service.assertTaskIdle(f.taskId);
  });
  it("rejects altered specs and unavailable runtime without recording an action", async () => {
    const f = await fixture();
    const input = { requestId: "invalid", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: "f".repeat(64) };
    await expect(f.service.start(input)).rejects.toMatchObject({ code: "SPEC_CHANGED" });
    const unavailable = new ProductRunService(f.database, f.execution, f.orchestrator, { assertReady: () => { throw Error("unavailable"); }, invoke: async action => action() }, { cancel: () => ({ cancelled: false }) });
    await expect(unavailable.start({ ...input, specHash: f.specHash })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((f.database.db.prepare("SELECT COUNT(*) count FROM product_run_actions").get() as { count: number }).count).toBe(0);
  });
  it("does not mark stale final-review results as successful product execution", async () => {
    const f = await fixture("GATE_READY");
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const review = f.orchestrator.startFinalGate;
    f.orchestrator.startFinalGate = async id => { await barrier; return review(id); };
    await f.service.start({ requestId: "review", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash });
    const current = await f.products.getOverview({ productId: f.productId });
    await f.products.reviseGoal({ requestId: "changed-goal", productId: f.productId, expectedRevision: current.product.revision, goal: { ...current.goal.goal, scope: "Different scope" } });
    release();
    await vi.waitFor(async () => expect((await f.service.getState({ productId: f.productId }))?.status).toBe("FAILED"));
    expect((await f.service.getState({ productId: f.productId }))?.errorCode).toBe("PLAN_STALE");
    expect(f.database.getTask(f.taskId)?.status).toBe("PASSED");
  });
  it("marks interrupted actions without replaying their requests", async () => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const build = f.orchestrator.startBuild;
    f.orchestrator.startBuild = async id => { await barrier; return build(id); };
    const input = { requestId: "restart", productId: f.productId, planRevision: f.planRevision, taskId: f.taskId, specRevision: f.specRevision, specHash: f.specHash };
    const action = await f.service.start(input);
    expect(f.service.recoverInterrupted()).toBe(1);
    expect((await f.service.start(input)).id).toBe(action.id);
    expect((await f.service.getState({ productId: f.productId }))?.status).toBe("INTERRUPTED");
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.calls).toEqual(["build"]);
  });
});
