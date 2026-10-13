import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../../schemas/product-run.schema.json" with { type: "json" };
import { ProductRunError, type ProductRunsApi, type ProductRunAction } from "../contracts/product-run.js";
export type ProductRunMethod = keyof ProductRunsApi;
const ajv = new Ajv2020({ strict: true, ownProperties: true }); ajv.addSchema(schema);
const methods: ProductRunMethod[] = ["getState", "start", "pause", "cancel"];
const inputs = new Map(methods.map(method => [method, ajv.compile({ $ref: schema.$id + "#/$defs/" + method })]));
const outputs = new Map(methods.map(method => [method, ajv.compile({ $ref: schema.$id + "#/$defs/" + method + "Response" })]));
export function assertProductRunInput(method: ProductRunMethod, value: unknown): void {
  if (!inputs.get(method)!(value)) throw new ProductRunError("INVALID_INPUT", "产品连续执行请求不正确。");
}
export function assertProductRunResponse(method: ProductRunMethod, value: unknown, productId: string): void {
  if (!outputs.get(method)!(value)) throw new ProductRunError("INVALID_RESPONSE", "连续执行响应不正确。");
  const result = value as { ok: boolean; value: ProductRunAction | null };
  if (!result.ok || result.value === null) return;
  const action = result.value;
  const active = ["RUNNING", "PAUSE_REQUESTED", "CANCEL_REQUESTED"].includes(action.status);
  if (action.reservedModelCalls > action.maxModelCalls || (action.usedModelCalls !== undefined && action.usedModelCalls < action.reservedModelCalls)) throw new ProductRunError("INVALID_RESPONSE", "共享预算计数不正确。");
  if (action.productId !== productId || active !== (action.finishedAt === null)) throw new ProductRunError("INVALID_RESPONSE", "连续执行状态或归属不一致。");
}
