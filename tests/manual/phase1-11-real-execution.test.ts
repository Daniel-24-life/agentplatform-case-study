import { describe, expect, it } from "vitest";
import { executePhase111RealRun } from "./phase1-11-end-to-end.js";

describe.skipIf(process.env.RUN_PHASE1_11 !== "1")("Phase 1.11 separately approved real end-to-end acceptance", () => {
  it("runs only the sealed approved task through the trusted execution loop", async () => {
    const result = await executePhase111RealRun();
    expect(result).toMatchObject({ status: "PASS", taskStatus: "PASSED", modelCalls: 3 });
  }, 33 * 60 * 1000);
});
