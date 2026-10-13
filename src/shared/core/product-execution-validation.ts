import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../../schemas/product-execution.schema.json" with { type: "json" };
import { ProductExecutionError, type ProductExecutionApi, type ProductExecutionState, type ProductTaskLink } from "../contracts/product-execution.js";
export type ProductExecutionMethod = keyof ProductExecutionApi;
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
ajv.addSchema(schema);
const methods: ProductExecutionMethod[] = ["getState", "bindRepository", "createTask"];
const inputs = new Map(methods.map(method => [method, ajv.compile({ $ref: schema.$id + "#/$defs/" + method })]));
const outputs = new Map(methods.map(method => [method, ajv.compile({ $ref: schema.$id + "#/$defs/" + method + "Response" })]));
export function assertProductExecutionInput(method: ProductExecutionMethod, value: unknown): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new ProductExecutionError("INVALID_INPUT", "请求不可序列化。"); }
  if (!json || new TextEncoder().encode(json).byteLength > 8192 || !inputs.get(method)!(value)) throw new ProductExecutionError("INVALID_INPUT", "产品任务请求不正确。");
}
export function assertProductExecutionResponse(method: ProductExecutionMethod, value: unknown, productId: string): void {
  if (!outputs.get(method)!(value)) throw new ProductExecutionError("INVALID_RESPONSE", "产品任务响应不正确。");
  const result = value as { ok: boolean; value: ProductTaskLink | ProductExecutionState };
  if (!result.ok) return;
  if (result.value.productId !== productId) throw new ProductExecutionError("INVALID_RESPONSE", "产品任务归属不正确。");
  if (method !== "createTask") {
    const state = result.value as ProductExecutionState;
    if ((state.link === null) !== (state.taskStatus === null) || (state.link && (state.link.productId !== productId || state.link.planRevision !== state.planRevision)) || (state.planConfirmed && !state.planCurrent)) throw new ProductExecutionError("INVALID_RESPONSE", "产品任务状态不一致。");
  }
}
