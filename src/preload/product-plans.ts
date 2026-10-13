import { ipcRenderer } from "electron";
import { ProductPlanError, type ProductPlanApi } from "../shared/contracts/product-plan.js";
import { assertProductPlanInput, assertProductPlanResponse, type ProductPlanMethod } from "../shared/core/product-plan-validation.js";

async function invokeProductPlan(method: ProductPlanMethod, input: unknown): Promise<unknown> {
  try { assertProductPlanInput(method, input); }
  catch (error) {
    if (error instanceof ProductPlanError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const result: unknown = await ipcRenderer.invoke(`productPlans:${method}`, input);
  assertProductPlanResponse(method, result, input as { productId: string });
  return result;
}
export const productPlansApi: ProductPlanApi = {
  getState: async input => await invokeProductPlan("getState", input) as Awaited<ReturnType<ProductPlanApi["getState"]>>,
  save: async input => await invokeProductPlan("save", input) as Awaited<ReturnType<ProductPlanApi["save"]>>,
  confirm: async input => await invokeProductPlan("confirm", input) as Awaited<ReturnType<ProductPlanApi["confirm"]>>
};
