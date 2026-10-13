import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../../schemas/product-preview.schema.json" with { type: "json" };
import { ProductPreviewError, type ProductPreviewsApi, type ProductPreviewSession } from "../contracts/product-preview.js";
export type ProductPreviewMethod = keyof ProductPreviewsApi;
export const PRODUCT_PREVIEW_METHODS: ProductPreviewMethod[] = ["getState", "start", "stop", "open"];
const ajv = new Ajv2020({ strict: true, ownProperties: true }); ajv.addSchema(schema);
const inputs = new Map(PRODUCT_PREVIEW_METHODS.map(method => [method, ajv.compile({ $ref: schema.$id + "#/$defs/" + method })]));
const outputs = new Map(PRODUCT_PREVIEW_METHODS.map(method => [method, ajv.compile({ $ref: schema.$id + "#/$defs/" + method + "Response" })]));
export function assertProductPreviewInput(method: ProductPreviewMethod, value: unknown): void {
  if (!inputs.get(method)!(value)) throw new ProductPreviewError("INVALID_INPUT", "预览请求不正确。");
}
export function assertProductPreviewResponse(method: ProductPreviewMethod, value: unknown, productId: string): void {
  if (!outputs.get(method)!(value)) throw new ProductPreviewError("INVALID_RESPONSE", "预览响应不正确。");
  const result = value as { ok: boolean; value: ProductPreviewSession | null };
  if (!result.ok || !result.value) return;
  const session = result.value;
  const active = ["STARTING", "RUNNING", "STOPPING"].includes(session.status);
  const port = session.url ? Number(session.url.match(/:(\d+)\/$/)?.[1]) : 0;
  if (session.productId !== productId || active !== (session.finishedAt === null) || (session.status === "RUNNING") !== (session.url !== null) || (session.url !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) throw new ProductPreviewError("INVALID_RESPONSE", "预览状态、端口或归属不一致。");
}
