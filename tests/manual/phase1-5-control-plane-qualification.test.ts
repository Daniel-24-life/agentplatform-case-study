import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient, type AppServerEvent } from "../../src/main/adapters/codex/codex-app-server-client.js";
import { CodexAdapter, writeCodexOutputSchema } from "../../src/main/adapters/codex/codex-adapter.js";
import { runProcess, type ProcessResult } from "../../src/main/process/runner.js";
import { buildBoundedContext } from "../../src/shared/core/bounded-context.js";
import { buildQualificationPreregistration, evaluateCandidate, type FailureAxis, type QualificationSample, type QualificationUsage } from "../../src/shared/core/control-plane-qualification.js";
import { parseCodexEvent, parseCodexTerminalEvents } from "../../src/shared/core/codex-terminal-events.js";
import { capturePhase14TreeEvidence, createPhase14SourceSnapshot } from "../../src/shared/core/runtime-certification.js";
import { parseTransportObservation, PHASE13_FIXTURE_COMMIT_DATE, validateReadOnlyArchitectResponse, type RuntimeStabilityCase } from "../../src/shared/core/runtime-stability.js";

const prepareEnabled = process.env.RUN_PHASE1_5_PREPARE === "1";
const executeEnabled = process.env.RUN_PHASE1_5_RUNTIME === "1";
const qualificationCase: RuntimeStabilityCase = {
  id: "P15-QUALIFICATION-01", order: 1, kind: "cross_file_reasoning", title: "Bounded control-plane qualification",
  prompt: "Analyze the bounded read-only fixture and return one TaskSpec describing the observed retry-policy contract and its validation. Do not modify files, invoke a Worker, use network, or run write-capable commands.",
  contextPaths: ["README.md", "docs/contract.md", "src/config.ts", "src/policy.ts", "src/evaluator.ts", "tests/requirements.md"],
  acceptanceCriteria: ["covers every prepared path", "preserves read-only intent", "returns valid TaskSpec JSON"],
  fixtureFiles: ["README.md", "docs/contract.md", "src/config.ts", "src/policy.ts", "src/evaluator.ts", "tests/requirements.md"]
};
const fixtureFiles: Record<string, string> = {
  "README.md": "# Phase 1.5 qualification fixture\nThis repository defines a bounded retry policy for read-only runtime inspection.\n",
  "docs/contract.md": "# Contract\nRetry is allowed only for a transient transport signal. Protocol, authentication, and integrity failures fail fast. The retry count cannot exceed the configured limit.\n",
  "src/config.ts": "export type RuntimeConfig = { retryLimit: number; readOnly: boolean };\nexport const config: RuntimeConfig = { retryLimit: 1, readOnly: true };\n",
  "src/policy.ts": "export type FailureKind = 'transport' | 'protocol' | 'auth' | 'integrity';\nexport const retryable = (kind: FailureKind): boolean => kind === 'transport';\n",
  "src/evaluator.ts": "import type { RuntimeConfig } from './config';\nimport { retryable, type FailureKind } from './policy';\nexport const shouldRetry = (config: RuntimeConfig, kind: FailureKind, retries: number): boolean => config.readOnly && retryable(kind) && retries < config.retryLimit;\n",
  "tests/requirements.md": "# Requirements\nR-01 transport may retry once.\nR-02 protocol, auth, and integrity fail fast.\nR-03 readOnly=false disables automatic retry.\nR-04 inspection leaves Git clean.\n"
};
type Reasoning = "low" | "medium" | "high" | "xhigh";
type Prepared = { outputPath: string; executable: string; model: string; reasoning: Reasoning; accountAvailable: boolean; fixtureRoot: string; baseSha: string; schemaPath: string; outputSchema: unknown; prompt: string; request: { promptSha256: string; schemaSha256: string; contextSha256: string }; fixtureTree: ReturnType<typeof capturePhase14TreeEvidence> };
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const hashFile = (filePath: string): string => hash(readFileSync(filePath));
const writeJson = (filePath: string, value: unknown): void => { mkdirSync(path.dirname(filePath), { recursive: true }); writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); };
const readJson = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, "utf8")) as T;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> { const result = await runProcess({ program: "git", args, cwd, timeoutSeconds: 30, env }); if (result.status !== "SUCCEEDED") throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`); return result.stdout.trim(); }

const validPreflight = (filePath: string, executable: string): boolean => {
  if (!path.isAbsolute(filePath) || !existsSync(filePath)) return false;
  const value = readJson<{ passed?: boolean; modelCalls?: number; executable?: { path?: string; sha256?: string }; account?: { accountPresent?: boolean } }>(filePath);
  return value.passed === true && value.modelCalls === 0 && value.account?.accountPresent === true && value.executable?.path === executable && value.executable.sha256 === hashFile(executable);
};

export async function preparePhase15Qualification(env: Record<string, string | undefined> = process.env): Promise<Prepared> {
  const outputPath = env.PHASE1_5_OUTPUT; const executable = env.CODEX_PROGRAM; const preflightPath = env.PHASE1_5_PREFLIGHT_RESULT;
  if (!outputPath || !path.isAbsolute(outputPath)) throw new Error("PHASE1_5_OUTPUT must be a fresh absolute directory");
  if (!executable || !path.isAbsolute(executable) || !existsSync(executable)) throw new Error("CODEX_PROGRAM must be an existing absolute executable");
  if (!preflightPath || !validPreflight(preflightPath, executable)) throw new Error("a matching successful zero-model Phase 1.5 preflight is required");
  const preregistration = buildQualificationPreregistration({ outputPath, calls: ["APP_SERVER", "BOUNDED_EXEC"], historicalPaths: ["phase1-2-evidence", "phase1-3-evidence", "phase1-4-evidence"].map((root) => path.join(process.cwd(), root)) });
  mkdirSync(outputPath);
  const sourceSnapshot = createPhase14SourceSnapshot({ sourceRoot: process.cwd(), snapshotRoot: path.join(outputPath, "source-snapshot") });
  const fixtureRoot = path.join(outputPath, "fixture"); mkdirSync(fixtureRoot, { recursive: true });
  for (const [relative, content] of Object.entries(fixtureFiles)) { const target = path.join(fixtureRoot, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content, "utf8"); }
  await git(fixtureRoot, ["init"]); await git(fixtureRoot, ["config", "user.email", "phase15@example.invalid"]); await git(fixtureRoot, ["config", "user.name", "Phase 1.5 Qualification"]); await git(fixtureRoot, ["add", "."]);
  await git(fixtureRoot, ["commit", "--no-verify", "-m", "Phase 1.5 qualification fixture"], { GIT_AUTHOR_NAME: "Phase 1.5 Qualification", GIT_AUTHOR_EMAIL: "phase15@example.invalid", GIT_AUTHOR_DATE: PHASE13_FIXTURE_COMMIT_DATE, GIT_COMMITTER_NAME: "Phase 1.5 Qualification", GIT_COMMITTER_EMAIL: "phase15@example.invalid", GIT_COMMITTER_DATE: PHASE13_FIXTURE_COMMIT_DATE });
  const baseSha = await git(fixtureRoot, ["rev-parse", "HEAD"]);
  const schemaPath = path.join(sourceSnapshot.sourceRoot, "schemas", "task-spec.schema.json");
  const projectedSchemaPath = writeCodexOutputSchema(schemaPath, path.join(outputPath, "qualification-response-placeholder.json"));
  const schema = readFileSync(projectedSchemaPath, "utf8"); const outputSchema = JSON.parse(schema) as unknown;
  const context = buildBoundedContext(fixtureRoot, qualificationCase.contextPaths, { maxFiles: 10, maxBytesPerFile: 16_384, maxTotalBytes: 65_536 });
  const preparedContext = context.items.map((item) => `FILE ${item.path}\n${item.content}`).join("\n");
  const prompt = `${qualificationCase.prompt}\nUse task_id "${qualificationCase.id}" and base_sha "${baseSha}". Include every prepared file in context_paths. Keep the TaskSpec itself read-only; test_commands may use only git status, git diff --exit-code, or git rev-parse HEAD.\n\nPrepared context (authoritative exact bytes):\n${preparedContext}`;
  const request = { promptSha256: hash(prompt), schemaSha256: hash(schema), contextSha256: hash(preparedContext) }; const fixtureTree = capturePhase14TreeEvidence(fixtureRoot);
  const version = await runProcess({ program: executable, args: ["--version"], cwd: process.cwd(), timeoutSeconds: 15 }); if (version.status !== "SUCCEEDED") throw new Error("Codex version capture failed");
  const requestPath = path.join(outputPath, "qualification-request.json"); writeJson(requestPath, { caseDefinition: qualificationCase, baseSha, prompt, preparedContext, outputSchema, boundedContext: context, request });
  const preregistrationPath = path.join(outputPath, "qualification-preregistration.json"); writeJson(preregistrationPath, { ...preregistration, model: env.PHASE1_5_MODEL ?? "gpt-5.6-sol", reasoning: env.PHASE1_5_REASONING ?? "medium", timeoutSeconds: 300, cleanupSeconds: 10, retryLimit: 0, fixtureTree, request });
  const manifest = { protocolVersion: preregistration.protocolVersion, preparedAt: preregistration.preparedAt, outputPath, executable: { path: executable, sha256: hashFile(executable), version: version.stdout.trim() }, sourceSnapshot: { rootRelative: "source-snapshot", tree: sourceSnapshot.tree, manifestSha256: hashFile(path.join(sourceSnapshot.snapshotRoot, "snapshot-manifest.json")) }, fixture: { rootRelative: "fixture", baseSha, files: qualificationCase.contextPaths, tree: fixtureTree }, request: { path: "qualification-request.json", sha256: hashFile(requestPath), ...request }, preregistration: { path: "qualification-preregistration.json", sha256: hashFile(preregistrationPath) }, preflight: { path: preflightPath, sha256: hashFile(preflightPath) }, realCalls: 0 };
  writeJson(path.join(outputPath, "qualification-prepare-manifest.json"), manifest);
  return { outputPath, executable, model: env.PHASE1_5_MODEL ?? "gpt-5.6-sol", reasoning: (env.PHASE1_5_REASONING as Reasoning | undefined) ?? "medium", accountAvailable: true, fixtureRoot, baseSha, schemaPath, outputSchema, prompt, request, fixtureTree };
}

async function readPrepared(env: Record<string, string | undefined> = process.env): Promise<Prepared> {
  const outputPath = env.PHASE1_5_OUTPUT; const executable = env.CODEX_PROGRAM;
  if (!outputPath || !path.isAbsolute(outputPath) || !existsSync(outputPath)) throw new Error("prepared PHASE1_5_OUTPUT is required");
  if (!executable || !path.isAbsolute(executable) || !existsSync(executable)) throw new Error("CODEX_PROGRAM is required");
  const manifest = readJson<any>(path.join(outputPath, "qualification-prepare-manifest.json"));
  if (manifest.realCalls !== 0 || manifest.executable.path !== executable || manifest.executable.sha256 !== hashFile(executable)) throw new Error("prepared executable identity changed");
  const requestPath = path.join(outputPath, manifest.request.path); const preregistrationPath = path.join(outputPath, manifest.preregistration.path);
  if (hashFile(requestPath) !== manifest.request.sha256 || hashFile(preregistrationPath) !== manifest.preregistration.sha256) throw new Error("prepared request or preregistration changed");
  if (existsSync(path.join(outputPath, "qualification-decision.json"))) throw new Error("Phase 1.5 qualification is already terminal");
  const requestRecord = readJson<any>(requestPath); const preregistration = readJson<any>(preregistrationPath); const fixtureRoot = path.join(outputPath, manifest.fixture.rootRelative);
  if (capturePhase14TreeEvidence(fixtureRoot).digest !== manifest.fixture.tree.digest || await git(fixtureRoot, ["rev-parse", "HEAD"]) !== manifest.fixture.baseSha || (await git(fixtureRoot, ["status", "--porcelain=v1"])).length > 0) throw new Error("prepared fixture changed");
  const snapshotRoot = path.join(outputPath, manifest.sourceSnapshot.rootRelative); const sourceRoot = path.join(snapshotRoot, "source");
  if (capturePhase14TreeEvidence(sourceRoot).digest !== manifest.sourceSnapshot.tree.digest || hashFile(path.join(snapshotRoot, "snapshot-manifest.json")) !== manifest.sourceSnapshot.manifestSha256) throw new Error("prepared source snapshot changed");
  return { outputPath, executable, model: preregistration.model, reasoning: preregistration.reasoning, accountAvailable: true, fixtureRoot, baseSha: manifest.fixture.baseSha, schemaPath: path.join(sourceRoot, "schemas", "task-spec.schema.json"), outputSchema: requestRecord.outputSchema, prompt: requestRecord.prompt, request: manifest.request, fixtureTree: manifest.fixture.tree };
}

const usageFromEvents = (events: AppServerEvent[]): QualificationUsage => { const values = events.map((event) => parseCodexEvent(event).usage).filter((value) => value !== undefined); const latest = values.at(-1); return latest ? { available: true, inputTokens: latest.inputTokens, outputTokens: latest.outputTokens } : { available: false }; };
const extractTerminalOutput = (terminal: unknown): unknown => { if (!isRecord(terminal) || !isRecord(terminal.turn) || !Array.isArray(terminal.turn.items)) throw new Error("turn/completed payload has no items"); if (terminal.turn.status !== "completed") throw new Error(`turn terminal status is ${String(terminal.turn.status)}`); const messages = terminal.turn.items.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "agentMessage" && typeof item.text === "string"); const text = messages.at(-1)?.text; if (typeof text !== "string") throw new Error("turn/completed has no agentMessage text"); return JSON.parse(text) as unknown; };
const processFromError = (error: unknown): ProcessResult | null => { const result = (error as { result?: unknown })?.result; return isRecord(result) && typeof result.status === "string" ? result as unknown as ProcessResult : null; };
async function fixtureClean(prepared: Prepared): Promise<boolean> { return (await git(prepared.fixtureRoot, ["status", "--porcelain=v1"])).length === 0 && capturePhase14TreeEvidence(prepared.fixtureRoot).digest === prepared.fixtureTree.digest; }

async function executeAppServer(prepared: Prepared): Promise<QualificationSample> {
  const armRoot = path.join(prepared.outputPath, "app-server"); mkdirSync(armRoot); const started = Date.now(); const client = new CodexAppServerClient({ program: prepared.executable, timeoutMs: 300_000 });
  let authoritative = false, schema = false, semantic = false; let output: unknown = null; let events: AppServerEvent[] = []; let usage: QualificationUsage = { available: false }; let symptom: string | null = null; let error: { name: string; message: string } | null = null;
  try { await client.initialize(); const account = await client.accountRead(); if (!isRecord(account) || !isRecord(account.account)) throw new Error("account/read returned no active account"); const thread = await client.threadStart({ cwd: prepared.fixtureRoot, model: prepared.model, reasoning: prepared.reasoning }); if (!isRecord(thread) || !isRecord(thread.thread) || typeof thread.thread.id !== "string") throw new Error("thread/start returned no thread id"); const result = await client.turnStart(thread.thread.id, prepared.prompt, prepared.outputSchema); events = result.events; usage = usageFromEvents(events); authoritative = true; output = extractTerminalOutput(result.terminal); const validation = validateReadOnlyArchitectResponse(output, qualificationCase, prepared.baseSha, qualificationCase.fixtureFiles); schema = validation.schemaValid; semantic = validation.semanticValid; if (!validation.valid) symptom = `OUTPUT_INVALID: ${validation.issues.join("; ")}`; }
  catch (cause) { const failure = cause instanceof Error ? cause : new Error(String(cause)); error = { name: failure.name, message: failure.message }; symptom = /timeout/i.test(failure.message) ? "PROCESS_TIMEOUT" : "TERMINAL_FAILURE"; }
  finally { await client.close(); }
  const integrity = await fixtureClean(prepared); const process = client.getProcessDiagnostics(); const axes: FailureAxis[] = [];
  if (!process.closeObserved || !process.stdoutClosed || !process.stderrClosed) axes.push("PLATFORM_PROCESS_CONTROL"); if (!authoritative) axes.push("CODEX_CONTROL_PLANE_COMPLETION"); if (!schema) axes.push("PROTOCOL_OUTPUT"); if ((output !== null && !semantic) || !integrity) axes.push("SEMANTIC_INTEGRITY"); if (error && /transport|connection|stream|network|reconnect/i.test(error.message)) axes.push("TRANSPORT_SIGNAL");
  const sample: QualificationSample = { id: "P15-APP-SERVER-01", candidate: "APP_SERVER", duration: Date.now() - started, authoritative, schema, semantic, integrity, fixtureClean: integrity, retry: 0, human: false, processConverged: process.closeObserved, stdioConverged: process.stdoutClosed && process.stderrClosed, transportFallback: false, protocolAmbiguous: false, usage, accountAvailable: prepared.accountAvailable, failureSymptom: symptom, axes: [...new Set(axes)] };
  writeJson(path.join(armRoot, "events.json"), events); writeJson(path.join(armRoot, "result.json"), { sample, output, process, error, request: prepared.request }); return sample;
}

async function executeBoundedExec(prepared: Prepared): Promise<QualificationSample> {
  const armRoot = path.join(prepared.outputPath, "bounded-exec"); mkdirSync(armRoot); const outputPath = path.join(armRoot, "response.json"); const started = Date.now(); const adapter = new CodexAdapter(prepared.executable);
  let execution: Awaited<ReturnType<CodexAdapter["runPlanner"]>> | null = null; let process: ProcessResult | null = null; let schema = false, semantic = false; let symptom: string | null = null; let error: { name: string; message: string } | null = null;
  try { execution = await adapter.runPlanner({ cwd: prepared.fixtureRoot, model: prepared.model, reasoning: prepared.reasoning, timeoutSeconds: 300, schemaPath: prepared.schemaPath, outputPath, prompt: prepared.prompt, runId: "phase15-bounded-exec-01" }); process = execution.process; const validation = validateReadOnlyArchitectResponse(execution.output, qualificationCase, prepared.baseSha, qualificationCase.fixtureFiles); schema = validation.schemaValid; semantic = validation.semanticValid; if (!validation.valid) symptom = `OUTPUT_INVALID: ${validation.issues.join("; ")}`; }
  catch (cause) { const failure = cause instanceof Error ? cause : new Error(String(cause)); error = { name: failure.name, message: failure.message }; process = processFromError(cause); symptom = process?.status === "TIMED_OUT" ? "PROCESS_TIMEOUT" : "TERMINAL_FAILURE"; }
  const terminalEvents = parseCodexTerminalEvents(process?.stdout ?? ""); const authoritative = process?.status === "SUCCEEDED" && terminalEvents.some((event) => event.kind === "completed"); const integrity = await fixtureClean(prepared); const transport = parseTransportObservation(process?.stdout ?? "", process?.stderr ?? "", false); const processConverged = Boolean(process?.closeObserved && (process.stdoutClosed || process.stdoutDestroyed) && (process.stderrClosed || process.stderrDestroyed)); const axes: FailureAxis[] = [];
  if (!processConverged) axes.push("PLATFORM_PROCESS_CONTROL"); if (!authoritative) axes.push("CODEX_CONTROL_PLANE_COMPLETION"); if (transport.reconnectCount > 0 || transport.fallbackCount > 0) axes.push("TRANSPORT_SIGNAL"); if (!schema) axes.push("PROTOCOL_OUTPUT"); if ((execution !== null && !semantic) || !integrity) axes.push("SEMANTIC_INTEGRITY");
  const generatedSchemaPath = path.join(armRoot, "codex-output-schema.json"); const expectedSchemaHash = hash(`${JSON.stringify(prepared.outputSchema, null, 2)}\n`); const protocolAmbiguous = !existsSync(generatedSchemaPath) || hashFile(generatedSchemaPath) !== expectedSchemaHash; if (protocolAmbiguous && !axes.includes("PROTOCOL_OUTPUT")) axes.push("PROTOCOL_OUTPUT");
  const usage: QualificationUsage = execution?.usage ? { available: true, inputTokens: execution.usage.inputTokens, outputTokens: execution.usage.outputTokens } : { available: false };
  const sample: QualificationSample = { id: "P15-BOUNDED-EXEC-01", candidate: "BOUNDED_EXEC", duration: Date.now() - started, authoritative, schema, semantic, integrity, fixtureClean: integrity, retry: 0, human: false, processConverged, stdioConverged: processConverged, transportFallback: transport.fallbackCount > 0, protocolAmbiguous, usage, accountAvailable: prepared.accountAvailable, failureSymptom: symptom, axes: [...new Set(axes)] };
  writeJson(path.join(armRoot, "result.json"), { sample, output: execution?.output ?? null, process: process ? { status: process.status, exitCode: process.exitCode, durationMs: process.durationMs, closeObserved: process.closeObserved, stdoutClosed: process.stdoutClosed, stderrClosed: process.stderrClosed, stdoutSha256: process.stdoutSha256, stderrSha256: process.stderrSha256, termination: process.termination ?? null } : null, terminalEvents, transport, error, request: prepared.request }); return sample;
}

export async function executePhase15Qualification(env: Record<string, string | undefined> = process.env): Promise<{ samples: QualificationSample[] }> {
  const prepared = await readPrepared(env); const samples: QualificationSample[] = [await executeAppServer(prepared)];
  if (!samples[0].fixtureClean || !samples[0].processConverged || samples[0].axes.includes("AUTH_ACCOUNT_AVAILABILITY")) { writeJson(path.join(prepared.outputPath, "qualification-decision.json"), { stoppedAfter: "APP_SERVER", reason: "stop condition after first call", samples, appServer: evaluateCandidate("APP_SERVER", samples), boundedExec: evaluateCandidate("BOUNDED_EXEC", samples), runtimeCertification: "NOT_RUN" }); return { samples }; }
  samples.push(await executeBoundedExec(prepared));
  const decision = { stoppedAfter: "BOUNDED_EXEC", reason: "matched two-arm evidence complete", samples, appServer: evaluateCandidate("APP_SERVER", samples), boundedExec: evaluateCandidate("BOUNDED_EXEC", samples), runtimeCertification: "NOT_RUN", productHypothesis: "NOT_EVALUATED", pilotReadiness: "NOT_READY" }; writeJson(path.join(prepared.outputPath, "qualification-decision.json"), decision);
  const manifest = readJson<Record<string, unknown>>(path.join(prepared.outputPath, "qualification-prepare-manifest.json")); writeJson(path.join(prepared.outputPath, "qualification-execution-manifest.json"), { ...manifest, realCalls: samples.length, completedAt: new Date().toISOString(), decisionSha256: hashFile(path.join(prepared.outputPath, "qualification-decision.json")) }); return { samples };
}

describe("Phase 1.5 control-plane qualification", () => {
  it.skipIf(!prepareEnabled)("prepares a fresh fixture and bounded request without executing a model", async () => { const result = await preparePhase15Qualification(); expect(readJson(path.join(result.outputPath, "qualification-prepare-manifest.json"))).toMatchObject({ protocolVersion: "phase1-5-control-plane-qualification-v1", realCalls: 0 }); }, 120_000);
  it.skipIf(!executeEnabled)("executes the preregistered app-server and bounded exec comparison", async () => { const result = await executePhase15Qualification(); expect(result.samples.length).toBeLessThanOrEqual(2); expect(result.samples[0]?.candidate).toBe("APP_SERVER"); }, 630_000);
});
