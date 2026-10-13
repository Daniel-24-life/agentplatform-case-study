import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ProductRunError } from "../../shared/contracts/product-run.js";
import { assertProductRunInput, assertProductRunResponse, type ProductRunMethod } from "../../shared/core/product-run-validation.js";
import type { ProductRunService } from "./product-run-service.js";

const methods: ProductRunMethod[] = ["getState", "start", "pause", "cancel"];
export function initProductRunIpcHandlers(service: ProductRunService, trusted: (_event: IpcMainInvokeEvent) => boolean): void {
  for (const method of methods) {
    ipcMain.handle(`productRuns:${method}`, async (event, input: unknown) => {
      try {
        if (!trusted(event)) throw new ProductRunError("INVALID_INPUT", "此窗口不能访问产品任务。");
        assertProductRunInput(method, input);
        const operation = service[method] as (_input: unknown) => Promise<unknown>;
        const result = { ok: true, value: await operation.call(service, input) };
        assertProductRunResponse(method, result, (input as { productId: string }).productId);
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof ProductRunError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "产品任务操作失败，请刷新记录。" } };
      }
    });
  }
}
export function disposeProductRunIpcHandlers(): void {
  for (const method of methods) ipcMain.removeHandler(`productRuns:${method}`);
}
