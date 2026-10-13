import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexAdapter } from "../../src/main/adapters/codex/codex-adapter.js";
import { AppDatabase } from "../../src/main/db/database.js";
import { GitService } from "../../src/main/git/git-service.js";
import { TaskOrchestrator } from "../../src/main/orchestrator/task-orchestrator.js";
import { minimalEnvironment } from "../../src/main/process/runner.js";
import type { WorkerProfiles } from "../../src/main/router/worker-router.js";
import { validateTaskSpec, type TaskSpec } from "../../src/shared/core/task-spec.js";

const TASK_ID = "P111-MVP-01";
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
function assert(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true, env: minimalEnvironment() }).trim();

type Preparation = {
  version: string;
  execution_authorized: false;
  real_model_calls: 0;
  source_head: string;
  source_tree: string;
  task_spec_sha256: string;
  schema_sha256: string;
  files: Array<{ path: string; sha256: string }>;
};
type Readiness = { version: string; git_head: string; preparation_seal_sha256: string; files: Array<{ path: string; sha256: string }> };
type Approval = { execution_authorized: boolean; preparation_seal_sha256: string; offline_readiness_sha256: string; approved_task_spec_sha256: string; output_root: string; max_model_requests: number; retry_count: number; stop_on_first_fatal: boolean };

const requestText = [
  "Implement normalizeLines(input) in src/normalize-lines.mjs in this disposable repository.",
  "It must accept only strings and throw TypeError for other inputs.",
  "Trim each line, remove empty lines, preserve order, and join retained lines with a newline.",
  "Read src/normalize-lines.mjs and verify.mjs; modify only src/normalize-lines.mjs.",
  "The platform will run node verify.mjs; do not modify the verifier or execute unrelated commands.",
].join(" ");
const stub = "export function normalizeLines(input) { throw new Error('TODO'); }\n";
const verifier = [
  "import assert from 'node:assert/strict';",
  "import { normalizeLines } from './src/normalize-lines.mjs';",
  "assert.equal(normalizeLines(' a \\n\\n b \\n  c '), 'a\\nb\\nc');",
  "assert.equal(normalizeLines(' \\n '), '');",
  "assert.throws(() => normalizeLines(null), TypeError);",
  "console.log('verification PASS');",
  "",
].join("\n");

function exactSpec(baseSha: string): TaskSpec {
  return {
    schema_version: "2.0", task_id: TASK_ID, title: "Normalize lines", goal: requestText, base_sha: baseSha,
    context_paths: ["src/normalize-lines.mjs", "verify.mjs"],
    scope: { allowed_paths: ["src/normalize-lines.mjs"], forbidden_paths: ["verify.mjs"] },
    acceptance_criteria: [
      { id: "AC-01", text: "Export normalizeLines(input); accept only strings and throw TypeError for other inputs." },
      { id: "AC-02", text: "Trim each line, remove empty lines, preserve order, and join retained lines with newline." },
      { id: "AC-03", text: "Platform-owned node verify.mjs passes without changing verify.mjs or the source checkout." },
    ],
    test_commands: [{ id: "verification", program: "node", args: ["verify.mjs"], cwd: ".", timeout_seconds: 30, required: true }],
    execution_policy: { planner_recommendation: "strong", planner_confidence: "high", recommendation_reasons: ["Single bounded controlled task"], user_lock: "strong" },
    limits: { max_attempts: 1, run_timeout_seconds: 300, max_changed_files: 1, max_diff_bytes: 65536 },
  };
}

