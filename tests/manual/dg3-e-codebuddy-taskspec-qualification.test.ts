import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodeBuddyAdapter } from "../../src/main/adapters/codebuddy/codebuddy-adapter.js";
import { buildTaskSpecPrompt } from "../../src/shared/core/task-spec-prompt.js";
import { validateExpectedTaskSpecIdentity } from "../../src/shared/core/task-spec.js";
import { AgentRunError } from "../../src/main/adapters/agent-adapter.js";

const enabled = process.env.RUN_DG3_E_CODEBUDDY === "1";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const writeJson = (filePath: string, value: unknown): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

type ManifestEntry = { path: string; bytes: number; sha256: string };
const manifest = (root: string): ManifestEntry[] => {
  const entries: ManifestEntry[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) entries.push({ path: relative, bytes: stat.size, sha256: sha256(readFileSync(absolute)) });
    }
  };
  visit(root);
  return entries;
};

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, { cwd, shell: false, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};

describe("DG3-E CodeBuddy TaskSpec qualification", () => {
  it.skipIf(!enabled)("executes exactly one sealed read-only production-adapter request", async () => {
    const nodePath = process.env.CODEBUDDY_NODE_PATH;
    const entryPath = process.env.CODEBUDDY_ENTRY_PATH;
    const outputParent = process.env.DG3_E_OUTPUT_ROOT;
    if (!nodePath || !entryPath || !outputParent) throw new Error("DG3_E_REQUIRED_ENV_MISSING");

    const outputRoot = path.resolve(outputParent);
    if (path.relative(path.resolve(outputParent), outputRoot) !== "" || outputRoot === path.parse(outputRoot).root) {
      throw new Error("DG3_E_OUTPUT_ROOT_INVALID");
    }
    if (existsSync(outputRoot)) throw new Error("DG3_E_OUTPUT_ROOT_MUST_NOT_EXIST");
    mkdirSync(outputRoot, { recursive: true });
    const fixture = path.join(outputRoot, "fixture");
    const artifactRoot = path.join(outputRoot, "artifacts");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(path.join(fixture, "README.md"), "# DG3-E read-only fixture\n", "utf8");
    git(fixture, ["init"]);
    git(fixture, ["config", "user.name", "AgentPlatform DG3-E"]);
    git(fixture, ["config", "user.email", "dg3-e@agentplatform.local"]);
    git(fixture, ["add", "README.md"]);
    git(fixture, ["commit", "-m", "DG3-E fixture"]);
    const baseSha = git(fixture, ["rev-parse", "HEAD"]);
    const taskId = "DG3E_TASK_001";
    const before = manifest(fixture);
    const registration = {
      version: "dg3-e-codebuddy-taskspec-qualification.v1",
      model: "glm-5.3",
      reasoning: "low",
      taskId,
      baseSha,
      fixtureManifest: before,
      fixtureManifestSha256: sha256(JSON.stringify(before)),
      callLimit: 1,
      retry: false,
      writerEnabled: false
    };
    writeJson(path.join(outputRoot, "preregistration.json"), registration);
    const adapter = new CodeBuddyAdapter({ executableResolver: () => ({ nodePath, entryPath }) });
    let calls = 0;
    let resultWritten = false;
    try {
      calls += 1;
      const execution = await adapter.runPlanner({
        cwd: fixture,
        model: "glm-5.3",
        reasoning: "low",
        timeoutSeconds: 180,
        schemaPath: path.resolve("schemas/task-spec.schema.json"),
        outputPath: path.join(artifactRoot, "final.json"),
        hashOnlyLogs: true,
        runId: `dg3-e-${randomUUID()}`,
        prompt: buildTaskSpecPrompt({
          taskId,
          baseSha,
          request: "Create the smallest valid plan for documenting this read-only fixture. Do not use tools or change files."
        })
      });
      const identity = validateExpectedTaskSpecIdentity(execution.output, { taskId, baseSha });
      if (!identity.valid) throw new Error("DG3_E_IDENTITY_MISMATCH");
      const after = manifest(fixture);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("DG3_E_FIXTURE_MUTATED");
      writeJson(path.join(outputRoot, "result.json"), {
        taskSpec: execution.output,
        usage: execution.usage,
        process: {
          status: execution.process.status,
          exitCode: execution.process.exitCode,
          durationMs: execution.process.durationMs,
          stdoutSha256: execution.process.stdoutSha256,
          stderrSha256: execution.process.stderrSha256
        },
        fixtureManifestAfter: after,
        identityValid: true,
        fixtureUnchanged: true
      });
      resultWritten = true;
      writeJson(path.join(outputRoot, "decision.json"), { status: "PASS", calls, fixtureUnchanged: true, identityValid: true });
      expect(calls).toBe(1);
    } catch (error) {
      const processResult = error instanceof AgentRunError ? error.result : null;
      writeJson(path.join(outputRoot, "decision.json"), {
        status: "FAIL",
        calls,
        error: { name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error) },
        process: processResult ? { status: processResult.status, exitCode: processResult.exitCode, durationMs: processResult.durationMs, stdoutSha256: processResult.stdoutSha256, stderrSha256: processResult.stderrSha256 } : null,
        resultWritten
      });
      throw error;
    }
  }, 240_000);
});
