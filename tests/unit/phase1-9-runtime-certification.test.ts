import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import {
  buildPhase19Prompt,
  evaluatePhase19Run,
  evaluatePhase19Sample,
  PHASE_1_9_CASE_IDS,
  validatePhase19ExecutionApproval,
  type Phase19Registration,
  type Phase19Sample,
} from "../../src/shared/core/phase1-9-runtime-certification.js";

const registration = (): Phase19Registration => ({
  version: "phase1.9-codex-exec.v1",
  model: "gpt-5.6-sol",
  reasoning: "medium",
  timeoutMs: 300_000,
  cleanupCeilingMs: 10_000,
  retryCount: 0,
  humanInterventionCount: 0,
  cases: PHASE_1_9_CASE_IDS.map((id, index) => ({
    id, order: index + 1, title: `Case ${index + 1}`, focus: "scope",
    fixtureFiles: ["spec.md"], contextPaths: ["spec.md"],
    baseSha: "a".repeat(40), baseTree: "b".repeat(40),
    contextSha256: "c".repeat(64), contextBytes: 10,
    prompt: `task_id MUST be exactly: ${id}\nbase_sha MUST be exactly: ${"a".repeat(40)}\ntest_commands are declarations for the platform to execute later; do not execute them`,
    promptSha256: "d".repeat(64), schemaSha256: "e".repeat(64),
  })),
});

const task = (id: string = PHASE_1_9_CASE_IDS[0]) => ({
  schema_version: "2.0",
  task_id: id,
  title: "Bound path scope",
  goal: "Define safe change boundaries",
  base_sha: "a".repeat(40),
  context_paths: ["spec.md"],
  scope: { allowed_paths: ["spec.md"], forbidden_paths: ["src/main/**"] },
  test_commands: [{ id: "unit-tests", program: "pnpm", args: ["test"], cwd: ".", timeout_seconds: 300, required: true }],
  acceptance_criteria: [{ id: "AC-01", text: "Only declared paths may change" }],
  execution_policy: { planner_recommendation: "strong", planner_confidence: "high", recommendation_reasons: ["bounded task"], user_lock: null },
  limits: { max_attempts: 1, run_timeout_seconds: 600, max_changed_files: 10, max_diff_bytes: 100_000 },
});

const sample = (id: string = PHASE_1_9_CASE_IDS[0]): Phase19Sample => ({
  id, order: PHASE_1_9_CASE_IDS.indexOf(id) + 1,
  processStatus: "SUCCEEDED", exitCode: 0, durationMs: 100, cleanupDurationMs: 10,
  stdout: '{"type":"turn.completed","usage":{"input_tokens":1}}\n',
  taskSpec: task(id),
  before: { head: "a".repeat(40), tree: "b".repeat(40), status: "" },
  after: { head: "a".repeat(40), tree: "b".repeat(40), status: "" },
  processConverged: true, stdioConverged: true, artifactHashesValid: true,
  retryCount: 0, humanIntervention: false,
});

