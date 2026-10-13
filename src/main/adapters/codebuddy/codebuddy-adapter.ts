import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess, type ProcessResult } from "../../process/runner.js";
import { resolveWindowsUserProxy } from "../../runtime/windows-user-proxy.js";
import { validateTaskSpec, type TaskSpec } from "../../../shared/core/task-spec.js";
import {
  validateChangeSetAgainstRequest,
  validateWorkerProposalRequest,
  type ChangeOperation,
  type ChangeSet,
  type WorkerProposalRequest
} from "../../../shared/core/worker-proposal.js";
import { classifyFailureCode, classifyProcessResult } from "../../../shared/core/failure-taxonomy.js";
import { ERROR_CODES } from "../../../shared/core/errors.js";
import { AgentOutputError, AgentRunError, type AgentExecution, type AgentUsage, type PlannerAgentAdapter, type PlannerInput } from "../agent-adapter.js";

export type CodeBuddyExecutable = {
  nodePath: string;
  entryPath: string;
};

export type CodeBuddyExecutableResolverOptions = {
  env?: Record<string, string | undefined>;
  fileExists?: (_candidate: string) => boolean;
};

export type CodeBuddyAdapterOptions = {
  executableResolver?: () => CodeBuddyExecutable;
  proxyResolver?: () => Record<string, string>;
  processRunner?: typeof runProcess;
};

export type CodeBuddyCommandInput = Pick<PlannerInput, "model" | "reasoning" | "schemaPath" | "prompt">;

export type {
  ChangeOperation,
  ChangeSet,
  WorkerProposalContextFile,
  WorkerProposalLimits,
  WorkerProposalRequest
} from "../../../shared/core/worker-proposal.js";

/** Compatibility spelling for callers that use the artifact-oriented name. */
export type ChangeSetOperation = ChangeOperation;

/**
 * The proposal adapter deliberately keeps its input separate from WorkerInput.
 * WorkerInput.cwd is the disposable worktree for the direct Codex worker; a
 * proposal worker must instead run from an empty, AgentPlatform-owned run
 * directory and receive the bounded request through a system-prompt file.
 */
export type CodeBuddyProposalInput = {
  request: WorkerProposalRequest;
  /** Empty AgentPlatform-owned run directory used as provider cwd. */
  runDirectory: string;
  model: string;
  reasoning?: PlannerInput["reasoning"];
  timeoutSeconds?: number;
  schemaPath: string;
  outputPath: string;
  hashOnlyLogs?: boolean;
  runId?: string;
  onSpawn?: (_pid: number | null) => void;
  onOutput?: (_stream: "stdout" | "stderr", _atMs: number, _bytes: number) => void;
};

export type CodeBuddyProposalCommandInput = Pick<CodeBuddyProposalInput, "model" | "reasoning" | "schemaPath"> & {
  systemPromptPath: string;
};

export type CodeBuddyTerminalResult = {
  terminal: Record<string, unknown>;
  structuredOutput: unknown;
  usage: AgentUsage | null;
};

export type CodeBuddyParsedOutput =
  | ({ kind: "success" } & CodeBuddyTerminalResult)
  | ({ kind: "provider-error"; message: string } & Omit<CodeBuddyTerminalResult, "structuredOutput">);

const CODEBUDDY_PACKAGE_ENTRY = ["node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy"];
const CODEBUDDY_SYSTEM_PROMPT = "You are AgentPlatform's read-only planner. Do not use tools, modify files, or emit prose. Return exactly one TaskSpec object matching the supplied JSON Schema.";
const CODEBUDDY_PROPOSAL_SYSTEM_PROMPT = [
  "You are AgentPlatform's bounded worker.",
  "You have no tools and must not access files, execute commands, or modify a repository.",
  "Use only the bounded worker proposal request below.",
  "Return exactly one change-set JSON object matching the supplied JSON Schema and no prose.",
  "The platform, not you, will validate and apply any proposed operation."
].join("\n");

export const buildCodeBuddyProposalSystemPrompt = (request: WorkerProposalRequest): string =>
  `${CODEBUDDY_PROPOSAL_SYSTEM_PROMPT}\n\nWORKER_PROPOSAL_REQUEST_JSON:\n${JSON.stringify(request)}\n`;
