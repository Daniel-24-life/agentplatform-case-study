import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { ProductResult } from "../../shared/contracts/products.js";
import { assertProductInput, assertProductResponse, ProductError, type ProductMethod } from "../../shared/core/product-validation.js";
import type { ProductService } from "./product-service.js";

const methods: ProductMethod[] = ["create", "reviseGoal", "confirmDirection", "trash", "restore", "list", "getOverview", "getMetrics", "getGoal", "getGoalHistory", "readEvents"];

export function initProductIpcHandlers(service: ProductService, isTrustedSender: (_event: IpcMainInvokeEvent) => boolean): void {
  for (const method of methods) {
    ipcMain.handle(`products:${method}`, async (event, input: unknown) => {
      let result: ProductResult<unknown>;
      try {
        if (!isTrustedSender(event)) throw new ProductError("INVALID_INPUT", "此窗口不能访问产品接口。");
        const request = method === "list" && input === undefined ? {} : input;
        assertProductInput(method, request);
        // Every entry is a fixed public method; no arbitrary command dispatch.
        const operation = (service as unknown as Record<string, (_input: unknown) => unknown>)[method];
        result = { ok: true, value: await operation.call(service, request) };
        assertProductResponse(method, result, request);
      } catch (error) {
        result = { ok: false, error: error instanceof ProductError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "产品操作失败，请重试读取当前状态。" } };
      }
      return result;
    });
  }
}

export function disposeProductIpcHandlers(): void {
  for (const method of methods) ipcMain.removeHandler(`products:${method}`);
}
