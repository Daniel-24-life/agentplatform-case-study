import { isRelativeSafePath } from "./paths.js";
import type { WorkerResult } from "./worker-result.js";

export type WorkerEvidenceInput = {
  worker: Pick<WorkerResult, "status" | "changed_files">;
  authoritativeChangedFiles: string[];
  diff: string;
  /** Set when the approved task explicitly requires a repository change. */
  requiresChange?: boolean;
};

export type WorkerEvidenceCheck = {
  diagnostics: string[];
  workerChangedFiles: string[];
  authoritativeChangedFiles: string[];
};

const normalize = (value: string): string => value.trim().replace(/\\/g, "/");
const unique = (values: string[]): string[] => [...new Set(values.map(normalize).filter(Boolean))];

/** Compare the worker's claim with Git evidence; Git remains authoritative. */
export const checkWorkerEvidence = (input: WorkerEvidenceInput): WorkerEvidenceCheck => {
  const workerChangedFiles = unique(input.worker.changed_files);
  const authoritativeChangedFiles = unique(input.authoritativeChangedFiles);
  const actual = new Set(authoritativeChangedFiles);
  const diagnostics: string[] = [];
  const claimsChange = workerChangedFiles.length > 0 || input.requiresChange === true;

  if (input.worker.status === "completed" && claimsChange && authoritativeChangedFiles.length === 0 && input.diff.length === 0) {
    diagnostics.push("WORKER_NOOP");
  }

  for (const file of workerChangedFiles) {
    if (isRelativeSafePath(file) && !actual.has(file)) {
      diagnostics.push(`CLAIMED_CHANGE_WITHOUT_DIFF:${file}`);
    }
  }

  return { diagnostics, workerChangedFiles, authoritativeChangedFiles };
};
