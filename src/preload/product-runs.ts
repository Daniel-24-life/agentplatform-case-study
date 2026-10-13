import { ipcRenderer } from "electron";
import { ProductRunError, type ProductRunsApi } from "../shared/contracts/product-run.js";
import { assertProductRunInput, assertProductRunResponse, type ProductRunMethod } from "../shared/core/product-run-validation.js";

async function invokeProductRun(method: ProductRunMethod, input: unknown): Promise<unknown> {
  try { assertProductRunInput(method, input); }
  catch (error) {
    if (error instanceof ProductRunError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const result: unknown = await ipcRenderer.invoke(`productRuns:${method}`, input);
  assertProductRunResponse(method, result, (input as { productId: string }).productId);
  return result;
}
export const productRunsApi: ProductRunsApi = {
  getState: async input => await invokeProductRun("getState", input) as Awaited<ReturnType<ProductRunsApi["getState"]>>,
  start: async input => await invokeProductRun("start", input) as Awaited<ReturnType<ProductRunsApi["start"]>>,
  pause: async input => await invokeProductRun("pause", input) as Awaited<ReturnType<ProductRunsApi["pause"]>>,
  cancel: async input => await invokeProductRun("cancel", input) as Awaited<ReturnType<ProductRunsApi["cancel"]>>
};
