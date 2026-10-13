import { lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../process/runner.js";

export type RepositorySnapshot = { root: string; head: string; branch: string; clean: boolean };
export type GitEvidence = { head: string; changedFiles: string[]; diff: string; stat: string; invalidPaths: string[] };
const OUTPUT_LIMIT = 12 * 1024 * 1024;
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export class GitService {
  private readonly gitProgram: string;
  private readonly managedRoot: string;
  constructor(gitProgram: string, managedRoot: string) { this.gitProgram = gitProgram; this.managedRoot = managedRoot; }
  getManagedRoot(): string { return this.managedRoot; }

  private async git(cwd: string, args: string[], allowDifference = false): Promise<string> {
    const result = await runProcess({ program: this.gitProgram, args, cwd, timeoutSeconds: 30, maxSummaryBytes: OUTPUT_LIMIT });
    if (result.status !== "SUCCEEDED" && !(allowDifference && result.exitCode === 1)) throw new Error(result.stderr || `git ${args[0]} failed`);
    if (Buffer.byteLength(result.stdout) >= OUTPUT_LIMIT) throw new Error("GIT_OUTPUT_LIMIT");
    return result.stdout;
  }

  async inspect(repo: string): Promise<RepositorySnapshot> {
    const root = (await this.git(repo, ["rev-parse", "--show-toplevel"])).trim();
    const head = (await this.git(root, ["rev-parse", "HEAD"])).trim();
    const branch = (await this.git(root, ["branch", "--show-current"])).trim();
    const clean = (await this.git(root, ["status", "--porcelain=v1"])) === "";
    return { root: path.resolve(root), head, branch, clean };
  }

  async createWorktree(repo: string, input: { taskId: string; attempt: number; baseSha: string }): Promise<{ branch: string; worktreePath: string }> {
    const snapshot = await this.inspect(repo);
    if (!snapshot.clean) throw new Error("REPOSITORY_DIRTY");
    if (snapshot.head !== input.baseSha) throw new Error("BASE_SHA_CHANGED");
    const safe = input.taskId.replace(/[^A-Za-z0-9_-]/g, "-");
    const branch = `agentplatform/${safe}/${input.attempt}`;
    const target = path.resolve(this.managedRoot, safe, String(input.attempt));
    if (!inside(path.resolve(this.managedRoot), target)) throw new Error("WORKTREE_CREATE_FAILED");
    await this.git(snapshot.root, ["worktree", "add", "-b", branch, target, input.baseSha]);
    return { branch, worktreePath: target };
  }

  async collectEvidence(worktree: string): Promise<GitEvidence> {
    const root = realpathSync(worktree);
    const head = (await this.git(root, ["rev-parse", "HEAD"])).trim();
    const status = await this.git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const tokens = status.split("\0");
    const changedFiles: string[] = [];
    const untracked: string[] = [];
    for (let index = 0; index < tokens.length && tokens[index]; index++) {
      const token = tokens[index];
      if (token.length < 4 || token[2] !== " ") throw new Error("GIT_STATUS_INVALID");
      const file = token.slice(3).replace(/\\/g, "/");
      changedFiles.push(file);
      if (token.startsWith("?? ")) untracked.push(file);
      if (/[RC]/.test(token.slice(0, 2))) {
        const old = tokens[++index];
        if (!old) throw new Error("GIT_STATUS_INVALID");
        changedFiles.push(old.replace(/\\/g, "/"));
      }
    }
    const invalidPaths: string[] = [];
    for (const file of changedFiles) {
      const absolute = path.resolve(root, file);
      if (!inside(root, absolute)) { invalidPaths.push(file); continue; }
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          if (!inside(root, realpathSync(absolute))) invalidPaths.push(file);
        } else if (!stat.isFile()) invalidPaths.push(file);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) invalidPaths.push(file);
      }
      const stage = await this.git(root, ["ls-files", "--stage", "--", file]);
      if (stage.split("\n").some(line => line.startsWith("160000 "))) invalidPaths.push(file);
      if (stage.split("\n").some(line => line.startsWith("120000 "))) {
        const target = (await this.git(root, ["show", `:${file}`])).trim();
        if (!inside(root, path.resolve(root, path.dirname(file), target))) invalidPaths.push(file);
      }
    }
    let diff = await this.git(root, ["diff", "--binary", "--no-ext-diff", "HEAD"]);
    let stat = await this.git(root, ["diff", "--stat", "--no-ext-diff", "HEAD"]);
    for (const file of untracked) {
      if (invalidPaths.includes(file)) continue;
      diff += await this.git(root, ["diff", "--binary", "--no-index", "--", "NUL", file], true);
      stat += await this.git(root, ["diff", "--stat", "--no-index", "--", "NUL", file], true);
      if (Buffer.byteLength(diff) >= OUTPUT_LIMIT) throw new Error("GIT_OUTPUT_LIMIT");
    }
    return { head, changedFiles: [...new Set(changedFiles)], diff, stat, invalidPaths: [...new Set(invalidPaths)] };
  }

  async cleanupWorktree(repo: string, target: string): Promise<void> {
    const managed = realpathSync(this.managedRoot);
    if (managed !== path.resolve(this.managedRoot)) throw new Error("Refusing to clean path outside managed root");
    const resolved = path.resolve(target);
    if (!inside(managed, resolved)) throw new Error("Refusing to clean path outside managed root");
    if (!lstatSync(resolved).isDirectory() || !inside(managed, realpathSync(resolved))) throw new Error("Refusing to clean path outside managed root");
    await this.git(repo, ["worktree", "remove", "--force", resolved]);
    rmSync(resolved, { recursive: true, force: true });
  }
}
