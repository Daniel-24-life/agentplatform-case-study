import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodexRuntimePreflight } from "../../src/main/runtime/codex-runtime-preflight.js";
import type { ProcessResult } from "../../src/main/process/runner.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = (): string => { const value = mkdtempSync(path.join(os.tmpdir(), "preflight-test-")); roots.push(value); return value; };
const fakeResult = (status: ProcessResult["status"] = "SUCCEEDED", stdout = "", stderr = ""): ProcessResult => ({ status, exitCode: status === "SUCCEEDED" ? 0 : 1, stdout, stderr, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64), durationMs: 2 });

describe("Codex runtime preflight", () => {
  it("runs zero-quota CLI doctor with no codex exec invocation", async () => {
    const calls: string[][] = [];
    const result = await runCodexRuntimePreflight({ models: [], probeModels: false, artifactRoot: path.join(root(), "doctor"), timeoutSeconds: 1, processRunner: (async (spec: { args: string[] }) => { calls.push(spec.args); return fakeResult(); }) as never });
    expect(result.passed).toBe(true);
    expect(calls).toEqual([["--version"], ["login", "status"]]);
    expect(calls.some(args => args.includes("exec"))).toBe(false);
  });
  it("validates models and timeout without starting a process", async () => {
    const missingModels = await runCodexRuntimePreflight({ program: "missing-codex", models: [], artifactRoot: path.join(root(), "artifacts"), timeoutSeconds: 1 });
    expect(missingModels.passed).toBe(false);
    expect(missingModels.failure?.code).toBe("PROCESS_START_FAILED");
    const badTimeout = await runCodexRuntimePreflight({ program: "missing-codex", models: ["strong"], artifactRoot: path.join(root(), "artifacts"), timeoutSeconds: 0 });
    expect(badTimeout.passed).toBe(false);
  });

  it("fails for a missing CLI and preserves an existing artifact root", async () => {
    const base = root();
    const artifactRoot = path.join(base, "artifacts");
    const missing = await runCodexRuntimePreflight({ program: "definitely-missing-codex", models: ["strong"], artifactRoot, timeoutSeconds: 1 });
    expect(missing.passed).toBe(false);
    expect(missing.failure?.code).toBe("CLI_NOT_FOUND");
    const existingRoot = path.join(base, "existing-artifacts");
    mkdirSync(existingRoot);
    const existing = await runCodexRuntimePreflight({ program: "definitely-missing-codex", models: ["strong"], artifactRoot: existingRoot, timeoutSeconds: 1 });
    expect(existing.passed).toBe(false);
    expect(existing.failure?.code).toBe("PROCESS_START_FAILED");
    expect(existing.failure?.diagnosticSummary).toContain("already exists");
  });

  it("runs version, login and unique model probes with isolated temp cwd", async () => {
    const artifactRoot = path.join(root(), "artifacts");
    const calls: { args: string[]; cwd: string }[] = [];
    const processRunner = async (spec: { args: string[]; cwd: string; logDir?: string }): Promise<ProcessResult> => {
      calls.push({ args: spec.args, cwd: spec.cwd });
      if (spec.args.includes("--version")) return fakeResult("SUCCEEDED", "codex 1\n");
      if (spec.args[0] === "login") return fakeResult();
      const output = spec.args[spec.args.indexOf("--output-last-message") + 1];
      (await import("node:fs")).writeFileSync(output, '{"status":"ok"}');
      return fakeResult("SUCCEEDED", '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n');
    };
    const result = await runCodexRuntimePreflight({ models: ["m1", "m1", "m2"], artifactRoot, timeoutSeconds: 1, processRunner: processRunner as never });
    expect(result.passed).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[2].args).toContain("--skip-git-repo-check");
    expect(calls[2].args.slice(0, 10)).toEqual(["--ask-for-approval", "never", "--disable", "multi_agent", "exec", "--ephemeral", "--ignore-rules", "-c", "agents.enabled=false", "--skip-git-repo-check"]);
    expect(calls[2].cwd).toContain("agentplatform-preflight-");
    expect(calls[2].cwd).not.toBe(calls[3].cwd);
    expect(result.steps[2].usage?.totalTokens).toBeNull();
    const schema = JSON.parse(readFileSync(path.join(artifactRoot, "probe-1-m1", "schema.json"), "utf8")) as { properties: { status: { type?: string; const?: string } } };
    expect(schema.properties.status).toEqual({ type: "string", const: "ok" });
  });

  it("maps generic login failure to authentication and stops after probe timeout", async () => {
    const artifactRoot = path.join(root(), "artifacts");
    let calls = 0;
    const loginFail = await runCodexRuntimePreflight({ models: ["m1"], artifactRoot, timeoutSeconds: 1, processRunner: (async (spec: { args: string[] }) => { calls++; return spec.args[0] === "login" ? fakeResult("FAILED", "", "exit 1") : fakeResult(); }) as never });
    expect(loginFail.failure?.code).toBe("CLI_NOT_AUTHENTICATED");
    const timeoutRoot = path.join(root(), "timeout");
    const timeout = await runCodexRuntimePreflight({ models: ["m1", "m2"], artifactRoot: timeoutRoot, timeoutSeconds: 1, processRunner: (async (_spec: { args: string[]; cwd: string }) => { calls++; if (calls === 1) return fakeResult(); if (calls === 2) return fakeResult(); return fakeResult("TIMED_OUT", "late ok"); }) as never });
    expect(timeout.failure?.code).toBe("PROCESS_TIMEOUT");
    expect(calls).toBe(3);
  });

  it("preserves complete runner stream logs beyond the bounded result summary", async () => {
    const artifactRoot = path.join(root(), "real-runner-artifacts");
    const processRunner = async (spec: { args: string[]; cwd: string; logDir?: string; timeoutSeconds: number; program: string; env?: Record<string, string> }): Promise<ProcessResult> => {
      const script = spec.args.includes("--version")
        ? "process.stdout.write('x'.repeat(70000))"
        : spec.args[0] === "login"
          ? "process.exit(0)"
          : `require('node:fs').writeFileSync(${JSON.stringify(spec.args[spec.args.indexOf("--output-last-message") + 1])}, '{"status":"ok"}'); process.stdout.write('x'.repeat(70000))`;
      return (await import("../../src/main/process/runner.js")).runProcess({
        program: process.execPath,
        args: ["-e", script],
        cwd: spec.cwd,
        timeoutSeconds: spec.timeoutSeconds,
        logDir: spec.logDir,
        env: {}
      });
    };
    const result = await runCodexRuntimePreflight({ models: ["m1"], artifactRoot, timeoutSeconds: 5, processRunner: processRunner as never });
    expect(result.passed).toBe(true);
    const stdoutLog = path.join(artifactRoot, "version", "stdout.log");
    expect(existsSync(stdoutLog)).toBe(true);
    expect(statSync(stdoutLog).size).toBeGreaterThan(65_536);
    expect(readFileSync(stdoutLog, "utf8")).toHaveLength(70_000);
    expect(JSON.parse(readFileSync(path.join(artifactRoot, "version", "result.json"), "utf8")).status).toBe("SUCCEEDED");
  });

  it("materializes fallback logs and metadata for a runner without logDir support", async () => {
    const artifactRoot = path.join(root(), "fake-runner-artifacts");
    const processRunner = async (spec: { args: string[] }): Promise<ProcessResult> => {
      if (spec.args[0] === "login") return fakeResult("SUCCEEDED", "login ok", "");
      if (spec.args.includes("--version")) return fakeResult("SUCCEEDED", "codex fake\n", "");
      writeFileSync(spec.args[spec.args.indexOf("--output-last-message") + 1], '{"status":"ok"}');
      return fakeResult("SUCCEEDED", '{"type":"turn.completed"}\n', "");
    };
    const result = await runCodexRuntimePreflight({ models: ["m1"], artifactRoot, timeoutSeconds: 1, processRunner: processRunner as never });
    expect(result.passed).toBe(true);
    for (const id of ["version", "login", "probe-1-m1"]) {
      expect(readFileSync(path.join(artifactRoot, id, "stdout.log"), "utf8")).toBeTruthy();
      expect(existsSync(path.join(artifactRoot, id, "stderr.log"))).toBe(true);
      expect(JSON.parse(readFileSync(path.join(artifactRoot, id, "result.json"), "utf8"))).toMatchObject({ status: "SUCCEEDED" });
    }
  });
});
