import { describe, expect, it } from "vitest";
import { checkWorkerEvidence } from "../../src/shared/core/worker-evidence.js";

const check = (worker: { status: "completed" | "blocked" | "failed"; changed_files: string[] }, actual: string[], diff = "") =>
  checkWorkerEvidence({ worker, authoritativeChangedFiles: actual, diff });

describe("worker evidence consistency", () => {
  it("accepts a legitimate completed no-op", () => {
    expect(check({ status: "completed", changed_files: [] }, [], "").diagnostics).toEqual([]);
  });
  it("diagnoses a completed worker claiming a change with no Git evidence", () => {
    expect(check({ status: "completed", changed_files: ["src/a.ts"] }, [], "").diagnostics).toEqual(["WORKER_NOOP", "CLAIMED_CHANGE_WITHOUT_DIFF:src/a.ts"]);
  });
  it("reports only safe claimed paths missing from Git, with normalized paths", () => {
    expect(check({ status: "completed", changed_files: ["src\\a.ts", "src/b.ts", "../secret"] }, ["src/a.ts"], "diff").diagnostics)
      .toEqual(["CLAIMED_CHANGE_WITHOUT_DIFF:src/b.ts"]);
  });
  it("does not call blocked or failed output a worker no-op", () => {
    expect(check({ status: "blocked", changed_files: ["src/a.ts"] }, [], "").diagnostics).toEqual(["CLAIMED_CHANGE_WITHOUT_DIFF:src/a.ts"]);
  });
  it("handles deletions and duplicate claims", () => {
    expect(check({ status: "completed", changed_files: ["src\\old.ts", "src/old.ts"] }, ["src/old.ts"], "diff").diagnostics).toEqual([]);
  });
});
