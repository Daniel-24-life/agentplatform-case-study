import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPhase16CaseExecutor } from "./phase1-6-codex-executor.js";
import { type PreparationManifest, verifyPhase16Preparation } from "./phase1-6-preparation.js";
import { runRegisteredCases, type Preregistration } from "./phase1-6-runtime-certification.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const readJson = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, "utf8")) as T;
const inside = (root: string, target: string): boolean => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

export const PHASE1_6_PROTECTED_ROOT_NAMES = [
  "phase1-2-ab-development-run1", "phase1-2-ab-development-run2", "phase1-2-ab-holdout-run1",
  "phase1-2-ab-holdout-run2", "phase1-2-ab-holdout-run3", "phase1-2-evidence",
  "phase1-3-evidence", "phase1-3-runtime-stability-run1", "phase1-4-evidence",
  "phase1-4-runtime-canary-run1", "phase1-4-runtime-isolation-i01-run1",
  "phase1-4-runtime-isolation-i01-run2", "phase1-4-runtime-isolation-i01-run3",
  "phase1-4-runtime-isolation-i01-run4", "phase1-4-runtime-isolation-i02-run1",
  "phase1-4-runtime-isolation-i03-run1", "phase1-5-evidence",
  "phase1-5-runtime-qualification-run1", "phase1-6-evidence",
] as const;

export function validatePhase16PreparationVersion(manifest: PreparationManifest): void {
  if (manifest.version !== "phase1.6-preparation.v2") throw new Error("PHASE1_6_PREPARATION_VERSION_INVALID");
}

export function validatePhase16SourceRoot(rawRoot: string | undefined): string {
  if (!rawRoot || !path.isAbsolute(rawRoot)) throw new Error("PHASE1_6_SOURCE_ROOT_INVALID");
  return path.resolve(rawRoot);
}

export function validatePhase16PreflightFailureRoot(sourceRoot: string, rawRoot: string | undefined): string {
  if (!rawRoot || !path.isAbsolute(rawRoot) || existsSync(rawRoot)) throw new Error("PHASE1_6_PREFLIGHT_FAILURE_ROOT_INVALID");
  const evidenceRoot = path.join(sourceRoot, "phase1-6-evidence");
  const resolved = path.resolve(rawRoot);
  if (!inside(evidenceRoot, resolved) || path.dirname(resolved) !== path.resolve(evidenceRoot) || !path.basename(resolved).startsWith("wp5-preflight-failure-")) throw new Error("PHASE1_6_PREFLIGHT_FAILURE_ROOT_INVALID");
  return resolved;
}

