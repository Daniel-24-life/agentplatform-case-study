import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ProductPreviewError } from "../../shared/contracts/product-preview.js";
import { assertProductPreviewInput, assertProductPreviewResponse, type ProductPreviewMethod } from "../../shared/core/product-preview-validation.js";
import type { ProductPreviewService } from "./product-preview-service.js";

const methods: ProductPreviewMethod[] = ["getState", "start", "stop", "open"];
export function initProductPreviewIpcHandlers(service: ProductPreviewService, trusted: (_event: IpcMainInvokeEvent) => boolean): void {
  for (const method of methods) {
    ipcMain.handle(`productPreviews:${method}`, async (event, input: unknown) => {
      try {
        if (!trusted(event)) throw new ProductPreviewError("INVALID_INPUT", "此窗口不能访问产品任务。");
        assertProductPreviewInput(method, input);
        const operation = service[method] as (_input: unknown) => Promise<unknown>;
        const result = { ok: true, value: await operation.call(service, input) };
        assertProductPreviewResponse(method, result, (input as { productId: string }).productId);
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof ProductPreviewError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "产品任务操作失败，请刷新记录。" } };
      }
    });
  }
}
export function disposeProductPreviewIpcHandlers(): void {
  for (const method of methods) ipcMain.removeHandler(`productPreviews:${method}`);
}
