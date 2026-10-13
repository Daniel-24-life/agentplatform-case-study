import { Ajv2020 } from "ajv/dist/2020.js";
import goalSchema from "../../../schemas/product-goal.schema.json" with { type: "json" };
import foundationSchema from "../../../schemas/product-foundation.schema.json" with { type: "json" };
import type { ProductErrorCode, ProductGoal, ProductMetrics, ProductsApi } from "../contracts/products.js";

export type ProductMethod = keyof ProductsApi;

export class ProductError extends Error {
  constructor(readonly code: ProductErrorCode, message: string = code) {
    super(message);
    this.name = "ProductError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
ajv.addSchema(goalSchema);
ajv.addSchema(foundationSchema);
const schemaRoot = foundationSchema.$id;
const methods: ProductMethod[] = ["create", "reviseGoal", "confirmDirection", "trash", "restore", "list", "getOverview", "getMetrics", "getGoal", "getGoalHistory", "readEvents"];
const inputs = new Map(methods.map(method => [method, ajv.compile({ $ref: `${schemaRoot}#/$defs/${method}` })]));
const outputs = new Map(methods.map(method => [method, ajv.compile({ $ref: `${schemaRoot}#/$defs/${method}Response` })]));
const goalValidator = ajv.getSchema(goalSchema.$id)!;

function checkSize(value: unknown, maximum: number, code: ProductErrorCode): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); }
  catch { throw new ProductError(code, "数据必须可以序列化为 JSON。"); }
  if (json === undefined) throw new ProductError(code, "缺少请求数据。");
  if (new TextEncoder().encode(json).byteLength > maximum) {
    throw new ProductError(code === "INVALID_INPUT" ? "INPUT_TOO_LARGE" : code, "数据超过允许的大小。");
  }
}

export function assertProductGoal(value: unknown): asserts value is ProductGoal {
  checkSize(value, 65536, "INVALID_INPUT");
  if (!goalValidator(value)) throw new ProductError("INVALID_INPUT", "产品目标格式不正确。");
  const goal = value as ProductGoal;
  if (!goal.originalRequest.trim() || goal.assumptions.some(item => !item.trim()) ||
      goal.acceptanceCriteria.some(item => !item.description.trim()) ||
      new Set(goal.acceptanceCriteria.map(item => item.id)).size !== goal.acceptanceCriteria.length) {
    throw new ProductError("INVALID_INPUT", "原始需求与条目不得空白，验收编号不得重复。");
  }
}

export function initialProductGoal(originalRequest: string): ProductGoal {
  return { schemaVersion: "1.0", originalRequest, goal: originalRequest, scope: "", assumptions: [], acceptanceCriteria: [] };
}

export function assertProductInput(method: ProductMethod, value: unknown): void {
  checkSize(value, 65536, "INVALID_INPUT");
  if (!inputs.get(method)!(value)) throw new ProductError("INVALID_INPUT", "请求格式不正确。");
  if (method === "create") {
    const input = value as { name: string; initialRequest: string };
    if (!input.name.trim() || !input.initialRequest.trim()) throw new ProductError("INVALID_INPUT", "产品名称和原始需求不能为空。");
    assertProductGoal(initialProductGoal(input.initialRequest));
  }
  if (method === "reviseGoal") assertProductGoal((value as { goal: unknown }).goal);
}

export function validateDirection(goal: ProductGoal): void {
  assertProductGoal(goal);
  if (!goal.goal.trim() || !goal.scope.trim() || !goal.acceptanceCriteria.some(item => item.required)) {
    throw new ProductError("DIRECTION_INCOMPLETE", "确认前请填写目标、范围和至少一条必要验收条件。");
  }
}