export function writePhase16AccountPreflightFailure(root: string, result: Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">): void {
  mkdirSync(root, { recursive: false });
  writeFileSync(path.join(root, "account-preflight-failure.json"), `${JSON.stringify({
    status: "CODEX_ACCOUNT_PREFLIGHT_FAILED",
    exitCode: result.status,
    stdoutSha256: sha256(result.stdout ?? ""),
    stderrSha256: sha256(result.stderr ?? ""),
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

type Spawn = typeof spawnSync;

export async function executePhase16RealRun(env: Record<string, string | undefined> = process.env, spawn: Spawn = spawnSync): Promise<{ calls: number; decision: unknown }> {
  if (env.RUN_PHASE1_6_RUNTIME !== "1" || env.PHASE1_6_EXECUTION_APPROVAL !== "I_APPROVE_10_REAL_CALLS") throw new Error("PHASE1_6_REAL_EXECUTION_NOT_APPROVED");
  const sourceRoot = validatePhase16SourceRoot(env.PHASE1_6_SOURCE_ROOT);
  const preparationRoot = env.PHASE1_6_PREPARATION_ROOT;
  const outputRoot = env.PHASE1_6_OUTPUT_ROOT;
  const expectedManifestSha256 = env.PHASE1_6_PREPARE_MANIFEST_SHA256;
  if (!preparationRoot || !path.isAbsolute(preparationRoot) || !existsSync(preparationRoot)) throw new Error("PHASE1_6_PREPARATION_ROOT_INVALID");
  if (!outputRoot || !path.isAbsolute(outputRoot)) throw new Error("PHASE1_6_OUTPUT_ROOT_INVALID");
  if (!expectedManifestSha256 || !/^[0-9a-f]{64}$/.test(expectedManifestSha256)) throw new Error("PHASE1_6_PREPARE_MANIFEST_SHA256_INVALID");
  const preflightFailureRoot = validatePhase16PreflightFailureRoot(sourceRoot, env.PHASE1_6_PREFLIGHT_FAILURE_ROOT);

  const manifestPath = path.join(preparationRoot, "prepare-manifest.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  if (sha256(manifestText) !== expectedManifestSha256) throw new Error("PREPARE_MANIFEST_HASH_DRIFT");
  const manifest = JSON.parse(manifestText) as PreparationManifest;
  validatePhase16PreparationVersion(manifest);
  const preregistration = readJson<Preregistration>(path.join(preparationRoot, manifest.preregistration.path));
  const versionRun = spawn(manifest.codex.executable, ["--version"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true });
  if (versionRun.status !== 0) throw new Error("CODEX_VERSION_PREFLIGHT_FAILED");
  const codexVersion = String(versionRun.stdout).trim();
  verifyPhase16Preparation(manifest, {
    preparationRoot,
    planPath: path.join(sourceRoot, "docs", "PHASE_1_6_WP5_EXECUTION_PLAN.md"),
    schemaDir: path.join(sourceRoot, "schemas"),
    sourceRoot,
    baselinePath: path.join(sourceRoot, "phase1-6-evidence", "baseline", "baseline-manifest-v2.json"),
    outputRoot,
    codexExecutable: manifest.codex.executable,
    codexVersion,
    forbiddenRoots: PHASE1_6_PROTECTED_ROOT_NAMES.map((name) => path.join(sourceRoot, name)),
  });

  const accountRun = spawn(manifest.codex.executable, ["login", "status"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true });
  if (accountRun.status !== 0) {
    writePhase16AccountPreflightFailure(preflightFailureRoot, accountRun as SpawnSyncReturns<string>);
    throw new Error("CODEX_ACCOUNT_PREFLIGHT_FAILED");
  }
  const accountEvidence = {
    checkedWithoutModelCall: true,
    exitCode: accountRun.status,
    stdoutSha256: sha256(String(accountRun.stdout)),
    stderrSha256: sha256(String(accountRun.stderr)),
  };
  const repoById = new Map(manifest.cases.map((item) => [item.id, item.repo]));
  const caseExecutor = createPhase16CaseExecutor({
    program: manifest.codex.executable,
    schemaPath: path.join(sourceRoot, "schemas", "task-spec.schema.json"),
    repoForCase: (item) => {
      const repo = repoById.get(item.id);
      if (!repo) throw new Error(`FIXTURE_REPO_MISSING:${item.id}`);
      return repo;
    },
  });
  let preflightWritten = false;
  const result = await runRegisteredCases(preregistration, outputRoot, async (item, caseOutputPath) => {
    if (!preflightWritten) {
      writeFileSync(path.join(outputRoot, "execution-preflight.json"), `${JSON.stringify(accountEvidence, null, 2)}\n`, "utf8");
      preflightWritten = true;
    }
    return caseExecutor(item, caseOutputPath);
  });
  return { calls: result.calls, decision: result.decision };
}

const executionEnabled = process.env.RUN_PHASE1_6_RUNTIME === "1" && process.env.PHASE1_6_EXECUTION_APPROVAL === "I_APPROVE_10_REAL_CALLS";
describe("Phase 1.6 explicitly approved real certification", () => {
  it.skipIf(!executionEnabled)("executes only the sealed ten-case registration", async () => {
    const result = await executePhase16RealRun();
    expect(result.calls).toBeGreaterThanOrEqual(1);
    expect(result.calls).toBeLessThanOrEqual(10);
  }, 3_100_000);
});
