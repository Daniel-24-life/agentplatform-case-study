import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPhase110RunArtifacts } from "./phase1-10-runtime-certification.js";

const enabled = process.env.PHASE1_10_OFFLINE_VERIFY === "1";

describe.skipIf(!enabled)("Phase 1.10 closed run2 offline verification", () => {
  it("checks the sealed run2 artifacts without invoking Codex", () => {
    const sourceRoot = path.resolve(process.env.PHASE1_10_SOURCE_ROOT ?? "");
    const outputRoot = path.join(sourceRoot, "phase1-10-runtime-certification-run2");
    expect(verifyPhase110RunArtifacts(outputRoot)).toBe(true);
    const decision = JSON.parse(readFileSync(path.join(outputRoot, "run-decision.json"), "utf8")) as { status: string; calls: number; passed: number; failed: number };
    expect(decision).toMatchObject({ status: "FAIL", calls: 7, passed: 6, failed: 1 });
  });
});
