import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ProductPlanError } from "../../shared/contracts/product-plan.js";
import { assertProductPlanInput, assertProductPlanResponse, type ProductPlanMethod } from "../../shared/core/product-plan-validation.js";
import type { ProductPlanService } from "./product-plan-service.js";

const methods: ProductPlanMethod[] = ["getState", "save", "confirm"];
export function initProductPlanIpcHandlers(service: ProductPlanService, trusted: (_event: IpcMainInvokeEvent) => boolean): void {
  for (const method of methods) {
    ipcMain.handle(`productPlans:${method}`, async (event, input: unknown) => {
      try {
        if (!trusted(event)) throw new ProductPlanError("INVALID_INPUT", "此窗口不能访问产品计划。");
        assertProductPlanInput(method, input);
        const operation = service[method] as (_input: unknown) => Promise<unknown>;
        const result = { ok: true, value: await operation.call(service, input) };
        assertProductPlanResponse(method, result, input as { productId: string });
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof ProductPlanError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "产品计划操作失败，请刷新记录。" } };
      }
    });
  }
}
export function disposeProductPlanIpcHandlers(): void {
  for (const method of methods) ipcMain.removeHandler(`productPlans:${method}`);
}
