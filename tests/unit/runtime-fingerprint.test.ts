import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectRuntimeFingerprint } from "../../src/main/runtime/runtime-fingerprint.js";

describe("runtime fingerprint", () => {
  it("records executable identity and redacts config values deterministically", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-fingerprint-"));
    const configPath = path.join(root, "config.toml");
    writeFileSync(configPath, "api_key = 'secret-value'\nmodel = 'gpt-secret'\n", "utf8");
    const result = collectRuntimeFingerprint({ executable: process.execPath, configPath, model: "gpt-5.6-sol", reasoning: "medium", doctorEvidencePath: "phase1-4-evidence/doctor" });
    expect(result.executable.absolutePath).toBe(path.resolve(process.execPath));
    expect(result.executable.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.config.present).toBe(true);
    expect(result.config.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(result.features).toMatchObject({ multiAgent: "disabled", agentsEnabled: false, sandbox: "read-only", structuredOutput: "json" });
    expect(result.doctor.diagnosticOnly).toBe(true);
  });
});
