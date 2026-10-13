export const PRODUCT_RUN_STATUSES = ["RUNNING", "PAUSE_REQUESTED", "CANCEL_REQUESTED", "PAUSED", "CANCELLED", "SUCCEEDED", "FAILED", "INTERRUPTED"] as const;
export type ProductRunStatus = typeof PRODUCT_RUN_STATUSES[number];
export type ProductRunAction = { id: string; productId: string; planRevision: number; taskId: string; specRevision: number; specHash: string; status: ProductRunStatus; stage: "build" | "tests" | "review" | null; reservedModelCalls: number; maxModelCalls: number; usedModelCalls?: number; errorCode: string | null; createdAt: string; finishedAt: string | null };
export type StartProductRunInput = { requestId: string; productId: string; planRevision: number; taskId: string; specRevision: number; specHash: string };
export type ControlProductRunInput = { productId: string; actionId: string };
export type ProductRunErrorCode = "INVALID_INPUT" | "INVALID_RESPONSE" | "NOT_FOUND" | "REQUEST_ID_CONFLICT" | "PLAN_STALE" | "SPEC_NOT_APPROVED" | "SPEC_CHANGED" | "TASK_NOT_READY" | "TASK_BUSY" | "RUNTIME_UNAVAILABLE" | "BUDGET_EXHAUSTED" | "INTERNAL_ERROR";
export class ProductRunError extends Error { constructor(readonly code: ProductRunErrorCode, message: string = code) { super(message); this.name = "ProductRunError"; } }
export type ProductRunResult<T> = { ok: true; value: T } | { ok: false; error: { code: ProductRunErrorCode; message: string } };
export interface ProductRunsApi {
  getState(_input: { productId: string }): Promise<ProductRunResult<ProductRunAction | null>>;
  start(_input: StartProductRunInput): Promise<ProductRunResult<ProductRunAction>>;
  pause(_input: ControlProductRunInput): Promise<ProductRunResult<ProductRunAction>>;
  cancel(_input: ControlProductRunInput): Promise<ProductRunResult<ProductRunAction>>;
}
