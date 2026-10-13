import { ipcRenderer } from "electron";
import { ProductExecutionError, type ProductExecutionApi } from "../shared/contracts/product-execution.js";
import { assertProductExecutionInput, assertProductExecutionResponse, type ProductExecutionMethod } from "../shared/core/product-execution-validation.js";

async function invokeProductExecution(method: ProductExecutionMethod, input: unknown): Promise<unknown> {
  try { assertProductExecutionInput(method, input); }
  catch (error) {
    if (error instanceof ProductExecutionError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const result: unknown = await ipcRenderer.invoke(`productExecution:${method}`, input);
  assertProductExecutionResponse(method, result, (input as { productId: string }).productId);
  return result;
}
export const productExecutionApi: ProductExecutionApi = {
  getState: async input => await invokeProductExecution("getState", input) as Awaited<ReturnType<ProductExecutionApi["getState"]>>,
  bindRepository: async input => await invokeProductExecution("bindRepository", input) as Awaited<ReturnType<ProductExecutionApi["bindRepository"]>>,
  createTask: async input => await invokeProductExecution("createTask", input) as Awaited<ReturnType<ProductExecutionApi["createTask"]>>
};
