import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readBoundedContext } from "../../src/shared/core/bounded-context.js";
import {
  buildPhase19Prompt,
  PHASE_1_9_CASE_IDS,
  PHASE_1_9_CLEANUP_CEILING_MS,
  PHASE_1_9_MODEL,
  PHASE_1_9_REASONING,
  PHASE_1_9_TIMEOUT_MS,
  validatePhase19Registration,
  type Phase19CaseRegistration,
  type Phase19FixtureState,
  type Phase19Registration,
} from "../../src/shared/core/phase1-9-runtime-certification.js";

const CASES = [
  ["path scope", ["specification.md", "implementation.ts", "focused.test.ts"], "Derive safe allowed and forbidden path rules."],
  ["task state", ["state-spec.md", "state-implementation.ts", "state.test.ts"], "Derive legal and illegal task-state transitions."],
  ["retry policy", ["policy.md", "configuration.json", "requirements.md"], "Separate retryable transport failures from fail-fast failures."],
  ["structured test command", ["command-spec.md", "command-implementation.ts", "command.test.ts"], "Design shell-free structured validation commands."],
  ["evidence manifest", ["manifest-spec.md", "manifest-implementation.ts", "manifest.test.ts"], "Define manifest hashing and integrity acceptance."],
  ["worker result", ["worker-result.schema.json", "worker-result.ts", "worker-result.test.ts"], "Derive WorkerResult cross-field invariants."],
  ["final gate", ["gate-policy.md", "gate-evaluator.ts", "gate.test.ts"], "Derive PASS and REWORK verdict invariants."],
  ["managed worktree", ["worktree-policy.md", "worktree-service.ts", "worktree.test.ts"], "Define managed-root and original-checkout protections."],
  ["process lifecycle", ["process-taxonomy.md", "process-runner.ts", "process-timeout.test.ts"], "Classify timeout, cancellation and cleanup evidence."],
  ["acceptance synthesis", ["acceptance-requirements.md", "integration.ts", "integration.test.ts"], "Synthesize acceptance criteria across contract, implementation and tests."],
] as const;

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixtureContents(id: string, focus: string, file: string): string {
  if (file.endsWith(".json")) return `${JSON.stringify({ case_id: id, focus, fixture: file }, null, 2)}\n`;
  return `case=${id}\nfocus=${focus}\nfixture=${file}\n`;
}

export function readPhase19FixtureState(repo: string): Phase19FixtureState {
  return {
    head: git(repo, "rev-parse", "HEAD"),
    tree: git(repo, "rev-parse", "HEAD^{tree}"),
    status: git(repo, "status", "--porcelain=v1"),
  };
}

function createFixture(root: string, id: string, focus: string, files: readonly string[]): { repo: string; baseSha: string; baseTree: string; fileHashes: Record<string, string> } {
  const repo = path.join(root, "fixtures", id);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  for (const file of files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).some((part) => part === ".." || part === "")) throw new Error("UNSAFE_FIXTURE_PATH");
    const target = path.join(repo, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, fixtureContents(id, focus, file), { flag: "wx" });
  }
  git(repo, "add", "--", ...files);
  execFileSync("git", ["-c", "commit.gpgSign=false", "commit", "--date=2020-01-01T00:00:00Z", "-m", `Phase 1.9 deterministic fixture ${id}`], {
    cwd: repo,
    encoding: "utf8",
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentPlatform Phase 1.9 Fixture",
      GIT_AUTHOR_EMAIL: "phase1-9@example.invalid",
      GIT_COMMITTER_NAME: "AgentPlatform Phase 1.9 Fixture",
      GIT_COMMITTER_EMAIL: "phase1-9@example.invalid",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  });
  const state = readPhase19FixtureState(repo);
  const fileHashes = Object.fromEntries(files.map((file) => [file, sha256(readFileSync(path.join(repo, file)))]));
  return { repo, baseSha: state.head, baseTree: state.tree, fileHashes };
}

/** Create a new ten-case preparation root. It does not invoke Codex or a model. */
export function createPhase19Preparation(outputRoot: string, schemaPath: string): Phase19Registration {
  const root = path.resolve(outputRoot);
  if (existsSync(root)) throw new Error("PHASE19_OUTPUT_ROOT_NOT_FRESH");
  const schemaSha256 = sha256(readFileSync(schemaPath));
  mkdirSync(root, { recursive: false });
  const fixtureManifest: Array<{ id: string; repo: string; baseSha: string; baseTree: string; files: Record<string, string> }> = [];
  const registrations: Phase19CaseRegistration[] = CASES.map(([focus, files, request], index) => {
    const id = PHASE_1_9_CASE_IDS[index];
    const fixture = createFixture(root, id, focus, files);
    const bounded = readBoundedContext(fixture.repo, files);
    const prompt = buildPhase19Prompt({ taskId: id, baseSha: fixture.baseSha, focus: request, contextPaths: [...files], allowedPaths: [files[0]] });
    fixtureManifest.push({ id, repo: path.relative(root, fixture.repo).replaceAll("\\", "/"), baseSha: fixture.baseSha, baseTree: fixture.baseTree, files: fixture.fileHashes });
    return {
      id,
      order: index + 1,
      title: `Codex Architect certification ${String(index + 1).padStart(2, "0")}`,
      focus,
      fixtureFiles: files,
      contextPaths: files,
      baseSha: fixture.baseSha,
      baseTree: fixture.baseTree,
      contextSha256: bounded.sha256,
      contextBytes: bounded.totalBytes,
      prompt,
      promptSha256: sha256(prompt),
      schemaSha256,
    };
  });
  const registration: Phase19Registration = {
    version: "phase1.9-codex-exec.v1",
    model: PHASE_1_9_MODEL,
    reasoning: PHASE_1_9_REASONING,
    timeoutMs: PHASE_1_9_TIMEOUT_MS,
    cleanupCeilingMs: PHASE_1_9_CLEANUP_CEILING_MS,
    retryCount: 0,
    humanInterventionCount: 0,
    cases: registrations,
  };
  const errors = validatePhase19Registration(registration);
  if (errors.length > 0) throw new Error(`PHASE19_REGISTRATION_INVALID:${errors.join(",")}`);
  writeFileSync(path.join(root, "preregistration.json"), `${JSON.stringify(registration, null, 2)}\n`, { flag: "wx" });
  writeFileSync(path.join(root, "fixture-manifest.json"), `${JSON.stringify({ version: "phase1.9-fixtures.v1", fixtures: fixtureManifest }, null, 2)}\n`, { flag: "wx" });
  return registration;
}
