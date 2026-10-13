import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess, type ProcessResult } from "../process/runner.js";
import { parseCodexUsage } from "../adapters/codex/codex-adapter.js";
import type { AgentUsage } from "../adapters/agent-adapter.js";
import { classifyFailureCode, classifyProcessResult } from "../../shared/core/failure-taxonomy.js";
import { ERROR_CODES, type FailureClassification } from "../../shared/core/errors.js";
import { proxyEnvPresence, resolveWindowsUserProxy } from "./windows-user-proxy.js";

export type RuntimeFailure = FailureClassification;

export type PreflightStep = {
  id: string;
  command: string[];
  status: ProcessResult["status"] | "PASSED" | "FAILED";
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
  usage: AgentUsage | null;
  outputPath?: string;
  cwd?: string;
};

export type CodexRuntimePreflightOptions = {
  program?: string;
  models: string[];
  artifactRoot: string;
  timeoutSeconds: number;
  probeModels?: boolean;
  processRunner?: typeof runProcess;
  proxyResolver?: () => { env: Record<string, string>; source: "process" | "registry" | "none" };
};

export type CodexRuntimePreflightResult = {
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  artifactRoot: string;
  proxyEnv: Record<string, boolean | string>;
  steps: PreflightStep[];
  failure?: RuntimeFailure;
};

const runtimeFailure = (code: FailureClassification["code"], summary?: string): RuntimeFailure => ({
  ...classifyFailureCode(code), domain: "runtime", failFast: true,
  ...(summary ? { diagnosticSummary: summary } : {})
});

const classifyProcess = (step: "version" | "login" | "probe", result: ProcessResult): RuntimeFailure => {
  const classified = classifyProcessResult(result);
  if (step === "login" && result.status === "FAILED" && classified?.code === ERROR_CODES.MODEL_RUNTIME_FAILED) return runtimeFailure(ERROR_CODES.CLI_NOT_AUTHENTICATED, "Codex login status failed");
  if (classified) return classified;
  if (step === "login") return runtimeFailure(ERROR_CODES.CLI_NOT_AUTHENTICATED, "Codex login status failed");
  return runtimeFailure(ERROR_CODES.MODEL_RUNTIME_FAILED, `${step} process failed (${result.status})`);
};

const toStep = (id: string, command: string[], result: ProcessResult, cwd?: string, outputPath?: string): PreflightStep => ({
  id, command, status: result.status, durationMs: result.durationMs,
  stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256,
  usage: parseCodexUsage(result.stdout), cwd, outputPath
});

const writeStepLogs = (root: string, id: string, result: ProcessResult): void => {
  // runProcess writes complete stream logs. Preserve those files: result.stdout/stderr are
  // intentionally bounded summaries and must never replace the full stream capture.
  mkdirSync(path.join(root, id), { recursive: true });
  const stdoutPath = path.join(root, id, "stdout.log");
  const stderrPath = path.join(root, id, "stderr.log");
  // Injected/fake runners used by offline tests do not necessarily implement logDir.
  // Materialize their bounded output only when the runner did not create a stream log.
  // Checking existence also avoids appending the same summary to a real runner log.
  if (!existsSync(stdoutPath)) writeFileSync(stdoutPath, result.stdout, "utf8");
  if (!existsSync(stderrPath)) writeFileSync(stderrPath, result.stderr, "utf8");
  writeFileSync(path.join(root, id, "result.json"), `${JSON.stringify({
    status: result.status, exitCode: result.exitCode, durationMs: result.durationMs,
    stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256,
    usage: parseCodexUsage(result.stdout)
  }, null, 2)}\n`, "utf8");
};

