export type ProductWorkItem = {
  id: string;
  title: string;
  objective: string;
  deliverable: string;
  acceptanceCriterionIds: string[];
  dependsOn: string[];
};

export type ProductPlan = {
  schemaVersion: "1.0";
  productId: string;
  goalRevision: number;
  goalHash: string;
  summary: string;
  workItems: ProductWorkItem[];
};

export type SavedProductPlan = {
  productId: string;
  revision: number;
  hash: string;
  plan: ProductPlan;
  createdAt: string;
  confirmedAt: string | null;
};

export type ProductPlanState = { saved: SavedProductPlan | null; current: boolean; directionConfirmed: boolean };
export type SaveProductPlanInput = { requestId: string; productId: string; expectedPlanRevision: number; plan: ProductPlan };
export type ConfirmProductPlanInput = { requestId: string; productId: string; planRevision: number };
export type ProductPlanErrorCode =
  | "INVALID_INPUT" | "INPUT_TOO_LARGE" | "INVALID_RESPONSE" | "NOT_FOUND" | "REVISION_CONFLICT"
  | "REQUEST_ID_CONFLICT" | "PLAN_INCOMPLETE" | "PLAN_STALE" | "DIRECTION_NOT_CONFIRMED" | "INTERNAL_ERROR";
export type ProductPlanResult<T> = { ok: true; value: T } | { ok: false; error: { code: ProductPlanErrorCode; message: string } };
export class ProductPlanError extends Error {
  constructor(readonly code: ProductPlanErrorCode, message: string = code) { super(message); this.name = "ProductPlanError"; }
}
export interface ProductPlanApi {
  getState(_input: { productId: string }): Promise<ProductPlanResult<ProductPlanState>>;
  save(_input: SaveProductPlanInput): Promise<ProductPlanResult<SavedProductPlan>>;
  confirm(_input: ConfirmProductPlanInput): Promise<ProductPlanResult<SavedProductPlan>>;
}
