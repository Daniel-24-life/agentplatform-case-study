import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPhase110Readiness, verifyPhase110Ready } from "./phase1-10-runtime-certification.js";

const enabled = process.env.PHASE1_10_RUN3_OFFLINE_VERIFY === "1";
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!enabled)("Phase 1.10 run3 zero-call preparation", () => {
  it("checks final source readiness and the fresh run3 pair", () => {
    const sourceRoot = path.resolve(process.env.PHASE1_10_SOURCE_ROOT ?? "");
    const preparationRoot = path.join(sourceRoot, "phase1-10-run3-evidence", "preparation-run1");
    const sealSha256 = sha256(readFileSync(path.join(preparationRoot, "preparation-seal.json")));
    const readinessSha256 = sha256(readFileSync(path.join(sourceRoot, "phase1-10-run3-evidence", "offline-readiness-final.json")));
    verifyPhase110Readiness(sourceRoot, readinessSha256, sealSha256);
    const outputRoot = path.join(sourceRoot, "phase1-10-runtime-certification-run3");
    const ready = verifyPhase110Ready({
      sourceRoot,
      preparationRoot,
      outputRoot,
      expectedSealSha256: sealSha256,
      approval: { execution_authorized: true, preparation_seal_sha256: sealSha256, output_root: outputRoot, max_requests: 10, retry_count: 0, stop_on_first_fatal: true },
      runtime: { executable: process.execPath, version: process.version, sha256: sha256(readFileSync(process.execPath)) },
      schemaPath: path.join(sourceRoot, "schemas", "task-spec.schema.json"),
    });
    expect(ready.registration.cases).toHaveLength(10);
    expect(ready.registration.cases.every((item) => item.prompt.includes("test_commands MUST equal this JSON array exactly"))).toBe(true);
  });
});
