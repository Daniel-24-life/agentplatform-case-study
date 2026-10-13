import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

for (const operation of ["pause", "cancel"] as const) {
  it(`converges ${operation} requested while the already-reserved build awaits its worktree`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-product-control-"));
    const f = await createProductWorkflowFixture(root);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const original = f.git.createWorktree.bind(f.git);
    vi.spyOn(f.git, "createWorktree").mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    try {
      const action = await f.runs.start(f.input);
      await reached;
      expect(f.database.getTask(f.input.taskId)?.status).toBe("PREPARING_WORKTREE");
      await f.runs[operation]({ productId: f.input.productId, actionId: action.id });
      release();
      const stopped = await waitForProductRun(f);
      expect(stopped.status).toBe(operation === "pause" ? "PAUSED" : "CANCELLED");
      expect(f.database.getTask(f.input.taskId)?.status).not.toMatch(/^(PREPARING_WORKTREE|BUILDING|REVIEWING|TESTING)$/);
      const runs = f.database.listRuns(f.database.getLatestAttempt(f.input.taskId)!.id);
      expect(runs.filter(run => run.stage === "builder")).toHaveLength(1);
      expect(runs.every(run => !["STARTING", "RUNNING"].includes(run.status))).toBe(true);
      if (operation === "pause") {
        expect(f.database.getTask(f.input.taskId)?.status).toBe("BUILT");
        expect(stopped.usedModelCalls).toBe(1);
        await f.runs.start({ ...f.input, requestId: "resume" });
        expect(await waitForProductRun(f)).toMatchObject({ status: "SUCCEEDED", usedModelCalls: 2, maxModelCalls: 2 });
        expect(f.database.getLatestAttempt(f.input.taskId)?.number).toBe(1);
      }
    } finally { release(); await waitForProductRun(f).catch(() => undefined); f.database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
}
