import { createHash, randomUUID } from "node:crypto";

import type {
  PlanningAction,
  PlanningContext,
  PlanningErrorCode,
  PlanningGrant,
  PlanningState,
  ProductProposal
} from "../../shared/contracts/product-planning.js";
import type { PlanningPurpose } from "../../shared/contracts/product-planning.js";
import type { ProductGoal } from "../../shared/contracts/products.js";
import {
  assertPlanningInput,
  assertPlanningResponse,
  assertProposal,
  PlanningError
} from "../../shared/core/planning-validation.js";
import { assertProductGoal, canonicalProductJson } from "../../shared/core/product-validation.js";
import type { ProductPlanner } from "./product-planner.js";
import type { AppDatabase } from "../db/database.js";
import type { ProductService } from "./product-service.js";

type Row = Record<string, unknown>;
type AuthorizeInput = { requestId: string; productId: string; expectedRevision: number };
type RevokeInput = { productId: string; grantId: string };
type RequestProposalInput = { requestId: string; productId: string; grantId: string; expectedRevision: number; purpose?: PlanningPurpose };
type GetStateInput = { productId: string };

const timestamp = (): string => new Date().toISOString();
const sha256 = (value: unknown): string => createHash("sha256").update(canonicalProductJson(value), "utf8").digest("hex");
const allowedErrorCodes = new Set<PlanningErrorCode>([
  "INVALID_INPUT", "INPUT_TOO_LARGE", "INVALID_RESPONSE", "NOT_FOUND", "REVISION_CONFLICT",
  "REQUEST_ID_CONFLICT", "PERMISSION_REQUIRED", "GRANT_REVOKED", "BUDGET_EXHAUSTED",
  "RUNTIME_NOT_QUALIFIED", "INVALID_PROPOSAL", "GOAL_STALE", "INTERRUPTED", "QUOTA_EXHAUSTED", "INTERNAL_ERROR"
]);

