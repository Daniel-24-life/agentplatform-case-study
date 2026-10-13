import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import type { ProcessResult } from "../../src/main/process/runner.js";
import type { Phase19ExecutionApproval } from "../../src/shared/core/phase1-9-runtime-certification.js";
import { createPhase19Preparation } from "../manual/phase1-9-runtime-certification.js";
import { executePhase110Cases, executePhase110RealRun, verifyPhase110Readiness, verifyPhase110Ready, verifyPhase110RunArtifacts, type Phase110PreflightInput } from "../manual/phase1-10-runtime-certification.js";

const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];

function setup(variant: "original" | "requalification" | "run3" = "original") {
  const root = mkdtempSync(path.join(tmpdir(), "agentplatform-p110-"));
  roots.push(root);
  const schemaDir = path.join(root, "schemas");
  mkdirSync(schemaDir);
  const schemaPath = path.join(schemaDir, "task-spec.schema.json");
  writeFileSync(schemaPath, readFileSync(path.resolve("schemas/task-spec.schema.json")));
  const prepParent = path.join(root, variant === "original" ? "phase1-9-evidence" : variant === "run3" ? "phase1-10-run3-evidence" : "phase1-10-requalification-evidence");
  mkdirSync(prepParent);
  const prepRoot = path.join(prepParent, variant === "original" ? "preparation-20260926" : "preparation-run1");
  createPhase19Preparation(prepRoot, schemaPath);
  const artifacts = ["preregistration.json", "fixture-manifest.json"].map((name) => ({ path: name, sha256: sha(readFileSync(path.join(prepRoot, name))) }));
  const seal = { version: "phase1.9-preparation-seal.v1", execution_authorized: false, registration_sha256: artifacts[0].sha256, schema_sha256: sha(readFileSync(schemaPath)), artifacts, registered_case_count: 10, fixture_count: 10 };
  const sealPath = path.join(prepRoot, "preparation-seal.json");
  writeFileSync(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
  const fakePath = path.join(root, "fake-codex.cjs");
  writeFileSync(fakePath, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const out = args[args.indexOf('--output-last-message') + 1];",
    "const prompt = args.at(-1);",
    "const id = /task_id MUST be exactly: ([A-Z0-9-]+)/.exec(prompt)?.[1];",
    "const base = /base_sha MUST be exactly: ([a-f0-9]{40})/.exec(prompt)?.[1];",
    `const registration = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(prepRoot, "preregistration.json"))}, 'utf8'));`,
    "const entry = registration.cases.find(x => x.id === id);",
    "if (!entry) process.exit(2);",
    "const bad = process.env.PHASE110_FAKE_BAD_ID === id;",
    "const spec = {schema_version:'2.0',task_id:id,title:'Bounded offline fixture',goal:'Derive safe implementation requirements',base_sha:bad?'f'.repeat(40):base,context_paths:entry.contextPaths,scope:{allowed_paths:[entry.fixtureFiles[0]],forbidden_paths:[]},acceptance_criteria:[{id:'AC-01',text:'Implement only the declared scope'}],test_commands:[{id:'unit-tests',program:'pnpm',args:['test'],cwd:'.',timeout_seconds:300,required:true}],execution_policy:{planner_recommendation:'strong',planner_confidence:'high',recommendation_reasons:['bounded fixture'],user_lock:null},limits:{max_attempts:1,run_timeout_seconds:600,max_changed_files:10,max_diff_bytes:100000}};",
    "fs.writeFileSync(out, JSON.stringify(spec));",
    "if (process.env.PHASE110_FAKE_MUTATE === id) fs.appendFileSync(entry.fixtureFiles[0], 'mutated\\n');",
    "if (process.env.PHASE110_FAKE_MALFORMED === id) { process.stdout.write('invalid-json\\n'); process.exit(0); }",
    "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}) + '\\n');",
  ].join("\n"));
  const sealHash = sha(readFileSync(sealPath));
  const outputRoot = path.join(root, variant === "original" ? "phase1-10-runtime-certification-run1" : variant === "run3" ? "phase1-10-runtime-certification-run3" : "phase1-10-runtime-certification-run2");
  const approval: Phase19ExecutionApproval = { execution_authorized: true, preparation_seal_sha256: sealHash, output_root: outputRoot, max_requests: 10, retry_count: 0, stop_on_first_fatal: true };
  const input: Phase110PreflightInput = { sourceRoot: root, preparationRoot: prepRoot, outputRoot, expectedSealSha256: sealHash, approval, runtime: { executable: process.execPath, version: process.version, sha256: sha(readFileSync(process.execPath)) }, schemaPath };
  return { root, prepRoot, outputRoot, approval, input, fakePath, sealPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("agentplatform-p110-")) throw new Error("UNSAFE_TEST_CLEANUP");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Phase 1.10 offline entry", () => {
  it("rejects real entry when execution approval is absent", async () => {
    await expect(executePhase110RealRun({})).rejects.toThrow("PHASE110_REAL_EXECUTION_NOT_APPROVED");
  });

  it("binds offline readiness to reviewed bytes and the Git baseline", () => {
    const context = setup();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: context.root, stdio: "ignore" });
    git("init", "--initial-branch=main");
    writeFileSync(path.join(context.root, "reviewed.txt"), "approved bytes\n");
    git("add", "--", "reviewed.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "fixture");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: context.root, encoding: "utf8" }).trim();
    const evidence = path.join(context.root, "phase1-10-evidence");
    mkdirSync(evidence);
    const readinessPath = path.join(evidence, "offline-readiness-final.json");
    const record = { version: "phase1.10-offline-readiness.v1", git_head: head, preparation_seal_sha256: context.input.expectedSealSha256, files: [{ path: "reviewed.txt", sha256: sha(readFileSync(path.join(context.root, "reviewed.txt"))) }] };
    writeFileSync(readinessPath, `${JSON.stringify(record)}\n`);
    const hash = sha(readFileSync(readinessPath));
    expect(() => verifyPhase110Readiness(context.root, hash, context.input.expectedSealSha256)).not.toThrow();
    writeFileSync(path.join(context.root, "reviewed.txt"), "changed\n");
    expect(() => verifyPhase110Readiness(context.root, hash, context.input.expectedSealSha256)).toThrow("PHASE110_SOURCE_HASH_DRIFT");
    expect(() => verifyPhase110Readiness(context.root, "a".repeat(64), context.input.expectedSealSha256)).toThrow("PHASE110_READINESS_HASH_DRIFT");
  });

  it("rejects missing approval, seal drift, fixture mutation and reused output before spawning", () => {
    const context = setup();
    expect(verifyPhase110Ready(context.input).registration.cases).toHaveLength(10);
    expect(() => verifyPhase110Ready({ ...context.input, approval: { ...context.approval, execution_authorized: false } })).toThrow("EXECUTION_NOT_AUTHORIZED");
    expect(() => verifyPhase110Ready({ ...context.input, expectedSealSha256: "a".repeat(64) })).toThrow("PREPARATION_SEAL_MISMATCH");
    writeFileSync(path.join(context.prepRoot, "fixtures", "P19-ARCH-01", "specification.md"), "tampered\n");
    expect(() => verifyPhase110Ready(context.input)).toThrow("PHASE110_FIXTURE_DRIFT");
    mkdirSync(context.outputRoot);
    expect(() => verifyPhase110Ready(context.input)).toThrow("PHASE110_OUTPUT_ROOT_NOT_FRESH");
  });

  it("accepts only the sealed requalification preparation and fresh run2 pair", () => {
    const context = setup("requalification");
    expect(verifyPhase110Ready(context.input).registration.cases).toHaveLength(10);
    expect(() => verifyPhase110Ready({ ...context.input, outputRoot: path.join(context.root, "phase1-10-runtime-certification-run1") })).toThrow("PHASE110_OUTPUT_ROOT_INVALID");
  });

  it("binds run3 to its own fresh preparation and output root", () => {
    const context = setup("run3");
    expect(verifyPhase110Ready(context.input).registration.cases).toHaveLength(10);
    expect(() => verifyPhase110Ready({ ...context.input, outputRoot: path.join(context.root, "phase1-10-runtime-certification-run2") })).toThrow("PHASE110_OUTPUT_ROOT_INVALID");
    mkdirSync(context.outputRoot);
    expect(() => verifyPhase110Ready(context.input)).toThrow("PHASE110_OUTPUT_ROOT_NOT_FRESH");
  });

  it("runs ten fake cases through the production adapter and seals every case", async () => {
    const context = setup();
    const ready = verifyPhase110Ready(context.input);
    const adapter = new CodexAdapter(process.execPath, [context.fakePath], () => ({}));
    const decision = await executePhase110Cases(ready, adapter);
    expect(decision).toMatchObject({ status: "PASS", calls: 10, passed: 10, failed: 0 });
    expect(existsSync(path.join(context.outputRoot, "P19-ARCH-10", "case-artifact-manifest.json"))).toBe(true);
    expect(existsSync(path.join(context.outputRoot, "run-decision.json"))).toBe(true);
    expect(verifyPhase110RunArtifacts(context.outputRoot)).toBe(true);
    writeFileSync(path.join(context.outputRoot, "P19-ARCH-01", "decision.json"), "tampered\n");
    expect(verifyPhase110RunArtifacts(context.outputRoot)).toBe(false);
  }, 30000);

  it("stops after first fake semantic failure and leaves later cases absent", async () => {
    const context = setup();
    const ready = verifyPhase110Ready(context.input);
    const adapter = new CodexAdapter(process.execPath, [context.fakePath], () => ({ PHASE110_FAKE_BAD_ID: "P19-ARCH-01" }));
    const decision = await executePhase110Cases(ready, adapter);
    expect(decision.status).toBe("FAIL");
    expect(decision.calls).toBe(1);
    expect(decision.notRun).toHaveLength(9);
    expect(existsSync(path.join(context.outputRoot, "P19-ARCH-02"))).toBe(false);
  });

  it.each([
    ["malformed JSONL", "PHASE110_FAKE_MALFORMED", "AUTHORITATIVE_TERMINAL_INVALID"],
    ["fixture mutation", "PHASE110_FAKE_MUTATE", "FIXTURE_MUTATED"],
  ])("persists fatal %s and never starts case two", async (_label, variable, reason) => {
    const context = setup();
    const ready = verifyPhase110Ready(context.input);
    const adapter = new CodexAdapter(process.execPath, [context.fakePath], () => ({ [variable]: "P19-ARCH-01" }));
    const decision = await executePhase110Cases(ready, adapter);
    expect(decision.status).toBe("FAIL");
    expect(decision.calls).toBe(1);
    expect(decision.reasons).toContain(reason);
    expect(existsSync(path.join(context.outputRoot, "P19-ARCH-01", "decision.json"))).toBe(true);
    expect(existsSync(path.join(context.outputRoot, "P19-ARCH-02"))).toBe(false);
  });

  it.each(["TIMED_OUT", "CANCELLED"] as const)("persists %s without retry", async (status) => {
    const context = setup();
    const ready = verifyPhase110Ready(context.input);
    const result: ProcessResult = { status, exitCode: null, stdout: "", stderr: "", stdoutSha256: sha(""), stderrSha256: sha(""), durationMs: 100, closeObserved: true, stdoutClosed: true, stderrClosed: true };
    const adapter = { id: "offline-fatal", runPlanner: async () => { throw { result }; } };
    const decision = await executePhase110Cases(ready, adapter);
    expect(decision).toMatchObject({ status: "FAIL", calls: 1, failed: 1 });
    expect(decision.reasons).toContain(status === "TIMED_OUT" ? "PROCESS_TIMEOUT" : "PROCESS_CANCELLED");
    expect(decision.notRun).toHaveLength(9);
    expect(existsSync(path.join(context.outputRoot, "P19-ARCH-02"))).toBe(false);
  });

  it("seals a safe failure code without persisting process text and stops before case two", async () => {
    const context = setup("run3");
    const ready = verifyPhase110Ready(context.input);
    const secret = "private-token-example";
    const stdout = `${JSON.stringify({ type: "turn.failed", error: `rate limit ${secret}` })}\n`;
    const stderr = `rate limit ${secret}`;
    const result: ProcessResult = { status: "FAILED", exitCode: 1, stdout, stderr, stdoutSha256: sha(stdout), stderrSha256: sha(stderr), durationMs: 100, closeObserved: true, stdoutClosed: true, stderrClosed: true };
    const adapter = { id: "offline-fatal", runPlanner: async () => { throw { result }; } };
    const decision = await executePhase110Cases(ready, adapter);
    expect(decision).toMatchObject({ status: "FAIL", calls: 1, failed: 1 });
    const evidence = readFileSync(path.join(context.outputRoot, "P19-ARCH-01", "execution-evidence.json"), "utf8");
    expect(JSON.parse(evidence)).toMatchObject({ process: { failureClassification: { code: "RATE_LIMITED", domain: "runtime", retryable: true, failFast: true } } });
    expect(evidence).not.toContain(secret);
    expect(existsSync(path.join(context.outputRoot, "P19-ARCH-02"))).toBe(false);
    expect(verifyPhase110RunArtifacts(context.outputRoot)).toBe(true);
  });
});
