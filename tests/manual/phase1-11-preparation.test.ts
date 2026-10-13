import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPhase111Preparation } from "./phase1-11-end-to-end.js";

const enabled = process.env.PHASE1_11_PREPARE === "1";

describe.skipIf(!enabled)("Phase 1.11 zero-call controlled preparation", () => {
  it("creates only a fresh sealed disposable task fixture", () => {
    const sourceRoot = path.resolve(process.env.PHASE1_11_SOURCE_ROOT ?? "");
    const preparationRoot = path.join(sourceRoot, "phase1-11-evidence", "preparation-run1");
    expect(existsSync(preparationRoot)).toBe(false);
    const seal = createPhase111Preparation(sourceRoot, preparationRoot);
    expect(seal.real_model_calls).toBe(0);
    expect(seal.execution_authorized).toBe(false);
  });
});
