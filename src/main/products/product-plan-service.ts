import { createHash } from "node:crypto";

import type { AppDatabase } from "../db/database.js";
import type {
  ConfirmProductPlanInput,
  ProductPlan,
  ProductPlanState,
  SavedProductPlan,
  SaveProductPlanInput
} from "../../shared/contracts/product-plan.js";
import { ProductPlanError } from "../../shared/contracts/product-plan.js";
import type { ProductGoal, ProductOverview } from "../../shared/contracts/products.js";
import {
  assertProductPlanInput,
  assertProductPlanResponse,
  validateProductPlan,
  type ProductPlanMethod
} from "../../shared/core/product-plan-validation.js";
import { assertProductGoal, canonicalProductJson } from "../../shared/core/product-validation.js";
import type { ProductService } from "./product-service.js";

type Row = Record<string, unknown>;
type CurrentProductContext = {
  productId: string;
  cycleId: string;
  goalRevision: number;
  goalHash: string;
  goal: ProductGoal;
  directionConfirmed: boolean;
};

const timestamp = (): string => new Date().toISOString();
const sha256 = (value: unknown): string => createHash("sha256").update(canonicalProductJson(value), "utf8").digest("hex");

/** Persists immutable product plans and their confirmation receipts. */
export class ProductPlanService {
  private readonly database: AppDatabase;
  private readonly products: ProductService;

  constructor(database: AppDatabase, products: ProductService) {
    this.database = database;
    this.products = products;
  }

  async getState(input: { productId: string }): Promise<ProductPlanState> {
    this.validateInput("getState", input);
    const overview = await this.productOverview(input.productId);
    const firstRow = this.latestSnapshotRow(input.productId);
    await this.validateSnapshot(input.productId, firstRow);

    return this.mutation(() => {
      const current = this.readCurrentContext(input.productId);
      this.assertSameGoal(current, overview);
      const latest = this.latestSnapshotRow(input.productId);
      if (!this.sameSnapshot(firstRow, latest)) {
        throw new ProductPlanError("REVISION_CONFLICT", "产品计划已发生变化，请重试。");
      }
      const currentSaved = latest === undefined ? null : this.toSavedPlan(latest);
      const state: ProductPlanState = {
        saved: currentSaved,
        current: currentSaved !== null && currentSaved.plan.goalRevision === current.goalRevision && currentSaved.plan.goalHash === current.goalHash,
        directionConfirmed: current.directionConfirmed
      };
      this.assertResponse("getState", state, input.productId);
      return state;
    });
  }

  async save(input: SaveProductPlanInput): Promise<SavedProductPlan> {
    this.validateInput("save", input);
    const requestHash = sha256({ method: "save", input });
    const existing = this.mutation(() => this.readReceipt(input.requestId, requestHash, "save", input.productId));
    if (existing !== undefined) return existing;

    const overview = await this.productOverview(input.productId);
    this.validatePlan(input.plan, overview.goal.goal, {
      productId: input.productId,
      goalRevision: overview.goal.revision,
      goalHash: overview.goal.hash
    });

    return this.mutation(() => {
      const duplicate = this.readReceipt(input.requestId, requestHash, "save", input.productId);
      if (duplicate !== undefined) return duplicate;
      const current = this.readCurrentContext(input.productId);
      this.assertSameGoal(current, overview);
      this.validatePlan(input.plan, current.goal, current);
      const latest = this.latestSnapshotRow(input.productId);
      const latestRevision = latest === undefined ? 0 : this.rowRevision(latest);
      if (latestRevision !== input.expectedPlanRevision) {
        throw new ProductPlanError("REVISION_CONFLICT", "产品计划版本已发生变化。");
      }
      const revision = latestRevision + 1;
      const now = timestamp();
      const result: SavedProductPlan = {
        productId: input.productId,
        revision,
        hash: sha256(input.plan),
        plan: input.plan,
        createdAt: now,
        confirmedAt: null
      };
      this.database.db.prepare(
        "INSERT INTO product_plan_revisions (cycle_id,revision,goal_revision,goal_hash,payload_json,sha256,created_at,confirmed_at) VALUES(?,?,?,?,?,?,?,?)"
      ).run(current.cycleId, revision, input.plan.goalRevision, input.plan.goalHash, canonicalProductJson(input.plan), result.hash, now, null);
      this.assertResponse("save", result, input.productId);
      this.writeReceipt(input.requestId, requestHash, input.productId, result, now);
      return result;
    });
  }

