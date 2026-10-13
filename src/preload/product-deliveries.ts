import { ipcRenderer } from "electron";
import { ProductDeliveryError, type ProductDeliveriesApi } from "../shared/contracts/product-delivery.js";
import { assertProductDeliveryInput, assertProductDeliveryResponse, type ProductDeliveryMethod } from "../shared/core/product-delivery-validation.js";

async function invokeProductDelivery(method: ProductDeliveryMethod, input: unknown): Promise<unknown> {
  try { assertProductDeliveryInput(method, input); }
  catch (error) {
    if (error instanceof ProductDeliveryError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const result: unknown = await ipcRenderer.invoke(`productDeliveries:${method}`, input);
  assertProductDeliveryResponse(method, result, (input as { productId: string }).productId);
  return result;
}
export const productDeliveriesApi: ProductDeliveriesApi = {
  getState: async input => await invokeProductDelivery("getState", input) as Awaited<ReturnType<ProductDeliveriesApi["getState"]>>,
  create: async input => await invokeProductDelivery("create", input) as Awaited<ReturnType<ProductDeliveriesApi["create"]>>
};