export function assertProductResponse(method: ProductMethod, value: unknown, request?: unknown): void {
  checkSize(value, 1024 * 1024, "INVALID_RESPONSE");
  if (!outputs.get(method)!(value)) throw new ProductError("INVALID_RESPONSE", "产品接口返回了无效数据。");
  const result = value as { ok: boolean; value?: unknown };
  if (!result.ok) return;
  if (["create", "reviseGoal", "confirmDirection", "trash", "restore", "getOverview"].includes(method)) {
    const overview = result.value as { product: { id: string; goalRevision: number; confirmedGoalRevision: number | null; deletedAt?: string | null }; goal: { revision: number; goal: ProductGoal } };
    const requestedId = (request as { productId?: string } | undefined)?.productId;
    if (overview.product.goalRevision !== overview.goal.revision ||
        (requestedId !== undefined && overview.product.id !== requestedId) ||
        (overview.product.confirmedGoalRevision !== null && overview.product.confirmedGoalRevision !== overview.product.goalRevision)) {
      throw new ProductError("INVALID_RESPONSE", "产品目标版本不一致。");
    }
    checkResponseGoal(overview.goal.goal);
    if (method === "trash" && typeof overview.product.deletedAt !== "string") throw new ProductError("INVALID_RESPONSE", "删除回执必须包含删除时间。");
    if (method === "restore" && overview.product.deletedAt !== null) throw new ProductError("INVALID_RESPONSE", "恢复回执必须清除删除时间。");
  }
  if (method === "list" && request && typeof (request as { deleted?: unknown }).deleted === "boolean") {
    const items = (result.value as { items: Array<{ deletedAt?: string | null }> }).items;
    const deleted = (request as { deleted: boolean }).deleted;
    if (items.some(item => (item.deletedAt != null) !== deleted)) throw new ProductError("INVALID_RESPONSE", "产品列表删除状态与筛选条件不一致。");
  }
  if (method === "getGoal") {
    const snapshot = result.value as { revision: number; goal: unknown };
    if (request && snapshot.revision !== (request as { revision: number }).revision) throw new ProductError("INVALID_RESPONSE", "返回的历史目标版本不匹配。");
    checkResponseGoal(snapshot.goal);
  }
  if (method === "getMetrics") {
    const metrics = result.value as ProductMetrics;
    const requestedId = (request as { productId?: unknown } | undefined)?.productId;
    const keyTotal = metrics.directionConfirmations + metrics.planConfirmations + metrics.specApprovals + metrics.escalationApprovals;
    if ((requestedId !== undefined && metrics.productId !== requestedId) ||
        metrics.passedTaskCount > metrics.taskCount || metrics.specApprovals > metrics.taskCount ||
        metrics.technicalCompletionRate !== (metrics.taskCount ? metrics.passedTaskCount / metrics.taskCount : null) ||
        metrics.agentRunCount > metrics.runCount || metrics.usageAvailableRuns > metrics.agentRunCount ||
        metrics.usageCoverage !== (metrics.agentRunCount ? metrics.usageAvailableRuns / metrics.agentRunCount : null) ||
        metrics.durationAvailableRuns > metrics.runCount ||
        (metrics.durationAvailableRuns === 0) !== (metrics.recordedDurationMs === null) ||
        metrics.repairAttemptCount > metrics.attemptCount || metrics.failedAttemptCount > metrics.attemptCount ||
        metrics.keyConfirmationCount !== keyTotal ||
        (metrics.usageAvailableRuns === 0 && [metrics.inputTokens, metrics.outputTokens, metrics.totalTokens].some(value => value !== null))) {
      throw new ProductError("INVALID_RESPONSE", "产品指标不一致。");
    }
  }
}

function checkResponseGoal(goal: unknown): void {
  try { assertProductGoal(goal); }
  catch { throw new ProductError("INVALID_RESPONSE", "接口返回了无效产品目标。"); }
}

export function canonicalProductJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalProductJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalProductJson(object[key])}`).join(",")}}`;
  }
  throw new ProductError("INVALID_INPUT", "数据包含不支持的值。");
}
