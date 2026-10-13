import { describe, expect, it } from "vitest";
import {
  BOUNDED_RUNTIME_CASE_IDS,
  BOUNDED_RUNTIME_CLEANUP_CEILING_MS,
  BOUNDED_RUNTIME_TIMEOUT_MS,
  evaluateBoundedRuntimeCertification,
  type BoundedRuntimeRegistration,
  type BoundedRuntimeSample,
} from "../../src/shared/core/bounded-runtime-certification.js";

const registration: BoundedRuntimeRegistration = { cases: BOUNDED_RUNTIME_CASE_IDS.map((id, index) => ({ id, order: index + 1 })), timeoutMs: BOUNDED_RUNTIME_TIMEOUT_MS, cleanupCeilingMs: BOUNDED_RUNTIME_CLEANUP_CEILING_MS, model: "gpt-5.6-sol", reasoning: "medium", retryCount: 0, humanInterventionCount: 0 };
const sample = (index: number, overrides: Partial<BoundedRuntimeSample> = {}): BoundedRuntimeSample => ({ id: BOUNDED_RUNTIME_CASE_IDS[index], order: index + 1, durationMs: 1000, cleanupDurationMs: 100, authoritativeTerminal: true, accountAvailable: true, protocolValid: true, transportClean: true, schemaValid: true, semanticValid: true, fixtureClean: true, baseShaValid: true, processConverged: true, stdioConverged: true, hashesValid: true, retryCount: 0, humanIntervention: false, usageAvailable: false, ...overrides });
const allSamples = (): BoundedRuntimeSample[] => BOUNDED_RUNTIME_CASE_IDS.map((_, index) => sample(index));

describe("bounded runtime certification", () => {
  it("passes exactly ten ordered clean cases and does not require usage", () => {
    const result = evaluateBoundedRuntimeCertification({ registration, samples: allSamples() });
    expect(result.status).toBe("PASS");
    expect(result.passedCaseCount).toBe(10);
  });
  it("distinguishes no run and missing cases", () => {
    expect(evaluateBoundedRuntimeCertification({ registration, samples: [] }).status).toBe("NOT_RUN");
    expect(evaluateBoundedRuntimeCertification({ registration, samples: allSamples().slice(0, 9) }).status).toBe("BLOCKED");
  });
  it.each([
    ["authoritativeTerminal", false], ["schemaValid", false], ["semanticValid", false], ["fixtureClean", false], ["baseShaValid", false],
    ["processConverged", false], ["stdioConverged", false], ["hashesValid", false], ["humanIntervention", true],
  ] as const)("fails on a single %s defect", (field, value) => {
    const result = evaluateBoundedRuntimeCertification({ registration, samples: allSamples().map((item, index) => index === 0 ? { ...item, [field]: value } : item) });
    expect(result.status).toBe("FAIL");
  });
  it("treats timeout as failure even after cleanup converges", () => {
    const result = evaluateBoundedRuntimeCertification({ registration, samples: allSamples().map((item, index) => index === 0 ? { ...item, durationMs: BOUNDED_RUNTIME_TIMEOUT_MS + 1 } : item) });
    expect(result.status).toBe("FAIL");
    expect(result.cases[0].reasons).toContain("PROCESS_TIMEOUT");
  });
  it.each([
    ["cleanupDurationMs", BOUNDED_RUNTIME_CLEANUP_CEILING_MS + 1],
    ["protocolValid", false],
    ["transportClean", false],
    ["durationMs", -1],
  ] as const)("fails on bounded runtime evidence defect %s", (field, value) => {
    const result = evaluateBoundedRuntimeCertification({ registration, samples: allSamples().map((item, index) => index === 0 ? { ...item, [field]: value } : item) });
    expect(result.status).toBe("FAIL");
  });
  it("keeps an early fatal result as FAIL when later cases are not run", () => {
    const result = evaluateBoundedRuntimeCertification({ registration, samples: [sample(0, { schemaValid: false })] });
    expect(result.status).toBe("FAIL");
  });
  it("never passes duplicate or unknown samples", () => {
    const duplicate = [...allSamples(), sample(0)];
    expect(evaluateBoundedRuntimeCertification({ registration, samples: duplicate }).status).toBe("BLOCKED");
    const unknown = [...allSamples(), { ...sample(0), id: "P16-ARCH-UNKNOWN" }];
    expect(evaluateBoundedRuntimeCertification({ registration, samples: unknown }).status).toBe("BLOCKED");
  });
  it("blocks a sample with only preregistration drift or account unavailability", () => {
    expect(evaluateBoundedRuntimeCertification({ registration, samples: allSamples().map((item, index) => index === 0 ? { ...item, failureAxes: ["PREREGISTRATION_DRIFT"] } : item) }).status).toBe("BLOCKED");
    expect(evaluateBoundedRuntimeCertification({ registration, samples: allSamples().map((item, index) => index === 0 ? { ...item, accountAvailable: false } : item) }).status).toBe("BLOCKED");
  });
  it("rejects registration order, duplicates, retries and nonzero intervention", () => {
    const bad: BoundedRuntimeRegistration = { ...registration, cases: [...registration.cases].reverse(), retryCount: 1, humanInterventionCount: 1 };
    const result = evaluateBoundedRuntimeCertification({ registration: bad, samples: allSamples() });
    expect(result.status).toBe("BLOCKED");
    expect(result.failureAxes).toContain("PREREGISTRATION_DRIFT");
  });
  it("rejects missing or drifted fixed runtime registration settings", () => {
    const missing = { ...registration } as unknown as Partial<BoundedRuntimeRegistration>;
    delete missing.model;
    const missingResult = evaluateBoundedRuntimeCertification({ registration: missing as BoundedRuntimeRegistration, samples: allSamples() });
    expect(missingResult.status).toBe("BLOCKED");
    expect(missingResult.reasons).toContain("REGISTRATION_MODEL_INVALID");
    const drifted = { ...registration, cleanupCeilingMs: 9_999, model: "gpt-5.5", reasoning: "low" as const };
    const driftedResult = evaluateBoundedRuntimeCertification({ registration: drifted, samples: allSamples() });
    expect(driftedResult.status).toBe("BLOCKED");
    expect(driftedResult.reasons).toEqual(expect.arrayContaining(["REGISTRATION_CLEANUP_CEILING_INVALID", "REGISTRATION_MODEL_INVALID", "REGISTRATION_REASONING_INVALID"]));
  });
});
