import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

const target = process.env.AGENTPLATFORM_PHASE32_UI_FIXTURE;
it.skipIf(!target)("prepares a registered offline static-preview UI fixture", async () => {
  const root = readFileSync("docs/PHASE_1_32_EVIDENCE_ROOT.txt", "utf8").trim();
  const relative = path.relative(path.resolve(root), path.resolve(target!));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || existsSync(target!)) throw Error("Fresh registered evidence child required");
  mkdirSync(target!, { recursive: true });
  const f = await createProductWorkflowFixture(target!, { staticWeb: true });
  try {
    await f.runs.start(f.input);
    const completed = await waitForProductRun(f);
    expect(completed).toMatchObject({ status: "SUCCEEDED", reservedModelCalls: 2, usedModelCalls: 2, maxModelCalls: 2 });
    const sources = f.database.db.prepare("SELECT product_run_action_id FROM runs WHERE stage IN ('builder','reviewer')").all();
    expect(sources).toHaveLength(2);
    expect(sources.every(row => row.product_run_action_id === completed.id)).toBe(true);
  } finally { f.database.close(); }
  renameSync(path.join(target!, "app.db"), path.join(target!, "agentplatform.db"));
}, 30000);