/** Writes a deterministic, disposable Git task fixture; no Codex process is launched. */
export function createPhase111Preparation(sourceRoot: string, preparationRoot: string): Preparation {
  assert(path.isAbsolute(sourceRoot) && path.isAbsolute(preparationRoot) && !existsSync(preparationRoot), "P111_PREPARATION_ROOT_NOT_FRESH");
  mkdirSync(preparationRoot, { recursive: false });
  const repo = path.join(preparationRoot, "source");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "--initial-branch=main");
  writeFileSync(path.join(repo, "src", "normalize-lines.mjs"), stub, { flag: "wx" });
  writeFileSync(path.join(repo, "verify.mjs"), verifier, { flag: "wx" });
  git(repo, "add", "--", "src/normalize-lines.mjs", "verify.mjs");
  execFileSync("git", ["-c", "user.name=AgentPlatform Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "Phase 1.11 controlled base"], {
    cwd: repo, encoding: "utf8", stdio: "ignore", shell: false, windowsHide: true,
    env: { ...minimalEnvironment(), GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" },
  });
  const head = git(repo, "rev-parse", "HEAD");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  assert(git(repo, "status", "--porcelain=v1") === "", "P111_PREPARATION_DIRTY");
  const spec = exactSpec(head);
  assert(validateTaskSpec(spec).valid, "P111_TASK_SPEC_INVALID");
  json(path.join(preparationRoot, "task-spec-approved.json"), spec);
  writeFileSync(path.join(preparationRoot, "request.txt"), `${requestText}\n`, { flag: "wx" });
  const names = ["source/src/normalize-lines.mjs", "source/verify.mjs", "task-spec-approved.json", "request.txt"];
  const seal: Preparation = {
    version: "phase1.11-preparation.v1", execution_authorized: false, real_model_calls: 0,
    source_head: head, source_tree: tree,
    task_spec_sha256: sha256(readFileSync(path.join(preparationRoot, "task-spec-approved.json"))),
    schema_sha256: sha256(readFileSync(path.join(sourceRoot, "schemas", "task-spec.schema.json"))),
    files: names.map((name) => ({ path: name, sha256: sha256(readFileSync(path.join(preparationRoot, name))) })),
  };
  json(path.join(preparationRoot, "preparation-seal.json"), seal);
  return seal;
}

export function verifyPhase111Preparation(sourceRoot: string, preparationRoot: string, expectedSealSha256: string): { seal: Preparation; spec: TaskSpec; repo: string } {
  const sealPath = path.join(preparationRoot, "preparation-seal.json");
  assert(sha256(readFileSync(sealPath)) === expectedSealSha256, "P111_SEAL_HASH_DRIFT");
  const seal = readJson<Preparation>(sealPath);
  assert(seal.version === "phase1.11-preparation.v1" && seal.execution_authorized === false && seal.real_model_calls === 0 && seal.files.length === 4, "P111_SEAL_INVALID");
  for (const file of seal.files) assert(sha256(readFileSync(path.join(preparationRoot, file.path))) === file.sha256, `P111_FIXTURE_FILE_DRIFT:${file.path}`);
  const repo = path.join(preparationRoot, "source");
  assert(realpathSync(repo) === repo && git(repo, "rev-parse", "HEAD") === seal.source_head && git(repo, "rev-parse", "HEAD^{tree}") === seal.source_tree && git(repo, "status", "--porcelain=v1") === "", "P111_FIXTURE_GIT_DRIFT");
  const specPath = path.join(preparationRoot, "task-spec-approved.json");
  assert(sha256(readFileSync(specPath)) === seal.task_spec_sha256 && sha256(readFileSync(path.join(sourceRoot, "schemas", "task-spec.schema.json"))) === seal.schema_sha256, "P111_SPEC_OR_SCHEMA_DRIFT");
  const checked = validateTaskSpec(readJson<unknown>(specPath));
  assert(checked.valid && checked.value.task_id === TASK_ID && checked.value.base_sha === seal.source_head && JSON.stringify(checked.value) === JSON.stringify(exactSpec(seal.source_head)), "P111_APPROVED_SPEC_DRIFT");
  return { seal, spec: checked.value, repo };
}

export function verifyPhase111Readiness(sourceRoot: string, readinessPath: string, expectedHash: string, sealHash: string): void {
  assert(sha256(readFileSync(readinessPath)) === expectedHash, "P111_READINESS_HASH_DRIFT");
  const readiness = readJson<Readiness>(readinessPath);
  assert(readiness.version === "phase1.11-offline-readiness.v1" && readiness.preparation_seal_sha256 === sealHash && readiness.files.length > 0 && git(sourceRoot, "rev-parse", "HEAD") === readiness.git_head, "P111_READINESS_INVALID");
  for (const file of readiness.files) {
    const absolute = path.resolve(sourceRoot, file.path);
    const relative = path.relative(sourceRoot, absolute);
    assert(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "P111_READINESS_PATH_INVALID");
    assert(sha256(readFileSync(absolute)) === file.sha256, `P111_SOURCE_HASH_DRIFT:${file.path}`);
  }
}

