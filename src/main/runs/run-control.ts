import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../db/database.js";
import { cancelActiveProcess } from "../process/runner.js";
import { cancelActiveCursorProposal } from "../adapters/cursor/cursor-proposal-adapter.js";

export type LogWindow = { runId: string; stream: "stdout" | "stderr"; cursor: number; nextCursor: number; text: string; eof: boolean };
const WINDOW_BYTES = 32 * 1024;

export class RunControl {
  private readonly database: AppDatabase;
  private readonly artifactRoot: string;
  constructor(database: AppDatabase, artifactRoot: string) { this.database = database; this.artifactRoot = artifactRoot; }

  cancel(runId: string): { cancelled: boolean } {
    const run = this.database.getRun(runId);
    if (!run || !["STARTING", "RUNNING", "CANCELLING"].includes(run.status)) return { cancelled: false };
    return { cancelled: cancelActiveProcess(runId) || cancelActiveCursorProposal(runId) };
  }

  readLogWindow(runId: string, stream: "stdout" | "stderr", cursor: number): LogWindow {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("INVALID_LOG_CURSOR");
    const run = this.database.getRun(runId);
    if (!run) throw new Error("RUN_NOT_FOUND");
    const testId = run.stage.startsWith("test:") ? run.stage.slice(5) : null;
    if (testId !== null && (!run.attemptId || !/^[A-Za-z0-9_-]{1,100}$/.test(testId))) throw new Error("INVALID_RUN_PATH");
    const root = testId === null ? path.resolve(this.artifactRoot, "runs") : path.resolve(this.artifactRoot, "attempts", run.attemptId!, "tests");
    const runRoot = path.resolve(root, testId ?? runId);
    const result: LogWindow = { runId, stream, cursor, nextCursor: cursor, text: "", eof: true };
    if (!existsSync(runRoot) && run.status === "STARTING") return result;
    if (path.relative(root, runRoot) !== (testId ?? runId) || !lstatSync(runRoot).isDirectory() || realpathSync(runRoot) !== runRoot) throw new Error("INVALID_RUN_PATH");
    const file = path.join(runRoot, `${stream}.log`);
    let fd: number;
    try {
      if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error("INVALID_LOG_PATH");
      fd = openSync(file, "r");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return result;
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      if (cursor > size) throw new Error("INVALID_LOG_CURSOR");
      const bytes = Math.min(WINDOW_BYTES, size - cursor);
      const buffer = Buffer.alloc(bytes);
      const count = readSync(fd, buffer, 0, bytes, cursor);
      if (count > 0 && (buffer[0] & 0xc0) === 0x80) throw new Error("INVALID_LOG_CURSOR");
      let length = count;
      if (count > 0 && cursor + count < size) {
        let lead = count - 1;
        while (lead > 0 && (buffer[lead] & 0xc0) === 0x80) lead--;
        const first = buffer[lead];
        const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        if (count - lead < width) length = lead;
      }
      result.nextCursor = cursor + length;
      result.text = buffer.subarray(0, length).toString("utf8");
      result.eof = result.nextCursor >= size;
      return result;
    } finally { closeSync(fd); }
  }
}
