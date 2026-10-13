import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ProductError } from "../../shared/core/product-validation.js";
import { ProductPlanError } from "../../shared/contracts/product-plan.js";
import { ProductDeliveryError } from "../../shared/contracts/product-delivery.js";
import { assertProductDeliveryInput, assertProductDeliveryResponse, type ProductDeliveryMethod } from "../../shared/core/product-delivery-validation.js";
import type { ProductDeliveryService } from "./product-delivery-service.js";

const methods: ProductDeliveryMethod[] = ["getState", "create"];
export function initProductDeliveryIpcHandlers(service: ProductDeliveryService, trusted: (_event: IpcMainInvokeEvent) => boolean): void {
  for (const method of methods) {
    ipcMain.handle(`productDeliveries:${method}`, async (event, input: unknown) => {
      try {
        if (!trusted(event)) throw new ProductDeliveryError("INVALID_INPUT", "此窗口不能访问产品交付。");
        assertProductDeliveryInput(method, input);
        const operation = service[method] as (_input: unknown) => Promise<unknown>;
        const result = { ok: true, value: await operation.call(service, input) };
        assertProductDeliveryResponse(method, result, (input as { productId: string }).productId);
        return result;
      } catch (error) {
        if ((error instanceof ProductError || error instanceof ProductPlanError) && error.code === 'NOT_FOUND') return {ok:false,error:{code:'NOT_FOUND',message:'产品不存在。'}};
        if (error instanceof ProductError && error.code === 'DATA_CORRUPT') return {ok:false,error:{code:'DATA_CORRUPT',message:'产品数据校验失败。'}};
        return { ok: false, error: error instanceof ProductDeliveryError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "产品交付操作失败，请刷新记录。" } };
      }
    });
  }
}
export function disposeProductDeliveryIpcHandlers(): void {
  for (const method of methods) ipcMain.removeHandler(`productDeliveries:${method}`);
}
