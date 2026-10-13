import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPhase14CertificationPreregistration,
  certificationGate,
  phase14CertificationPrerequisite,
  phase14IsolationCallDirectory,
  PHASE14_BOUNDED_CONTEXT_PREFIX_ARGS,
  PHASE14_SIMPLIFIED_SCHEMA,
  validatePhase14SimplifiedArchitectResponse,
  selectPhase14IsolationVariants
} from "../manual/phase1-4-runtime-isolation.test.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Phase 1.4 isolation/certification track guards", () => {
  it("requires an explicit candidate runtime marker", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "phase14-isolation-guard-"));
    roots.push(root);
    const summary = path.join(root, "isolation-summary.json");
    writeFileSync(summary, JSON.stringify({ candidateQualified: true }), "utf8");
    expect(phase14CertificationPrerequisite(summary)).toBe(false);
    const candidate = path.join(root, "I-03", "sample.json");
    const content = "candidate evidence\n";
    mkdirSync(path.dirname(candidate), { recursive: true });
    writeFileSync(candidate, content, { encoding: "utf8", flag: "w" });
    writeFileSync(summary, JSON.stringify({ candidateQualified: true, candidateRuntime: "codex-cli-0.151.0", candidateSamplePath: "I-03/sample.json", candidateEvidenceSha256: createHash("sha256").update(content).digest("hex") }), "utf8");
    expect(phase14CertificationPrerequisite(summary)).toBe(true);
  });

  it("preregisters only fresh ten-case certification IDs and strict gates", () => {
    const prereg = buildPhase14CertificationPreregistration({ candidateEvidencePath: "isolation-summary.json", runtimeLabel: "codex-cli-0.151.0", fixtureTreeDigest: "a".repeat(64), baseSha: "b".repeat(40), promptSha256: "c".repeat(64), schemaSha256: "d".repeat(64), contextSha256: "e".repeat(64) });
    expect(prereg.track).toBe("CERTIFICATION");
    expect(prereg.caseIds).toHaveLength(10);
    expect(new Set(prereg.caseIds).size).toBe(10);
    expect(prereg.requirements).toMatchObject({ authoritativeStructuredCompletion: 10, semanticAndIntegrityValid: 10, maxSecondsPerCase: 600, maxRetries: 0, maxHumanIntervention: 0, maxFatalRuntime: 0, boundedTimeoutSeconds: 910 });
  });

  it("does not infer a certification pass from an incomplete sample set", () => {
    expect(certificationGate([])).toMatchObject({ status: "BLOCKED", caseCount: 0, validCaseCount: 0 });
  });

  it("uses explicit Codex feature flags for the bounded-context variant", () => {
    expect(PHASE14_BOUNDED_CONTEXT_PREFIX_ARGS).toEqual(["--disable", "shell_tool", "--disable", "unified_exec"]);
    expect(PHASE14_BOUNDED_CONTEXT_PREFIX_ARGS.filter((value) => value === "--disable")).toHaveLength(2);
  });

  it("gives each isolation variant an independent evidence directory", () => {
    expect(phase14IsolationCallDirectory("fresh-run", "I-01")).toBe(path.join("fresh-run", "I-01"));
    expect(phase14IsolationCallDirectory("fresh-run", "I-01")).not.toBe(phase14IsolationCallDirectory("fresh-run", "I-03"));
  });

  it("selects only requested variants while restoring preregistered matrix order", () => {
    expect(selectPhase14IsolationVariants("I-03,I-01").map((variant) => variant.id)).toEqual(["I-01", "I-03"]);
    expect(selectPhase14IsolationVariants(undefined).map((variant) => variant.id)).toEqual(["I-01", "I-02", "I-03", "I-04"]);
    expect(() => selectPhase14IsolationVariants("I-01,I-01")).toThrow(/Duplicate/);
    expect(() => selectPhase14IsolationVariants("I-05")).toThrow(/Unknown/);
  });

  it("uses a strict minimal I-01 schema and independent semantic validator", () => {
    expect(PHASE14_SIMPLIFIED_SCHEMA.additionalProperties).toBe(false);
    expect(PHASE14_SIMPLIFIED_SCHEMA.properties.read_only).toEqual({ type: "boolean", const: true });
    expect(PHASE14_SIMPLIFIED_SCHEMA.required).toEqual(["task_id", "base_sha", "context_paths", "facts", "risks", "read_only"]);
    const input = { taskId: "P14-CANARY-01", baseSha: "a".repeat(40), contextPaths: ["README.md", "docs/context.md"] };
    const valid = { task_id: input.taskId, base_sha: input.baseSha, context_paths: [...input.contextPaths], facts: ["runtime is read-only"], risks: ["one bounded risk"], read_only: true as const };
    expect(validatePhase14SimplifiedArchitectResponse(valid, input)).toEqual({ schemaValid: true, semanticValid: true });
    expect(validatePhase14SimplifiedArchitectResponse({ ...valid, context_paths: ["README.md"] }, input).semanticValid).toBe(false);
    expect(validatePhase14SimplifiedArchitectResponse({ ...valid, write_intent: "create a file" }, input).schemaValid).toBe(false);
    expect(validatePhase14SimplifiedArchitectResponse({ ...valid, risks: ["I will edit the repository"] }, input).semanticValid).toBe(false);
  });
});
