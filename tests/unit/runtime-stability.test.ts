import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFreshPhase13Output,
  assertPhase13OptIn,
  captureFixtureIntegrity,
  CANONICAL_TREE_HASH_VERSION,
  collectEvidenceFiles,
  evaluateRuntimeStability,
  hashCaseDefinition,
  materializeCasePrompt,
  parseTransportObservation,
  phase13RuntimeCases,
  PHASE13_PARSER_VERSION,
  PHASE13_EXPECTED_BASE_SHA,
  PHASE13_FIXTURE_COMMIT_DATE,
  shouldStopRuntimeRun,
  sha256Text,
  hashDirectory,
  validateReadOnlyArchitectResponse,
  type RuntimeSample
} from "../../src/shared/core/runtime-stability.js";

const roots: string[] = [];
const tempRoot = (): string => { const root = mkdtempSync(path.join(os.tmpdir(), "phase13-runtime-test-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sample = (order: number, changes: Partial<RuntimeSample> = {}): RuntimeSample => ({
  id: phase13RuntimeCases[order - 1].id,
  order,
  complete: true,
  durationMs: 10,
  protocolValid: true,
  semanticValid: true,
  integrityValid: true,
  transport: { parserVersion: PHASE13_PARSER_VERSION, reconnectCount: 0, fallbackCount: 0, status: "CLEAN", evidence: [] },
  failureCode: null,
  failureClass: "none",
  fatal: false,
  retryCount: 0,
  humanIntervention: false,
  usage: null,
  artifactHashes: {},
  ...changes
});

describe("Phase 1.3 runtime stability definitions", () => {
  it("freezes exactly ten new cases in a 3/4/3 order", () => {
    expect(phase13RuntimeCases).toHaveLength(10);
    expect(phase13RuntimeCases.map((item) => item.id)).toEqual(["P13-ARCH-01", "P13-ARCH-02", "P13-ARCH-03", "P13-ARCH-04", "P13-ARCH-05", "P13-ARCH-06", "P13-ARCH-07", "P13-ARCH-08", "P13-ARCH-09", "P13-ARCH-10"]);
    expect(phase13RuntimeCases.slice(0, 3).every((item) => item.kind === "context_synthesis")).toBe(true);
    expect(phase13RuntimeCases.slice(3, 7).every((item) => item.kind === "cross_file_reasoning")).toBe(true);
    expect(phase13RuntimeCases.slice(7).every((item) => item.kind === "evidence_risk_report")).toBe(true);
    expect(new Set(phase13RuntimeCases.map((item) => item.id)).size).toBe(10);
    expect(phase13RuntimeCases.flatMap((item) => item.fixtureFiles).some((file) => /DEV_|HOLDOUT_|PATH_REPORT/.test(file))).toBe(false);
    expect(PHASE13_EXPECTED_BASE_SHA).toBe("1967975557059b69010fdb35254b601c314c75a6");
    expect(PHASE13_FIXTURE_COMMIT_DATE).toBe("2000-01-01T00:00:00Z");
  });

  it("keeps case-definition and materialized prompt hashes as separate evidence", () => {
    const item = phase13RuntimeCases[0];
    const prompt = materializeCasePrompt(item, PHASE13_EXPECTED_BASE_SHA);
    expect(hashCaseDefinition(item)).not.toBe(hashCaseDefinition({ ...item, prompt }));
    expect(sha256Text(prompt)).toBe("1e003db08a70830d8ed6f280e42b5f95568c1ce66b998a3239ec489b33a64a06");
  });

  it("requires explicit opt-in and refuses reused or historical output", () => {
    expect(() => assertPhase13OptIn({})).toThrow(/RUN_PHASE1_3_RUNTIME/);
    const root = tempRoot();
    const output = path.join(root, "phase1-3-runtime-stability-run1");
    expect(assertFreshPhase13Output(output)).toBe(output);
    expect(() => assertFreshPhase13Output(output)).toThrow(/already exists/);
    for (const historical of ["phase1-2-evidence", "phase1-1-evidence", "phase1-3-evidence", "phase1-ab-artifacts-run6", "phase1-1-ab-artifacts-run1", "phase1-2-ab-holdout-run1", "phase1-runtime-preflight-2026", "run6", "run11"]) {
      expect(() => assertFreshPhase13Output(path.join(root, historical, "new-run"))).toThrow(/sealed|historical/);
    }
  });

  it("parses explicit reconnect and WebSocket to HTTPS fallback signals only", () => {
    const clean = parseTransportObservation("completed in 900000ms", "");
    expect(clean.status).toBe("CLEAN");
    const degraded = parseTransportObservation("Reconnecting (2/5)\nWebSocket connection failed; falling back to HTTPS", "");
    expect(degraded).toMatchObject({ status: "DEGRADED", reconnectCount: 1, fallbackCount: 1, parserVersion: PHASE13_PARSER_VERSION });
    expect(degraded.evidence).toHaveLength(2);
  });

  it("rejects protocol and read-only semantic violations", () => {
    const item = phase13RuntimeCases[0];
    const baseSha = "a".repeat(40);
    const valid = {
      schema_version: "2.0", task_id: item.id, title: "Read-only analysis", goal: "Summarize the evidence without changing the repository.", base_sha: baseSha,
      context_paths: item.contextPaths, scope: { allowed_paths: ["README.md"], forbidden_paths: [".git/**"] },
      acceptance_criteria: [{ id: "AC-01", text: "References the evidence." }], test_commands: [{ id: "check", program: "rg", args: ["evidence", "README.md"], cwd: ".", timeout_seconds: 60, required: true }],
      execution_policy: { planner_recommendation: "strong", planner_confidence: "medium", recommendation_reasons: ["read-only synthesis"], user_lock: null }, limits: { max_attempts: 1, run_timeout_seconds: 600, max_changed_files: 1, max_diff_bytes: 1024 }
    };
    expect(validateReadOnlyArchitectResponse(valid, item, baseSha, item.fixtureFiles).valid).toBe(true);
    expect(validateReadOnlyArchitectResponse({ ...valid, goal: "No Worker is involved; do not edit any file." }, item, baseSha, item.fixtureFiles).valid).toBe(true);
    expect(validateReadOnlyArchitectResponse({ ...valid, goal: "Create an analysis of the read-only evidence" }, item, baseSha, item.fixtureFiles).valid).toBe(true);
    expect(validateReadOnlyArchitectResponse({ ...valid, goal: "Edit the repository" }, item, baseSha, item.fixtureFiles).valid).toBe(false);
    expect(validateReadOnlyArchitectResponse({ ...valid, base_sha: "b".repeat(40) }, item, baseSha, item.fixtureFiles).issues).toContain("base_sha does not match frozen fixture SHA");
    expect(validateReadOnlyArchitectResponse({ ...valid, context_paths: ["README.md"] }, item, baseSha, item.fixtureFiles).issues).toContain("missing preregistered context path: docs/operations.md");
    for (const args of [["status"], ["status", "--short"], ["diff", "--exit-code"], ["rev-parse", "HEAD"]]) {
      expect(validateReadOnlyArchitectResponse({ ...valid, test_commands: [{ ...valid.test_commands[0], program: "git", args }] }, item, baseSha, item.fixtureFiles).valid).toBe(true);
    }
    expect(validateReadOnlyArchitectResponse({ ...valid, test_commands: [{ ...valid.test_commands[0], program: "git", args: ["diff", "--exit-code", baseSha, "--", ...item.fixtureFiles] }] }, item, baseSha, item.fixtureFiles).valid).toBe(true);
    expect(validateReadOnlyArchitectResponse({ ...valid, test_commands: [{ ...valid.test_commands[0], program: "git", args: ["commit", "-m", "x"] }] }, item, baseSha, item.fixtureFiles).valid).toBe(false);
  });

  it("applies preregistered runtime decision thresholds and stop rules", () => {
    const cleanSamples = Array.from({ length: 10 }, (_, index) => sample(index + 1));
    expect(evaluateRuntimeStability({ preflightPassed: true, samples: cleanSamples }).status).toBe("PASS");
    expect(evaluateRuntimeStability({ preflightPassed: true, samples: cleanSamples.slice(0, 9) }).status).toBe("BLOCKED");
    expect(evaluateRuntimeStability({ preflightPassed: true, samples: cleanSamples.map((entry, index) => index === 0 ? { ...entry, durationMs: 601_000, transport: { ...entry.transport, status: "DEGRADED", reconnectCount: 1, evidence: [{ signal: "reconnect" as const, line: 1, hash: "a", text: "Reconnecting" }] } } : entry) }).status).toBe("PARTIAL");
    expect(evaluateRuntimeStability({ preflightPassed: true, samples: cleanSamples.map((entry) => ({ ...entry, fatal: true, failureClass: "transport/runtime" as const })) }).status).toBe("FAIL");
    expect(shouldStopRuntimeRun([sample(1, { fatal: true }), sample(2, { fatal: true })], sample(2, { fatal: true })).stop).toBe(true);
    expect(shouldStopRuntimeRun([sample(1, { failureClass: "write/integrity", integrityValid: false, fatal: true })], sample(1, { failureClass: "write/integrity", integrityValid: false, fatal: true })).stop).toBe(true);
  });

  it("records and verifies frozen HEAD independently from tree and Git cleanliness", async () => {
    const root = tempRoot();
    const file = path.join(root, "evidence.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "stable\n", "utf8");
    const matching = await captureFixtureIntegrity(root, async () => "", async () => "", async () => "abc", "abc");
    expect(matching.headSha).toBe("abc");
    expect(matching.headMatchesBaseSha).toBe(true);
    const drifted = await captureFixtureIntegrity(root, async () => "", async () => "", async () => "def", "abc");
    expect(drifted.clean).toBe(false);
    expect(drifted.headMatchesBaseSha).toBe(false);
  });

  it("uses a versioned, slash-normalized, locale-independent tree hash", async () => {
    const root = tempRoot();
    const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
    mkdirSync(path.join(root, "z"));
    writeFileSync(path.join(root, "z", "b.txt"), Buffer.from([0, 1, 255]));
    writeFileSync(path.join(root, "a.txt"), "a", "utf8");
    expect(CANONICAL_TREE_HASH_VERSION).toBe("agentplatform-tree-sha256-v1");
    const first = hashDirectory(root);
    const reordered = tempRoot();
    mkdirSync(path.join(reordered, "z"));
    writeFileSync(path.join(reordered, "a.txt"), "a", "utf8");
    writeFileSync(path.join(reordered, "z", "b.txt"), Buffer.from([0, 1, 255]));
    expect(hashDirectory(reordered)).toBe(first);
    if (process.platform !== "win32") {
      symlinkSync("a.txt", path.join(root, "link.txt"));
      expect(hashDirectory(root)).not.toBe(first);
    }
  });

  it("builds a complete evidence inventory while excluding aggregate self-reference and .git metadata", async () => {
    const root = tempRoot();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, "manifest.json"), "manifest", "utf8");
    writeFileSync(path.join(root, "evaluation.json"), "evaluation", "utf8");
    writeFileSync(path.join(root, "aggregate-manifest.json"), "self", "utf8");
    const files = collectEvidenceFiles(root);
    expect(files.map((file) => file.path)).toEqual(["evaluation.json", "manifest.json"]);
    expect(files.every((file) => file.bytes > 0 && file.sha256.length === 64)).toBe(true);
  });
});
