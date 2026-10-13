import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture } from "../helpers/product-workflow.js";

it("trash preserves linked evidence and blocks legacy dispatch and awaited plan writes until restore", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-trash-boundary-"));
  const f = await createProductWorkflowFixture(root);
  try {
    const productId = f.input.productId;
    const before = await f.products.getOverview({ productId });
    const saved = (await f.plans.getState({ productId })).saved!;
    const read = f.products.getOverview.bind(f.products);
    let raced = false;
    f.products.getOverview = async input => {
      const captured = await read(input);
      if (!raced) {
        raced = true;
        await f.products.trash({ requestId: "delete-race", productId, expectedRevision: captured.product.revision });
      }
      return captured;
    };
    await expect(f.plans.save({ requestId: "racing-save", productId, expectedPlanRevision: saved.revision, plan: saved.plan })).rejects.toThrow();
    f.products.getOverview = read;
    expect(() => f.runs.assertTaskIdle(f.link.taskId)).toThrow("请先恢复");
    await expect(f.runs.start({ ...f.input, requestId: "deleted-run" })).rejects.toThrow();
    expect(f.database.getTask(f.link.taskId)?.status).toBe("SPEC_APPROVED");
    expect(f.database.db.prepare("SELECT 1 FROM product_plan_receipts WHERE request_id=?").get("racing-save")).toBeUndefined();
    const deleted = (await f.products.list({ deleted: true })).items.find(p => p.id === productId)!;
    expect((await f.products.list()).items).toHaveLength(0);
    const restored = await f.products.restore({ requestId: "restore", productId, expectedRevision: deleted.revision });
    expect(restored.goal).toEqual(before.goal);
    expect(restored.product.confirmedGoalRevision).toBe(before.product.confirmedGoalRevision);
    expect((await f.plans.getState({ productId })).saved?.revision).toBe(saved.revision);
    expect(() => f.runs.assertTaskIdle(f.link.taskId)).not.toThrow();
  } finally { f.database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
