import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";
it("takes an approved product plan through real Git, fake CLI, platform TestRun and final gate", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-product-loop-"));
  const fixture = await createProductWorkflowFixture(root);
  try {
    const started = await fixture.runs.start(fixture.input);
    expect(await fixture.runs.start(fixture.input)).toMatchObject({ id: started.id });
    const finished = await waitForProductRun(fixture);
    if (finished.status !== "SUCCEEDED") console.log({ finished, task: fixture.database.getTask(fixture.link.taskId), runs: fixture.database.listTaskRuns(fixture.link.taskId) });
    expect(finished).toMatchObject({ status: "SUCCEEDED", reservedModelCalls: 2 });
    const detail = fixture.orchestrator.detail(fixture.link.taskId);
    expect(detail.task.status).toBe("PASSED"); expect(detail.snapshot?.gate?.passed).toBe(true);
    expect(detail.snapshot?.tests?.every(test => test.result.status === "SUCCEEDED")).toBe(true);
    expect(detail.snapshot?.final?.verdict).toBe("PASS");
    expect(detail.runs.filter(run => run.adapter !== "test-runner")).toHaveLength(3);
    expect((await fixture.git.inspect(fixture.repo)).clean).toBe(true);
  } finally { fixture.database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
