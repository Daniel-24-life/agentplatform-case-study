import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

const target = process.env.AGENTPLATFORM_PHASE28_UI_FIXTURE;

it.skipIf(!target)("prepares a registered isolated product progress UI fixture without real models", async () => {
  const root = readFileSync("docs/PHASE_1_28_EVIDENCE_ROOT.txt", "utf8").trim();
  const relative = path.relative(path.resolve(root), path.resolve(target!));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || existsSync(target!)) {
    throw new Error("Fresh registered evidence child required");
  }
  mkdirSync(target!, { recursive: true });
  const fixture = await createProductWorkflowFixture(target!);
  try {
    if (process.env.AGENTPLATFORM_PHASE28_UI_MODE === "approved") {
      expect(fixture.database.getTask(fixture.link.taskId)?.status).toBe("SPEC_APPROVED");
    } else {
      await fixture.runs.start(fixture.input);
      expect(await waitForProductRun(fixture)).toMatchObject({ status: "SUCCEEDED" });
      expect(fixture.database.getTask(fixture.link.taskId)?.status).toBe("PASSED");
    }
  } finally {
    fixture.database.close();
  }
  renameSync(path.join(target!, "app.db"), path.join(target!, "agentplatform.db"));
}, 30000);
