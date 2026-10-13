import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPhase19Preparation } from "./phase1-9-runtime-certification.js";

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const outputRoot = process.env.PHASE1_9_OUTPUT;

describe.skipIf(!process.env.PHASE1_9_PREPARE || !outputRoot)("Phase 1.9 zero-call preparation", () => {
  it("creates and seals a fresh ten-fixture registration without invoking Codex", () => {
    if (!outputRoot) throw new Error("PHASE1_9_OUTPUT_REQUIRED");
    const absoluteRoot = path.resolve(outputRoot);
    if (existsSync(absoluteRoot)) throw new Error("PHASE19_OUTPUT_ROOT_NOT_FRESH");
    const schemaPath = path.resolve("schemas/task-spec.schema.json");
    const registration = createPhase19Preparation(absoluteRoot, schemaPath);
    const artifacts = ["preregistration.json", "fixture-manifest.json"];
    const manifest = {
      version: "phase1.9-preparation-seal.v1",
      real_model_calls: 0,
      codex_executable_invocations: 0,
      execution_authorized: false,
      registration_sha256: sha256(readFileSync(path.join(absoluteRoot, artifacts[0]))),
      schema_sha256: sha256(readFileSync(schemaPath)),
      artifacts: artifacts.map((name) => ({ path: name, sha256: sha256(readFileSync(path.join(absoluteRoot, name))) })),
      registered_case_count: registration.cases.length,
      fixture_count: JSON.parse(readFileSync(path.join(absoluteRoot, "fixture-manifest.json"), "utf8")).fixtures.length as number,
      stop_rule: "No retries; stop after first fatal case; real execution requires separate approval of this exact seal.",
    };
    writeFileSync(path.join(absoluteRoot, "preparation-seal.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    expect(registration.cases).toHaveLength(10);
    expect(manifest.fixture_count).toBe(10);
    expect(manifest.execution_authorized).toBe(false);
  });
});