/** Durable coordinator for one-shot, read-only product direction proposals. */
export class ProductPlanningService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly database: AppDatabase;
  private readonly products: ProductService;
  private readonly planner: ProductPlanner;

  constructor(database: AppDatabase, products: ProductService, planner: ProductPlanner) {
    this.database = database;
    this.products = products;
    this.planner = planner;
    this.recoverRunningActions();
  }

  async authorize(input: AuthorizeInput): Promise<PlanningGrant> {
    this.validateInput("authorize", input);
    const requestHash = sha256({ method: "authorize", input });
    const context = await this.productContext(input.productId);

    const grant = this.database.transaction(() => {
      const duplicate = this.grantForRequest(input.requestId, requestHash);
      if (duplicate) return duplicate;
      const current = this.readContext(input.productId);
      if (current.workspaceRevision !== input.expectedRevision || current.workspaceRevision !== context.workspaceRevision) {
        throw new PlanningError("REVISION_CONFLICT", "Product revision has changed.");
      }

      const active = this.database.db.prepare(
        "SELECT * FROM product_planning_grants WHERE product_id=? AND goal_revision=? AND goal_hash=? AND revoked_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1"
      ).get(input.productId, current.goalRevision, current.goalHash) as Row | undefined;
      if (active) {
        const existing = this.toGrant(active);
        if (existing.usedCalls === 0) throw new PlanningError("PERMISSION_REQUIRED", "An unused planning grant already exists.");
      }

      const running = this.database.db.prepare(
        "SELECT 1 FROM product_planning_actions WHERE product_id=? AND status='RUNNING' LIMIT 1"
      ).get(input.productId);
      if (running) throw new PlanningError("PERMISSION_REQUIRED", "A planning action is already running.");

      const now = timestamp();
      this.database.db.prepare("UPDATE product_planning_grants SET revoked_at=? WHERE product_id=? AND revoked_at IS NULL")
        .run(now, input.productId);
      const record: PlanningGrant = {
        id: randomUUID(), productId: input.productId, goalRevision: current.goalRevision, goalHash: current.goalHash,
        maxCalls: 1, usedCalls: 0, timeoutSeconds: 300, revokedAt: null, createdAt: now
      };
      this.database.db.prepare(
        "INSERT INTO product_planning_grants (id,product_id,request_id,request_hash,goal_revision,goal_hash,max_calls,used_calls,timeout_seconds,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
      ).run(record.id, record.productId, input.requestId, requestHash, record.goalRevision, record.goalHash, 1, 0, 300, null, now);
      this.assertOutput("authorize", record);
      return record;
    });
    return grant;
  }

  async revoke(input: RevokeInput): Promise<PlanningGrant> {
    this.validateInput("revoke", input);
    const grant = this.database.transaction(() => {
      const row = this.database.db.prepare("SELECT * FROM product_planning_grants WHERE id=? AND product_id=?").get(input.grantId, input.productId) as Row | undefined;
      if (!row) throw new PlanningError("NOT_FOUND", "Planning grant not found.");
      const current = this.toGrant(row);
      if (current.revokedAt === null) {
        const now = timestamp();
        this.database.db.prepare("UPDATE product_planning_grants SET revoked_at=? WHERE id=? AND product_id=? AND revoked_at IS NULL")
          .run(now, input.grantId, input.productId);
        return this.toGrant(this.database.db.prepare("SELECT * FROM product_planning_grants WHERE id=?").get(input.grantId) as Row);
      }
      return current;
    });

    for (const [actionId, controller] of this.controllers) {
      const action = this.database.db.prepare("SELECT grant_id FROM product_planning_actions WHERE id=?").get(actionId) as Row | undefined;
      if (action && String(action.grant_id) === grant.id) controller.abort();
    }
    return grant;
  }

  async requestProposal(input: RequestProposalInput): Promise<PlanningAction> {
    this.validateInput("requestProposal", input);
    const requestHash = sha256({ method: "requestProposal", input });
    const duplicate = this.database.transaction(() => this.actionForRequest(input.requestId, requestHash));
    if (duplicate) return duplicate;
    const purpose = input.purpose ?? "direction";
    if (purpose === "plan" && !this.isPlanEligible(input.productId)) throw new PlanningError("PERMISSION_REQUIRED", "请先确认当前产品方向。");
    if (purpose === "plan" ? !this.planner.planAvailable : !this.planner.available) throw new PlanningError("RUNTIME_NOT_QUALIFIED", "Planning runtime is not qualified.");

    const context = await this.productContext(input.productId);
    context.purpose = purpose;
    const contextHash = sha256(context);
    if (new TextEncoder().encode(canonicalProductJson(context)).byteLength > 16 * 1024) {
      throw new PlanningError("INPUT_TOO_LARGE", "Planning context is too large.");
    }
    const reservation = this.database.transaction(() => {
      const again = this.actionForRequest(input.requestId, requestHash);
      if (again) return { action: again, context: null as PlanningContext | null, contextHash: "" };
      const current = this.readContext(input.productId);
      current.purpose = purpose;
      if (purpose === "plan" && !this.isPlanEligible(input.productId)) throw new PlanningError("PERMISSION_REQUIRED", "请先确认当前产品方向。");
      if (current.workspaceRevision !== input.expectedRevision || current.workspaceRevision !== context.workspaceRevision) {
        throw new PlanningError("REVISION_CONFLICT", "Product revision has changed.");
      }
      if (current.goalRevision !== context.goalRevision || current.goalHash !== context.goalHash) {
        throw new PlanningError("GOAL_STALE", "Product goal has changed.");
      }
      const grantRow = this.database.db.prepare("SELECT * FROM product_planning_grants WHERE id=? AND product_id=?").get(input.grantId, input.productId) as Row | undefined;
      if (!grantRow) throw new PlanningError("NOT_FOUND", "Planning grant not found.");
      const grant = this.toGrant(grantRow);
      if (grant.revokedAt !== null) throw new PlanningError("GRANT_REVOKED", "Planning grant was revoked.");
      if (grant.goalRevision !== current.goalRevision || grant.goalHash !== current.goalHash) throw new PlanningError("GOAL_STALE", "Planning grant targets an old goal.");
      if (grant.usedCalls >= grant.maxCalls) throw new PlanningError("BUDGET_EXHAUSTED", "Planning grant budget is exhausted.");

      const now = timestamp();
      const action: PlanningAction = {
        id: randomUUID(), productId: input.productId, grantId: grant.id, goalRevision: current.goalRevision,
        goalHash: current.goalHash, contextHash, status: "RUNNING", proposal: null, errorCode: null,
        createdAt: now, finishedAt: null
      };
      this.database.db.prepare("UPDATE product_planning_grants SET used_calls=1 WHERE id=? AND product_id=? AND used_calls=0 AND revoked_at IS NULL")
        .run(grant.id, input.productId);
      const changed = this.database.db.prepare("SELECT used_calls FROM product_planning_grants WHERE id=?").get(grant.id) as Row;
      if (Number(changed.used_calls) !== 1) throw new PlanningError("BUDGET_EXHAUSTED", "Planning grant budget is exhausted.");
      this.database.db.prepare(
        "INSERT INTO product_planning_actions (id,product_id,request_id,request_hash,grant_id,goal_revision,goal_hash,context_hash,context_json,status,proposal_json,error_code,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(action.id, action.productId, input.requestId, requestHash, action.grantId, action.goalRevision, action.goalHash, action.contextHash, canonicalProductJson(current), action.status, null, null, action.createdAt, null);
      this.assertOutput("requestProposal", action);
      return { action, context: current, contextHash };
    });

    if (!reservation.context) return reservation.action;
    const controller = new AbortController();
    this.controllers.set(reservation.action.id, controller);
    try {
      const result = await this.planner.run({ actionId: reservation.action.id, context: reservation.context, contextHash: reservation.contextHash, timeoutSeconds: 300, signal: controller.signal });
      return this.finishAction(reservation.action.id, reservation.context, reservation.contextHash, result, null);
    } catch (error) {
      return this.finishAction(reservation.action.id, reservation.context, reservation.contextHash, null, error);
    } finally {
      this.controllers.delete(reservation.action.id);
    }
  }

  async getState(input: GetStateInput): Promise<PlanningState> {
    this.validateInput("getState", input);
    await this.productContext(input.productId);
    const state = this.database.transaction(() => {
      const context = this.readContext(input.productId);
      const grantRow = this.database.db.prepare(
        "SELECT * FROM product_planning_grants WHERE product_id=? AND goal_revision=? AND goal_hash=? ORDER BY created_at DESC,rowid DESC LIMIT 1"
      ).get(input.productId, context.goalRevision, context.goalHash) as Row | undefined;
      const actionRow = this.database.db.prepare("SELECT * FROM product_planning_actions WHERE product_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(input.productId) as Row | undefined;
      const value: PlanningState = { available: this.planner.available, planAvailable: this.planner.planAvailable, grant: grantRow ? this.toGrant(grantRow) : null, action: actionRow ? this.toAction(actionRow) : null };
      this.assertOutput("getState", value);
      return value;
    });
    return state;
  }

  private async productContext(productId: string): Promise<PlanningContext> {
    try {
      const overview = await this.products.getOverview({ productId });
      const context: PlanningContext = {
        productId,
        workspaceRevision: overview.product.revision,
        goalRevision: overview.goal.revision,
        goalHash: overview.goal.hash,
        goal: overview.goal.goal
      };
      assertProductGoal(context.goal);
      return context;
    } catch (error) {
      if (error instanceof PlanningError) throw error;
      const code = error instanceof Error && "code" in error && allowedErrorCodes.has((error as { code: PlanningErrorCode }).code)
        ? (error as { code: PlanningErrorCode }).code : "INTERNAL_ERROR";
      throw new PlanningError(code, code === "NOT_FOUND" ? "Product not found." : "Unable to read product planning context.");
    }
  }

  private isPlanEligible(productId: string): boolean {
    const row = this.database.db.prepare("SELECT 1 FROM product_decisions d JOIN product_cycles c ON c.id=d.cycle_id WHERE c.workspace_id=? AND d.kind='DIRECTION_CONFIRMED' AND d.goal_revision=(SELECT goal_revision FROM product_cycles WHERE id=(SELECT current_cycle_id FROM product_workspaces WHERE id=?)) LIMIT 1").get(productId, productId) as Row | undefined;
    return row !== undefined;
  }

  private readContext(productId: string): PlanningContext {
    this.products.assertActive(productId);
    const row = this.database.db.prepare(
      "SELECT w.id,w.revision,c.goal_revision,g.payload_json,g.sha256 FROM product_workspaces w JOIN product_cycles c ON c.id=w.current_cycle_id AND c.workspace_id=w.id JOIN product_goal_revisions g ON g.cycle_id=c.id AND g.revision=c.goal_revision WHERE w.id=?"
    ).get(productId) as Row | undefined;
    if (!row) throw new PlanningError("NOT_FOUND", "Product not found.");
    let goal: unknown;
    try { goal = JSON.parse(String(row.payload_json)); } catch { throw new PlanningError("INTERNAL_ERROR", "Product planning context is invalid."); }
    try { assertProductGoal(goal); } catch { throw new PlanningError("INTERNAL_ERROR", "Product planning context is invalid."); }
    const goalHash = String(row.sha256);
    if (!/^[a-f0-9]{64}$/i.test(goalHash) || sha256(goal) !== goalHash) throw new PlanningError("INTERNAL_ERROR", "Product planning context is invalid.");
    const context: PlanningContext = { productId: String(row.id), workspaceRevision: Number(row.revision), goalRevision: Number(row.goal_revision), goalHash, goal: goal as ProductGoal };
    if (!Number.isSafeInteger(context.workspaceRevision) || context.workspaceRevision < 1 || !Number.isSafeInteger(context.goalRevision) || context.goalRevision < 1) {
      throw new PlanningError("INTERNAL_ERROR", "Product planning context is invalid.");
    }
    return context;
  }

  private grantForRequest(requestId: string, requestHash: string): PlanningGrant | undefined {
    const row = this.database.db.prepare("SELECT * FROM product_planning_grants WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return undefined;
    if (!/^[a-f0-9]{64}$/.test(String(row.request_hash))) throw new PlanningError("INVALID_RESPONSE", "Stored planning grant is invalid.");
    if (String(row.request_hash) !== requestHash) throw new PlanningError("REQUEST_ID_CONFLICT", "requestId was already used with different input.");
    return this.toGrant(row);
  }

  private actionForRequest(requestId: string, requestHash: string): PlanningAction | undefined {
    const row = this.database.db.prepare("SELECT * FROM product_planning_actions WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return undefined;
    if (!/^[a-f0-9]{64}$/.test(String(row.request_hash))) throw new PlanningError("INVALID_RESPONSE", "Stored planning action is invalid.");
    if (String(row.request_hash) !== requestHash) throw new PlanningError("REQUEST_ID_CONFLICT", "requestId was already used with different input.");
    return this.toAction(row);
  }

  private toGrant(row: Row): PlanningGrant {
    const grant: PlanningGrant = {
      id: String(row.id), productId: String(row.product_id), goalRevision: Number(row.goal_revision), goalHash: String(row.goal_hash),
      maxCalls: Number(row.max_calls) as 1, usedCalls: Number(row.used_calls) as 0 | 1, timeoutSeconds: Number(row.timeout_seconds) as 300,
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at), createdAt: String(row.created_at)
    };
    this.assertOutput("authorize", grant);
    return grant;
  }

  private toAction(row: Row): PlanningAction {
    const context = this.validateStoredContext(row);
    let proposal: ProductProposal | null = null;
    if (row.proposal_json !== null) {
      try { proposal = JSON.parse(String(row.proposal_json)) as ProductProposal; } catch { throw new PlanningError("INVALID_RESPONSE", "Stored planning action is invalid."); }
      try { assertProposal(proposal, context, String(row.context_hash)); } catch { throw new PlanningError("INVALID_RESPONSE", "Stored planning proposal is invalid."); }
    }
    const errorCode = row.error_code === null ? null : String(row.error_code);
    if (errorCode !== null && !allowedErrorCodes.has(errorCode as PlanningErrorCode)) throw new PlanningError("INVALID_RESPONSE", "Stored planning action is invalid.");
    const action: PlanningAction = {
      id: String(row.id), productId: String(row.product_id), grantId: String(row.grant_id), goalRevision: Number(row.goal_revision),
      goalHash: String(row.goal_hash), contextHash: String(row.context_hash), status: String(row.status) as PlanningAction["status"],
      proposal, errorCode: errorCode as PlanningErrorCode | null, createdAt: String(row.created_at), finishedAt: row.finished_at === null ? null : String(row.finished_at)
    };
    this.assertOutput("requestProposal", action);
    return action;
  }

  private validateStoredContext(row: Row): PlanningContext {
    let value: unknown;
    try { value = JSON.parse(String(row.context_json)); } catch { throw new PlanningError("INVALID_RESPONSE", "Stored planning context is invalid."); }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PlanningError("INVALID_RESPONSE", "Stored planning context is invalid.");
    const context = value as Partial<PlanningContext>;
    if ((context.purpose !== undefined && context.purpose !== "direction" && context.purpose !== "plan") ||
        Object.keys(context).some(key => !["purpose", "productId", "workspaceRevision", "goalRevision", "goalHash", "goal"].includes(key))) {
      throw new PlanningError("INVALID_RESPONSE", "Stored planning purpose is invalid.");
    }
    try { assertProductGoal(context.goal); } catch { throw new PlanningError("INVALID_RESPONSE", "Stored planning context is invalid."); }
    const workspaceRevision = context.workspaceRevision;
    if (context.productId !== String(row.product_id) || typeof workspaceRevision !== "number" || !Number.isSafeInteger(workspaceRevision) || workspaceRevision < 1 || context.goalRevision !== Number(row.goal_revision) || context.goalHash !== String(row.goal_hash) || sha256(value) !== String(row.context_hash)) {
      throw new PlanningError("INVALID_RESPONSE", "Stored planning context is invalid.");
    }
    return context as PlanningContext;
  }

  private async finishAction(actionId: string, context: PlanningContext, contextHash: string, result: unknown, failure: unknown): Promise<PlanningAction> {
    const action = this.database.transaction(() => {
      const row = this.database.db.prepare("SELECT * FROM product_planning_actions WHERE id=?").get(actionId) as Row | undefined;
      if (!row) throw new PlanningError("INTERNAL_ERROR", "Planning action is missing.");
      const current = this.toAction(row);
      if (current.status !== "RUNNING") return current;
      const grant = this.database.db.prepare("SELECT revoked_at FROM product_planning_grants WHERE id=?").get(current.grantId) as Row | undefined;
      const latest = this.readContext(current.productId);
      let errorCode: PlanningErrorCode | null = null;
      let proposal: ProductProposal | null = null;
      if (!grant || grant.revoked_at !== null) errorCode = "GRANT_REVOKED";
      else if (latest.goalRevision !== context.goalRevision || latest.goalHash !== context.goalHash || latest.workspaceRevision !== context.workspaceRevision) errorCode = "GOAL_STALE";
      else if (failure !== null) errorCode = failure instanceof PlanningError && allowedErrorCodes.has(failure.code) ? failure.code : "INTERNAL_ERROR";
      else {
        try { assertProposal(result, context, contextHash); proposal = result as ProductProposal; }
        catch { errorCode = "INVALID_PROPOSAL"; }
      }
      const now = timestamp();
      const status: PlanningAction["status"] = errorCode === null ? "SUCCEEDED" : "FAILED";
      this.database.db.prepare("UPDATE product_planning_actions SET status=?,proposal_json=?,error_code=?,finished_at=? WHERE id=? AND status='RUNNING'")
        .run(status, proposal ? canonicalProductJson(proposal) : null, errorCode, now, actionId);
      return this.toAction(this.database.db.prepare("SELECT * FROM product_planning_actions WHERE id=?").get(actionId) as Row);
    });
    this.assertOutput("requestProposal", action);
    return action;
  }

  private recoverRunningActions(): void {
    this.database.transaction(() => {
      const now = timestamp();
      this.database.db.prepare("UPDATE product_planning_actions SET status='INTERRUPTED',error_code='INTERRUPTED',finished_at=? WHERE status='RUNNING'").run(now);
    });
  }

  private validateInput(method: "authorize" | "revoke" | "requestProposal" | "getState", value: unknown): void {
    try { assertPlanningInput(method, value); } catch (error) { if (error instanceof PlanningError) throw error; throw new PlanningError("INVALID_INPUT", "Invalid planning input."); }
  }

  private assertOutput(method: "authorize" | "revoke" | "requestProposal" | "getState", value: unknown): void {
    try { assertPlanningResponse(method, { ok: true, value }); } catch (error) { if (error instanceof PlanningError) throw error; throw new PlanningError("INVALID_RESPONSE", "Invalid planning response."); }
  }
}
