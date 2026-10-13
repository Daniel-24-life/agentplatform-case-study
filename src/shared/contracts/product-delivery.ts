import type { AcceptanceCriterion } from './products.js';
export type ProductCriterionReview = { criterionId: string; accepted: boolean; taskCriterionIds: string[]; note: string };
export type DeliveryEvidence = { taskId: string; specRevision: number; specHash: string; attemptId: string; branch: string; worktreePath: string; head: string; diffHash: string; manifestHash: string; finalGateHash: string; testRunIds: string[] };
export type ProductDelivery = { id: string; productId: string; goalRevision: number; goalHash: string; planRevision: number; planHash: string; criteria: AcceptanceCriterion[]; reviews: ProductCriterionReview[]; evidence: DeliveryEvidence; runInstructions: string; limitations: string; status: 'REVIEW_REQUIRED' | 'ACCEPTED_UNPUBLISHED'; previewStatus: 'NOT_RUN'; publicationStatus: 'NOT_RUN'; createdAt: string };
export type ProductDeliveryState = { productId: string; latest: ProductDelivery | null; current: boolean };
export type CreateProductDeliveryInput = { requestId: string; productId: string; planRevision: number; taskId: string; attemptId: string; reviews: ProductCriterionReview[]; runInstructions: string; limitations: string };
export type ProductDeliveryErrorCode = 'INVALID_INPUT' | 'INPUT_TOO_LARGE' | 'INVALID_RESPONSE' | 'NOT_FOUND' | 'REQUEST_ID_CONFLICT' | 'PLAN_STALE' | 'TASK_NOT_PASSED' | 'EVIDENCE_CHANGED' | 'DATA_CORRUPT' | 'REVIEW_INCOMPLETE' | 'INTERNAL_ERROR';
export type ProductDeliveryResult<T> = { ok: true; value: T } | { ok: false; error: { code: ProductDeliveryErrorCode; message: string } };
export class ProductDeliveryError extends Error { constructor(readonly code: ProductDeliveryErrorCode, message: string = code) { super(message); this.name = 'ProductDeliveryError'; } }
export interface ProductDeliveriesApi { getState(_input: { productId: string }): Promise<ProductDeliveryResult<ProductDeliveryState>>; create(_input: CreateProductDeliveryInput): Promise<ProductDeliveryResult<ProductDelivery>>; }
