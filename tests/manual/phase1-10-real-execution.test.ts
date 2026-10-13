import { describe, expect, it } from "vitest";
import { executePhase110RealRun } from "./phase1-10-runtime-certification.js";

const enabled = process.env.RUN_PHASE1_10_RUNTIME === "1" && process.env.PHASE1_10_EXECUTION_APPROVAL === "I_APPROVE_10_REAL_CODEX_CALLS";

describe.skipIf(!enabled)("Phase 1.10 separately approved real Codex certification", () => {
  it("executes only the sealed ten-case registration", async () => {
    const result = await executePhase110RealRun();
    expect(result.status).toBe("PASS");
    expect(result.calls).toBeGreaterThanOrEqual(1);
    expect(result.calls).toBeLessThanOrEqual(10);
  }, 3_100_000);
});