const CODEBUDDY_SETTING_SOURCES = "";
const SUPPORTED_SCHEMA_KEYS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "$defs", "$ref",
  "description", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "minLength", "maxLength"
]);
const SCHEMA_MAP_KEYS = new Set(["properties", "$defs"]);

const projectSchemaValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(projectSchemaValue);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && entry && typeof entry === "object" && !Array.isArray(entry)) {
      const map: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(entry as Record<string, unknown>)) map[name] = projectSchemaValue(schema);
      output[key] = map;
    } else {
      output[key] = projectSchemaValue(entry);
    }
  }
  return output;
};

const readProjectedSchema = (schemaPath: string): string => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
  return JSON.stringify(projectSchemaValue(schema));
};

/** Build the fixed, tool-disabled CodeBuddy planner invocation. The prompt is always the final argument. */
export const buildCodeBuddyArgs = (input: CodeBuddyCommandInput): string[] => [
  "--print",
  "--output-format", "json",
  "--model", input.model,
  "--effort", input.reasoning ?? "low",
  "--permission-mode", "plan",
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", "{}",
  "--no-session-persistence",
  "--max-turns", "1",
  "--json-schema", readProjectedSchema(input.schemaPath),
  "--system-prompt", CODEBUDDY_SYSTEM_PROMPT,
  "--setting-sources", CODEBUDDY_SETTING_SOURCES,
  input.prompt
];

/** Build the fixed, tool-disabled CodeBuddy worker-proposal invocation. */
export const buildCodeBuddyProposalArgs = (input: CodeBuddyProposalCommandInput): string[] => [
  "--print",
  "--output-format", "json",
  "--model", input.model,
  "--effort", input.reasoning ?? "low",
  "--permission-mode", "plan",
  "--tools", "",
  "--strict-mcp-config",
  "--mcp-config", "{}",
  "--no-session-persistence",
  "--max-turns", "1",
  "--json-schema", readProjectedSchema(input.schemaPath),
  "--system-prompt-file", input.systemPromptPath,
  "--setting-sources", CODEBUDDY_SETTING_SOURCES,
  "Return exactly one change-set JSON object."
];

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const ancestorDirectories = (directory: string, depth: number): string[] => {
  const result: string[] = [];
  let current = path.resolve(directory);
  for (let index = 0; index <= depth; index += 1) {
    if (!result.includes(current)) result.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

/** Resolve a global npm CodeBuddy install to node.exe plus its JavaScript entry, never a .cmd/.ps1 shim. */
export const resolveCodeBuddyExecutable = (options: CodeBuddyExecutableResolverOptions = {}): CodeBuddyExecutable => {
  const env = options.env ?? process.env;
  const exists = options.fileExists ?? isFile;
  const pathValue = env.PATH ?? env.Path ?? "";
  const pathEntries = pathValue.split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const roots = pathEntries.flatMap((entry) => ancestorDirectories(entry, 3));
  const seenRoots = [...new Set(roots)];
  const nodeNames = process.platform === "win32" ? ["node.exe"] : ["node", "node.exe"];
  for (const root of seenRoots) {
    const nodePath = nodeNames.map((name) => path.join(root, name)).find(exists);
    if (!nodePath) continue;
    const entryPath = path.join(root, ...CODEBUDDY_PACKAGE_ENTRY);
    if (exists(entryPath)) return { nodePath, entryPath };
  }
  throw new Error("CodeBuddy node.exe and JavaScript entry were not found in PATH");
};

const readNonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const terminalFromStdout = (stdout: string): Record<string, unknown> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    const terminal = parsed.at(-1);
    return terminal && typeof terminal === "object" && !Array.isArray(terminal)
      ? terminal as Record<string, unknown>
      : null;
  }
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
};

