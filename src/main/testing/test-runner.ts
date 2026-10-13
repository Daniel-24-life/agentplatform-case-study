import { runProcess, type ProcessResult } from "../process/runner.js";
import type { TestCommand } from "../../shared/core/task-spec.js";
import { isPathInside } from "../../shared/core/paths.js";
import { realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type TestRun = {
  id: string;
  runId?: string;
  required: boolean;
  result: ProcessResult;
};

export type TestRunHooks = {
  begin: (_command: TestCommand) => { runId: string; onSpawn?: (_pid: number | null) => void };
  finish: (_runId: string, _result: ProcessResult, _logDir: string) => void;
};

export const runApprovedTests = async (
  worktree: string,
  commands: TestCommand[],
  logRoot: string,
  hooks?: TestRunHooks
): Promise<TestRun[]> => {
  const runs: TestRun[] = [];

  for (const command of commands) {
    if (!isPathInside(command.cwd, worktree).valid) {
      throw new Error("Test cwd escapes worktree");
    }

    const realWorktree = realpathSync(worktree);
    const cwd = path.resolve(worktree, command.cwd);
    const realCwd = realpathSync(cwd);
    const relative = path.relative(realWorktree, realCwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Test cwd escapes worktree");
    }

    const managed = hooks?.begin(command);
    const runId = managed?.runId ?? randomUUID();
    const logDir = path.resolve(logRoot, command.id);
    const result = await runProcess({
      program: command.program,
      args: command.args,
      cwd: realCwd,
      timeoutSeconds: command.timeout_seconds,
      logDir,
      runId,
      onSpawn: managed?.onSpawn
    });

    hooks?.finish(runId, result, logDir);
    runs.push({ id: command.id, runId, required: command.required, result });
    if (result.status === "CANCELLED") break;
  }
  return runs;
};
