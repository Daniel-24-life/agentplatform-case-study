import type { TaskStatus } from "../core/task-state.js";
import type { WorkerResult } from "../core/worker-result.js";
import type { FinalGateResult } from "../core/final-gate.js";

export type ProjectRecord = { id: string; name: string; repoPath: string; repoRealPath: string; createdAt: string; lastSeenHead: string };
export type TaskRecord = { id: string; projectId: string; title: string; requestText: string; status: TaskStatus; baseSha: string; specJson: string | null; specRevision: number; specApprovedAt: string | null; createdAt: string; updatedAt: string };
export type AttemptRecord = { id: string; taskId: string; number: number; branch: string; worktreePath: string; status: string; createdAt: string };
export type WorkerClass = "cheap" | "strong" | null;
export type RunRecord = { id: string; taskId: string; attemptId: string | null; stage: string; adapter: string; model: string | null; reasoning: string | null; workerClass: WorkerClass; cwd: string; pid: number | null; status: string; exitCode: number | null; startedAt: string; endedAt: string | null; errorCode: string | null; failureDomain?: "runtime" | "task" | "user" | null; durationMs: number | null; isEscalation: boolean; isHighTier: boolean; usageJson: string | null };
export type RunUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens?: number | null };
export type RunMetrics = { runCount: number; highTierCalls: number; highTierInputTokens: number | null; highTierOutputTokens: number | null; highTierTotalTokens: number | null; escalationCount: number; totalDurationMs: number; workerRuns: number; cheapRuns: number; strongRuns: number; retryCount: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; usageAvailableRuns: number; agentRunCount: number };
export type ArtifactRecord = { id: string; runId: string; kind: string; path: string; sha256: string; sizeBytes: number };
export type EventRecord = { id: string; taskId: string; runId: string | null; sequence: number; type: string; payloadJson: string; createdAt: string };
export type TaskEvidenceSnapshot={attemptId:string;branch:string;worktreePath:string;worker:WorkerResult;git:{head:string;changedFiles:string[];diff:string;stat:string;invalidPaths?:string[]};tests?:Array<{id:string;runId?:string;required:boolean;result:{exitCode:number|null;status:string;stdout:string;stderr:string;stdoutSha256:string;stderrSha256:string;durationMs:number}}> ;gate?:{passed:boolean;failures:string[]};final?:FinalGateResult;artifacts:Array<{kind:string;path:string;sizeBytes:number;sha256:string}>};
export type TaskDetailRecord={task:TaskRecord;attempt:AttemptRecord|null;events:EventRecord[];snapshot:TaskEvidenceSnapshot|null;runs:RunRecord[];metrics:RunMetrics;escalationPending:boolean};
