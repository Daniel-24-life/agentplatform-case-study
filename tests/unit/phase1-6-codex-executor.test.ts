import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createPhase16CaseExecutor, verifyPhase16CaseArtifacts } from "../manual/phase1-6-codex-executor.js";
import { PHASE1_6_CASES, type CaseRegistration } from "../manual/phase1-6-runtime-certification.js";
import { readBoundedContext } from "../../src/shared/core/bounded-context.js";
import type { PlannerAgentAdapter } from "../../src/main/adapters/agent-adapter.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const validSpec = (item: CaseRegistration) => ({ schema_version: "2.0", task_id: item.id, title: "read", goal: "read", base_sha: item.baseSha, context_paths: [...item.contextPaths], scope: { allowed_paths: [...item.contextPaths], forbidden_paths: ["**/*"] }, acceptance_criteria: [{ id: "AC-01", text: "read" }], test_commands: [{ id: "head", program: "git", args: ["rev-parse", "HEAD"], cwd: ".", timeout_seconds: 60, required: true }], execution_policy: { planner_recommendation: "strong", planner_confidence: "high", recommendation_reasons: ["read"], user_lock: null }, limits: { max_attempts: 1, run_timeout_seconds: 300, max_changed_files: 1, max_diff_bytes: 1024 }});
const process = (stdout = '{"type":"response.completed"}\n', status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" = "SUCCEEDED", extras: Record<string, unknown> = {}) => ({ exitCode: status === "SUCCEEDED" ? 0 : 1, status, stdout, stderr: "", stdoutSha256: createHash("sha256").update(stdout).digest("hex"), stderrSha256: createHash("sha256").digest("hex"), durationMs: 3, closeObserved: true, stdoutClosed: true, stderrClosed: true, ...extras });
async function fixture(item = PHASE1_6_CASES[0]) {
  const root = await mkdtemp(join(tmpdir(), "p16-")); const repo = join(root, "repo");
  for (const [index, relativePath] of item.contextPaths.entries()) {
    const absolutePath = join(repo, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, `fixture-${index + 1}:${relativePath}\n`);
  }
  git(repo, "init", "--initial-branch=main"); git(repo, "config", "user.email", "test@example.invalid"); git(repo, "config", "user.name", "test"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
  const sha = git(repo, "rev-parse", "HEAD"); const contextHash = readBoundedContext(repo, item.contextPaths).sha256;
  const schemaPath = join(root, "task-spec.schema.json"); await writeFile(schemaPath, "phase16-test-schema");
  const registration = { ...item, baseSha: sha, baseTree: git(repo, "rev-parse", "HEAD^{tree}"), contextHash, contextTotalBytes: 5, promptHash: createHash("sha256").update(item.prompt).digest("hex"), authoritativeSchemaHash: createHash("sha256").update("phase16-test-schema").digest("hex") } as CaseRegistration;
  const outputPath = join(root, "output"); await mkdir(outputPath, { recursive: true });
  return { repo, registration, schemaPath, outputPath };
}
describe("Phase 1.6 bounded Codex executor", () => {
  it("records a successful fake without invoking real Codex", async () => {
    const { repo, registration, schemaPath, outputPath } = await fixture(); const fake: PlannerAgentAdapter = { id: "fake", runPlanner: async (input) => { await writeFile(input.outputPath, `${JSON.stringify(validSpec(registration))}\n`); return { output: validSpec(registration) as never, process: process(), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 }, }; } };
    const sample = await createPhase16CaseExecutor({ adapter: fake, program: "C:\\absolute\\codex.exe", schemaPath, repoForCase: () => repo })(registration, outputPath);
    const evidence = JSON.parse(await readFile(join(outputPath, "execution-evidence.json"), "utf8")) as Record<string, unknown>;
    expect(evidence).not.toHaveProperty("stdout");
    expect(sample).toMatchObject({ authoritativeTerminal: true, schemaValid: true, semanticValid: true, fixtureClean: true, baseShaValid: true, hashesValid: true, usageAvailable: true });
    const manifest = JSON.parse(await readFile(join(outputPath, "case-artifact-manifest.json"), "utf8")) as { artifacts: Record<string, string> };
    expect(manifest.artifacts).toEqual(expect.objectContaining({ "task-spec.json": expect.any(String), "execution-evidence.json": expect.any(String) }));
  });
  it("keeps complete evidence for schema, process, timeout and mutation failures", async () => {
    const { repo, registration, schemaPath, outputPath } = await fixture();
    for (const status of ["FAILED", "TIMED_OUT"] as const) {
      const fake: PlannerAgentAdapter = { id: "fake", runPlanner: async () => { throw Object.assign(new Error(`${status}; Authorization: Bearer super-secret`), { result: process("not-json", status) }); } };
      const sample = await createPhase16CaseExecutor({ adapter: fake, schemaPath, repoForCase: () => repo })(registration, outputPath); expect(sample).toHaveProperty("fixtureClean"); expect(sample.authoritativeTerminal).toBe(false);
      expect(await readFile(join(outputPath, "execution-evidence.json"), "utf8")).not.toContain("super-secret");
    }
    const fake: PlannerAgentAdapter = { id: "fake", runPlanner: async () => { await writeFile(join(repo, registration.contextPaths[0]), "mutated"); return { output: validSpec(registration) as never, process: process(), usage: null }; } };
    const sample = await createPhase16CaseExecutor({ adapter: fake, schemaPath, repoForCase: () => repo })(registration, outputPath); expect(sample.fixtureClean).toBe(false);
    expect(await readFile(join(outputPath, "execution-evidence.json"), "utf8")).toContain('"error"');
  });
  it("redacts terminal-event and transport evidence", async () => {
    const { repo, registration, schemaPath, outputPath } = await fixture();
    const stdout = `${JSON.stringify({ type: "response.failed", error: "Authorization: Bearer terminal-secret" })}\n`;
    const stderr = "reconnecting transport token=transport-secret";
    const fake: PlannerAgentAdapter = { id: "fake", runPlanner: async () => { throw Object.assign(new Error("failed"), { result: process(stdout, "FAILED", { stderr, stderrSha256: createHash("sha256").update(stderr).digest("hex") }) }); } };
    await createPhase16CaseExecutor({ adapter: fake, schemaPath, repoForCase: () => repo })(registration, outputPath);
    const evidence = await readFile(join(outputPath, "execution-evidence.json"), "utf8");
    expect(evidence).not.toContain("terminal-secret");
    expect(evidence).not.toContain("transport-secret");
    expect(evidence).toContain("[REDACTED]");
  });
  it("flags semantic drift, schema/hash drift, auth unavailability, and cleanup overrun", async () => {
    const { repo, registration, schemaPath, outputPath } = await fixture();
    const semantic: PlannerAgentAdapter = { id: "fake", runPlanner: async () => ({ output: { ...validSpec(registration), base_sha: "0".repeat(40) } as never, process: process(), usage: null }) };
    const semanticSample = await createPhase16CaseExecutor({ adapter: semantic, schemaPath, repoForCase: () => repo })(registration, outputPath);
    expect(semanticSample.schemaValid).toBe(true); expect(semanticSample.semanticValid).toBe(false);
    const unavailable: PlannerAgentAdapter = { id: "fake", runPlanner: async () => ({ output: validSpec(registration) as never, process: process('{"type":"response.completed"}\n', "SUCCEEDED", { stderr: "authentication required" }), usage: null }) };
    const unavailableSample = await createPhase16CaseExecutor({ adapter: unavailable, schemaPath, repoForCase: () => repo })(registration, outputPath);
    expect(unavailableSample.accountAvailable).toBe(false);
    const timed: PlannerAgentAdapter = { id: "fake", runPlanner: async () => ({ output: validSpec(registration) as never, process: process(undefined, "TIMED_OUT", { termination: { taskkill: [{ requestedAtMs: 0 }], settledWithoutClose: true }, endedAtMs: 20_001 }), usage: null }) };
    const timedSample = await createPhase16CaseExecutor({ adapter: timed, schemaPath, repoForCase: () => repo })(registration, outputPath);
    expect(timedSample.cleanupDurationMs).toBeGreaterThan(10_000);
    const drift = { ...registration, authoritativeSchemaHash: "f".repeat(64) };
    const driftSample = await createPhase16CaseExecutor({ adapter: unavailable, schemaPath, repoForCase: () => repo })(drift, outputPath);
    expect(driftSample.hashesValid).toBe(false);
  });
  it("checks the registered Git tree and removes raw runtime logs in hash-only mode", async () => {
    const { repo, registration, schemaPath, outputPath } = await fixture();
    const treeDrift = { ...registration, baseTree: "0".repeat(40) };
    const sample = await createPhase16CaseExecutor({ adapter: { id: "fake", runPlanner: async () => ({ output: validSpec(registration) as never, process: process(), usage: null }) }, schemaPath, repoForCase: () => repo })(treeDrift, outputPath);
    expect(sample.baseShaValid).toBe(false);
    const hashOnly = await createPhase16CaseExecutor({ adapter: { id: "fake", runPlanner: async (input) => { await writeFile(input.outputPath, `${JSON.stringify(validSpec(registration))}\n`); await writeFile(join(path.dirname(input.outputPath), "stdout.log"), "Authorization: Bearer secret"); return { output: validSpec(registration) as never, process: process(), usage: null }; } }, schemaPath, repoForCase: () => repo, hashOnly: true })(registration, outputPath);
    expect(hashOnly.hashesValid).toBe(true);
    expect(existsSync(join(outputPath, "stdout.log"))).toBe(false);
    const manifestText = await readFile(join(outputPath, "case-artifact-manifest.json"), "utf8");
    expect(manifestText).not.toContain("secret");
    await writeFile(join(outputPath, "task-spec.json"), "corrupted\n");
    expect(await verifyPhase16CaseArtifacts(outputPath)).toBe(false);
  });
});
