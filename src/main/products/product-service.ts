import { createHash, randomUUID } from "node:crypto";

import type { AppDatabase } from "../db/database.js";
import type {
  ConfirmDirectionInput,
  CreateProductInput,
  GoalHistoryInput,
  GoalHistoryItem,
  GoalSnapshot,
  GetGoalInput,
  ListProductsInput,
  Page,
  ProductEvent,
  ProductEventsInput,
  ProductGoal,
  ProductOverview,
  ProductSummary,
  ReviseGoalInput
  ,ProductRevisionInput
} from "../../shared/contracts/products.js";
import { assertProductGoal, assertProductInput, assertProductResponse, canonicalProductJson, initialProductGoal, ProductError, validateDirection } from "../../shared/core/product-validation.js";
import type { ProductMetrics } from "../../shared/contracts/products.js";
import { summarizeRunUsage } from "../../shared/core/run-usage-metrics.js";

type Row = Record<string, unknown>;
type ProductCommand = "create" | "reviseGoal" | "confirmDirection" | "trash" | "restore";
type QueryKind = "list" | "getOverview" | "getMetrics" | "getGoal" | "getGoalHistory" | "readEvents";

const sha256 = (value: unknown): string => createHash("sha256").update(canonicalProductJson(value), "utf8").digest("hex");
const timestamp = (): string => new Date().toISOString();

export class ProductService {
  private readonly database: AppDatabase;
  constructor(database: AppDatabase) { this.database = database; }