const parseUsageFromTerminal = (terminal: Record<string, unknown> | null): AgentUsage | null => {
  if (!terminal) return null;
  const raw = terminal.usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const inputTokens = readNonNegativeInteger(usage.input_tokens);
  const outputTokens = readNonNegativeInteger(usage.output_tokens);
  const totalTokens = readNonNegativeInteger(usage.total_tokens);
  const cachedInputTokens = readNonNegativeInteger(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  return inputTokens === null && outputTokens === null && totalTokens === null && cachedInputTokens === null
    ? null
    : { inputTokens, outputTokens, totalTokens, cachedInputTokens };
};

/** Parse only the terminal CodeBuddy JSON result and its explicit usage object. */
export const parseCodeBuddyOutput = (stdout: string): CodeBuddyParsedOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch (cause) {
    throw new Error(`CodeBuddy JSON output is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const terminal = Array.isArray(parsed)
    ? parsed.at(-1)
    : parsed;
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) {
    throw new Error("CodeBuddy output does not contain a terminal result object");
  }
  const result = terminal as Record<string, unknown>;
  if (result.type !== "result") throw new Error("CodeBuddy output terminal event is not result");
  const usage = parseUsageFromTerminal(result);
  const providerMessage = typeof result.result === "string"
    ? result.result
    : typeof result.error === "string"
      ? result.error
      : "CodeBuddy provider returned an unsuccessful result";
  if (result.subtype !== "success" || result.is_error === true) {
    return { kind: "provider-error", terminal: result, usage, message: providerMessage };
  }
  if (!Object.prototype.hasOwnProperty.call(result, "structured_output")) {
    throw new Error("CodeBuddy successful result is missing structured_output");
  }
  return { kind: "success", terminal: result, structuredOutput: result.structured_output, usage };
};

/** Read only explicit usage from a terminal CodeBuddy JSON object/array. */
export const parseCodeBuddyUsage = (stdout: string): AgentUsage | null => parseUsageFromTerminal(terminalFromStdout(stdout));

const tail = (value: string): string => value.length <= 4096 ? value : value.slice(-4096);

const processFailure = (result: ProcessResult, detail?: string) => classifyProcessResult({
  status: result.status === "SUCCEEDED" ? "FAILED" : result.status,
  stdout: detail ?? result.stdout,
  stderr: result.stderr
}) ?? classifyFailureCode(ERROR_CODES.MODEL_RUNTIME_FAILED);

/**
 * Validate the proposal request and returned change set at the adapter boundary.
 * These calls are deliberately delegated to the versioned shared validator so
 * identity, scope, path-collision and byte-limit semantics cannot drift from
 * the controlled applier.
 */
const validateProposalRequest = (value: unknown) => validateWorkerProposalRequest(value);

const validateProposalChangeSet = (
  value: unknown,
  request: WorkerProposalRequest
): ReturnType<typeof validateChangeSetAgainstRequest> => validateChangeSetAgainstRequest(value, request);

const writeProposalSystemPrompt = (
  runDirectory: string,
  request: WorkerProposalRequest
): string => {
  // The adapter owns creation of the provider cwd. Requiring an absent leaf
  // prevents callers from pointing CodeBuddy at a repository, a symlink, or a
  // directory containing pre-existing material.
  mkdirSync(runDirectory);
  const promptPath = path.join(runDirectory, "codebuddy-system-prompt.txt");
  writeFileSync(
    promptPath,
    buildCodeBuddyProposalSystemPrompt(request),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  return promptPath;
};

export class CodeBuddyRunError extends AgentRunError {
  constructor(result: ProcessResult, detail?: string) {
    const details = [result.stderr ? `stderr: ${tail(result.stderr)}` : "", result.stdout ? `stdout: ${tail(result.stdout)}` : ""].filter(Boolean).join("\n");
    super(detail ?? (details || result.status), result, processFailure(result, detail));
    this.name = "CodeBuddyRunError";
  }
}

export class CodeBuddyOutputError extends AgentOutputError {
  readonly code = ERROR_CODES.OUTPUT_SCHEMA_INVALID;

  constructor(result: ProcessResult, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`OUTPUT_SCHEMA_INVALID${detail ? `: ${detail}` : ""}`, result, classifyFailureCode(ERROR_CODES.OUTPUT_SCHEMA_INVALID), { cause });
    this.name = "CodeBuddyOutputError";
  }
}

export class CodeBuddyAdapter implements PlannerAgentAdapter {
  readonly id = "codebuddy";
  private readonly executableResolver: () => CodeBuddyExecutable;
  private readonly proxyResolver: () => Record<string, string>;
  private readonly processRunner: typeof runProcess;

  constructor(options: CodeBuddyAdapterOptions = {}) {
    this.executableResolver = options.executableResolver ?? (() => resolveCodeBuddyExecutable());
    this.proxyResolver = options.proxyResolver ?? (() => resolveWindowsUserProxy().env);
    this.processRunner = options.processRunner ?? runProcess;
  }

  private async run(input: PlannerInput): Promise<ProcessResult> {
    const executable = this.executableResolver();
    return this.processRunner({
      program: executable.nodePath,
      args: [executable.entryPath, ...buildCodeBuddyArgs(input)],
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds ?? 900,
      logDir: path.dirname(input.outputPath),
      hashOnlyLogs: input.hashOnlyLogs,
      runId: input.runId,
      onSpawn: input.onSpawn,
      onOutput: input.onOutput,
      env: this.proxyResolver()
    });
  }

  private async runProposalProcess(
    input: CodeBuddyProposalInput,
    systemPromptPath: string
  ): Promise<ProcessResult> {
    const executable = this.executableResolver();
    return this.processRunner({
      program: executable.nodePath,
      args: [
        executable.entryPath,
        ...buildCodeBuddyProposalArgs({
          model: input.model,
          reasoning: input.reasoning,
          schemaPath: input.schemaPath,
          systemPromptPath
        })
      ],
      // This must remain the empty AgentPlatform run directory. In particular,
      // never substitute a managed worktree or the caller's repository cwd.
      cwd: input.runDirectory,
      timeoutSeconds: input.timeoutSeconds ?? 180,
      logDir: path.dirname(input.outputPath),
      hashOnlyLogs: input.hashOnlyLogs,
      runId: input.runId,
      onSpawn: input.onSpawn,
      onOutput: input.onOutput,
      env: this.proxyResolver()
    });
  }

  async runPlanner(input: PlannerInput): Promise<AgentExecution<TaskSpec>> {
    const process = await this.run(input);
    if (process.status !== "SUCCEEDED") throw new CodeBuddyRunError(process);
    let parsed: CodeBuddyParsedOutput;
    try {
      parsed = parseCodeBuddyOutput(process.stdout);
    } catch (cause) {
      throw new CodeBuddyOutputError(process, cause);
    }
    if (parsed.kind === "provider-error") throw new CodeBuddyRunError(process, parsed.message);
    try {
      mkdirSync(path.dirname(input.outputPath), { recursive: true });
      writeFileSync(input.outputPath, `${JSON.stringify(parsed.structuredOutput, null, 2)}\n`, "utf8");
      const checked = validateTaskSpec(parsed.structuredOutput);
      if (!checked.valid) throw new Error(`OUTPUT_SCHEMA_INVALID: ${checked.issues.map((issue) => issue.path).join(",")}`);
      return { output: checked.value, process, usage: parsed.usage };
    } catch (cause) {
      throw new CodeBuddyOutputError(process, cause);
    }
  }

  /**
   * Execute CodeBuddy as a bounded proposal worker. This is intentionally an
   * explicit experimental method rather than a WorkerAgentAdapter route: the
   * platform still owns validation, application and all authoritative tests.
   */
  async runProposal(input: CodeBuddyProposalInput): Promise<AgentExecution<ChangeSet>> {
    const request = validateProposalRequest(input.request);
    if (!request.valid) {
      throw new Error(`WORKER_PROPOSAL_REQUEST_INVALID: ${request.issues.map((issue) => issue.path).join(",")}`);
    }

    const systemPromptPath = writeProposalSystemPrompt(input.runDirectory, request.value);
    const process = await this.runProposalProcess(input, systemPromptPath);
    if (process.status !== "SUCCEEDED") throw new CodeBuddyRunError(process);

    let parsed: CodeBuddyParsedOutput;
    try {
      parsed = parseCodeBuddyOutput(process.stdout);
    } catch (cause) {
      throw new CodeBuddyOutputError(process, cause);
    }
    if (parsed.kind === "provider-error") throw new CodeBuddyRunError(process, parsed.message);

    try {
      const checked = validateProposalChangeSet(parsed.structuredOutput, request.value);
      if (!checked.valid) {
        throw new Error(`OUTPUT_SCHEMA_INVALID: ${checked.issues.map((issue) => issue.path).join(",")}`);
      }
      mkdirSync(path.dirname(input.outputPath), { recursive: true });
      writeFileSync(input.outputPath, `${JSON.stringify(checked.value, null, 2)}\n`, "utf8");
      return { output: checked.value, process, usage: parsed.usage };
    } catch (cause) {
      throw new CodeBuddyOutputError(process, cause);
    }
  }

  /** Alias kept explicit for callers that name the role rather than the artifact. */
  async runWorkerProposal(input: CodeBuddyProposalInput): Promise<AgentExecution<ChangeSet>> {
    return this.runProposal(input);
  }
}