function fileManifest(root: string): Array<{ path: string; sha256: string; bytes: number }> {
  const pending = [root];
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  while (pending.length > 0) {
    const dir = pending.pop();
    assert(dir, "P111_MANIFEST_DIR_MISSING");
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, item.name);
      if (item.isDirectory()) pending.push(absolute);
      else if (item.isFile() && item.name !== "run-artifact-manifest.json") files.push({ path: path.relative(root, absolute).replaceAll("\\", "/"), sha256: sha256(readFileSync(absolute)), bytes: statSync(absolute).size });
      else if (!item.isFile()) throw new Error("P111_UNSUPPORTED_EVIDENCE_ENTRY");
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

/** Real entry point. The account is checked only after exact approval and source preflight. */
export async function executePhase111RealRun(env: Record<string, string | undefined> = process.env, runId: "run1" | "run2" = "run1"): Promise<{ status: "PASS" | "FAIL"; stage: string; taskStatus: string; modelCalls: number }> {
  assert(runId === "run1" || runId === "run2", "P111_RUN_ID_INVALID");
  const phrase = runId === "run2" ? "I_APPROVE_P111_RUN2_3_REAL_CODEX_CALLS" : "I_APPROVE_3_REAL_CODEX_CALLS";
  assert(env.RUN_PHASE1_11 === "1" && env.PHASE1_11_EXECUTION_APPROVAL === phrase, "P111_REAL_EXECUTION_NOT_APPROVED");
  const sourceRoot = path.resolve(env.PHASE1_11_SOURCE_ROOT ?? "");
  assert(path.isAbsolute(env.PHASE1_11_SOURCE_ROOT ?? "") && existsSync(sourceRoot), "P111_SOURCE_ROOT_INVALID");
  const preparationRoot = path.join(sourceRoot, "phase1-11-evidence", `preparation-${runId}`);
  const outputRoot = path.join(sourceRoot, `phase1-11-end-to-end-${runId}`);
  const readinessFile = runId === "run2" ? "offline-readiness-run2.json" : "offline-readiness-final.json";
  const sealHash = env.PHASE1_11_SEAL_SHA256 ?? "";
  const readinessHash = env.PHASE1_11_READINESS_SHA256 ?? "";
  const { seal, spec, repo } = verifyPhase111Preparation(sourceRoot, preparationRoot, sealHash);
  verifyPhase111Readiness(sourceRoot, path.join(sourceRoot, "phase1-11-evidence", readinessFile), readinessHash, sealHash);
  assert(!existsSync(outputRoot), "P111_OUTPUT_ROOT_NOT_FRESH");
  const approvalPath = env.PHASE1_11_APPROVAL_FILE ?? "";
  assert(path.isAbsolute(approvalPath) && existsSync(approvalPath), "P111_APPROVAL_FILE_MISSING");
  const approval = readJson<Approval>(approvalPath);
  assert(approval.execution_authorized === true && approval.preparation_seal_sha256 === sealHash && approval.offline_readiness_sha256 === readinessHash && approval.approved_task_spec_sha256 === seal.task_spec_sha256 && approval.output_root === outputRoot && approval.max_model_requests === 3 && approval.retry_count === 0 && approval.stop_on_first_fatal === true, "P111_APPROVAL_MISMATCH");
  const baseline = readJson<{ toolchain: { codex_path: string; codex_version: string; codex_sha256: string } }>(path.join(sourceRoot, "phase1-9-evidence", "baseline.json"));
  const cli = baseline.toolchain.codex_path;
  assert(path.isAbsolute(cli) && sha256(readFileSync(cli)) === baseline.toolchain.codex_sha256, "P111_CLI_HASH_DRIFT");
  const version = spawnSync(cli, ["--version"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, env: minimalEnvironment() });
  assert(version.status === 0 && String(version.stdout).trim() === baseline.toolchain.codex_version, "P111_CLI_VERSION_DRIFT");
  const account = spawnSync(cli, ["login", "status"], { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, env: minimalEnvironment() });
  assert(account.status === 0, "P111_ACCOUNT_PREFLIGHT_FAILED");

  return executePhase111Cases({ sourceRoot, outputRoot, seal, spec, repo, sealHash, readinessHash, approvalSha256: sha256(readFileSync(approvalPath)), adapter: new CodexAdapter(cli) });
}

/** Runs the same bounded workflow with a production or offline fake Codex adapter. */
export async function executePhase111Cases(input: { sourceRoot: string; outputRoot: string; seal: Preparation; spec: TaskSpec; repo: string; sealHash: string; readinessHash: string; approvalSha256: string; adapter: CodexAdapter }): Promise<{ status: "PASS" | "FAIL"; stage: string; taskStatus: string; modelCalls: number }> {
  const { sourceRoot, outputRoot, seal, spec, repo, sealHash, readinessHash, approvalSha256, adapter } = input;
  assert(!existsSync(outputRoot), "P111_OUTPUT_ROOT_NOT_FRESH");
  mkdirSync(outputRoot, { recursive: false });
  json(path.join(outputRoot, "run-start.json"), { version: "phase1.11-run.v1", preparation_seal_sha256: sealHash, offline_readiness_sha256: readinessHash, approval_sha256: approvalSha256, approved_task_spec_sha256: seal.task_spec_sha256, base_sha: seal.source_head, max_model_requests: 3 });
  const appData = path.join(outputRoot, "app-data");
  const database = new AppDatabase(path.join(appData, "run.sqlite"));
  const profiles: WorkerProfiles = { cheap: { adapterId: "cheap-worker", model: "gpt-5.5", reasoning: "low", highTier: false }, strong: { adapterId: "codex", model: "gpt-5.6-sol", reasoning: "medium", highTier: true } };
  const orchestrator = new TaskOrchestrator(database, new GitService("git", path.join(appData, "worktrees")), adapter, adapter, [adapter], undefined, profiles, path.join(appData, "artifacts"), path.join(sourceRoot, "schemas"));
  database.createProject({ id: "P111-PROJECT", name: "Phase 1.11 controlled fixture", repoPath: repo, repoRealPath: repo, lastSeenHead: seal.source_head });
  database.createTask({ id: TASK_ID, projectId: "P111-PROJECT", title: "Normalize lines", requestText, status: "DRAFT", baseSha: seal.source_head });
  let stage = "architect";
  let status: "PASS" | "FAIL" = "FAIL";
  let taskStatus = "DRAFT";
  let modelCalls = 0;
  try {
    await orchestrator.startDesign(TASK_ID);
    modelCalls++;
    json(path.join(outputRoot, "architect-decision.json"), { status: orchestrator.detail(TASK_ID).task.status, candidate_sha256: sha256(orchestrator.detail(TASK_ID).task.specJson ?? ""), candidate_validated: true });
    stage = "task-spec-approval";
    orchestrator.updateSpec(TASK_ID, spec);
    orchestrator.approveSpec(TASK_ID);
    json(path.join(outputRoot, "task-spec-approval.json"), { status: orchestrator.detail(TASK_ID).task.status, approved_task_spec_sha256: seal.task_spec_sha256, user_approval_sha256: approvalSha256 });
    stage = "builder";
    await orchestrator.startBuild(TASK_ID);
    modelCalls++;
    assert(orchestrator.detail(TASK_ID).task.status === "BUILT", "P111_BUILDER_NOT_BUILT");
    stage = "platform-tests-and-gate";
    await orchestrator.startTests(TASK_ID);
    assert(orchestrator.detail(TASK_ID).task.status === "GATE_READY", "P111_DETERMINISTIC_GATE_FAILED");
    json(path.join(outputRoot, "gate-decision.json"), { task_status: orchestrator.detail(TASK_ID).task.status, test_runs: orchestrator.detail(TASK_ID).snapshot?.tests?.map((test) => ({ id: test.id, status: test.result.status, exit_code: test.result.exitCode })) ?? [], gate: orchestrator.detail(TASK_ID).snapshot?.gate ?? null });
    stage = "final-gate";
    await orchestrator.startFinalGate(TASK_ID);
    modelCalls++;
    taskStatus = orchestrator.detail(TASK_ID).task.status;
    assert(taskStatus === "PASSED", "P111_FINAL_GATE_NOT_PASSED");
    assert(git(repo, "rev-parse", "HEAD") === seal.source_head && git(repo, "status", "--porcelain=v1") === "", "P111_SOURCE_CHECKOUT_MUTATED");
    status = "PASS";
  } catch {
    taskStatus = orchestrator.detail(TASK_ID).task.status;
  } finally {
    const detail = orchestrator.detail(TASK_ID);
    const runs = detail.runs.filter((run) => ["architect", "builder", "reviewer"].includes(run.stage));
    modelCalls = runs.length;
    assert(modelCalls <= 3, "P111_MODEL_CALL_BUDGET_EXCEEDED");
    json(path.join(outputRoot, "run-decision.json"), { status, stage, taskStatus, modelCalls, source_head: git(repo, "rev-parse", "HEAD"), source_clean: git(repo, "status", "--porcelain=v1") === "", attempt_id: detail.attempt?.id ?? null, branch: detail.attempt?.branch ?? null, worktree_path: detail.attempt?.worktreePath ?? null, tests: detail.snapshot?.tests?.map((test) => ({ id: test.id, status: test.result.status })) ?? [], gate: detail.snapshot?.gate?.passed ?? null, final_verdict: detail.snapshot?.final?.verdict ?? null, run_stages: runs.map((run) => ({ stage: run.stage, status: run.status, exitCode: run.exitCode, errorCode: run.errorCode })) });
    database.close();
    json(path.join(outputRoot, "run-artifact-manifest.json"), { version: "phase1.11-run-artifacts.v1", artifacts: fileManifest(outputRoot) });
  }
  return { status, stage, taskStatus, modelCalls };
}
