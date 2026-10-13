import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

const target = process.env.AGENTPLATFORM_PHASE34_UI_FIXTURE;
it.skipIf(!target)("prepares a registered offline historical-metrics UI fixture", async () => {
  const root = readFileSync("docs/PHASE_1_34_EVIDENCE_ROOT.txt", "utf8").trim();
  const relative = path.relative(path.resolve(root), path.resolve(target!));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || existsSync(target!)) throw Error("Fresh registered evidence child required");
  mkdirSync(target!, { recursive: true });
  const f = await createProductWorkflowFixture(target!, { staticWeb: true });
  try {
    await f.runs.start(f.input);
    const completed = await waitForProductRun(f);
    expect(completed).toMatchObject({ status: "SUCCEEDED", reservedModelCalls: 2, usedModelCalls: 2, maxModelCalls: 2 });
    // Simulated report gaps stay inside this registered offline fixture.
    f.database.db.prepare("UPDATE runs SET usage_json=NULL WHERE stage='reviewer'").run();
    f.database.db.prepare("UPDATE runs SET usage_json=? WHERE stage='builder'").run(JSON.stringify({ inputTokens: 0 }));
    f.database.db.prepare("UPDATE runs SET usage_json=? WHERE adapter='test-runner'").run(JSON.stringify({ inputTokens: 99999 }));
    f.database.db.prepare("UPDATE runs SET duration_ms=50 WHERE adapter!='test-runner'").run();
    const metrics = await f.products.getMetrics({ productId: f.input.productId });
    expect(metrics).toMatchObject({ taskCount: 1, passedTaskCount: 1, technicalCompletionRate: 1, keyConfirmationCount: 3, attemptCount: 1, repairAttemptCount: 0, failedAttemptCount: 0, runCount: 4, agentRunCount: 3, usageAvailableRuns: 2, usageCoverage: 2 / 3, inputTokens: 10, outputTokens: 10, totalTokens: null });
    const taskMetrics = f.database.taskRunMetrics(f.link.taskId);
    expect(taskMetrics).toMatchObject({ inputTokens: 10, outputTokens: 10, totalTokens: null, usageAvailableRuns: 2, agentRunCount: 3 });
    const empty = await f.products.create({ requestId: "empty-metrics", name: "无任务指标夹具", initialRequest: "Offline empty metrics fixture" });
    expect(await f.products.getMetrics({ productId: empty.product.id })).toMatchObject({ taskCount: 0, technicalCompletionRate: null, recordedDurationMs: null, usageCoverage: null, inputTokens: null });
    const audits = f.database.db.prepare("SELECT kind,path FROM artifacts WHERE kind IN ('read-only-input','read-only-audit')").all();
    expect(audits).toHaveLength(4);
    const sources = f.database.db.prepare("SELECT product_run_action_id FROM runs WHERE stage IN ('builder','reviewer')").all();
    expect(sources).toHaveLength(2);
    expect(sources.every(row => row.product_run_action_id === completed.id)).toBe(true);
  } finally { f.database.close(); }
  renameSync(path.join(target!, "app.db"), path.join(target!, "agentplatform.db"));
}, 30000);
