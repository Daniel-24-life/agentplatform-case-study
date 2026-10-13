export type AcceptanceCriterion = {
  id: string;
  description: string;
  verification: "platform" | "review" | "user";
  required: boolean;
};

export type ProductGoal = {
  schemaVersion: "1.0";
  originalRequest: string;
  goal: string;
  scope: string;
  assumptions: string[];
  acceptanceCriteria: AcceptanceCriterion[];
};

export type ProductSummary = {
  id: string;
  name: string;
  repositoryId: null;
  revision: number;
  goalRevision: number;
  confirmedGoalRevision: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

export type GoalSnapshot = {
  revision: number;
  hash: string;
  goal: ProductGoal;
  createdAt: string;
};

export type GoalHistoryItem = {
  revision: number;
  hash: string;
  createdAt: string;
  confirmedAt: string | null;
};

export type ProductOverview = { product: ProductSummary; goal: GoalSnapshot };
export type ProductMetrics = {
  productId: string; scope: "PRODUCT_HISTORY"; taskCount: number; passedTaskCount: number; technicalCompletionRate: number | null;
  directionConfirmations: number; planConfirmations: number; specApprovals: number; escalationApprovals: number; keyConfirmationCount: number;
  attemptCount: number; repairAttemptCount: number; failedAttemptCount: number; runCount: number; agentRunCount: number;
  durationAvailableRuns: number; recordedDurationMs: number | null; usageAvailableRuns: number; usageCoverage: number | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
};
export type ProductEvent = {
  productId: string;
  sequence: number;
  type: "PRODUCT_CREATED" | "GOAL_REVISED" | "DIRECTION_CONFIRMED" | "REPOSITORY_BOUND" | "PRODUCT_TRASHED" | "PRODUCT_RESTORED";
  goalRevision: number;
  workspaceRevision: number;
  createdAt: string;
};

export type CreateProductInput = { requestId: string; name: string; initialRequest: string };
export type ReviseGoalInput = { requestId: string; productId: string; expectedRevision: number; goal: ProductGoal };
export type ConfirmDirectionInput = { requestId: string; productId: string; expectedRevision: number; goalRevision: number };
export type ProductIdInput = { productId: string };
export type GetGoalInput = ProductIdInput & { revision: number };
export type ListProductsInput = { afterId?: string; limit?: number; deleted?: boolean };
export type ProductRevisionInput = { requestId: string; productId: string; expectedRevision: number };
export type GoalHistoryInput = ProductIdInput & { afterRevision?: number; limit?: number };
export type ProductEventsInput = ProductIdInput & { afterSequence?: number; limit?: number };
export type Page<T, Cursor> = { items: T[]; nextCursor: Cursor | null };

export type ProductErrorCode =
  | "INVALID_INPUT" | "INPUT_TOO_LARGE" | "INVALID_RESPONSE"
  | "NOT_FOUND" | "REVISION_CONFLICT" | "REQUEST_ID_CONFLICT"
  | "DIRECTION_INCOMPLETE" | "DATA_CORRUPT" | "INTERNAL_ERROR" | "PRODUCT_DELETED" | "PRODUCT_BUSY";
export type ProductResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ProductErrorCode; message: string } };

export interface ProductsApi {
  create(_input: CreateProductInput): Promise<ProductResult<ProductOverview>>;
  reviseGoal(_input: ReviseGoalInput): Promise<ProductResult<ProductOverview>>;
  confirmDirection(_input: ConfirmDirectionInput): Promise<ProductResult<ProductOverview>>;
  trash(_input: ProductRevisionInput): Promise<ProductResult<ProductOverview>>;
  restore(_input: ProductRevisionInput): Promise<ProductResult<ProductOverview>>;
  list(_input?: ListProductsInput): Promise<ProductResult<Page<ProductSummary, string>>>;
  getOverview(_input: ProductIdInput): Promise<ProductResult<ProductOverview>>;
  getMetrics(_input: ProductIdInput): Promise<ProductResult<ProductMetrics>>;
  getGoal(_input: GetGoalInput): Promise<ProductResult<GoalSnapshot>>;
  getGoalHistory(_input: GoalHistoryInput): Promise<ProductResult<Page<GoalHistoryItem, number>>>;
  readEvents(_input: ProductEventsInput): Promise<ProductResult<Page<ProductEvent, number>>>;
}