  async confirm(input: ConfirmProductPlanInput): Promise<SavedProductPlan> {
    this.validateInput("confirm", input);
    const requestHash = sha256({ method: "confirm", input });
    const existing = this.mutation(() => this.readReceipt(input.requestId, requestHash, "confirm", input.productId));
    if (existing !== undefined) return existing;

    const overview = await this.productOverview(input.productId);
    const firstRow = this.latestSnapshotRow(input.productId);
    const first = await this.validateSnapshot(input.productId, firstRow);
    if (first === null) throw new ProductPlanError("NOT_FOUND", "产品计划不存在。");

    return this.mutation(() => {
      const duplicate = this.readReceipt(input.requestId, requestHash, "confirm", input.productId);
      if (duplicate !== undefined) return duplicate;
      const current = this.readCurrentContext(input.productId);
      this.assertSameGoal(current, overview);
      if (current.goalRevision !== first.plan.goalRevision || current.goalHash !== first.plan.goalHash) {
        throw new ProductPlanError("PLAN_STALE", "计划与当前目标版本不一致。");
      }
      if (!current.directionConfirmed) throw new ProductPlanError("DIRECTION_NOT_CONFIRMED", "请先确认当前产品方向。");
      const latest = this.latestSnapshotRow(input.productId);
      if (!this.sameSnapshot(firstRow, latest) || latest === undefined || this.rowRevision(latest) !== input.planRevision) {
        throw new ProductPlanError("REVISION_CONFLICT", "产品计划版本已发生变化。");
      }
      if (first.plan.productId !== input.productId) throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan is invalid.");
      this.validatePlan(first.plan, current.goal, current);
      const saved = this.toSavedPlan(latest);
      const now = saved.confirmedAt ?? timestamp();
      if (saved.confirmedAt === null) {
        this.database.db.prepare("UPDATE product_plan_revisions SET confirmed_at=? WHERE cycle_id=? AND revision=? AND confirmed_at IS NULL")
          .run(now, current.cycleId, input.planRevision);
      }
      const result: SavedProductPlan = { ...saved, confirmedAt: now };
      this.assertResponse("confirm", result, input.productId);
      this.writeReceipt(input.requestId, requestHash, input.productId, result, timestamp());
      return result;
    });
  }

  private validateInput(method: ProductPlanMethod, value: unknown): void {
    try { assertProductPlanInput(method, value); }
    catch (error) {
      if (error instanceof ProductPlanError) throw error;
      throw new ProductPlanError("INVALID_INPUT", "计划请求格式不正确。");
    }
  }

  private validatePlan(plan: ProductPlan, goal: ProductGoal, expected: { productId: string; goalRevision: number; goalHash: string }): void {
    try { validateProductPlan(plan, goal, expected); }
    catch (error) {
      if (error instanceof ProductPlanError) throw error;
      throw new ProductPlanError("INVALID_INPUT", "计划格式不正确。");
    }
  }

  private assertResponse(method: ProductPlanMethod, value: unknown, productId: string): void {
    try { assertProductPlanResponse(method, { ok: true, value }, { productId }); }
    catch (error) {
      if (error instanceof ProductPlanError) throw error;
      throw new ProductPlanError("INVALID_RESPONSE", "计划响应格式不正确。");
    }
  }

