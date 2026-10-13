import { ipcRenderer } from "electron";
import { ProductPreviewError, type ProductPreviewsApi } from "../shared/contracts/product-preview.js";
import { assertProductPreviewInput, assertProductPreviewResponse, type ProductPreviewMethod } from "../shared/core/product-preview-validation.js";

async function invokeProductPreview(method: ProductPreviewMethod, input: unknown): Promise<unknown> {
  try { assertProductPreviewInput(method, input); }
  catch (error) {
    if (error instanceof ProductPreviewError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const result: unknown = await ipcRenderer.invoke(`productPreviews:${method}`, input);
  assertProductPreviewResponse(method, result, (input as { productId: string }).productId);
  return result;
}
export const productPreviewsApi: ProductPreviewsApi = {
  getState: async input => await invokeProductPreview("getState", input) as Awaited<ReturnType<ProductPreviewsApi["getState"]>>,
  start: async input => await invokeProductPreview("start", input) as Awaited<ReturnType<ProductPreviewsApi["start"]>>,
  stop: async input => await invokeProductPreview("stop", input) as Awaited<ReturnType<ProductPreviewsApi["stop"]>>,
  open: async input => await invokeProductPreview("open", input) as Awaited<ReturnType<ProductPreviewsApi["open"]>>
};
