import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildQualificationPreregistration, evaluateCandidate, type QualificationSample } from "../../src/shared/core/control-plane-qualification";

const sample = (overrides: Partial<QualificationSample> = {}): QualificationSample => ({
  id: "case-01", candidate: "APP_SERVER", duration: 1000, authoritative: true, schema: true,
  semantic: true, integrity: true, fixtureClean: true, retry: 0, human: false,
  processConverged: true, stdioConverged: true, transportFallback: false, protocolAmbiguous: false,
  usage: { available: true }, accountAvailable: true, failureSymptom: null, axes: [], ...overrides,
});

describe("control-plane qualification", () => {
  it("qualifies a clean candidate and fixes runtime certification to NOT_RUN", () => {
    expect(evaluateCandidate("APP_SERVER", [sample()])).toMatchObject({ status: "QUALIFIED", runtimeCertification: "NOT_RUN", validSampleCount: 1 });
  });
  it("rejects fatal axes even when another sample passes", () => {
    expect(evaluateCandidate("APP_SERVER", [sample(), sample({ id: "bad", axes: ["PROTOCOL_OUTPUT"] })]).status).toBe("NOT_QUALIFIED");
  });
  it("blocks without valid evidence or when account availability is unavailable", () => {
    expect(evaluateCandidate("APP_SERVER", []).status).toBe("BLOCKED");
    expect(evaluateCandidate("APP_SERVER", [sample({ accountAvailable: false })]).status).toBe("BLOCKED");
    expect(evaluateCandidate("APP_SERVER", [sample({ usage: { available: false } })]).status).toBe("QUALIFIED");
  });
  it("keeps timeout as a symptom rather than inventing an axis", () => {
    const result = evaluateCandidate("APP_SERVER", [sample({ duration: 301_000, failureSymptom: "PROCESS_TIMEOUT" })]);
    expect(result.status).toBe("NOT_QUALIFIED");
    expect(sample({ failureSymptom: "PROCESS_TIMEOUT" }).axes).toEqual([]);
  });
  it("requires a fresh output path and caps ordered calls at four", () => {
    const root = mkdtempSync(path.join(tmpdir(), "qualification-"));
    const prepared = buildQualificationPreregistration({ outputPath: path.join(root, "new") });
    expect(prepared.order).toEqual(["APP_SERVER", "BOUNDED_EXEC"]);
    expect(() => buildQualificationPreregistration({ outputPath: root })).toThrow("QUALIFICATION_OUTPUT_PATH_NOT_FRESH");
    expect(() => buildQualificationPreregistration({ outputPath: path.join(root, "other"), calls: ["APP_SERVER", "BOUNDED_EXEC", "APP_SERVER", "BOUNDED_EXEC", "APP_SERVER"] })).toThrow("QUALIFICATION_CALL_LIMIT_EXCEEDED");
  });
});
