import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../../schemas/product-plan.schema.json" with { type: "json" };
import { ProductPlanError, type ProductPlan, type ProductPlanApi, type SavedProductPlan } from "../contracts/product-plan.js";
import type { ProductGoal } from "../contracts/products.js";
import { validateDirection } from "./product-validation.js";
export { ProductPlanError } from "../contracts/product-plan.js";
export type ProductPlanMethod = keyof ProductPlanApi;

const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
ajv.addSchema(schema);
const methods: ProductPlanMethod[] = ["getState", "save", "confirm"];
const inputs = new Map(methods.map(method => [method, ajv.compile({ $ref: `${schema.$id}#/$defs/${method}` })]));
const outputs = new Map(methods.map(method => [method, ajv.compile({ $ref: `${schema.$id}#/$defs/${method}Response` })]));
const planValidator = ajv.getSchema(schema.$id)!;

function checkBytes(value: unknown, limit: number, response = false): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new ProductPlanError(response ? "INVALID_RESPONSE" : "INVALID_INPUT", "计划数据不可序列化。"); }
  if (json === undefined) throw new ProductPlanError(response ? "INVALID_RESPONSE" : "INVALID_INPUT", "缺少计划数据。");
  if (new TextEncoder().encode(json).byteLength > limit) throw new ProductPlanError(response ? "INVALID_RESPONSE" : "INPUT_TOO_LARGE", "计划数据超出允许大小。");
}

export function assertProductPlanInput(method: ProductPlanMethod, value: unknown): void {
  checkBytes(value, 128 * 1024);
  if (!inputs.get(method)!(value)) throw new ProductPlanError("INVALID_INPUT", "计划请求格式不正确。");
}

function checkWorkItems(plan: ProductPlan): void {
  if (!plan.summary.trim() || plan.workItems.some(item => !item.title.trim() || !item.objective.trim() || !item.deliverable.trim())) {
    throw new ProductPlanError("PLAN_INCOMPLETE", "计划摘要、工作目标和交付物须明确。");
  }
  const items = new Map(plan.workItems.map(item => [item.id, item]));
  if (items.size !== plan.workItems.length) throw new ProductPlanError("PLAN_INCOMPLETE", "工作项编号不能重复。");
  for (const item of plan.workItems) {
    if (item.dependsOn.some(id => id === item.id || !items.has(id))) throw new ProductPlanError("PLAN_INCOMPLETE", "依赖须引用其他已有工作项。");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ProductPlanError("PLAN_INCOMPLETE", "工作项依赖不能形成循环。");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of items.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of items.keys()) visit(id);
}

export function validateProductPlan(value: unknown, goal: ProductGoal, expected: { productId: string; goalRevision: number; goalHash: string }): asserts value is ProductPlan {
  checkBytes(value, 64 * 1024);
  if (!planValidator(value)) throw new ProductPlanError("INVALID_INPUT", "计划格式不正确。");
  const plan = value as ProductPlan;
  if (plan.productId !== expected.productId || plan.goalRevision !== expected.goalRevision || plan.goalHash !== expected.goalHash) {
    throw new ProductPlanError("PLAN_STALE", "计划与当前目标版本不一致。");
  }
  try { validateDirection(goal); } catch { throw new ProductPlanError("PLAN_INCOMPLETE", "请先完整保存产品目标与必要验收。"); }
  checkWorkItems(plan);
  const criteria = new Set(goal.acceptanceCriteria.map(item => item.id));
  const covered = new Set(plan.workItems.flatMap(item => item.acceptanceCriterionIds));
  if ([...covered].some(id => !criteria.has(id)) || goal.acceptanceCriteria.some(item => item.required && !covered.has(item.id))) {
    throw new ProductPlanError("PLAN_INCOMPLETE", "工作项须引用有效验收并覆盖所有必需产品验收。");
  }
}

export function assertProductPlanResponse(method: ProductPlanMethod, value: unknown, request?: { productId: string }): void {
  checkBytes(value, 1024 * 1024, true);
  if (!outputs.get(method)!(value)) throw new ProductPlanError("INVALID_RESPONSE", "计划响应格式不正确。");
  const result = value as { ok: boolean; value: unknown };
  if (!result.ok) return;
  const saved = method === "getState" ? (result.value as { saved: SavedProductPlan | null }).saved : result.value as SavedProductPlan;
  if (method === "getState" && !saved && (result.value as { current: boolean }).current) {
    throw new ProductPlanError("INVALID_RESPONSE", "不存在当前计划快照。");
  }
  if (!saved) return;
  if ((request && saved.productId !== request.productId) || saved.plan.productId !== saved.productId) {
    throw new ProductPlanError("INVALID_RESPONSE", "计划响应归属不正确。");
  }
  try { checkBytes(saved.plan, 64 * 1024); checkWorkItems(saved.plan); }
  catch { throw new ProductPlanError("INVALID_RESPONSE", "返回的工作项无效。"); }
}
