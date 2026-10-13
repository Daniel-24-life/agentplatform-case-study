import { ipcRenderer } from "electron";
import type { PlanningApi } from "../shared/contracts/product-planning.js";
import { assertPlanningInput, assertPlanningResponse, PlanningError, type PlanningMethod } from "../shared/core/planning-validation.js";

async function invokePlanning(method: PlanningMethod, input: unknown): Promise<unknown> {
  try { assertPlanningInput(method, input); }
  catch (error) {
    if (error instanceof PlanningError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const result: unknown = await ipcRenderer.invoke(`productPlanning:${method}`, input);
  assertPlanningResponse(method, result, input as { productId: string });
  return result;
}

export const planningApi: PlanningApi = {
  authorize: async input => await invokePlanning("authorize", input) as Awaited<ReturnType<PlanningApi["authorize"]>>,
  revoke: async input => await invokePlanning("revoke", input) as Awaited<ReturnType<PlanningApi["revoke"]>>,
  requestProposal: async input => await invokePlanning("requestProposal", input) as Awaited<ReturnType<PlanningApi["requestProposal"]>>,
  getState: async input => await invokePlanning("getState", input) as Awaited<ReturnType<PlanningApi["getState"]>>
};
