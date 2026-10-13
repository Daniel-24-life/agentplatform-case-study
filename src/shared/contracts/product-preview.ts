export type PreviewBuildDirectory = "dist" | "build" | "out";
export type ProductPreviewStatus = "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED" | "INTERRUPTED";
export type ProductPreviewSession = { id: string; productId: string; taskId: string; attemptId: string; buildDirectory: PreviewBuildDirectory; status: ProductPreviewStatus; url: string | null; errorCode: string | null; createdAt: string; finishedAt: string | null; logTail: string };
export type StartProductPreviewInput = { requestId: string; productId: string; buildDirectory: PreviewBuildDirectory };
export type ControlProductPreviewInput = { productId: string; sessionId: string };
export type ProductPreviewErrorCode = "INVALID_INPUT" | "INVALID_RESPONSE" | "NOT_FOUND" | "REQUEST_ID_CONFLICT" | "BUSY" | "NOT_READY" | "EVIDENCE_CHANGED" | "STATIC_OUTPUT_MISSING" | "UNSAFE_OUTPUT" | "OUTPUT_TOO_LARGE" | "START_FAILED" | "STOP_NOT_CONFIRMED" | "INTERNAL_ERROR";
export class ProductPreviewError extends Error { constructor(readonly code: ProductPreviewErrorCode, message: string = code) { super(message); this.name = "ProductPreviewError"; } }
export type ProductPreviewResult<T> = { ok: true; value: T } | { ok: false; error: { code: ProductPreviewErrorCode; message: string } };
export interface ProductPreviewsApi {
  getState(_input: { productId: string }): Promise<ProductPreviewResult<ProductPreviewSession | null>>;
  start(_input: StartProductPreviewInput): Promise<ProductPreviewResult<ProductPreviewSession>>;
  stop(_input: ControlProductPreviewInput): Promise<ProductPreviewResult<ProductPreviewSession>>;
  open(_input: ControlProductPreviewInput): Promise<ProductPreviewResult<ProductPreviewSession>>;
}
