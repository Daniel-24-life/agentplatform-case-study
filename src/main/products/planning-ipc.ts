import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { PlanningResult } from "../../shared/contracts/product-planning.js";
import { assertPlanningInput, assertPlanningResponse, PlanningError, type PlanningMethod } from "../../shared/core/planning-validation.js";
import type { ProductPlanningService } from "./product-planning-service.js";

const methods: PlanningMethod[] = ["authorize", "revoke", "requestProposal", "getState"];

export function initPlanningIpcHandlers(service: ProductPlanningService, trusted: (_event: IpcMainInvokeEvent) => boolean): void {
  for (const method of methods) {
    ipcMain.handle(`productPlanning:${method}`, async (event, input: unknown) => {
      try {
        if (!trusted(event)) throw new PlanningError("INVALID_INPUT", "此窗口不能访问产品规划接口。");
        assertPlanningInput(method, input);
        const operation = service[method] as (_input: unknown) => Promise<unknown>;
        const result: PlanningResult<unknown> = { ok: true, value: await operation.call(service, input) };
        assertPlanningResponse(method, result, input as { productId: string });
        return result;
      } catch (error) {
        return { ok: false, error: error instanceof PlanningError
          ? { code: error.code, message: error.message }
          : { code: "INTERNAL_ERROR", message: "产品规划操作失败，请读取当前记录。" } };
      }
    });
  }
}

export function disposePlanningIpcHandlers(): void {
  for (const method of methods) ipcMain.removeHandler(`productPlanning:${method}`);
}
