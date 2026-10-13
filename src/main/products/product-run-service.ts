import { createHash, randomUUID } from "node:crypto";

import type { AppDatabase } from "../db/database.js";
import type { TaskOrchestrator } from "../orchestrator/task-orchestrator.js";
import { AgentRunError, AgentOutputError } from "../adapters/agent-adapter.js";
import type { RunControl } from "../runs/run-control.js";
import type { ProductExecutionService } from "./product-execution-service.js";
import {
  ProductRunError,
  type ControlProductRunInput,
  type ProductRunAction,
  type StartProductRunInput,
} from "../../shared/contracts/product-run.js";
import { assertProductRunInput, assertProductRunResponse } from "../../shared/core/product-run-validation.js";
import { canonicalProductJson } from "../../shared/core/product-validation.js";
import { validateExpectedTaskSpecIdentity, validateTaskSpec, type TaskSpec } from "../../shared/core/task-spec.js";
import type { TaskRecord } from "../../shared/contracts/records.js";

type Row = Record<string, unknown>;
type RuntimeAccess = { assertReady: () => void; invoke: <T>(_action: () => Promise<T>) => Promise<T> };
type Execution = Pick<ProductExecutionService, "getState">;
type Orchestrator = Pick<TaskOrchestrator, "startBuild" | "startTests" | "startFinalGate">;
type Runs = Pick<RunControl, "cancel">;

const ACTIVE = ["RUNNING", "PAUSE_REQUESTED", "CANCEL_REQUESTED"] as const;
const isActive = (status: string): boolean => (ACTIVE as readonly string[]).includes(status);
const timestamp = (): string => new Date().toISOString();
const hash = (value: unknown): string => createHash("sha256").update(canonicalProductJson(value), "utf8").digest("hex");
const hashText = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Coordinates one already approved product Task through the existing executor. */
export class ProductRunService {
  private readonly database: AppDatabase;
  private readonly execution: Execution;
  private readonly orchestrator: Orchestrator;
  private readonly runtime: RuntimeAccess;
  private readonly runs: Runs;

  constructor(
    database: AppDatabase,
    execution: Execution,
    orchestrator: Orchestrator,
    runtime: RuntimeAccess,
    runs: Runs,
  ) {
    this.database = database;
    this.execution = execution;
    this.orchestrator = orchestrator;
    this.runtime = runtime;
    this.runs = runs;
  }

  async getState(input: { productId: string }): Promise<ProductRunAction | null> {
    this.input("getState", input);
    try { await this.execution.getState(input); } catch (error) { throw this.mapExecutionError(error); }
    const row = this.database.db.prepare("SELECT * FROM product_run_actions WHERE product_id=? ORDER BY created_at DESC, id DESC LIMIT 1").get(input.productId) as Row | undefined;
    const action = row ? this.action(row) : null;
    this.output("getState", action, input.productId);
    return action;
  }

