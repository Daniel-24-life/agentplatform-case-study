import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePhase16, verifyPhase16Preparation } from "../manual/phase1-6-preparation.js";

describe("Phase 1.6 zero-quota preparation", () => {
  it("creates ten clean fixtures and records zero model calls", () => {
    const root = mkdtempSync(join(tmpdir(), "p16-prep-")); const plan = join(root, "plan.md"); const baseline = join(root, "baseline.json"); writeFileSync(plan, "approved plan\n"); writeFileSync(baseline, "baseline-v2\n");
    const manifest = preparePhase16({ root: join(root, "prep"), codexExecutable: process.execPath, codexVersion: "fake-node", planPath: plan, baselinePath: baseline, schemaDir: "schemas", sourceRoot: resolve("."), outputRoot: join(root, "prep") });
    expect(manifest.modelCalls).toBe(0); expect(manifest.cases).toHaveLength(10); expect(manifest.baselineReference.path).toBe(baseline);
    expect(manifest.cases.every((item) => item.baseSha.length === 40 && item.baseTree.length === 40)).toBe(true);
  });

  it("rejects existing output roots before any fixture/output overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "p16-fresh-")); const output = join(root, "sealed"); writeFileSync(output, "occupied");
    expect(() => preparePhase16({ root: output, codexExecutable: process.execPath, codexVersion: "fake-node", planPath: output, baselinePath: output, schemaDir: "schemas", sourceRoot: resolve("."), outputRoot: output })).toThrow("OUTPUT_ROOT_NOT_FRESH");
  });

  it("verifies plan, schema, source, and fixture hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "p16-verify-")); const plan = join(root, "plan.md"); const baseline = join(root, "baseline.json"); writeFileSync(plan, "approved plan\n"); writeFileSync(baseline, "baseline-v2\n");
    const prep = join(root, "prep"); const sourceRoot = resolve("."); const manifest = preparePhase16({ root: prep, codexExecutable: process.execPath, codexVersion: "fake-node", planPath: plan, baselinePath: baseline, schemaDir: "schemas", sourceRoot, outputRoot: prep });
    expect(() => verifyPhase16Preparation(manifest, { preparationRoot: prep, baselinePath: baseline, planPath: plan, schemaDir: "schemas", sourceRoot, outputRoot: join(root, "new-output"), codexExecutable: process.execPath, codexVersion: "fake-node" })).not.toThrow();
    writeFileSync(plan, "drift\n"); expect(() => verifyPhase16Preparation(manifest, { preparationRoot: prep, baselinePath: baseline, planPath: plan, schemaDir: "schemas", sourceRoot, outputRoot: join(root, "newer-output") })).toThrow("PLAN_HASH_DRIFT");
  });
  it("rejects preregistration, source, and fixture tampering", () => {
    const root = mkdtempSync(join(tmpdir(), "p16-tamper-")); const plan = join(root, "plan.md"); const baseline = join(root, "baseline.json"); writeFileSync(plan, "approved\n"); writeFileSync(baseline, "baseline\n"); const prep = join(root, "prep"); const sourceRoot = resolve("."); const manifest = preparePhase16({ root: prep, codexExecutable: process.execPath, codexVersion: "fake", planPath: plan, baselinePath: baseline, schemaDir: "schemas", sourceRoot, outputRoot: prep });
    const preregPath = join(prep, "preregistration.json"); const originalPrereg = readFileSync(preregPath, "utf8"); writeFileSync(preregPath, "{}\n"); expect(() => verifyPhase16Preparation(manifest, { preparationRoot: prep, baselinePath: baseline, planPath: plan, schemaDir: "schemas", sourceRoot, outputRoot: join(root, "out") })).toThrow("PREREGISTRATION_HASH_DRIFT"); writeFileSync(preregPath, originalPrereg);
    const sourceTampered = { ...manifest, sourceManifest: { ...manifest.sourceManifest, digest: "0".repeat(64) } }; expect(() => verifyPhase16Preparation(sourceTampered, { preparationRoot: prep, baselinePath: baseline, planPath: plan, schemaDir: "schemas", sourceRoot, outputRoot: join(root, "out2") })).toThrow("SOURCE_MANIFEST_DIGEST_DRIFT");
    const fixtureTampered = { ...manifest, cases: manifest.cases.map((item, index) => index === 0 ? { ...item, baseSha: "0".repeat(40) } : item) }; expect(() => verifyPhase16Preparation(fixtureTampered, { preparationRoot: prep, baselinePath: baseline, planPath: plan, schemaDir: "schemas", sourceRoot, outputRoot: join(root, "out3") })).toThrow("CASE_MAPPING_DRIFT");
    writeFileSync(join(manifest.cases[0].repo, manifest.cases[0].files[0]), "context tampered\n"); expect(() => verifyPhase16Preparation(manifest, { preparationRoot: prep, baselinePath: baseline, planPath: plan, schemaDir: "schemas", sourceRoot, outputRoot: join(root, "out4") })).toThrow();
  });

  it("rejects relative source roots and tracks the WP5 safety surface", () => {
    const root = mkdtempSync(join(tmpdir(), "p16-relative-"));
    expect(() => preparePhase16({ root: join(root, "prep"), codexExecutable: process.execPath, codexVersion: "fake", planPath: join(root, "plan"), baselinePath: join(root, "baseline"), schemaDir: "schemas", sourceRoot: "." })).toThrow("PHASE1_6_SOURCE_ROOT_INVALID");
  });
});