describe("Phase 1.9 Codex CLI offline certification contract", () => {
  it("renders the exact test command as an object array rather than a double-encoded string", () => {
    const prompt = buildPhase19Prompt({ taskId: "P19-ARCH-06", baseSha: "a".repeat(40), focus: "worker result", contextPaths: ["worker-result.ts"], allowedPaths: ["worker-result.ts"] });
    const encoded = prompt.match(/test_commands MUST equal this JSON array exactly;[^\n]*: (\[[^\n]+\])/ )?.[1];
    expect(encoded).toBeDefined();
    const commands = JSON.parse(encoded ?? "null") as unknown[];
    expect(commands).toEqual([{ id: "unit-tests", program: "pnpm", args: ["test"], cwd: ".", timeout_seconds: 300, required: true }]);
    expect(prompt).toContain("never 3000");
  });

  it("exercises the production CodexAdapter using only a local fake executable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentplatform-p19-fake-"));
    try {
      const fakePath = path.join(root, "fake-codex.cjs");
      const outputPath = path.join(root, "task-spec.json");
      const argsPath = path.join(root, "received-args.json");
      const schemaPath = path.resolve("schemas/task-spec.schema.json");
      const fakeTask = task();
      writeFileSync(fakePath, [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
        "const out = args[args.indexOf('--output-last-message') + 1];",
        `fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(fakeTask))});`,
        "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}) + '\\n');",
      ].join("\n"), { flag: "wx" });
      const adapter = new CodexAdapter(process.execPath, [fakePath], () => ({}));
      const execution = await adapter.runPlanner({
        cwd: root, model: "gpt-5.6-sol", reasoning: "medium", timeoutSeconds: 10,
        schemaPath, outputPath, prompt: "offline fake request", runId: "p19-fake-only",
      });
      const received = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      expect(execution.output).toMatchObject({ task_id: PHASE_1_9_CASE_IDS[0], base_sha: "a".repeat(40) });
      expect(execution.process.status).toBe("SUCCEEDED");
      expect(execution.process.closeObserved).toBe(true);
      expect(execution.process.stdoutClosed).toBe(true);
      expect(execution.process.stderrClosed).toBe(true);
      expect(execution.usage?.totalTokens).toBeNull();
      expect(received).toContain("--disable");
      expect(received).toContain("multi_agent");
      expect(received.slice(received.indexOf("--sandbox"), received.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
      expect(received).toContain("--output-schema");
      expect(received).toContain("--json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts product-valid structured non-Git test commands and rejects identity drift", () => {
    const r = registration();
    expect(evaluatePhase19Sample(r, sample()).status).toBe("PASS");
    const wrongIdentity = sample();
    wrongIdentity.taskSpec = task("P19-ARCH-02");
    expect(evaluatePhase19Sample(r, wrongIdentity).reasons).toContain("IDENTITY:task_id:TASK_ID_MISMATCH");
  });

  it.each([
    ["malformed stream", { stdout: "not-json\n" }, "AUTHORITATIVE_TERMINAL_INVALID"],
    ["missing terminal", { stdout: '{"type":"item.started"}\n' }, "AUTHORITATIVE_TERMINAL_INVALID"],
    ["timeout", { processStatus: "TIMED_OUT", exitCode: null }, "PROCESS_TIMEOUT"],
    ["cancellation", { processStatus: "CANCELLED", exitCode: null }, "PROCESS_CANCELLED"],
    ["process leak", { processConverged: false }, "PROCESS_TREE_NOT_CONVERGED"],
    ["stdio leak", { stdioConverged: false }, "STDIO_NOT_CONVERGED"],
    ["evidence drift", { artifactHashesValid: false }, "EVIDENCE_HASH_INVALID"],
    ["fixture mutation", { after: { head: "f".repeat(40), tree: "b".repeat(40), status: " M spec.md" } }, "FIXTURE_MUTATED"],
    ["retry", { retryCount: 1 }, "RETRY_NOT_ZERO"],
    ["human intervention", { humanIntervention: true }, "HUMAN_INTERVENTION_OCCURRED"],
  ] as const)("rejects %s", (_label, override, reason) => {
    const result = evaluatePhase19Sample(registration(), { ...sample(), ...override } as Phase19Sample);
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain(reason);
  });

  it("stops at the first fatal case and keeps later registered cases NOT RUN", () => {
    const first = sample();
    first.processStatus = "FAILED";
    const decision = evaluatePhase19Run(registration(), [first]);
    expect(decision.status).toBe("FAIL");
    expect(decision.calls).toBe(1);
    expect(decision.notRun).toEqual(PHASE_1_9_CASE_IDS.slice(1));
    expect(decision.reasons).not.toContain("SAMPLES_CONTINUE_AFTER_FATAL");
    expect(evaluatePhase19Run(registration(), [first, sample(PHASE_1_9_CASE_IDS[1])]).reasons).toContain("SAMPLES_CONTINUE_AFTER_FATAL");
  });

  it("blocks incomplete and invalid registrations", () => {
    const r = registration();
    expect(evaluatePhase19Run(r, [sample()]).status).toBe("BLOCKED");
    r.cases = r.cases.slice(1);
    expect(evaluatePhase19Run(r, []).status).toBe("BLOCKED");
  });

  it("refuses real execution unless separate approval matches the exact seal and fresh output root", () => {
    const expected = { preparationSealSha256: "f".repeat(64), outputRoot: "E:\\agentplatform\\phase1-10-runtime-certification-run1", outputRootExists: false };
    const approval = { execution_authorized: true, preparation_seal_sha256: "f".repeat(64), output_root: expected.outputRoot, max_requests: 10, retry_count: 0, stop_on_first_fatal: true };
    expect(validatePhase19ExecutionApproval(approval, expected)).toEqual([]);
    expect(validatePhase19ExecutionApproval({ ...approval, execution_authorized: false }, expected)).toContain("EXECUTION_NOT_AUTHORIZED");
    expect(validatePhase19ExecutionApproval({ ...approval, preparation_seal_sha256: "e".repeat(64) }, expected)).toContain("PREPARATION_SEAL_MISMATCH");
    expect(validatePhase19ExecutionApproval(approval, { ...expected, outputRootExists: true })).toContain("OUTPUT_ROOT_NOT_FRESH");
    expect(validatePhase19ExecutionApproval({ ...approval, max_requests: 11 }, expected)).toContain("REQUEST_BUDGET_INVALID");
  });
});
