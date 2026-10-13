import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../../src/main/adapters/codex/codex-app-server-client.js";
import { runProcess } from "../../src/main/process/runner.js";

const enabled = process.env.RUN_PHASE1_5_PREFLIGHT === "1";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const sha256 = (filePath: string): string => createHash("sha256").update(readFileSync(filePath)).digest("hex");

const sanitizeAccount = (value: unknown): Record<string, unknown> => {
  const response = record(value);
  const account = record(response?.account);
  return {
    accountPresent: account !== null,
    requiresOpenaiAuth: response?.requiresOpenaiAuth === true,
    accountType: typeof account?.type === "string" ? account.type : null,
    planType: typeof account?.planType === "string" ? account.planType : null
  };
};

export async function runPhase15AppServerPreflight(env: Record<string, string | undefined> = process.env): Promise<string> {
  const executable = env.CODEX_PROGRAM;
  const outputPath = env.PHASE1_5_PREFLIGHT_OUTPUT;
  if (!executable || !path.isAbsolute(executable) || !existsSync(executable)) throw new Error("CODEX_PROGRAM must be an existing absolute path");
  if (!outputPath || !path.isAbsolute(outputPath) || existsSync(outputPath)) throw new Error("PHASE1_5_PREFLIGHT_OUTPUT must be a fresh absolute path");
  mkdirSync(outputPath, { recursive: false });
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const client = new CodexAppServerClient({ program: executable, timeoutMs: 15_000 });
  let initialize: unknown;
  let account: unknown;
  let error: { name: string; message: string } | null = null;
  try {
    initialize = await client.initialize();
    account = await client.accountRead();
  } catch (cause) {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    error = { name: failure.name, message: failure.message };
  } finally {
    await client.close();
  }
  const version = await runProcess({ program: executable, args: ["--version"], cwd: process.cwd(), timeoutSeconds: 15 });
  const diagnostics = client.getProcessDiagnostics();
  const evidence = {
    protocolVersion: "phase1-5-app-server-preflight-v1",
    modelCalls: 0,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    executable: { path: executable, sha256: sha256(executable), version: version.stdout.trim(), versionStatus: version.status },
    initialize: error ? null : { responsePresent: record(initialize) !== null },
    account: error ? null : sanitizeAccount(account),
    process: diagnostics,
    error,
    passed: error === null && diagnostics.closeObserved && diagnostics.stdoutClosed && diagnostics.stderrClosed
  };
  writeFileSync(path.join(outputPath, "preflight-result.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!evidence.passed) throw new Error(`Phase 1.5 app-server preflight failed: ${error?.message ?? "stdio did not converge"}`);
  return outputPath;
}

describe("Phase 1.5 app-server preflight", () => {
  it.skipIf(!enabled)("performs initialize and account/read without a model turn", async () => {
    const outputPath = await runPhase15AppServerPreflight();
    const result = JSON.parse(readFileSync(path.join(outputPath, "preflight-result.json"), "utf8")) as { passed: boolean; modelCalls: number };
    expect(result).toMatchObject({ passed: true, modelCalls: 0 });
  }, 30_000);
});
