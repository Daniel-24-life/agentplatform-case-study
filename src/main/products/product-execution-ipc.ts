import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ProductExecutionError } from "../../shared/contracts/product-execution.js";
import { assertProductExecutionInput, assertProductExecutionResponse, type ProductExecutionMethod } from "../../shared/core/product-execution-validation.js";
import type { ProductExecutionService } from "./product-execution-service.js";

const methods: ProductExecutionMethod[] = ["getState", "bindRepository", "createTask"];
export function initProductExecutionIpcHandlers(service: ProductExecutionService, trusted: (_event: IpcMainInvokeEvent) => boolean): void {
  for (const method of methods) {
    ipcMain.handle(`productExecution:${method}`, async (event, input: unknown) => {
      try {
        if (!trusted(event)) throw new ProductExecutionError("INVALID_INPUT", "此窗口不能访问产品任务。");
        assertProductExecutionInput(method, input);
        const operation = service[method] as (_input: unknown) => Promise<unknown>;
        const result = { ok: true, value: await operation.call(service, input) };
        assertProductExecutionResponse(method, result, (input as { productId: string }).productId);
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof ProductExecutionError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "产品任务操作失败，请刷新记录。" } };
      }
    });
  }
}
export function disposeProductExecutionIpcHandlers(): void {
  for (const method of methods) ipcMain.removeHandler(`productExecution:${method}`);
}