  async start(input: StartProductRunInput): Promise<ProductRunAction> {
    this.input("start", input);
    const requestHash = hash({ method: "start", input });
    const historical = this.readRequest(input.requestId, requestHash);
    if (historical) return historical;

    try { await this.execution.getState({ productId: input.productId }); }
    catch (error) { throw this.mapExecutionError(error); }

    // The readiness check is intentionally before the reservation transaction.
    try { this.runtime.assertReady(); }
    catch { throw new ProductRunError("RUNTIME_UNAVAILABLE", "运行时尚未通过可用性检查。"); }

    let action: ProductRunAction;
    let created = false;
    try {
      const result = this.database.transaction(() => {
        const raced = this.readRequest(input.requestId, requestHash);
        if (raced) return { action: raced, created: false };
        this.assertBinding(input);
        const busy = this.database.db.prepare("SELECT id FROM product_run_actions WHERE task_id=? AND status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED')").get(input.taskId) as Row | undefined;
        if (busy) throw new ProductRunError("TASK_BUSY", "关联任务已有连续执行动作。");
        const task = this.database.getTask(input.taskId);
        if (!task) throw new ProductRunError("NOT_FOUND", "关联任务不存在。");
        const stage = this.initialStage(task.status, input.taskId);
        const maxModelCalls = this.maxModelCallsForTask(task);
        if (this.isModelStage(stage) && this.sharedSpent(input.taskId, input.specRevision, input.specHash) >= maxModelCalls) {
          throw new ProductRunError("BUDGET_EXHAUSTED", "已批准 TaskSpec 的共享模型预算已耗尽。");
        }
        const now = timestamp();
        const id = `PRODUCT-RUN-${randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase()}`;
        this.database.db.prepare(`INSERT INTO product_run_actions
          (id,request_id,request_hash,product_id,plan_revision,task_id,spec_revision,spec_hash,spec_approved_at,status,stage,reserved_model_calls,max_model_calls,created_at,finished_at,error_code)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, input.requestId, requestHash, input.productId, input.planRevision, input.taskId, input.specRevision, input.specHash, task.specApprovedAt, "RUNNING", stage, 0, maxModelCalls, now, null, null);
        return { action: this.action(this.database.db.prepare("SELECT * FROM product_run_actions WHERE id=?").get(id) as Row), created: true };
      });
      action = result.action;
      created = result.created;
    } catch (error) {
      if (error instanceof ProductRunError) throw error;
      if (String(error).includes("UNIQUE")) throw new ProductRunError("TASK_BUSY", "关联任务已有连续执行动作。");
      throw new ProductRunError("INTERNAL_ERROR", "无法登记连续执行动作。");
    }

    // Only the first request schedules a driver. Its failure is persisted by drive().
    if (created) void this.drive(action.id).catch(() => undefined);
    this.output("start", action, input.productId);
    return action;
  }

  async pause(input: ControlProductRunInput): Promise<ProductRunAction> {
    this.input("pause", input);
    const action = this.control(input, "PAUSE_REQUESTED");
    this.output("pause", action, input.productId);
    return action;
  }

  async cancel(input: ControlProductRunInput): Promise<ProductRunAction> {
    this.input("cancel", input);
    const action = this.control(input, "CANCEL_REQUESTED");
    for (const run of this.database.listTaskRuns(action.taskId)) {
      if (["STARTING", "RUNNING", "CANCELLING"].includes(run.status)) {
        try { this.runs.cancel(run.id); } catch { /* the driver keeps CANCEL_REQUESTED until convergence */ }
      }
    }
    this.output("cancel", action, input.productId);
    return action;
  }

  /** Marks actions left by a stopped process; it never dispatches old work. */
  recoverInterrupted(): number {
    const now = timestamp();
    const result = this.database.db.prepare(`UPDATE product_run_actions SET status='INTERRUPTED', finished_at=?, error_code='APP_RESTART'
      WHERE status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED')`).run(now);
    return Number(result.changes);
  }

  /** Guard used by the legacy manual Task IPC before it mutates a linked task. */
  assertTaskIdle(taskId: string, stage?: "build" | "review"): void {
    const deleted = this.database.db.prepare("SELECT 1 FROM product_task_links l JOIN product_workspaces w ON w.id=l.product_id WHERE l.task_id=? AND w.deleted_at IS NOT NULL LIMIT 1").get(taskId);
    if (deleted) throw new ProductRunError("NOT_FOUND", "请先恢复已删除的产品。");
    const row = this.database.db.prepare("SELECT 1 FROM product_run_actions WHERE task_id=? AND status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED') LIMIT 1").get(taskId);
    if (row) throw new ProductRunError("TASK_BUSY", "任务正在由产品连续执行控制。");
    if (!stage) return;

    const task = this.database.getTask(taskId);
    if (!task?.specJson || !task.specApprovedAt) return;
    const link = this.database.db.prepare("SELECT product_id FROM product_task_links WHERE task_id=?").get(taskId);
    if (!link) return;
    try { this.parseTaskSpec(task); } catch { return; }
    const specHash = hashText(task.specJson);
    const first = this.database.db.prepare(`SELECT max_model_calls FROM product_run_actions
      WHERE task_id=? AND spec_revision=? AND spec_hash=? ORDER BY created_at ASC, id ASC LIMIT 1`)
      .get(taskId, task.specRevision, specHash) as Row | undefined;
    if (!first) return;
    const maxModelCalls = Math.min(6, Math.max(2, Number(first.max_model_calls ?? 2)));
    if (this.sharedSpent(taskId, task.specRevision, specHash) >= maxModelCalls) {
      throw new ProductRunError("BUDGET_EXHAUSTED", "已批准 TaskSpec 的共享模型预算已耗尽。");
    }
  }

  private async drive(actionId: string): Promise<void> {
    try {
      while (true) {
        const action = this.readAction(actionId);
        if (!action || !isActive(action.status)) return;
        if (action.status === "CANCEL_REQUESTED") { this.finish(actionId, "CANCELLED", "CANCELLED"); return; }
        if (action.status === "PAUSE_REQUESTED") { this.finish(actionId, "PAUSED", "PAUSED"); return; }

        const task = this.database.getTask(action.taskId);
        if (!task) { this.finish(actionId, "FAILED", "TASK_NOT_FOUND"); return; }
        if (["BLOCKED", "FAILED", "INTERRUPTED"].includes(task.status)) { this.finish(actionId, "FAILED", `TASK_${task.status}`); return; }
        if (task.status === "CANCELLED") { this.finish(actionId, "CANCELLED", "CANCELLED"); return; }
        if (task.status === "PASSED") { this.finish(actionId, "SUCCEEDED", null); return; }

        const stage = this.stageFor(task.status, action.taskId);
        if (!stage) { this.finish(actionId, "FAILED", "TASK_NOT_READY"); return; }
        if (!(this.reserveStage(actionId, stage))) return;

        const unsubscribe = this.database.subscribeEvents(event => {
          if (event.taskId !== action.taskId || event.type !== "RUN_SPAWNED" || !event.runId) return;
          const runId = event.runId;
          queueMicrotask(() => {
            try { if (this.readAction(actionId)?.status === "CANCEL_REQUESTED") this.runs.cancel(runId); } catch { /* Await stage convergence; do not claim a confirmed stop. */ }
          });
        });
        let stageError: unknown = null;
        try {
          if (stage === "build") await this.runtime.invoke(() => this.orchestrator.startBuild(action.taskId, "default", action.id));
          else if (stage === "tests") await this.orchestrator.startTests(action.taskId);
          else await this.runtime.invoke(() => this.orchestrator.startFinalGate(action.taskId, action.id));
        } catch (error) { stageError = error; } finally { unsubscribe(); }

        const after = this.readAction(actionId);
        if (!after || !isActive(after.status)) return;
        if (after.status === "CANCEL_REQUESTED") {
          const unconfirmedStop = (stageError instanceof AgentRunError || stageError instanceof AgentOutputError) && stageError.result.closeObserved === false;
          this.finish(actionId, unconfirmedStop ? "INTERRUPTED" : "CANCELLED", unconfirmedStop ? "STOP_NOT_CONFIRMED" : "CANCELLED");
          return;
        }
        if (after.status === "PAUSE_REQUESTED") { this.finish(actionId, "PAUSED", "PAUSED"); return; }
        const completedTask = this.database.getTask(after.taskId);
        if (stageError) {
          // The orchestrator may classify an engineering failure as REWORK.
          // Continue only when the next Attempt is still within the approved
          // TaskSpec bound; runtime/auth/quota and hard failures are BLOCKED.
          if (completedTask?.status === "REWORK" && this.stageFor(completedTask.status, after.taskId) === "build") {
            try { this.assertBinding({ productId: after.productId, planRevision: after.planRevision, taskId: after.taskId, specRevision: after.specRevision, specHash: after.specHash }); }
            catch (error) { this.finish(actionId, "FAILED", this.safeError(error, "BINDING_CHANGED")); return; }
            continue;
          }
          this.finish(actionId, "FAILED", this.safeError(stageError, "STAGE_FAILED")); return;
        }

        if (completedTask?.status === "PASSED") {
          try { this.assertBinding({ productId: after.productId, planRevision: after.planRevision, taskId: after.taskId, specRevision: after.specRevision, specHash: after.specHash }, true); }
          catch (error) { this.finish(actionId, "FAILED", this.safeError(error, "BINDING_CHANGED")); return; }
          this.finish(actionId, "SUCCEEDED", null); return;
        }
        if (completedTask && ["BLOCKED", "FAILED", "INTERRUPTED"].includes(completedTask.status)) {
          this.finish(actionId, "FAILED", `TASK_${completedTask.status}`); return;
        }

        // Binding and approved-spec checks are repeated after every awaited stage.
        try { this.assertBinding({ productId: after.productId, planRevision: after.planRevision, taskId: after.taskId, specRevision: after.specRevision, specHash: after.specHash }); }
        catch (error) { this.finish(actionId, "FAILED", this.safeError(error, "BINDING_CHANGED")); return; }
      }
    } catch (error) {
      this.finish(actionId, "FAILED", this.safeError(error, "INTERNAL_ERROR"));
    }
  }

  private reserveStage(actionId: string, stage: ProductRunAction["stage"]): boolean {
    if (!stage) return false;
    try {
      return this.database.transaction(() => {
        const action = this.readAction(actionId);
        if (!action) return false;
        if (action.status === "CANCEL_REQUESTED") { this.finish(actionId, "CANCELLED", "CANCELLED"); return false; }
        if (action.status === "PAUSE_REQUESTED") { this.finish(actionId, "PAUSED", "PAUSED"); return false; }
        if (action.status !== "RUNNING") return false;
        this.assertBinding({ productId: action.productId, planRevision: action.planRevision, taskId: action.taskId, specRevision: action.specRevision, specHash: action.specHash });
        const task = this.database.getTask(action.taskId);
        if (!task || this.stageFor(task.status, action.taskId) !== stage) throw new ProductRunError("TASK_NOT_READY", "任务状态已改变。");
        const modelCall = this.isModelStage(stage);
        if (modelCall) {
          const spent = this.sharedSpent(action.taskId, action.specRevision, action.specHash);
          if (spent >= action.maxModelCalls || action.reservedModelCalls >= action.maxModelCalls) {
            throw new ProductRunError("BUDGET_EXHAUSTED", "已批准 TaskSpec 的共享模型预算已耗尽。");
          }
        }
        const result = this.database.db.prepare(`UPDATE product_run_actions SET stage=?, reserved_model_calls=reserved_model_calls+?, error_code=NULL
          WHERE id=? AND status='RUNNING' AND reserved_model_calls+?<=max_model_calls`)
          .run(stage, modelCall ? 1 : 0, actionId, modelCall ? 1 : 0);
        if (Number(result.changes) !== 1) throw new ProductRunError("BUDGET_EXHAUSTED", "已批准 TaskSpec 的共享模型预算已耗尽。");
        return true;
      });
    } catch (error) {
      this.finish(actionId, "FAILED", this.safeError(error, "STAGE_RESERVATION_FAILED"));
      return false;
    }
  }

  private control(input: ControlProductRunInput, requested: "PAUSE_REQUESTED" | "CANCEL_REQUESTED"): ProductRunAction {
    const row = this.database.db.prepare("SELECT * FROM product_run_actions WHERE id=? AND product_id=?").get(input.actionId, input.productId) as Row | undefined;
    if (!row) throw new ProductRunError("NOT_FOUND", "连续执行动作不存在。");
    const action = this.action(row);
    if (!isActive(action.status)) return action;
    if (requested === "PAUSE_REQUESTED" && action.status === "CANCEL_REQUESTED") return action;
    this.database.db.prepare("UPDATE product_run_actions SET status=? WHERE id=? AND status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED')").run(requested, action.id);
    return this.readAction(action.id)!;
  }

  private finish(actionId: string, status: ProductRunAction["status"], errorCode: string | null): void {
    if (status === "RUNNING" || status === "PAUSE_REQUESTED" || status === "CANCEL_REQUESTED") return;
    this.database.db.prepare("UPDATE product_run_actions SET status=?, finished_at=COALESCE(finished_at,?), error_code=? WHERE id=? AND status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED')").run(status, timestamp(), errorCode, actionId);
  }

  private assertBinding(input: Pick<StartProductRunInput, "productId" | "planRevision" | "taskId" | "specRevision" | "specHash">, allowPassed = false): void {
    const row = this.database.db.prepare(`SELECT w.id product_id,w.repo_project_id,w.current_cycle_id,c.goal_revision,g.sha256 goal_hash,g.payload_json goal_payload_json,
      p.revision,p.goal_revision plan_goal_revision,p.goal_hash plan_goal_hash,p.payload_json plan_payload_json,p.sha256 plan_hash,p.confirmed_at,
      l.task_id,l.cycle_id,d.id decision_id,t.spec_json,t.spec_revision,t.spec_approved_at,t.base_sha,t.status task_status
      FROM product_workspaces w
      JOIN product_cycles c ON c.id=w.current_cycle_id AND c.workspace_id=w.id
      JOIN product_goal_revisions g ON g.cycle_id=c.id AND g.revision=c.goal_revision
      JOIN product_plan_revisions p ON p.cycle_id=c.id AND p.revision=?
      JOIN product_task_links l ON l.product_id=w.id AND l.cycle_id=c.id AND l.plan_revision=p.revision AND l.task_id=?
      JOIN tasks t ON t.id=l.task_id
      LEFT JOIN product_decisions d ON d.cycle_id=c.id AND d.kind='DIRECTION_CONFIRMED' AND d.goal_revision=c.goal_revision
      WHERE w.id=? AND w.deleted_at IS NULL`).get(input.planRevision, input.taskId, input.productId) as Row | undefined;
    if (!row) throw new ProductRunError("PLAN_STALE", "产品计划或任务绑定已过期。");
    if (Number(row.revision) !== input.planRevision || Number(row.plan_goal_revision) !== Number(row.goal_revision) || row.confirmed_at === null || row.decision_id == null) throw new ProductRunError("PLAN_STALE", "产品计划尚未确认或已过期。");
    if (row.repo_project_id === null || String(row.repo_project_id) !== String((this.database.db.prepare("SELECT project_id FROM tasks WHERE id=?").get(input.taskId) as Row | undefined)?.project_id)) throw new ProductRunError("PLAN_STALE", "任务仓库绑定已发生变化。");
    if (!this.validJsonHash(row.goal_payload_json, row.goal_hash) || !this.validJsonHash(row.plan_payload_json, row.plan_hash) || String(row.plan_goal_hash) !== String(row.goal_hash)) throw new ProductRunError("PLAN_STALE", "产品目标或计划哈希不匹配。");
    const latest = this.database.db.prepare("SELECT revision FROM product_plan_revisions WHERE cycle_id=? ORDER BY revision DESC LIMIT 1").get(String(row.current_cycle_id)) as Row | undefined;
    if (!latest || Number(latest.revision) !== input.planRevision) throw new ProductRunError("PLAN_STALE", "产品计划已过期。");
    const raw = row.spec_json === null ? null : String(row.spec_json);
    if (!raw || row.spec_approved_at === null || Number(row.spec_revision) !== input.specRevision || hashText(raw) !== input.specHash) throw new ProductRunError("SPEC_CHANGED", "批准的 TaskSpec 已发生变化。");
    const spec = this.parseTaskSpec({ id: input.taskId, baseSha: String(row.base_sha), specJson: raw } as TaskRecord);
    const taskStatus = String(row.task_status);
    if (!("SPEC_APPROVED" === taskStatus || "BUILT" === taskStatus || "GATE_READY" === taskStatus || (allowPassed && taskStatus === "PASSED"))) {
      if (taskStatus !== "REWORK") throw new ProductRunError("TASK_NOT_READY", "任务尚未处于可连续执行状态。");
      const latestAttempt = this.database.getLatestAttempt(input.taskId);
      if (!latestAttempt || latestAttempt.number >= spec.limits.max_attempts) throw new ProductRunError("TASK_NOT_READY", "任务返工次数已达到 TaskSpec 上限。");
    }
  }

  private initialStage(status: string, taskId: string): ProductRunAction["stage"] {
    const stage = this.stageFor(status, taskId);
    if (!stage) throw new ProductRunError("TASK_NOT_READY", "任务尚未处于可连续执行状态。");
    return stage;
  }

  private stageFor(status: string, taskId?: string): ProductRunAction["stage"] {
    if (status === "SPEC_APPROVED") return "build";
    if (status === "BUILT") return "tests";
    if (status === "GATE_READY") return "review";
    if (status === "REWORK" && taskId) {
      const task = this.database.getTask(taskId);
      const latestAttempt = this.database.getLatestAttempt(taskId);
      if (!task || !latestAttempt) return null;
      try {
        const spec = this.parseTaskSpec(task);
        return latestAttempt.number < spec.limits.max_attempts ? "build" : null;
      } catch { return null; }
    }
    return null;
  }

  private validJsonHash(raw: unknown, expected: unknown): boolean {
    if (typeof raw !== "string" || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
    try { return hash(JSON.parse(raw)) === expected; } catch { return false; }
  }

  private readRequest(requestId: string, requestHash: string): ProductRunAction | null {
    const row = this.database.db.prepare("SELECT * FROM product_run_actions WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return null;
    if (String(row.request_hash) !== requestHash) throw new ProductRunError("REQUEST_ID_CONFLICT", "requestId 已用于不同的连续执行请求。");
    return this.action(row);
  }

  private readAction(id: string): ProductRunAction | null {
    const row = this.database.db.prepare("SELECT * FROM product_run_actions WHERE id=?").get(id) as Row | undefined;
    return row ? this.action(row) : null;
  }

  private parseTaskSpec(task: Pick<TaskRecord, "id" | "baseSha" | "specJson">): TaskSpec {
    if (!task.specJson) throw new ProductRunError("SPEC_NOT_APPROVED", "批准的 TaskSpec 不存在。");
    let parsed: unknown;
    try { parsed = JSON.parse(task.specJson); } catch { throw new ProductRunError("SPEC_NOT_APPROVED", "批准的 TaskSpec 不是有效 JSON。"); }
    const checked = validateTaskSpec(parsed);
    if (!checked.valid || !validateExpectedTaskSpecIdentity(checked.value, { taskId: task.id, baseSha: task.baseSha }).valid) {
      throw new ProductRunError("SPEC_NOT_APPROVED", "批准的 TaskSpec 无效或任务身份不匹配。");
    }
    return checked.value;
  }

  private maxModelCallsForTask(task: TaskRecord): number {
    const first = this.database.db.prepare(`SELECT max_model_calls FROM product_run_actions
      WHERE task_id=? AND spec_revision=? AND spec_hash=? ORDER BY created_at ASC, id ASC LIMIT 1`)
      .get(task.id, task.specRevision, hashText(task.specJson ?? "")) as Row | undefined;
    if (first && Number.isFinite(Number(first.max_model_calls))) return Math.min(6, Math.max(2, Number(first.max_model_calls)));
    const spec = this.parseTaskSpec(task);
    return Math.min(6, Math.max(2, spec.limits.max_attempts * 2));
  }

  private sharedSpent(taskId: string, specRevision: number, specHash: string): number {
    const reserved = this.database.db.prepare(`SELECT COALESCE(SUM(reserved_model_calls),0) AS total
      FROM product_run_actions WHERE task_id=? AND spec_revision=? AND spec_hash=?`)
      .get(taskId, specRevision, specHash) as Row;
    const manual = this.database.db.prepare(`SELECT COUNT(*) AS total FROM runs
      WHERE task_id=? AND stage IN ('builder','reviewer') AND product_run_action_id IS NULL`).get(taskId) as Row;
    return Number(reserved.total ?? 0) + Number(manual.total ?? 0);
  }

  private isModelStage(stage: ProductRunAction["stage"]): boolean {
    return stage === "build" || stage === "review";
  }

  private action(row: Row): ProductRunAction {
    const maxModelCalls = Math.min(6, Math.max(2, Number(row.max_model_calls ?? 2)));
    return { id: String(row.id), productId: String(row.product_id), planRevision: Number(row.plan_revision), taskId: String(row.task_id), specRevision: Number(row.spec_revision), specHash: String(row.spec_hash), status: String(row.status) as ProductRunAction["status"], stage: row.stage === null ? null : String(row.stage) as ProductRunAction["stage"], reservedModelCalls: Number(row.reserved_model_calls), maxModelCalls, usedModelCalls: this.sharedSpent(String(row.task_id), Number(row.spec_revision), String(row.spec_hash)), errorCode: row.error_code === null ? null : String(row.error_code), createdAt: String(row.created_at), finishedAt: row.finished_at === null ? null : String(row.finished_at) };
  }

  private input(method: "getState" | "start" | "pause" | "cancel", value: unknown): void {
    try { assertProductRunInput(method, value); } catch (error) { if (error instanceof ProductRunError) throw error; throw new ProductRunError("INVALID_INPUT", "产品连续执行请求不正确。"); }
  }

  private output(method: "getState" | "start" | "pause" | "cancel", value: ProductRunAction | null, productId: string): void {
    try { assertProductRunResponse(method, { ok: true, value }, productId); } catch (error) { if (error instanceof ProductRunError) throw error; throw new ProductRunError("INVALID_RESPONSE", "连续执行响应不正确。"); }
  }

  private mapExecutionError(error: unknown): ProductRunError {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "NOT_FOUND") return new ProductRunError("NOT_FOUND", "产品不存在。");
    return new ProductRunError("INTERNAL_ERROR", "无法读取产品执行上下文。");
  }

  private safeError(error: unknown, fallback: string): string {
    const value = error instanceof ProductRunError ? error.code : error instanceof AgentRunError || error instanceof AgentOutputError ? error.classification.code : error instanceof Error ? error.message : String(error);
    return /^[A-Z][A-Z0-9_]{1,100}$/.test(value) ? value : fallback;
  }
}
