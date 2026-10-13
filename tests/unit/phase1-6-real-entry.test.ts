import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validatePhase16PreflightFailureRoot,
  validatePhase16PreparationVersion,
  validatePhase16SourceRoot,
  writePhase16AccountPreflightFailure,
} from "../manual/phase1-6-real-execution.test.js";

describe("Phase 1.6 real-entry offline boundaries", () => {
  it("rejects preparation version drift", () => {
    expect(() => validatePhase16PreparationVersion({ version: "wrong" } as never)).toThrow("PHASE1_6_PREPARATION_VERSION_INVALID");
  });

  it("rejects a missing or relative source root", () => {
    expect(() => validatePhase16SourceRoot(undefined)).toThrow("PHASE1_6_SOURCE_ROOT_INVALID");
    expect(() => validatePhase16SourceRoot("relative")).toThrow("PHASE1_6_SOURCE_ROOT_INVALID");
  });

  it("requires a fresh direct child failure root under Phase 1.6 evidence", () => {
    const source = mkdtempSync(path.join(tmpdir(), "p16-entry-"));
    const evidence = path.join(source, "phase1-6-evidence");
    const valid = path.join(evidence, "wp5-preflight-failure-test");
    expect(validatePhase16PreflightFailureRoot(source, valid)).toBe(path.resolve(valid));
    expect(() => validatePhase16PreflightFailureRoot(source, "relative")).toThrow("PHASE1_6_PREFLIGHT_FAILURE_ROOT_INVALID");
    expect(() => validatePhase16PreflightFailureRoot(source, path.join(source, "outside"))).toThrow("PHASE1_6_PREFLIGHT_FAILURE_ROOT_INVALID");
    mkdirSync(evidence);
    writeFileSync(valid, "occupied");
    expect(() => validatePhase16PreflightFailureRoot(source, valid)).toThrow("PHASE1_6_PREFLIGHT_FAILURE_ROOT_INVALID");
  });

  it("persists only account status and stream hashes on login failure", () => {
    const source = mkdtempSync(path.join(tmpdir(), "p16-account-"));
    const evidence = path.join(source, "phase1-6-evidence");
    mkdirSync(evidence);
    const failureRoot = path.join(evidence, "wp5-preflight-failure-test");
    const stdout = "account@example.invalid";
    const stderr = "Authorization: Bearer super-secret";
    writePhase16AccountPreflightFailure(failureRoot, { status: 1, stdout, stderr });
    const artifactPath = path.join(failureRoot, "account-preflight-failure.json");
    const artifact = readFileSync(artifactPath, "utf8");
    expect(existsSync(artifactPath)).toBe(true);
    expect(artifact).not.toContain(stdout);
    expect(artifact).not.toContain("super-secret");
    expect(artifact).toContain(createHash("sha256").update(stderr).digest("hex"));
  });
});
