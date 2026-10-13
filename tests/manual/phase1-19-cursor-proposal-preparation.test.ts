import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { prepareCursorProposalFixture } from "../../src/main/adapters/cursor/cursor-context-transfer.js";
import { buildWorkerProposalRequest, taskSpecCanonicalSha256 } from "../../src/main/proposals/proposal-context.js";
import type { TaskSpec } from "../../src/shared/core/task-spec.js";

const root = path.resolve(import.meta.dirname, "../..");
const runNumber = process.env.PHASE119_PROPOSAL_PREPARE === "2" ? 2 : 1;
const preparation = path.join(root, `phase1-19-proposal-preparation-run${runNumber}`);
const checkout = path.join(preparation, "fixture-checkout");
const outputRoot = path.join(root, `cursor-wsl-proposal-run${runNumber}`);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

describe("Phase 1.19 Cursor real proposal preparation", () => {
  it.skipIf(!["1", "2"].includes(process.env.PHASE119_PROPOSAL_PREPARE ?? ""))("prepares one bounded immutable proposal fixture without a model call", async () => {
    expect(existsSync(preparation)).toBe(false);
    expect(existsSync(outputRoot)).toBe(false);
    mkdirSync(path.join(checkout, "src"), { recursive: true });
    writeFileSync(path.join(checkout, "src/message.txt"), "before\n", { flag: "wx" });
    writeFileSync(path.join(checkout, "verify.mjs"), "import {readFileSync} from 'node:fs'; if(readFileSync(new URL('./src/message.txt', import.meta.url),'utf8')!=='ready\\n') process.exit(1);\n", { flag: "wx" });
    git(checkout, "init", "--initial-branch=main");
    git(checkout, "config", "core.autocrlf", "false");
    git(checkout, "config", "user.name", "Cursor Proposal Fixture");
    git(checkout, "config", "user.email", "fixture@example.invalid");
    git(checkout, "add", "--", "src/message.txt", "verify.mjs");
    execFileSync("git", ["-c", "commit.gpgSign=false", "commit", "-m", "frozen fixture"], { cwd: checkout, windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
    const baseSha = git(checkout, "rev-parse", "HEAD");
    const taskSpec: TaskSpec = {
      schema_version: "2.0", task_id: "CURSOR-PROPOSAL-01", title: "One-file Cursor proposal qualification",
      goal: "Replace src/message.txt with exactly ready followed by one newline. Change no other file.", base_sha: baseSha,
      context_paths: ["src/message.txt"], scope: { allowed_paths: ["src/message.txt"], forbidden_paths: [] },
      acceptance_criteria: [{ id: "AC-01", text: "The registered fixture test passes after controlled apply." }],
      test_commands: [{ id: "fixture", program: "node", args: ["verify.mjs"], cwd: ".", timeout_seconds: 20, required: true }],
      execution_policy: { planner_recommendation: "cheap", planner_confidence: "high", recommendation_reasons: ["One-file qualification fixture"], user_lock: "cheap" },
      limits: { max_attempts: 1, run_timeout_seconds: 180, max_changed_files: 1, max_diff_bytes: 1024 }
    };
    const request = buildWorkerProposalRequest({ taskSpec, managedWorktree: checkout });
    const fixture = await prepareCursorProposalFixture(request, { fixtureId: randomUUID() });
    const prompt = runNumber === 1
      ? "Read only context.json in this workspace. Return one compact JSON ChangeSet matching the request inside that file. For src/message.txt propose the complete content ready followed by one newline, using replace_file and the given sha256. Include all required fields and AC-01. Do not use a shell, write files, delegate, or access any other path. Do not use Markdown."
      : "Read only context.json in this workspace. It contains a WorkerProposalRequest. Return exactly one compact ChangeSet JSON object and no other text. Required top-level keys: schema_version, task_id, base_sha, task_spec_sha256, status, summary, operations, acceptance_notes, risks, blocker. Copy schema_version as 1.0 and copy task_id, base_sha and task_spec_sha256 exactly from the request. Set status to completed, summary to a short sentence, risks to [], and blocker to null. Propose one operation object with exactly type, path, expected_sha256, content: type is replace_file, path is src/message.txt, expected_sha256 must equal the context file sha256 in the request, and content must be ready followed by one newline. Set acceptance_notes to one object with criterion_id AC-01 and a short note. Do not use the keys op or acceptance_criteria. Do not use a shell, write files, delegate, or access another path. No Markdown.";
    const runtime = JSON.parse(readFileSync(path.join(root, "docs/PHASE_1_19_CURSOR_CANCEL_READINESS.json"), "utf8")) as { runtime: Record<string, unknown> };
    const readiness = {
      version: "phase1-19-cursor-proposal-readiness.v1", git_head: git(root, "rev-parse", "HEAD"),
      source: { parser_sha256: sha(readFileSync(path.join(root, "src/shared/core/cursor-proposal-trace.ts"))),
        transfer_sha256: sha(readFileSync(path.join(root, "src/main/adapters/cursor/cursor-context-transfer.ts"))),
        task_spec_sha256: taskSpecCanonicalSha256(taskSpec), request_sha256: sha(JSON.stringify(request)), prompt_sha256: sha(prompt) },
      fixture: { checkout, base_sha: baseSha, base_tree: git(checkout, "rev-parse", "HEAD^{tree}"),
        source_file_sha256: sha(readFileSync(path.join(checkout, "src/message.txt"))),
        test_file_sha256: sha(readFileSync(path.join(checkout, "verify.mjs"))),
        workspace: fixture.workspace, context_sha256: fixture.contextSha256, context_bytes: fixture.contextBytes,
        sandbox_config_sha256: sha('{"type":"workspace_readonly","networkPolicy":{"default":"deny"}}\n') },
      runtime: runtime.runtime,
      request: { prompt, calls_max: 1, retry: 0, linux_timeout_seconds: 180, linux_kill_after_seconds: 10,
        windows_outer_deadline_seconds: 200, cleanup_deadline_seconds: 10, stream_max_bytes: 2 * 1024 * 1024 },
      evidence: { output_root: outputRoot }
    };
    writeJson(path.join(preparation, "task-spec.json"), taskSpec);
    writeJson(path.join(preparation, "worker-proposal-request.json"), request);
    writeJson(path.join(preparation, "readiness.json"), readiness);
    const inspect = spawnSync("C:\\Windows\\System32\\wsl.exe", ["--distribution", "Ubuntu", "--user", "agentplatform", "--exec", "/usr/bin/python3", "-c",
      "import hashlib,json,os,pathlib,stat,sys; r=pathlib.Path(sys.argv[1]); c=r/'context.json'; s=r/'.cursor/sandbox.json'; print(json.dumps({'uid':os.getuid(),'owners':[p.stat().st_uid for p in (r,c,s)],'modes':[oct(stat.S_IMODE(p.stat().st_mode)) for p in (r,c,s)],'files':sorted(str(p.relative_to(r)) for p in r.rglob('*') if p.is_file()),'context':hashlib.sha256(c.read_bytes()).hexdigest(),'config':hashlib.sha256(s.read_bytes()).hexdigest()}))", fixture.workspace],
    { shell: false, encoding: "utf8", timeout: 15_000, maxBuffer: 4096 });
    expect(inspect.status).toBe(0);
    const proof = JSON.parse(inspect.stdout.trim()) as { uid: number; owners: number[]; modes: string[]; files: string[]; context: string; config: string };
    expect(proof).toEqual({ uid: 1000, owners: [0, 0, 0], modes: ["0o555", "0o444", "0o444"],
      files: [".cursor/sandbox.json", "context.json"], context: fixture.contextSha256,
      config: readiness.fixture.sandbox_config_sha256 });
    console.log(JSON.stringify({ status: "PREPARATION_PASS", readiness_sha256: sha(readFileSync(path.join(preparation, "readiness.json"))),
      request_sha256: readiness.source.request_sha256, fixture_workspace: fixture.workspace, context_sha256: fixture.contextSha256 }));
  });
});