export const runCodexRuntimePreflight = async (options: CodexRuntimePreflightOptions): Promise<CodexRuntimePreflightResult> => {
  const startedAt = new Date().toISOString();
  const program = options.program ?? "codex";
  const steps: PreflightStep[] = [];
  const proxy = (options.proxyResolver ?? (() => resolveWindowsUserProxy()))();
  const proxyEnv = { ...proxyEnvPresence(proxy), source: proxy.source };
  let artifactCreated = false;
  const invalid = (summary: string): CodexRuntimePreflightResult => ({ passed: false, startedAt, finishedAt: new Date().toISOString(), artifactRoot: options.artifactRoot, proxyEnv, steps, failure: runtimeFailure(ERROR_CODES.PROCESS_START_FAILED, summary) });
  if (options.probeModels !== false && !options.models.length) return invalid("At least one model is required");
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) return invalid("timeoutSeconds must be positive");
  if (existsSync(options.artifactRoot)) return invalid("artifactRoot already exists; refusing to overwrite it");
  try {
    // mkdir without recursive is deliberate: an existing directory must never be reused.
    mkdirSync(options.artifactRoot);
    artifactCreated = true;
    const run = async (id: string, args: string[], cwd = options.artifactRoot): Promise<ProcessResult> => {
      const dir = path.join(options.artifactRoot, id);
      const result = await (options.processRunner ?? runProcess)({ program, args, cwd, timeoutSeconds: options.timeoutSeconds, logDir: dir, env: proxy.env });
      writeStepLogs(options.artifactRoot, id, result);
      steps.push(toStep(id, [program, ...args], result, cwd));
      return result;
    };
    const versionArgs = ["--version"];
    const version = await run("version", versionArgs);
    if (version.status !== "SUCCEEDED") throw classifyProcess("version", version);
    const loginArgs = ["login", "status"];
    const login = await run("login", loginArgs);
    if (login.status !== "SUCCEEDED") throw classifyProcess("login", login);

    const uniqueModels = options.probeModels === false ? [] : [...new Set(options.models)];
    for (const [index, model] of uniqueModels.entries()) {
      const id = `probe-${index + 1}-${model.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
      const tempCwd = mkdtempSync(path.join(os.tmpdir(), "agentplatform-preflight-"));
      mkdirSync(path.join(options.artifactRoot, id));
      const outputPath = path.join(options.artifactRoot, id, "final.json");
      const schemaPath = path.join(options.artifactRoot, id, "schema.json");
      writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { status: { type: "string", const: "ok" } }, required: ["status"], additionalProperties: false }) + "\n", "utf8");
      const args = ["--ask-for-approval", "never", "--disable", "multi_agent", "exec", "--ephemeral", "--ignore-rules", "-c", "agents.enabled=false", "--skip-git-repo-check", "-C", tempCwd, "-m", model, "--sandbox", "read-only", "--json", "--output-schema", schemaPath, "--output-last-message", outputPath, "Return exactly the JSON object {\"status\":\"ok\"}."];
      try {
        const result = await run(id, args, tempCwd);
        steps[steps.length - 1].outputPath = outputPath;
        if (result.status !== "SUCCEEDED") throw classifyProcess("probe", result);
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(outputPath, "utf8")); } catch { throw runtimeFailure(ERROR_CODES.OUTPUT_SCHEMA_INVALID, `Probe for ${model} did not produce valid JSON`); }
        if (JSON.stringify(parsed) !== JSON.stringify({ status: "ok" })) throw runtimeFailure(ERROR_CODES.OUTPUT_SCHEMA_INVALID, `Probe for ${model} returned an unexpected result`);
      } finally { rmSync(tempCwd, { recursive: true, force: true }); }
    }
    const result: CodexRuntimePreflightResult = { passed: true, startedAt, finishedAt: new Date().toISOString(), artifactRoot: options.artifactRoot, proxyEnv, steps };
    writeFileSync(path.join(options.artifactRoot, "preflight-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } catch (error) {
    const failure = (error as RuntimeFailure).code ? error as RuntimeFailure : runtimeFailure(ERROR_CODES.PROCESS_START_FAILED, error instanceof Error ? error.message : String(error));
    const result: CodexRuntimePreflightResult = { passed: false, startedAt, finishedAt: new Date().toISOString(), artifactRoot: options.artifactRoot, proxyEnv, steps, failure };
    if (artifactCreated) writeFileSync(path.join(options.artifactRoot, "preflight-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  }
};

export default runCodexRuntimePreflight;
