import { createHash, randomUUID } from "node:crypto";

import type { AppDatabase } from "../db/database.js";
import type { GitService, RepositorySnapshot } from "../git/git-service.js";
import type { ProductPlanService } from "./product-plan-service.js";
import type { ProductService } from "./product-service.js";
import type { ProductPlanState, SavedProductPlan } from "../../shared/contracts/product-plan.js";
import { ProductExecutionError, type BindProductRepositoryInput, type CreateProductTaskInput, type ProductExecutionState, type ProductTaskLink } from "../../shared/contracts/product-execution.js";
import type { ProductGoal } from "../../shared/contracts/products.js";
import { assertProductExecutionInput, assertProductExecutionResponse, type ProductExecutionMethod } from "../../shared/core/product-execution-validation.js";
import { canonicalProductJson } from "../../shared/core/product-validation.js";

type Row = Record<string, unknown>;
type Workspace = { id: string; name: string; repoProjectId: string | null; cycleId: string; revision: number; eventSequence: number };
type Project = { id: string; repoPath: string };

const timestamp = (): string => new Date().toISOString();
const digest = (value: unknown): string => createHash("sha256").update(canonicalProductJson(value), "utf8").digest("hex");

/** Connects one confirmed product plan to one existing project Task. */
export class ProductExecutionService {
  private readonly database: AppDatabase;
  private readonly products: ProductService;
  private readonly plans: ProductPlanService;
  private readonly git: Pick<GitService, "inspect">;

  constructor(database: AppDatabase, products: ProductService, plans: ProductPlanService, git: Pick<GitService, "inspect">) {
    this.database = database;
    this.products = products;
    this.plans = plans;
    this.git = git;
  }

  async getState(input: { productId: string }): Promise<ProductExecutionState> {
    this.validateInput("getState", input);
    const planState = await this.readPlanState(input.productId);
    const workspace = this.workspace(input.productId);
    const link = planState.saved && planState.current ? this.linkForPlan(workspace, planState.saved.revision) : null;
    const state: ProductExecutionState = {
      productId: workspace.id,
      repositoryId: workspace.repoProjectId,
      planRevision: planState.saved?.revision ?? null,
      planCurrent: planState.current,
      planConfirmed: planState.current && planState.saved?.confirmedAt !== null && planState.saved?.confirmedAt !== undefined,
      link,
      taskStatus: link === null ? null : this.taskStatus(link.taskId)
    };
    this.assertValue("getState", state, input.productId);
    return state;
  }

