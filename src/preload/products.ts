import { ipcRenderer } from "electron";
import type { ProductsApi } from "../shared/contracts/products.js";
import { assertProductInput, assertProductResponse, ProductError, type ProductMethod } from "../shared/core/product-validation.js";

async function invokeProduct(method: ProductMethod, input: unknown): Promise<unknown> {
  try { assertProductInput(method, input); }
  catch (error) {
    // contextBridge does not preserve custom Error properties. Return known
    // input failures in the typed envelope so UI retries stay unambiguous.
    if (error instanceof ProductError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const response: unknown = await ipcRenderer.invoke(`products:${method}`, input);
  assertProductResponse(method, response, input);
  return response;
}

export const productsApi: ProductsApi = {
  create: async input => await invokeProduct("create", input) as Awaited<ReturnType<ProductsApi["create"]>>,
  reviseGoal: async input => await invokeProduct("reviseGoal", input) as Awaited<ReturnType<ProductsApi["reviseGoal"]>>,
  confirmDirection: async input => await invokeProduct("confirmDirection", input) as Awaited<ReturnType<ProductsApi["confirmDirection"]>>,
  trash: async input => await invokeProduct("trash", input) as Awaited<ReturnType<ProductsApi["trash"]>>,
  restore: async input => await invokeProduct("restore", input) as Awaited<ReturnType<ProductsApi["restore"]>>,
  list: async (input = {}) => await invokeProduct("list", input) as Awaited<ReturnType<ProductsApi["list"]>>,
  getOverview: async input => await invokeProduct("getOverview", input) as Awaited<ReturnType<ProductsApi["getOverview"]>>,
  getMetrics: async input => await invokeProduct("getMetrics", input) as Awaited<ReturnType<ProductsApi["getMetrics"]>>,
  getGoal: async input => await invokeProduct("getGoal", input) as Awaited<ReturnType<ProductsApi["getGoal"]>>,
  getGoalHistory: async input => await invokeProduct("getGoalHistory", input) as Awaited<ReturnType<ProductsApi["getGoalHistory"]>>,
  readEvents: async input => await invokeProduct("readEvents", input) as Awaited<ReturnType<ProductsApi["readEvents"]>>
};
