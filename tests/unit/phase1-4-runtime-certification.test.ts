import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertFreshPhase14Output,
  assertPhase14OptIn,
  assertPhase14PrepareOptIn,
  buildPhase14RequestTelemetry,
  buildPhase14CanaryPreregistration,
  classifyPhase14Failure,
  capturePhase14TreeEvidence,
  createPhase14SourceSnapshot,
  evaluatePhase14Canary,
  evaluatePhase14Certification,
  hasExplicitPhase14TransportError,
  isPhase14CertificationSampleId,
  isPhase14IsolationCallAllowed,
  PHASE14_BOUNDED_CLEANUP_SECONDS,
  PHASE14_CANARY_TIMEOUT_SECONDS,
  PHASE14_CERTIFICATION_CASE_COUNT,
  PHASE14_CERTIFICATION_CASE_IDS,
  PHASE14_ISOLATION_CALL_LIMIT,
  PHASE14_ISOLATION_MATRIX,
  PHASE14_PROTOCOL_VERSION,
  summarizePhase14Process,
  runPhase14Certification,
  runPhase14Isolation,
  type Phase14Sample
} from "../../src/shared/core/runtime-certification.js";
import { sha256Text } from "../../src/shared/core/runtime-stability.js";

const roots: string[] = [];
const tempRoot = (): string => {
  const value = mkdtempSync(path.join(os.tmpdir(), "phase14-certification-test-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const request = buildPhase14RequestTelemetry({ prompt: "read-only prompt", schema: "{\"type\":\"object\"}", preparedContext: "README.md\ncontent" });

const process = summarizePhase14Process({
  events: [
    { name: "spawn", atMs: 0 },
    { name: "response.completed", atMs: 100 },
    { name: "turn.completed", atMs: 150 },
    { name: "stdio teardown", atMs: 200 }
  ],
  stdout: "{\"type\":\"response.completed\"}\n{\"type\":\"turn.completed\"}",
  knownPids: [123],
  remainingKnownPids: [],
  terminalResultPersisted: true,
  evidencePersisted: true
});

const sample = (changes: Partial<Phase14Sample> = {}): Phase14Sample => ({
  protocolVersion: PHASE14_PROTOCOL_VERSION,
  track: "CERTIFICATION",
  id: "P14-CERT-01",
  order: 1,
  runtimeLabel: "codex-cli-0.151.0",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  executablePath: "C:/codex/codex.exe",
  executableSha256: "a".repeat(64),
  cliVersion: "codex-cli 0.151.0",
  complete: true,
  protocolValid: true,
  semanticValid: true,
  integrityValid: true,
  fixtureClean: true,
  durationMs: 1000,
  outerWallClockMs: 1000,
  childProcessDurationMs: 900,
  retryCount: 0,
  fallbackCount: 0,
  humanIntervention: false,
  usage: null,
  request,
  process,
  failureSymptom: "NONE",
  failureAxes: [],
  failureCode: null,
  ...changes
});

describe("Phase 1.4 runtime certification protocol", () => {
  it("freezes the canary, cleanup, certification and isolation limits", () => {
    expect(PHASE14_PROTOCOL_VERSION).toBe("phase1-4-runtime-certification-v1");
    expect(PHASE14_CANARY_TIMEOUT_SECONDS).toBe(900);
    expect(PHASE14_BOUNDED_CLEANUP_SECONDS).toBe(10);
    expect(PHASE14_CERTIFICATION_CASE_COUNT).toBe(10);
    expect(PHASE14_CERTIFICATION_CASE_IDS).toEqual([
      "P14-CERT-01", "P14-CERT-02", "P14-CERT-03", "P14-CERT-04", "P14-CERT-05",
      "P14-CERT-06", "P14-CERT-07", "P14-CERT-08", "P14-CERT-09", "P14-CERT-10"
    ]);
    expect(PHASE14_ISOLATION_CALL_LIMIT).toBe(8);
    expect(PHASE14_ISOLATION_MATRIX.map((item) => item.id)).toEqual(["I-01", "I-02", "I-03", "I-04"]);
    expect(PHASE14_ISOLATION_MATRIX.every((item) => item.fixed.includes("machine") && item.fixed.includes("promptSha256"))).toBe(true);
  });

  it("records exact request byte/hash telemetry", () => {
    expect(request.promptBytes).toBe(Buffer.byteLength("read-only prompt", "utf8"));
    expect(request.schemaBytes).toBe(Buffer.byteLength("{\"type\":\"object\"}", "utf8"));
    expect(request.contextBytes).toBe(Buffer.byteLength("README.md\ncontent", "utf8"));
    expect(request.promptSha256).toBe(sha256Text("read-only prompt"));
    expect(request.schemaSha256).toBe(sha256Text("{\"type\":\"object\"}"));
    expect(request.contextSha256).toBe(sha256Text("README.md\ncontent"));
  });

  it("freezes an allowlisted source snapshot and records canonical tree/package-lock evidence", () => {
    const root = tempRoot();
    const source = path.join(root, "checkout");
    mkdirSync(path.join(source, "src"), { recursive: true });
    mkdirSync(path.join(source, "tests"), { recursive: true });
    mkdirSync(path.join(source, "docs"), { recursive: true });
    mkdirSync(path.join(source, "node_modules", "ignored"), { recursive: true });
    mkdirSync(path.join(source, "phase1-3-evidence", "ignored"), { recursive: true });
    writeFileSync(path.join(source, "src", "main.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(path.join(source, "tests", "main.test.ts"), "test('ok', () => undefined);\n", "utf8");
    writeFileSync(path.join(source, "docs", "notes.md"), "notes\n", "utf8");
    writeFileSync(path.join(source, "package.json"), "{}\n", "utf8");
    writeFileSync(path.join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(path.join(source, "node_modules", "ignored", "secret.txt"), "must not copy\n", "utf8");
    writeFileSync(path.join(source, "phase1-3-evidence", "ignored", "historical.txt"), "must not copy\n", "utf8");
    const snapshot = createPhase14SourceSnapshot({ sourceRoot: source, snapshotRoot: path.join(root, "phase1-4-source-snapshot") });
    expect(snapshot.gitHeadStatus).toBe("UNAVAILABLE_NO_GIT");
    expect(snapshot.gitHead).toBeNull();
    expect(snapshot.tree.algorithmVersion).toBe("agentplatform-tree-sha256-v1");
    expect(snapshot.tree.fileCount).toBe(5);
    expect(snapshot.tree.byteCount).toBeGreaterThan(0);
    expect(snapshot.packageLockSha256).toHaveLength(64);
    expect(snapshot.packageLockBytes).toBe(Buffer.byteLength("lockfileVersion: '9.0'\n", "utf8"));
    expect(existsSync(path.join(snapshot.sourceRoot, "node_modules"))).toBe(false);
    expect(existsSync(path.join(snapshot.sourceRoot, "phase1-3-evidence"))).toBe(false);
    expect(readFileSync(path.join(snapshot.snapshotRoot, "snapshot-manifest.json"), "utf8")).toContain("UNAVAILABLE_NO_GIT");
    expect(capturePhase14TreeEvidence(snapshot.sourceRoot).digest).toBe(snapshot.tree.digest);
  });

  it("copies the canonical tree evidence into the canary preregistration", () => {
    const prereg = buildPhase14CanaryPreregistration({
      canaryId: "P14-CANARY-01",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      baseSha: "a".repeat(40),
      fixtureTree: { algorithmVersion: "agentplatform-tree-sha256-v1", digest: "b".repeat(64), fileCount: 2, byteCount: 10 },
      request
    });
    expect(prereg.fixtureTree).toEqual({ algorithmVersion: "agentplatform-tree-sha256-v1", digest: "b".repeat(64), fileCount: 2, byteCount: 10 });
    expect(prereg.request).toEqual(request);
    expect(prereg.productionAdapter).toBe("CodexAdapter.runPlanner");
    expect(prereg.noRetry).toBe(true);
  });

  it("summarizes event gaps, completion markers, teardown and PID convergence", () => {
    expect(process.lastEvent).toBe("stdio teardown");
    expect(process.lastEventAtMs).toBe(200);
    expect(process.largestInterEventGapMs).toBe(100);
    expect(process.responseCompleted).toBe(true);
    expect(process.turnCompleted).toBe(true);
    expect(process.stdioTeardown).toBe(true);
    expect(process.processTreeConverged).toBe(true);
    expect(process.knownPids).toEqual([123]);
    expect(process.remainingKnownPids).toEqual([]);
    const closed = summarizePhase14Process({ process: { status: "SUCCEEDED", exitCode: 0, stdout: "", stderr: "", stdoutSha256: "a", stderrSha256: "b", durationMs: 123, startedAtMs: 0, endedAtMs: 123, closeObserved: true, stdoutClosed: true, stderrClosed: true }, terminalResultPersisted: true, evidencePersisted: true });
    expect(closed.stdioTeardown).toBe(true);
    expect(closed.stdioTeardownAtMs).toBe(123);
  });

  it("does not infer transport failure from timeout text alone", () => {
    expect(hasExplicitPhase14TransportError("request timeout after 900s", "")).toBe(false);
    expect(hasExplicitPhase14TransportError("websocket connection failed", "")).toBe(true);
  });

  it("assigns independent failure axes and keeps timeout as a symptom", () => {
    const classified = classifyPhase14Failure({
      symptom: "PROCESS_TIMEOUT",
      process: { processTreeConverged: true, terminalResultPersisted: true, evidencePersisted: true, stdioTeardown: true, remainingKnownPids: [] },
      codex: { responseCompleted: false, turnCompleted: false, terminal: false },
      transport: { failed: true, reconnectCount: 2, fallbackCount: 1 },
      protocol: { terminalOutput: false, schemaValid: false, semanticValid: false, integrityValid: true }
    });
    expect(classified.symptom).toBe("PROCESS_TIMEOUT");
    expect(classified.axes).toEqual(["CODEX_EXEC_COMPLETION", "TRANSPORT_SIGNAL"]);
    expect(classified.axes).not.toEqual(["PROCESS_TIMEOUT"]);

    const processFailure = classifyPhase14Failure({
      symptom: "PROCESS_TIMEOUT",
      process: { processTreeConverged: false, terminalResultPersisted: false, evidencePersisted: false, stdioTeardown: false, remainingKnownPids: [123] },
      codex: { responseCompleted: false, turnCompleted: false, terminal: false },
      transport: { failed: false },
      protocol: { terminalOutput: false, schemaValid: false, semanticValid: false, integrityValid: false }
    });
    expect(processFailure.axes).toContain("PLATFORM_PROCESS_CONTROL");
    expect(processFailure.axes).toContain("CODEX_EXEC_COMPLETION");

    const turnOnly = classifyPhase14Failure({
      symptom: "NONE",
      process: { processTreeConverged: true, terminalResultPersisted: true, evidencePersisted: true, stdioTeardown: true, remainingKnownPids: [] },
      codex: { responseCompleted: false, turnCompleted: true, terminal: true },
      transport: { failed: false },
      protocol: { terminalOutput: true, schemaValid: true, semanticValid: true, integrityValid: true }
    });
    expect(turnOnly.axes).toEqual([]);

    const semanticOnly = classifyPhase14Failure({
      symptom: "OUTPUT_INVALID",
      process: { processTreeConverged: true, terminalResultPersisted: true, evidencePersisted: true, stdioTeardown: true, remainingKnownPids: [] },
      codex: { responseCompleted: false, turnCompleted: true, terminal: false },
      transport: { failed: false },
      protocol: { terminalOutput: true, schemaValid: true, semanticValid: false, integrityValid: true }
    });
    expect(semanticOnly.axes).toEqual(["PROTOCOL_OUTPUT"]);
  });

  it("allows isolation only after the bounded canary qualifies", () => {
    const pass = evaluatePhase14Canary(sample({ track: "CANARY", id: "P14-CANARY-01", process }));
    expect(pass).toMatchObject({ status: "PASS", qualifiesForIsolation: true, boundedConvergence: true, wallClockWithinBound: true });
    expect(evaluatePhase14Canary(sample({ track: "CANARY", id: "P14-CANARY-01", durationMs: 910_001 })).qualifiesForIsolation).toBe(false);
    expect(evaluatePhase14Canary(sample({ track: "CANARY", id: "P14-CANARY-01", process: { ...process, remainingKnownPids: [99], processTreeConverged: false } })).status).toBe("FAIL");
  });

  it("requires a fresh independent ten-case certification", () => {
    const ten = PHASE14_CERTIFICATION_CASE_IDS.map((id, index) => sample({ id, order: index + 1 }));
    expect(evaluatePhase14Certification(ten)).toMatchObject({ status: "PASS", validCaseCount: 10, caseCount: 10 });
    expect(evaluatePhase14Certification(ten.map((item, index) => index === 0 ? { ...item, protocolValid: false } : item)).status).toBe("FAIL");
    expect(evaluatePhase14Certification(ten.slice(0, 9)).status).toBe("BLOCKED");
    expect(evaluatePhase14Certification(ten.map((item, index) => index === 0 ? { ...item, durationMs: 600_001, failureSymptom: "PROCESS_TIMEOUT", failureAxes: ["CODEX_EXEC_COMPLETION"] } : item))).toMatchObject({ status: "FAIL", timedOutCount: 1 });
    expect(isPhase14CertificationSampleId("P14-CERT-01")).toBe(true);
    expect(isPhase14CertificationSampleId("P13-ARCH-01")).toBe(false);
  });

  it("enforces the eight-call isolation cap", () => {
    expect(isPhase14IsolationCallAllowed(0)).toBe(true);
    expect(isPhase14IsolationCallAllowed(PHASE14_ISOLATION_CALL_LIMIT - 1)).toBe(true);
    expect(isPhase14IsolationCallAllowed(PHASE14_ISOLATION_CALL_LIMIT)).toBe(false);
  });

  it("does not launch isolation or certification before their gates", async () => {
    let calls = 0;
    const execute = async (): Promise<Phase14Sample> => {
      calls += 1;
      return sample({ track: "ISOLATION", id: "I-01" });
    };
    const isolation = await runPhase14Isolation({ canary: evaluatePhase14Canary(sample({ track: "CANARY", id: "P14-CANARY-01", process: { ...process, processTreeConverged: false } })), execute });
    expect(isolation.samples).toHaveLength(0);
    expect(isolation.stopReason).toMatch(/canary/);
    expect(calls).toBe(0);
    const certification = await runPhase14Certification({ candidateQualified: false, execute });
    expect(certification.started).toBe(false);
    expect(certification.samples).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it("requires explicit opt-in and refuses sealed or reused outputs", () => {
    expect(() => assertPhase14OptIn({})).toThrow(/RUN_PHASE1_4_RUNTIME/);
    expect(() => assertPhase14PrepareOptIn({})).toThrow(/RUN_PHASE1_4_PREPARE/);
    const root = tempRoot();
    const output = path.join(root, "phase1-4-runtime-canary-run1");
    expect(assertFreshPhase14Output(output)).toBe(output);
    expect(() => assertFreshPhase14Output(output)).toThrow(/already exists/);
    for (const sealed of ["phase1-2-evidence", "phase1-3-evidence", "phase1-3-runtime-stability-run1", "run6", "run11"]) {
      expect(() => assertFreshPhase14Output(path.join(root, sealed, "new-run"))).toThrow(/sealed|historical/);
    }
    expect(assertPhase14OptIn({ RUN_PHASE1_4_RUNTIME: "1", PHASE1_4_OUTPUT: path.join(root, "phase1-4-runtime-canary-run1") })).toEqual({ outputPath: output });
  });
});