  async bindRepository(input: BindProductRepositoryInput): Promise<ProductExecutionState> {
    this.validateInput("bindRepository", input);
    const requestHash = digest({ method: "bindRepository", input });
    const historical = this.mutation(() => this.readReceipt(input.requestId, requestHash, "bindRepository", input.productId));
    if (historical !== undefined) return historical as ProductExecutionState;

    const project = this.project(input.repositoryId);
    const planState = await this.readPlanState(input.productId);
    const afterAwait = this.mutation(() => this.readReceipt(input.requestId, requestHash, "bindRepository", input.productId));
    if (afterAwait !== undefined) return afterAwait as ProductExecutionState;
    return this.mutation(() => {
      const current = this.workspace(input.productId);
      if (current.revision !== input.expectedRevision) throw this.error("REVISION_CONFLICT", "产品版本已发生变化。");
      if (current.repoProjectId !== null && current.repoProjectId !== input.repositoryId) {
        throw this.error("REPOSITORY_LOCKED", "产品已经绑定了其他仓库。");
      }

      if (current.repoProjectId === null) {
        const now = timestamp();
        const nextRevision = current.revision + 1;
        const nextSequence = current.eventSequence + 1;
        const updated = this.database.db.prepare("UPDATE product_workspaces SET repo_project_id=?,revision=?,event_sequence=?,updated_at=? WHERE id=? AND revision=?")
          .run(input.repositoryId, nextRevision, nextSequence, now, current.id, current.revision);
        if (Number(updated.changes) !== 1) throw this.error("REVISION_CONFLICT", "产品版本已发生变化。");
        const goalRevision = this.goalRevision(current.cycleId);
        this.database.db.prepare("INSERT INTO product_events (id,workspace_id,sequence,type,goal_revision,workspace_revision,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), current.id, nextSequence, "REPOSITORY_BOUND", goalRevision, nextRevision, now);
      } else if (!project) {
        throw this.error("REPOSITORY_LOCKED", "已绑定的仓库注册记录不存在。");
      }

      const bound = this.workspace(input.productId);
      const state = this.stateFromPlan(bound, planState);
      this.assertValue("bindRepository", state, input.productId);
      this.writeReceipt(input.requestId, requestHash, input.productId, state, timestamp());
      return state;
    });
  }

  async createTask(input: CreateProductTaskInput): Promise<ProductTaskLink> {
    this.validateInput("createTask", input);
    const requestHash = digest({ method: "createTask", input });

    const historical = this.mutation(() => this.readReceipt(input.requestId, requestHash, "createTask", input.productId));
    if (historical !== undefined) return historical as ProductTaskLink;

    // A plan is unique even when a caller retries with a new request id. Return
    // the existing association and record the new request receipt atomically.
    const existing = this.mutation(() => this.linkForProductPlan(input.productId, input.planRevision));
    if (existing !== null) {
      return this.mutation(() => {
        const raced = this.readReceipt(input.requestId, requestHash, "createTask", input.productId);
        if (raced !== undefined) return raced as ProductTaskLink;
        this.assertValue("createTask", existing, input.productId);
        this.writeReceipt(input.requestId, requestHash, input.productId, existing, timestamp());
        return existing;
      });
    }

    const overview = await this.productOverview(input.productId);
    const planState = await this.readPlanState(input.productId);
    const saved = this.requireCurrentConfirmedPlan(planState, input.planRevision);
    const workspaceBefore = this.workspace(input.productId);
    if (workspaceBefore.repoProjectId === null) throw this.error("REPOSITORY_REQUIRED", "请先绑定仓库。");
    const project = this.project(workspaceBefore.repoProjectId);
    const snapshot = await this.inspectRepository(project);
    if (!snapshot.clean) throw this.error("REPOSITORY_DIRTY", "创建任务前仓库必须保持干净。");
    if (!snapshot.head) throw this.error("REPOSITORY_LOCKED", "无法读取仓库 HEAD。");

    const requestText = this.taskRequestText(overview.goal.goal, saved);
    return this.mutation(() => {
      const raced = this.readReceipt(input.requestId, requestHash, "createTask", input.productId);
      if (raced !== undefined) return raced as ProductTaskLink;
      const racedLink = this.linkForProductPlan(input.productId, input.planRevision);
      if (racedLink !== null) {
        this.writeReceipt(input.requestId, requestHash, input.productId, racedLink, timestamp());
        return racedLink;
      }
      const current = this.workspace(input.productId);
      if (current.repoProjectId === null) throw this.error("REPOSITORY_REQUIRED", "请先绑定仓库。");
      if (current.repoProjectId !== workspaceBefore.repoProjectId) throw this.error("REPOSITORY_LOCKED", "产品仓库绑定已发生变化。");

      const currentGoal = this.currentGoal(current);
      if (currentGoal.revision !== overview.goal.revision || currentGoal.hash !== overview.goal.hash) {
        throw this.error("PLAN_STALE", "产品目标已发生变化，请重新确认计划。");
      }
      const currentPlan = this.latestPlan(current);
      if (currentPlan === null || currentPlan.revision !== input.planRevision || currentPlan.hash !== saved.hash || currentPlan.goalRevision !== currentGoal.revision || currentPlan.goalHash !== currentGoal.hash) {
        throw this.error("PLAN_STALE", "产品计划已发生变化，请重新确认计划。");
      }
      if (currentPlan.confirmedAt === null || !this.directionConfirmed(current.cycleId, currentGoal.revision)) {
        throw this.error("PLAN_NOT_CONFIRMED", "请先确认当前计划。");
      }

      const now = timestamp();
      const taskId = `TASK-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
      this.database.createTask({
        id: taskId,
        projectId: current.repoProjectId,
        title: saved.plan.summary,
        requestText,
        status: "DRAFT",
        baseSha: snapshot.head
      });
      this.database.db.prepare("INSERT INTO product_task_links (product_id,cycle_id,plan_revision,task_id,created_at) VALUES(?,?,?,?,?)")
        .run(current.id, current.cycleId, input.planRevision, taskId, now);
      const link: ProductTaskLink = { productId: current.id, planRevision: input.planRevision, taskId, createdAt: now };
      this.assertValue("createTask", link, input.productId);
      this.writeReceipt(input.requestId, requestHash, input.productId, link, now);
      return link;
    });
  }

  private validateInput(method: ProductExecutionMethod, value: unknown): void {
    try { assertProductExecutionInput(method, value); }
    catch (cause) {
      if (cause instanceof ProductExecutionError) throw cause;
      throw this.error("INVALID_INPUT", "产品任务请求格式不正确。");
    }
  }

  private assertValue(method: ProductExecutionMethod, value: unknown, productId: string): void {
    try { assertProductExecutionResponse(method, { ok: true, value }, productId); }
    catch (cause) {
      if (cause instanceof ProductExecutionError) throw cause;
      throw this.error("INVALID_RESPONSE", "产品任务响应不正确。");
    }
  }

  private mutation<T>(work: () => T): T {
    try { return this.database.transaction(work); }
    catch (cause) {
      if (cause instanceof ProductExecutionError) throw cause;
      throw this.error("INTERNAL_ERROR", "产品任务操作失败。");
    }
  }

  private async productOverview(productId: string) {
    try { return await this.products.getOverview({ productId }); }
    catch (cause) { throw this.mapProductError(cause); }
  }

  private async readPlanState(productId: string): Promise<ProductPlanState> {
    try { return await this.plans.getState({ productId }); }
    catch (cause) { throw this.mapPlanError(cause); }
  }

  private mapProductError(cause: unknown): ProductExecutionError {
    const code = cause instanceof Error && "code" in cause ? String((cause as { code: unknown }).code) : "";
    if (code === "NOT_FOUND") return this.error("NOT_FOUND", "产品不存在。");
    if (code === "INVALID_INPUT") return this.error("INVALID_INPUT", "产品数据不正确。");
    return this.error("INTERNAL_ERROR", "无法读取产品上下文。");
  }

  private mapPlanError(cause: unknown): ProductExecutionError {
    const code = cause instanceof Error && "code" in cause ? String((cause as { code: unknown }).code) : "";
    if (code === "NOT_FOUND") return this.error("NOT_FOUND", "产品不存在。");
    if (code === "PLAN_STALE") return this.error("PLAN_STALE", "产品计划已过期。");
    if (code === "INVALID_INPUT") return this.error("INVALID_INPUT", "产品计划数据不正确。");
    return this.error("INVALID_RESPONSE", "已保存的产品计划不正确。");
  }

  private error(code: ProductExecutionError["code"], message: string): ProductExecutionError {
    return new ProductExecutionError(code, message);
  }

  private workspace(productId: string): Workspace {
    this.products.assertActive(productId);
    const row = this.database.db.prepare("SELECT id,name,repo_project_id,current_cycle_id,revision,event_sequence FROM product_workspaces WHERE id=?").get(productId) as Row | undefined;
    if (!row || row.current_cycle_id === null) throw this.error("NOT_FOUND", "产品不存在。");
    const revision = Number(row.revision);
    const eventSequence = Number(row.event_sequence);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(eventSequence) || eventSequence < 0) throw this.error("INVALID_RESPONSE", "产品版本计数不正确。");
    return { id: String(row.id), name: String(row.name), repoProjectId: row.repo_project_id === null ? null : String(row.repo_project_id), cycleId: String(row.current_cycle_id), revision, eventSequence };
  }

  private project(id: string): Project {
    const row = this.database.db.prepare("SELECT id,repo_path FROM projects WHERE id=?").get(id) as Row | undefined;
    if (!row || typeof row.repo_path !== "string" || row.repo_path.length === 0) throw this.error("REPOSITORY_LOCKED", "仓库注册记录不可用。");
    return { id: String(row.id), repoPath: String(row.repo_path) };
  }

  private async inspectRepository(project: Project): Promise<RepositorySnapshot> {
    try { return await this.git.inspect(project.repoPath); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (message.includes("REPOSITORY_DIRTY")) throw this.error("REPOSITORY_DIRTY", "创建任务前仓库必须保持干净。");
      throw this.error("REPOSITORY_LOCKED", "无法检查已注册仓库。");
    }
  }

  private goalRevision(cycleId: string): number {
    const row = this.database.db.prepare("SELECT goal_revision FROM product_cycles WHERE id=?").get(cycleId) as Row | undefined;
    const revision = Number(row?.goal_revision);
    if (!row || !Number.isSafeInteger(revision) || revision < 1) throw this.error("INVALID_RESPONSE", "产品目标版本不正确。");
    return revision;
  }

  private currentGoal(workspace: Workspace): { revision: number; hash: string } {
    const row = this.database.db.prepare("SELECT c.goal_revision,g.sha256,g.payload_json FROM product_cycles c JOIN product_goal_revisions g ON g.cycle_id=c.id AND g.revision=c.goal_revision WHERE c.id=? AND c.workspace_id=?").get(workspace.cycleId, workspace.id) as Row | undefined;
    if (!row) throw this.error("INVALID_RESPONSE", "产品当前目标不存在。");
    const revision = Number(row.goal_revision);
    const hash = String(row.sha256);
    if (!Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(hash)) throw this.error("INVALID_RESPONSE", "产品当前目标不正确。");
    let payload: unknown;
    try { payload = JSON.parse(String(row.payload_json)); }
    catch { throw this.error("INVALID_RESPONSE", "产品当前目标不是有效 JSON。"); }
    if (digest(payload) !== hash) throw this.error("INVALID_RESPONSE", "产品当前目标哈希不匹配。");
    return { revision, hash };
  }

  private latestPlan(workspace: Workspace): { revision: number; hash: string; goalRevision: number; goalHash: string; confirmedAt: string | null } | null {
    const row = this.database.db.prepare("SELECT revision,sha256,goal_revision,goal_hash,payload_json,confirmed_at FROM product_plan_revisions WHERE cycle_id=? ORDER BY revision DESC LIMIT 1").get(workspace.cycleId) as Row | undefined;
    if (!row) return null;
    const revision = Number(row.revision);
    const goalRevision = Number(row.goal_revision);
    const hash = String(row.sha256);
    const goalHash = String(row.goal_hash);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(goalRevision) || goalRevision < 1 || !/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{64}$/.test(goalHash)) throw this.error("INVALID_RESPONSE", "产品当前计划不正确。");
    let payload: unknown;
    try { payload = JSON.parse(String(row.payload_json)); }
    catch { throw this.error("INVALID_RESPONSE", "产品当前计划不是有效 JSON。"); }
    if (digest(payload) !== hash) throw this.error("INVALID_RESPONSE", "产品当前计划哈希不匹配。");
    return { revision, hash, goalRevision, goalHash, confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at) };
  }

  private directionConfirmed(cycleId: string, goalRevision: number): boolean {
    return this.database.db.prepare("SELECT 1 FROM product_decisions WHERE cycle_id=? AND kind='DIRECTION_CONFIRMED' AND goal_revision=?").get(cycleId, goalRevision) !== undefined;
  }

  private requireCurrentConfirmedPlan(state: ProductPlanState, revision: number): SavedProductPlan {
    if (!state.saved || state.saved.revision !== revision || !state.current) throw this.error("PLAN_STALE", "产品计划已过期，请重新确认计划。");
    if (!state.directionConfirmed || state.saved.confirmedAt === null) throw this.error("PLAN_NOT_CONFIRMED", "请先确认当前计划。");
    return state.saved;
  }

  private stateFromPlan(workspace: Workspace, planState: ProductPlanState): ProductExecutionState {
    const link = planState.saved && planState.current ? this.linkForPlan(workspace, planState.saved.revision) : null;
    return {
      productId: workspace.id,
      repositoryId: workspace.repoProjectId,
      planRevision: planState.saved?.revision ?? null,
      planCurrent: planState.current,
      planConfirmed: planState.current && planState.saved?.confirmedAt !== null && planState.saved?.confirmedAt !== undefined,
      link,
      taskStatus: link === null ? null : this.taskStatus(link.taskId)
    };
  }

  private linkForPlan(workspace: Workspace, revision: number): ProductTaskLink | null {
    return this.linkForProductPlan(workspace.id, revision, workspace.cycleId);
  }

  private linkForProductPlan(productId: string, revision: number, cycleId?: string): ProductTaskLink | null {
    const row = cycleId === undefined
      ? this.database.db.prepare("SELECT l.product_id,l.plan_revision,l.task_id,l.created_at FROM product_task_links l JOIN product_workspaces w ON w.id=l.product_id AND w.current_cycle_id=l.cycle_id WHERE l.product_id=? AND l.plan_revision=?").get(productId, revision) as Row | undefined
      : this.database.db.prepare("SELECT product_id,plan_revision,task_id,created_at FROM product_task_links WHERE product_id=? AND cycle_id=? AND plan_revision=?").get(productId, cycleId, revision) as Row | undefined;
    if (!row) return null;
    const link: ProductTaskLink = { productId: String(row.product_id), planRevision: Number(row.plan_revision), taskId: String(row.task_id), createdAt: String(row.created_at) };
    this.assertValue("createTask", link, productId);
    if (!this.database.getTask(link.taskId)) throw this.error("INVALID_RESPONSE", "关联任务不存在。");
    return link;
  }

  private taskStatus(taskId: string) {
    const task = this.database.getTask(taskId);
    if (!task) throw this.error("INVALID_RESPONSE", "关联任务不存在。");
    return task.status;
  }

  private taskRequestText(goal: ProductGoal, saved: SavedProductPlan): string {
    const criteria = goal.acceptanceCriteria.map(item =>
      `- ${item.id}：${item.description}（${item.required ? "必需" : "可选"}；${item.verification}验收）`);
    const workItems = saved.plan.workItems.map(item => [
      `工作项 ${item.id}：${item.title}`,
      `目标：${item.objective}`, `交付物：${item.deliverable}`,
      `覆盖验收：${item.acceptanceCriterionIds.join("、")}`,
      `依赖：${item.dependsOn.length ? item.dependsOn.join("、") : "无"}`
    ].join("\n"));
    return [
      `原始需求：${goal.originalRequest}`, `产品目标：${goal.goal}`, `范围：${goal.scope}`,
      ...(goal.assumptions.length ? [`待核对假设：${goal.assumptions.join("；")}`] : []),
      "产品验收：", ...criteria, `已确认计划 v${saved.revision}：${saved.plan.summary}`,
      "在同一个工作区完成以下全部工作项，并遵守依赖；TaskSpec必须涵盖产品必需验收：", ...workItems
    ].join("\n\n");
  }

  private readReceipt(requestId: string, requestHash: string, method: ProductExecutionMethod, productId: string): unknown | undefined {
    const row = this.database.db.prepare("SELECT request_hash,product_id,result_json,result_sha256 FROM product_execution_receipts WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return undefined;
    if (String(row.request_hash) !== requestHash) throw this.error("REQUEST_ID_CONFLICT", "requestId 已用于不同的产品任务请求。");
    if (String(row.product_id) !== productId || !/^[a-f0-9]{64}$/.test(String(row.result_sha256))) throw this.error("INVALID_RESPONSE", "已保存的产品任务回执不正确。");
    let value: unknown;
    try { value = JSON.parse(String(row.result_json)); }
    catch { throw this.error("INVALID_RESPONSE", "已保存的产品任务回执不是有效 JSON。"); }
    if (digest(value) !== String(row.result_sha256)) throw this.error("INVALID_RESPONSE", "已保存的产品任务回执哈希不匹配。");
    this.assertValue(method, value, productId);
    return value;
  }

  private writeReceipt(requestId: string, requestHash: string, productId: string, value: unknown, createdAt: string): void {
    const resultJson = canonicalProductJson(value);
    this.database.db.prepare("INSERT INTO product_execution_receipts (request_id,request_hash,product_id,result_json,result_sha256,created_at) VALUES(?,?,?,?,?,?)")
      .run(requestId, requestHash, productId, resultJson, digest(value), createdAt);
  }
}
