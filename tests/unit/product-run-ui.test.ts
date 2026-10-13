import { describe, expect, it } from "vitest";
import { eligibleProductRun, productRunBudget, sha256Utf8 } from "../../src/renderer/src/features/products/ProductRunPanel.js";
import type { ProductExecutionState } from "../../src/shared/contracts/product-execution.js";
import type { TaskRecord } from "../../src/shared/contracts/records.js";

const state: ProductExecutionState = { productId: "p", repositoryId: "r", planRevision: 2, planCurrent: true, planConfirmed: true, link: { productId: "p", planRevision: 2, taskId: "t", createdAt: "now" }, taskStatus: "SPEC_APPROVED" };
const task: TaskRecord = { id: "t", projectId: "project", title: "Task", requestText: "x", status: "SPEC_APPROVED", baseSha: "sha", specJson: "{\"x\":1}", specRevision: 3, specApprovedAt: "now", createdAt: "now", updatedAt: "now" };

describe("product run UI rules", () => {
  it("allows only a clean linked approved task", () => {
    expect(eligibleProductRun(state, task, false).eligible).toBe(true);
    expect(eligibleProductRun(state, { ...task, status: "REWORK" }, false).eligible).toBe(true);
    expect(eligibleProductRun(state, { ...task, status: "BLOCKED" }, false).eligible).toBe(false);
    expect(eligibleProductRun(state, task, true).eligible).toBe(false);
    expect(eligibleProductRun(state, { ...task, specApprovedAt: null }, false).eligible).toBe(false);
    expect(eligibleProductRun(state, { ...task, status: "DRAFT" }, false).eligible).toBe(false);
  });
  it("shows the frozen shared budget instead of refreshing it from a larger specification", () => {
    const approved = { ...task, specJson: JSON.stringify({ limits: { max_attempts: 3 } }) };
    const action = { id: "a", productId: "p", planRevision: 2, taskId: "t", specRevision: 3, specHash: "hash", status: "PAUSED" as const, stage: null, reservedModelCalls: 1, maxModelCalls: 2, usedModelCalls: 2, errorCode: null, createdAt: "now", finishedAt: "now" };
    expect(productRunBudget(approved, null)).toEqual({ limit: 6, used: 0, exhausted: false });
    expect(productRunBudget(approved, action)).toEqual({ limit: 2, used: 2, exhausted: true });
    expect(productRunBudget(approved, { ...action, specRevision: 2 })).toEqual({ limit: 6, used: 0, exhausted: false });
    expect(productRunBudget(task, null).limit).toBeNull();
  });
  it("hashes the raw specification bytes", async () => {
    await expect(sha256Utf8(task.specJson!)).resolves.toBe("5041bf1f713df204784353e82f6a4a535931cb64f1f4b4a5aeaffcb720918b22");
  });
});
