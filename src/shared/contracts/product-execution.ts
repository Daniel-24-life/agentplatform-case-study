import type { TaskStatus } from "../core/task-state.js";
export type ProductTaskLink = { productId: string; planRevision: number; taskId: string; createdAt: string };
export type ProductExecutionState = { productId: string; repositoryId: string | null; planRevision: number | null; planCurrent: boolean; planConfirmed: boolean; link: ProductTaskLink | null; taskStatus: TaskStatus | null };
export type BindProductRepositoryInput = { requestId: string; productId: string; expectedRevision: number; repositoryId: string };
export type CreateProductTaskInput = { requestId: string; productId: string; planRevision: number };
export type ProductExecutionErrorCode = "INVALID_INPUT" | "INVALID_RESPONSE" | "NOT_FOUND" | "REVISION_CONFLICT" | "REQUEST_ID_CONFLICT" | "PLAN_STALE" | "PLAN_NOT_CONFIRMED" | "REPOSITORY_REQUIRED" | "REPOSITORY_DIRTY" | "REPOSITORY_LOCKED" | "INTERNAL_ERROR";
export class ProductExecutionError extends Error { constructor(readonly code: ProductExecutionErrorCode, message: string = code) { super(message); this.name = "ProductExecutionError"; } }
export type ProductExecutionResult<T> = { ok: true; value: T } | { ok: false; error: { code: ProductExecutionErrorCode; message: string } };
export interface ProductExecutionApi {
  getState(_input: { productId: string }): Promise<ProductExecutionResult<ProductExecutionState>>;
  bindRepository(_input: BindProductRepositoryInput): Promise<ProductExecutionResult<ProductExecutionState>>;
  createTask(_input: CreateProductTaskInput): Promise<ProductExecutionResult<ProductTaskLink>>;
}
