import { describe, expect, it } from "vitest";
import { executePhase111RealRun } from "./phase1-11-end-to-end.js";

describe.skipIf(process.env.RUN_PHASE1_11_RUN2 !== "1")("Phase 1.11 separately approved run2 end-to-end acceptance", () => {
  it("runs only the new sealed run2 task through the trusted execution loop", async () => {
    const result = await executePhase111RealRun(process.env, "run2");
    expect(result).toMatchObject({ status: "PASS", taskStatus: "PASSED", modelCalls: 3 });
  }, 33 * 60 * 1000);
});
