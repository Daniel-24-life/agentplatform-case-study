import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preparePhase16 } from "./phase1-6-preparation.js";

export function preparePhase16FromEnvironment(env: Record<string, string | undefined> = process.env): ReturnType<typeof preparePhase16> {
  if (env.RUN_PHASE1_6_PREPARE !== "1") throw new Error("PHASE1_6_PREPARATION_NOT_ENABLED");
  if (!env.PHASE1_6_SOURCE_ROOT || !path.isAbsolute(env.PHASE1_6_SOURCE_ROOT)) throw new Error("PHASE1_6_SOURCE_ROOT_INVALID");
  const sourceRoot = path.resolve(env.PHASE1_6_SOURCE_ROOT);
  const preparationRoot = env.PHASE1_6_PREPARATION_ROOT;
  const executable = env.CODEX_PROGRAM;
  if (!preparationRoot || !path.isAbsolute(preparationRoot)) throw new Error("PHASE1_6_PREPARATION_ROOT_INVALID");
  if (!executable || !path.isAbsolute(executable)) throw new Error("CODEX_PROGRAM_INVALID");
  const version = spawnSync(executable, ["--version"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true });
  if (version.status !== 0) throw new Error("CODEX_VERSION_PREFLIGHT_FAILED");
  return preparePhase16({
    root: preparationRoot,
    codexExecutable: executable,
    codexVersion: version.stdout.trim(),
    planPath: path.join(sourceRoot, "docs", "PHASE_1_6_WP5_EXECUTION_PLAN.md"),
    schemaDir: path.join(sourceRoot, "schemas"),
    sourceRoot,
    baselinePath: path.join(sourceRoot, "phase1-6-evidence", "baseline", "baseline-manifest-v2.json"),
  });
}

const preparationEnabled = process.env.RUN_PHASE1_6_PREPARE === "1";
describe("Phase 1.6 zero-quota sealed preparation", () => {
  it.skipIf(!preparationEnabled)("prepares the immutable ten-case registration without a model call", () => {
    const manifest = preparePhase16FromEnvironment();
    expect(manifest.modelCalls).toBe(0);
    expect(manifest.cases).toHaveLength(10);
  }, 120_000);
});