  async create(input: CreateProductInput): Promise<ProductOverview> {
    this.validate("create", input);
    const requestHash = sha256({ command: "create", input });
    return this.mutation(() => {
      const duplicate = this.receipt(input.requestId, requestHash);
      if (duplicate !== undefined) return duplicate as ProductOverview;

      const now = timestamp();
      const productId = randomUUID();
      const cycleId = randomUUID();
      const goal = initialProductGoal(input.initialRequest);
      const goalJson = canonicalProductJson(goal);
      this.database.db.prepare("INSERT INTO product_workspaces (id,name,repo_project_id,current_cycle_id,revision,event_sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(productId, input.name, null, null, 1, 1, now, now);
      this.database.db.prepare("INSERT INTO product_cycles (id,workspace_id,cycle_number,state,goal_revision) VALUES(?,?,?,?,?)")
        .run(cycleId, productId, 1, "ALIGNING", 1);
      this.database.db.prepare("UPDATE product_workspaces SET current_cycle_id=? WHERE id=?").run(cycleId, productId);
      this.database.db.prepare("INSERT INTO product_goal_revisions (cycle_id,revision,payload_json,sha256,origin,created_at) VALUES(?,?,?,?,?,?)")
        .run(cycleId, 1, goalJson, sha256(goal), "USER", now);
      this.database.db.prepare("INSERT INTO product_events (id,workspace_id,sequence,type,goal_revision,workspace_revision,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), productId, 1, "PRODUCT_CREATED", 1, 1, now);
      const overview = this.readOverview(productId);
      this.assertResponse("create", overview);
      this.saveReceipt(input.requestId, "create", requestHash, productId, overview, now);
      return overview;
    });
  }

  async reviseGoal(input: ReviseGoalInput): Promise<ProductOverview> {
    this.validate("reviseGoal", input);
    const requestHash = sha256({ command: "reviseGoal", input });
    return this.mutation(() => {
      const duplicate = this.receipt(input.requestId, requestHash);
      if (duplicate !== undefined) return duplicate as ProductOverview;
      this.assertActive(input.productId);
      const workspace = this.workspace(input.productId);
      const cycle = this.cycle(workspace.id);
      if (workspace.revision !== input.expectedRevision) throw this.error("REVISION_CONFLICT", "Product revision has changed");
      const current = this.readGoal(cycle.id, cycle.goalRevision);
      if (input.goal.originalRequest !== current.goal.originalRequest) throw this.error("INVALID_INPUT", "originalRequest cannot be changed");

      const nextGoalRevision = cycle.goalRevision + 1;
      const nextWorkspaceRevision = workspace.revision + 1;
      const now = timestamp();
      const goalJson = canonicalProductJson(input.goal);
      this.database.db.prepare("INSERT INTO product_goal_revisions (cycle_id,revision,payload_json,sha256,origin,created_at) VALUES(?,?,?,?,?,?)")
        .run(cycle.id, nextGoalRevision, goalJson, sha256(input.goal), "USER", now);
      this.database.db.prepare("UPDATE product_cycles SET goal_revision=? WHERE id=?").run(nextGoalRevision, cycle.id);
      this.database.db.prepare("UPDATE product_workspaces SET revision=?,event_sequence=?,updated_at=? WHERE id=? AND revision=?")
        .run(nextWorkspaceRevision, workspace.eventSequence + 1, now, workspace.id, workspace.revision);
      this.database.db.prepare("INSERT INTO product_events (id,workspace_id,sequence,type,goal_revision,workspace_revision,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(), workspace.id, workspace.eventSequence + 1, "GOAL_REVISED", nextGoalRevision, nextWorkspaceRevision, now);
      const overview = this.readOverview(workspace.id);
      this.assertResponse("reviseGoal", overview);
      this.saveReceipt(input.requestId, "reviseGoal", requestHash, workspace.id, overview, now);
      return overview;
    });
  }

  async confirmDirection(input: ConfirmDirectionInput): Promise<ProductOverview> {
    this.validate("confirmDirection", input);
    const requestHash = sha256({ command: "confirmDirection", input });
    return this.mutation(() => {
      const duplicate = this.receipt(input.requestId, requestHash);
      if (duplicate !== undefined) return duplicate as ProductOverview;
      this.assertActive(input.productId);
      const workspace = this.workspace(input.productId);
      const cycle = this.cycle(workspace.id);
      if (workspace.revision !== input.expectedRevision) throw this.error("REVISION_CONFLICT", "Product revision has changed");
      if (cycle.goalRevision !== input.goalRevision) throw this.error("REVISION_CONFLICT", "Goal revision has changed");
      const current = this.readGoal(cycle.id, cycle.goalRevision);
      try { validateDirection(current.goal); } catch (cause) { throw this.directionError(cause); }

      const existing = this.database.db.prepare("SELECT id FROM product_decisions WHERE cycle_id=? AND kind='DIRECTION_CONFIRMED' AND goal_revision=?")
        .get(cycle.id, cycle.goalRevision) as Row | undefined;
      if (!existing) {
        const now = timestamp();
        const nextRevision = workspace.revision + 1;
        const nextSequence = workspace.eventSequence + 1;
        this.database.db.prepare("INSERT INTO product_decisions (id,cycle_id,kind,goal_revision,workspace_revision,created_at) VALUES(?,?,?,?,?,?)")
          .run(randomUUID(), cycle.id, "DIRECTION_CONFIRMED", cycle.goalRevision, nextRevision, now);
        this.database.db.prepare("UPDATE product_workspaces SET revision=?,event_sequence=?,updated_at=? WHERE id=? AND revision=?")
          .run(nextRevision, nextSequence, now, workspace.id, workspace.revision);
        this.database.db.prepare("INSERT INTO product_events (id,workspace_id,sequence,type,goal_revision,workspace_revision,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), workspace.id, nextSequence, "DIRECTION_CONFIRMED", cycle.goalRevision, nextRevision, now);
        const overview = this.readOverview(workspace.id);
        this.assertResponse("confirmDirection", overview);
        this.saveReceipt(input.requestId, "confirmDirection", requestHash, workspace.id, overview, now);
        return overview;
      }

      // A new request confirming the same current goal is a valid no-op. The
      // expected revision check above still makes stale callers fail closed.
      const overview = this.readOverview(workspace.id);
      this.assertResponse("confirmDirection", overview);
      this.saveReceipt(input.requestId, "confirmDirection", requestHash, workspace.id, overview, timestamp());
      return overview;
    });
  }

  async list(input: ListProductsInput = {}): Promise<Page<ProductSummary, string>> {
    this.validate("list", input);
    return this.query(() => {
      const afterId = input.afterId ?? "";
      const limit = this.limit(input.limit, 100);
      const rows = this.database.db.prepare("SELECT id FROM product_workspaces WHERE id>? AND ((deleted_at IS NULL AND ?=0) OR (deleted_at IS NOT NULL AND ?=1)) ORDER BY id LIMIT ?").all(afterId, input.deleted === true ? 1 : 0, input.deleted === true ? 1 : 0, limit + 1) as Row[];
      const hasNext = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => this.readSummary(String(row.id)));
      const result = { items, nextCursor: hasNext ? items.at(-1)?.id ?? null : null };
      this.assertStoredResponse("list", result);
      return result;
    });
  }

  async trash(input: ProductRevisionInput): Promise<ProductOverview> { return this.changeDeleted(input, true); }

  async restore(input: ProductRevisionInput): Promise<ProductOverview> { return this.changeDeleted(input, false); }

  private changeDeleted(input: ProductRevisionInput, deleting: boolean): Promise<ProductOverview> {
    this.validate(deleting ? "trash" : "restore", input);
    const hash = sha256({ command: deleting ? "trash" : "restore", input });
    return Promise.resolve(this.mutation(() => {
      const duplicate = this.receipt(input.requestId, hash); if (duplicate) return duplicate as ProductOverview;
      const workspace = this.workspace(input.productId);
      if (workspace.revision !== input.expectedRevision) throw this.error("REVISION_CONFLICT", "Product revision has changed");
      const row = this.database.db.prepare("SELECT deleted_at FROM product_workspaces WHERE id=?").get(workspace.id) as Row;
      if ((row.deleted_at !== null) === deleting) throw this.error("PRODUCT_DELETED", deleting ? "Product is already deleted" : "Product is not deleted");
      if (deleting) this.assertNotBusy(workspace.id);
      const now = timestamp(), revision = workspace.revision + 1, sequence = workspace.eventSequence + 1;
      this.database.db.prepare("UPDATE product_workspaces SET deleted_at=?,revision=?,event_sequence=?,updated_at=? WHERE id=? AND revision=?").run(deleting ? now : null, revision, sequence, now, workspace.id, workspace.revision);
      const goalRevision = this.cycle(workspace.id).goalRevision;
      this.database.db.prepare("INSERT INTO product_events (id,workspace_id,sequence,type,goal_revision,workspace_revision,created_at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), workspace.id, sequence, deleting ? "PRODUCT_TRASHED" : "PRODUCT_RESTORED", goalRevision, revision, now);
      const overview = this.readOverview(workspace.id);
      this.assertResponse(deleting ? "trash" : "restore", overview);
      this.saveReceipt(input.requestId, deleting ? "trash" : "restore", hash, workspace.id, overview, now);
      return overview;
    }));
  }

  async getOverview(input: { productId: string }): Promise<ProductOverview> {
    this.validate("getOverview", input);
    return this.query(() => {
      this.assertActive(input.productId);
      const overview = this.readOverview(input.productId);
      this.assertStoredResponse("getOverview", overview);
      return overview;
    });
  }

  async getMetrics(input: { productId: string }): Promise<ProductMetrics> {
    this.validate("getMetrics", input);
    return this.query(() => {
      this.assertActive(input.productId);
      const tasks = this.database.db.prepare(`SELECT t.id,t.status,t.spec_approved_at
        FROM tasks t JOIN product_task_links l ON l.task_id=t.id WHERE l.product_id=?`).all(input.productId) as Row[];
      const attempts = this.database.db.prepare(`SELECT a.number,a.status FROM attempts a
        JOIN product_task_links l ON l.task_id=a.task_id WHERE l.product_id=?`).all(input.productId) as Row[];
      // Legacy runs can inherit task identity from Attempt; conflicting identities are corrupt.
      const runs = this.database.db.prepare(`SELECT r.task_id,a.task_id AS attempt_task_id,r.adapter,r.usage_json,r.duration_ms
        FROM runs r LEFT JOIN attempts a ON a.id=r.attempt_id
        LEFT JOIN product_task_links direct ON direct.task_id=r.task_id
        LEFT JOIN product_task_links legacy ON legacy.task_id=a.task_id
        WHERE direct.product_id=? OR legacy.product_id=?`).all(input.productId, input.productId) as Row[];
      if (runs.some(run => run.task_id !== null && run.attempt_task_id !== null && run.task_id !== run.attempt_task_id)) {
        throw this.error("DATA_CORRUPT", "运行的任务归属不一致。");
      }
      const agentRuns = runs.filter(run => run.adapter !== "test-runner");
      const usage = summarizeRunUsage(agentRuns.map(run => run.usage_json === null ? null : String(run.usage_json)));
      const durations = runs.filter(run => typeof run.duration_ms === "number" && Number.isSafeInteger(run.duration_ms) && run.duration_ms >= 0);
      const directionConfirmations = Number((this.database.db.prepare(`SELECT COUNT(*) n FROM product_decisions d
        JOIN product_cycles c ON c.id=d.cycle_id WHERE c.workspace_id=? AND d.kind='DIRECTION_CONFIRMED'`).get(input.productId) as Row).n);
      const planConfirmations = Number((this.database.db.prepare(`SELECT COUNT(*) n FROM product_plan_revisions p
        JOIN product_cycles c ON c.id=p.cycle_id WHERE c.workspace_id=? AND p.confirmed_at IS NOT NULL`).get(input.productId) as Row).n);
      const escalationApprovals = Number((this.database.db.prepare(`SELECT COUNT(*) n FROM events e
        JOIN product_task_links l ON l.task_id=e.task_id WHERE l.product_id=? AND e.type='ESCALATION_APPROVED'`).get(input.productId) as Row).n);
      const passedTaskCount = tasks.filter(task => task.status === "PASSED").length;
      const specApprovals = tasks.filter(task => task.spec_approved_at !== null).length;
      const metrics: ProductMetrics = {
        productId: input.productId,
        scope: "PRODUCT_HISTORY",
        taskCount: tasks.length,
        passedTaskCount,
        technicalCompletionRate: tasks.length ? passedTaskCount / tasks.length : null,
        directionConfirmations,
        planConfirmations,
        specApprovals,
        escalationApprovals,
        keyConfirmationCount: directionConfirmations + planConfirmations + specApprovals + escalationApprovals,
        attemptCount: attempts.length,
        repairAttemptCount: attempts.filter(attempt => Number(attempt.number) > 1).length,
        failedAttemptCount: attempts.filter(attempt => ["FAILED", "BLOCKED", "INTERRUPTED"].includes(String(attempt.status))).length,
        runCount: runs.length,
        agentRunCount: agentRuns.length,
        durationAvailableRuns: durations.length,
        recordedDurationMs: durations.length ? durations.reduce((sum, run) => sum + Number(run.duration_ms), 0) : null,
        usageAvailableRuns: usage.availableRuns,
        usageCoverage: agentRuns.length ? usage.availableRuns / agentRuns.length : null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens
      };
      this.assertStoredResponse("getMetrics", metrics, input);
      return metrics;
    });
  }

  /** Synchronous guard for services that open their own short transaction. */
  assertActive(productId: string): void {
    const row = this.database.db.prepare("SELECT deleted_at FROM product_workspaces WHERE id=?").get(productId) as Row | undefined;
    if (!row) throw this.error("NOT_FOUND", "Product not found");
    if (row.deleted_at !== null) throw this.error("PRODUCT_DELETED", "Product is deleted");
  }

  async getGoal(input: GetGoalInput): Promise<GoalSnapshot> {
    this.validate("getGoal", input);
    return this.query(() => {
      const workspace = this.workspace(input.productId);
      const cycle = this.cycle(workspace.id);
      const goal = this.readGoal(cycle.id, input.revision);
      this.assertStoredResponse("getGoal", goal);
      return goal;
    });
  }

  async getGoalHistory(input: GoalHistoryInput): Promise<Page<GoalHistoryItem, number>> {
    this.validate("getGoalHistory", input);
    return this.query(() => {
      const workspace = this.workspace(input.productId);
      const cycle = this.cycle(workspace.id);
      const afterRevision = input.afterRevision ?? 0;
      const limit = this.limit(input.limit, 100);
      const rows = this.database.db.prepare("SELECT revision,sha256,created_at FROM product_goal_revisions WHERE cycle_id=? AND revision>? ORDER BY revision LIMIT ?")
        .all(cycle.id, afterRevision, limit + 1) as Row[];
      const hasNext = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => {
        const revision = Number(row.revision);
        const decision = this.database.db.prepare("SELECT created_at FROM product_decisions WHERE cycle_id=? AND kind='DIRECTION_CONFIRMED' AND goal_revision=?")
          .get(cycle.id, revision) as Row | undefined;
        return { revision, hash: String(row.sha256), createdAt: String(row.created_at), confirmedAt: decision ? String(decision.created_at) : null };
      });
      const result = { items, nextCursor: hasNext ? items.at(-1)?.revision ?? null : null };
      this.assertStoredResponse("getGoalHistory", result);
      return result;
    });
  }

  async readEvents(input: ProductEventsInput): Promise<Page<ProductEvent, number>> {
    this.validate("readEvents", input);
    return this.query(() => {
      const workspace = this.workspace(input.productId);
      const afterSequence = input.afterSequence ?? 0;
      const limit = this.limit(input.limit, 256);
      const rows = this.database.db.prepare("SELECT sequence,type,goal_revision,workspace_revision,created_at FROM product_events WHERE workspace_id=? AND sequence>? ORDER BY sequence LIMIT ?")
        .all(workspace.id, afterSequence, limit + 1) as Row[];
      const hasNext = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => ({
        productId: workspace.id,
        sequence: Number(row.sequence),
        type: String(row.type) as ProductEvent["type"],
        goalRevision: Number(row.goal_revision),
        workspaceRevision: Number(row.workspace_revision),
        createdAt: String(row.created_at)
      }));
      const result = { items, nextCursor: hasNext ? items.at(-1)?.sequence ?? null : null };
      this.assertStoredResponse("readEvents", result);
      return result;
    });
  }

  private validate(kind: ProductCommand | QueryKind, value: unknown): void {
    try { assertProductInput(kind, value); }
    catch (cause) {
      if (cause instanceof ProductError) throw cause;
      throw this.error("INVALID_INPUT", cause instanceof Error ? cause.message : "Invalid product input");
    }
  }

  private mutation<T>(work: () => T): T {
    try { return this.database.transaction(work); }
    catch (cause) {
      if (cause instanceof ProductError) throw cause;
      throw this.error("INTERNAL_ERROR", "Product mutation failed");
    }
  }

  private query<T>(work: () => T): T {
    try { return work(); }
    catch (cause) {
      if (cause instanceof ProductError) throw cause;
      throw this.error("INTERNAL_ERROR", "Product query failed");
    }
  }

  private assertResponse(method: ProductCommand | QueryKind, value: unknown): void {
    try { assertProductResponse(method, { ok: true, value }); }
    catch (cause) {
      if (cause instanceof ProductError) throw cause;
      throw this.error("INVALID_RESPONSE", cause instanceof Error ? cause.message : "Invalid product response");
    }
  }

  private assertStoredResponse(method: ProductCommand | QueryKind, value: unknown, request?: unknown): void {
    try { assertProductResponse(method, { ok: true, value }, request); }
    catch (cause) {
      if (cause instanceof ProductError && cause.code === "DATA_CORRUPT") throw cause;
      throw this.error("DATA_CORRUPT", "Stored product data is invalid");
    }
  }

  private error(code: "INVALID_INPUT" | "INVALID_RESPONSE" | "REVISION_CONFLICT" | "REQUEST_ID_CONFLICT" | "DIRECTION_INCOMPLETE" | "NOT_FOUND" | "DATA_CORRUPT" | "INTERNAL_ERROR" | "PRODUCT_DELETED" | "PRODUCT_BUSY", message: string): ProductError {
    return new ProductError(code, message);
  }
  private assertNotBusy(productId: string): void {
    const activeTask = this.database.db.prepare("SELECT 1 FROM product_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.product_id=? AND t.status IN ('DESIGNING','PREPARING_WORKTREE','BUILDING','TESTING','DETERMINISTIC_GATE','REVIEWING') LIMIT 1").get(productId);
    const activeRun = this.database.db.prepare("SELECT 1 FROM product_run_actions WHERE product_id=? AND status IN ('RUNNING','PAUSE_REQUESTED','CANCEL_REQUESTED') LIMIT 1").get(productId);
    const activePlanning = this.database.db.prepare("SELECT 1 FROM product_planning_actions WHERE product_id=? AND status='RUNNING' LIMIT 1").get(productId);
    const activePreview = this.database.db.prepare("SELECT 1 FROM product_preview_sessions WHERE product_id=? AND status IN ('STARTING','RUNNING','STOPPING') LIMIT 1").get(productId);
    if (activeTask || activeRun || activePlanning || activePreview) throw this.error("PRODUCT_BUSY", "Product has active work");
  }

  private directionError(cause: unknown): ProductError {
    if (cause instanceof ProductError) return cause;
    return this.error("DIRECTION_INCOMPLETE", cause instanceof Error ? cause.message : "Direction requires scope and a required acceptance criterion");
  }

  private limit(value: number | undefined, maximum: number): number {
    const candidate = value ?? 50;
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) throw this.error("INVALID_INPUT", "Invalid page limit");
    return candidate;
  }

  private receipt(requestId: string, requestHash: string): unknown | undefined {
    const row = this.database.db.prepare("SELECT command_type,request_hash,workspace_id,result_json FROM product_command_receipts WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return undefined;
    if (String(row.request_hash) !== requestHash) throw this.error("REQUEST_ID_CONFLICT", "requestId was already used with different input");
    if (!/^[a-f0-9]{64}$/.test(String(row.request_hash)) || row.workspace_id === null) throw this.error("DATA_CORRUPT", "Stored command receipt context is invalid");
    try {
      const result = JSON.parse(String(row.result_json));
      const commandType = String(row.command_type) as ProductCommand;
      this.assertResponse(commandType, result);
      const overview = (result as { product?: { id?: unknown } }).product;
      if (!overview || overview.id !== String(row.workspace_id)) throw this.error("DATA_CORRUPT", "Stored command receipt product does not match its workspace");
      return result;
    }
    catch { throw this.error("DATA_CORRUPT", "Stored command receipt is invalid"); }
  }

  private saveReceipt(requestId: string, commandType: ProductCommand, requestHash: string, workspaceId: string, result: ProductOverview, createdAt: string): void {
    this.database.db.prepare("INSERT INTO product_command_receipts (request_id,command_type,request_hash,workspace_id,result_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(requestId, commandType, requestHash, workspaceId, canonicalProductJson(result), createdAt);
  }

  private workspace(id: string): { id: string; revision: number; eventSequence: number } {
    const row = this.database.db.prepare("SELECT id,revision,event_sequence FROM product_workspaces WHERE id=?").get(id) as Row | undefined;
    if (!row) throw this.error("NOT_FOUND", "Product not found");
    const revision = Number(row.revision);
    const eventSequence = Number(row.event_sequence);
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(eventSequence) || eventSequence < 0) throw this.error("DATA_CORRUPT", "Product revision counters are invalid");
    return { id: String(row.id), revision, eventSequence };
  }

  private cycle(workspaceId: string): { id: string; goalRevision: number } {
    const workspace = this.database.db.prepare("SELECT current_cycle_id FROM product_workspaces WHERE id=?").get(workspaceId) as Row | undefined;
    if (!workspace || workspace.current_cycle_id === null) throw this.error("DATA_CORRUPT", "Product current cycle is missing");
    const row = this.database.db.prepare("SELECT id,goal_revision,state FROM product_cycles WHERE id=? AND workspace_id=?").get(String(workspace.current_cycle_id), workspaceId) as Row | undefined;
    if (!row) throw this.error("DATA_CORRUPT", "Product cycle is missing");
    if (String(row.state) !== "ALIGNING") throw this.error("DATA_CORRUPT", "Product cycle state is invalid");
    const goalRevision = Number(row.goal_revision);
    if (!Number.isSafeInteger(goalRevision) || goalRevision < 1) throw this.error("DATA_CORRUPT", "Product goal revision is invalid");
    return { id: String(row.id), goalRevision };
  }

  private readSummary(productId: string): ProductSummary {
    const row = this.database.db.prepare("SELECT w.id,w.name,w.revision,w.updated_at,w.created_at,w.deleted_at,c.goal_revision FROM product_workspaces w JOIN product_cycles c ON c.id=w.current_cycle_id AND c.workspace_id=w.id WHERE w.id=?").get(productId) as Row | undefined;
    if (!row) throw this.error("NOT_FOUND", "Product not found");
    const revision = Number(row.revision);
    const goalRevision = Number(row.goal_revision);
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(goalRevision)) throw this.error("DATA_CORRUPT", "Product revisions are invalid");
    const confirmed = this.database.db.prepare("SELECT 1 FROM product_decisions d JOIN product_cycles c ON c.id=d.cycle_id WHERE c.workspace_id=? AND d.kind='DIRECTION_CONFIRMED' AND d.goal_revision=?").get(productId, goalRevision);
    return { id: String(row.id), name: String(row.name), repositoryId: null, revision, goalRevision, confirmedGoalRevision: confirmed ? goalRevision : null, createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at === null ? null : String(row.deleted_at) };
  }

  private readOverview(productId: string): ProductOverview {
    const cycle = this.cycle(productId);
    return { product: this.readSummary(productId), goal: this.readGoal(cycle.id, cycle.goalRevision) };
  }

  private readGoal(cycleId: string, revision: number): GoalSnapshot {
    if (!Number.isSafeInteger(revision) || revision < 1) throw this.error("INVALID_INPUT", "Invalid goal revision");
    const row = this.database.db.prepare("SELECT revision,payload_json,sha256,created_at FROM product_goal_revisions WHERE cycle_id=? AND revision=?").get(cycleId, revision) as Row | undefined;
    if (!row) throw this.error("NOT_FOUND", "Goal revision not found");
    let goal: unknown;
    try { goal = JSON.parse(String(row.payload_json)); }
    catch { throw this.error("DATA_CORRUPT", "Stored goal is not valid JSON"); }
    if (sha256(goal) !== String(row.sha256)) throw this.error("DATA_CORRUPT", "Stored goal hash does not match");
    try { assertProductGoal(goal); }
    catch { throw this.error("DATA_CORRUPT", "Stored goal does not satisfy the product contract"); }
    return { revision: Number(row.revision), hash: String(row.sha256), goal: goal as ProductGoal, createdAt: String(row.created_at) };
  }

}
