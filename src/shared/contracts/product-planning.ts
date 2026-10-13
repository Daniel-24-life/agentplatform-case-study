import type { ProductPlan } from "./product-plan.js";
import type { ProductGoal } from "./products.js";

export type PlanningPurpose = "direction" | "plan";

export type PlanningContext = {
  purpose?: PlanningPurpose;
  productId: string;
  workspaceRevision: number;
  goalRevision: number;
  goalHash: string;
  goal: ProductGoal;
};
export type ProductProposalOption = { id: string; title: string; rationale: string; goal: ProductGoal; plan?: ProductPlan };
export type ProductProposal = {
  schemaVersion: "1.0";
  productId: string;
  goalRevision: number;
  goalHash: string;
  contextHash: string;
  summary: string;
  options: ProductProposalOption[];
  recommendedOptionId: string;
  questions: string[];
};
export type PlanningGrant = {
  id: string;
  productId: string;
  goalRevision: number;
  goalHash: string;
  maxCalls: 1;
  usedCalls: 0 | 1;
  timeoutSeconds: 300;
  revokedAt: string | null;
  createdAt: string;
};
export type PlanningAction = {
  id: string;
  productId: string;
  grantId: string;
  goalRevision: number;
  goalHash: string;
  contextHash: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";
  proposal: ProductProposal | null;
  errorCode: PlanningErrorCode | null;
  createdAt: string;
  finishedAt: string | null;
};
export type PlanningState = { available: boolean; planAvailable?: boolean; grant: PlanningGrant | null; action: PlanningAction | null };
export type PlanningErrorCode =
  | "INVALID_INPUT" | "INPUT_TOO_LARGE" | "INVALID_RESPONSE" | "NOT_FOUND"
  | "REVISION_CONFLICT" | "REQUEST_ID_CONFLICT" | "PERMISSION_REQUIRED"
  | "GRANT_REVOKED" | "BUDGET_EXHAUSTED" | "RUNTIME_NOT_QUALIFIED"
  | "INVALID_PROPOSAL" | "GOAL_STALE" | "INTERRUPTED" | "QUOTA_EXHAUSTED" | "INTERNAL_ERROR";
export type PlanningResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: PlanningErrorCode; message: string } };
export class PlanningError extends Error {
  constructor(readonly code: PlanningErrorCode, message: string = code) {
    super(message);
    this.name = "PlanningError";
  }
}
export type AuthorizePlanningInput = { requestId: string; productId: string; expectedRevision: number };
export type RequestProposalInput = AuthorizePlanningInput & { grantId: string; purpose?: PlanningPurpose };
export type RevokePlanningInput = { productId: string; grantId: string };
export interface PlanningApi {
  authorize(_input: AuthorizePlanningInput): Promise<PlanningResult<PlanningGrant>>;
  revoke(_input: RevokePlanningInput): Promise<PlanningResult<PlanningGrant>>;
  requestProposal(_input: RequestProposalInput): Promise<PlanningResult<PlanningAction>>;
  getState(_input: { productId: string }): Promise<PlanningResult<PlanningState>>;
}