  private mutation<T>(work: () => T): T {
    try { return this.database.transaction(work); }
    catch (error) {
      if (error instanceof ProductPlanError) throw error;
      throw new ProductPlanError("INTERNAL_ERROR", "产品计划操作失败。");
    }
  }

  private async productOverview(productId: string): Promise<ProductOverview> {
    try { return await this.products.getOverview({ productId }); }
    catch (error) { throw this.mapProductError(error); }
  }

  private async historicalGoal(productId: string, revision: number): Promise<{ goal: ProductGoal; hash: string }> {
    try {
      const snapshot = await this.products.getGoal({ productId, revision });
      return { goal: snapshot.goal, hash: snapshot.hash };
    } catch (error) { throw this.mapProductError(error); }
  }

  private mapProductError(error: unknown): ProductPlanError {
    if (error instanceof ProductPlanError) return error;
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "NOT_FOUND") return new ProductPlanError("NOT_FOUND", "产品不存在。");
    return new ProductPlanError("INTERNAL_ERROR", "无法读取产品上下文。");
  }

  private readCurrentContext(productId: string): CurrentProductContext {
    this.products.assertActive(productId);
    const row = this.database.db.prepare(
      "SELECT w.id AS product_id,w.current_cycle_id,c.goal_revision,g.payload_json,g.sha256 FROM product_workspaces w JOIN product_cycles c ON c.id=w.current_cycle_id AND c.workspace_id=w.id JOIN product_goal_revisions g ON g.cycle_id=c.id AND g.revision=c.goal_revision WHERE w.id=?"
    ).get(productId) as Row | undefined;
    if (!row || row.current_cycle_id === null) throw new ProductPlanError("NOT_FOUND", "产品不存在。");
    let goal: unknown;
    try { goal = JSON.parse(String(row.payload_json)); assertProductGoal(goal); }
    catch { throw new ProductPlanError("INVALID_RESPONSE", "Stored product goal is invalid."); }
    const goalHash = String(row.sha256);
    if (!/^[a-f0-9]{64}$/.test(goalHash) || sha256(goal) !== goalHash) throw new ProductPlanError("INVALID_RESPONSE", "Stored product goal hash is invalid.");
    const goalRevision = Number(row.goal_revision);
    if (!Number.isSafeInteger(goalRevision) || goalRevision < 1) throw new ProductPlanError("INVALID_RESPONSE", "Stored product goal revision is invalid.");
    const decision = this.database.db.prepare("SELECT 1 FROM product_decisions WHERE cycle_id=? AND kind='DIRECTION_CONFIRMED' AND goal_revision=?")
      .get(String(row.current_cycle_id), goalRevision);
    return { productId: String(row.product_id), cycleId: String(row.current_cycle_id), goalRevision, goalHash, goal: goal as ProductGoal, directionConfirmed: decision !== undefined };
  }

  private assertSameGoal(current: CurrentProductContext, overview: ProductOverview): void {
    if (current.productId !== overview.product.id || current.goalRevision !== overview.goal.revision || current.goalHash !== overview.goal.hash) {
      throw new ProductPlanError("PLAN_STALE", "计划与当前目标版本不一致。");
    }
  }

  private latestSnapshotRow(productId: string): Row | undefined {
    return this.database.db.prepare(
      "SELECT r.cycle_id,r.revision,r.goal_revision,r.goal_hash,r.payload_json,r.sha256,r.created_at,r.confirmed_at,c.workspace_id AS product_id FROM product_plan_revisions r JOIN product_cycles c ON c.id=r.cycle_id JOIN product_workspaces w ON w.id=c.workspace_id AND w.current_cycle_id=c.id WHERE c.workspace_id=? ORDER BY r.revision DESC LIMIT 1"
    ).get(productId) as Row | undefined;
  }

  private async validateSnapshot(productId: string, row: Row | undefined): Promise<SavedProductPlan | null> {
    if (!row) return null;
    const saved = this.toSavedPlan(row);
    const historical = await this.historicalGoal(productId, saved.plan.goalRevision);
    if (historical.hash !== saved.plan.goalHash || historical.hash !== String(row.goal_hash)) throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan goal binding is invalid.");
    this.validatePlan(saved.plan, historical.goal, { productId, goalRevision: saved.plan.goalRevision, goalHash: historical.hash });
    return saved;
  }

  private toSavedPlan(row: Row): SavedProductPlan {
    let plan: unknown;
    try { plan = JSON.parse(String(row.payload_json)); }
    catch { throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan is invalid."); }
    const hash = String(row.sha256);
    const revision = Number(row.revision);
    if (!/^[a-f0-9]{64}$/.test(hash) || sha256(plan) !== hash || !Number.isSafeInteger(revision) || revision < 1) {
      throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan is invalid.");
    }
    const confirmedAt = row.confirmed_at === null || row.confirmed_at === undefined ? null : String(row.confirmed_at);
    if (typeof row.created_at !== "string" || confirmedAt !== null && confirmedAt.length === 0) {
      throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan is invalid.");
    }
    const saved = { productId: String(row.product_id), revision, hash, plan: plan as ProductPlan, createdAt: String(row.created_at), confirmedAt };
    try { this.assertResponse("save", saved, saved.productId); }
    catch { throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan is invalid."); }
    if (saved.plan.productId !== saved.productId || saved.plan.goalRevision !== Number(row.goal_revision) || saved.plan.goalHash !== String(row.goal_hash)) {
      throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan binding is invalid.");
    }
    return saved;
  }

  private rowRevision(row: Row): number {
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan revision is invalid.");
    return revision;
  }

  private sameSnapshot(left: Row | undefined, right: Row | undefined): boolean {
    if (!left || !right) return left === right;
    return String(left.cycle_id) === String(right.cycle_id) && String(left.revision) === String(right.revision) && String(left.sha256) === String(right.sha256);
  }

  private readReceipt(requestId: string, requestHash: string, method: "save" | "confirm", productId: string): SavedProductPlan | undefined {
    const row = this.database.db.prepare("SELECT request_hash,product_id,result_json,result_sha256 FROM product_plan_receipts WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return undefined;
    if (String(row.request_hash) !== requestHash) throw new ProductPlanError("REQUEST_ID_CONFLICT", "requestId 已用于不同的计划请求。");
    if (String(row.product_id) !== productId || !/^[a-f0-9]{64}$/.test(String(row.result_sha256))) {
      throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan receipt is invalid.");
    }
    let result: unknown;
    try { result = JSON.parse(String(row.result_json)); }
    catch { throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan receipt is invalid."); }
    if (sha256(result) !== String(row.result_sha256)) throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan receipt hash is invalid.");
    try {
      this.assertResponse(method, result, productId);
      this.assertSavedValue(result, productId);
    }
    catch { throw new ProductPlanError("INVALID_RESPONSE", "Stored product plan receipt is invalid."); }
    return result as SavedProductPlan;
  }

  private assertSavedValue(value: unknown, productId: string): asserts value is SavedProductPlan {
    const saved = value as Partial<SavedProductPlan>;
    if (saved.productId !== productId) throw new Error("invalid saved plan binding");
    if (sha256(saved.plan) !== saved.hash) throw new Error("invalid saved plan hash");
    if ((saved.plan as ProductPlan).productId !== productId) throw new Error("invalid saved plan binding");
  }

  private writeReceipt(requestId: string, requestHash: string, productId: string, result: SavedProductPlan, createdAt: string): void {
    const resultJson = canonicalProductJson(result);
    this.database.db.prepare("INSERT INTO product_plan_receipts (request_id,request_hash,product_id,result_json,result_sha256,created_at) VALUES(?,?,?,?,?,?)")
      .run(requestId, requestHash, productId, resultJson, sha256(result), createdAt);
  }
}
