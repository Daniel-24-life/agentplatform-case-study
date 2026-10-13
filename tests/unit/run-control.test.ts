import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { runProcess } from "../../src/main/process/runner.js";
import { RunControl } from "../../src/main/runs/run-control.js";

const roots: string[] = [];
const stores: AppDatabase[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const setup = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-runs-")); roots.push(root);
  const database = new AppDatabase(path.join(root, "app.db")); stores.push(database);
  database.createProject({ id: "P1", name: "fixture", repoPath: root, repoRealPath: root, lastSeenHead: "a".repeat(40) });
  database.createTask({ id: "T1", projectId: "P1", title: "test", requestText: "test", status: "DRAFT", baseSha: "a".repeat(40) });
  database.createTask({ id: "T2", projectId: "P1", title: "other", requestText: "other", status: "DRAFT", baseSha: "a".repeat(40) });
  const artifactRoot = path.join(root, "artifacts");
  const addRun = (id: string, status = "RUNNING", taskId = "T1") => {
    const dir = path.join(artifactRoot, "runs", id); mkdirSync(dir, { recursive: true });
    database.createRun({ id, taskId, attemptId: null, stage: "builder", adapter: "fake", model: null, reasoning: null, workerClass: null, cwd: root, pid: null, status, exitCode: null, startedAt: new Date().toISOString(), endedAt: null, errorCode: null, failureDomain: null, durationMs: null, isEscalation: false, isHighTier: false, usageJson: null });
    return dir;
  };
  return { root, artifactRoot, database, addRun, control: new RunControl(database, artifactRoot) };
};

describe("RunControl", () => {
  it("cancels only the selected active fake process", async () => {
    const { root, addRun, control } = setup();
    const a = "run-a"; const b = "run-b"; addRun(a); addRun(b, "RUNNING", "T2");
    const first = runProcess({ program: process.execPath, args: ["-e", "setTimeout(()=>{},2000)"], cwd: root, timeoutSeconds: 5, runId: a });
    const second = runProcess({ program: process.execPath, args: ["-e", "setTimeout(()=>process.stdout.write('B complete'),450)"], cwd: root, timeoutSeconds: 5, runId: b });
    const probe = runProcess({ program: process.execPath, args: ["-e", "setTimeout(()=>process.stdout.write('probe complete'),450)"], cwd: root, timeoutSeconds: 5, runId: "probe-unowned" });
    expect(control.cancel("unknown")).toEqual({ cancelled: false });
    expect(control.cancel("probe-unowned")).toEqual({ cancelled: false });
    expect(control.cancel(a)).toEqual({ cancelled: true });
    const [firstResult, secondResult, probeResult] = await Promise.all([first, second, probe]);
    expect(firstResult.status).toBe("CANCELLED");
    expect(secondResult.status).toBe("SUCCEEDED");
    expect(secondResult.stdout).toBe("B complete");
    expect(probeResult.status).toBe("SUCCEEDED");
    expect(control.cancel(a)).toEqual({ cancelled: false });
  });

  it("reads bounded sequential log windows after a database restart", () => {
    const { root, artifactRoot, database, addRun, control } = setup();
    const dir = addRun("run-log", "SUCCEEDED");
    const content = "汉字😀".repeat(9000);
    writeFileSync(path.join(dir, "stdout.log"), content);
    let cursor = 0; let joined = ""; let windows = 0;
    while (true) {
      const window = control.readLogWindow("run-log", "stdout", cursor);
      expect(window.nextCursor - cursor).toBeLessThanOrEqual(32768);
      joined += window.text; windows++; cursor = window.nextCursor;
      if (window.eof) break;
      expect(windows).toBeLessThan(20);
    }
    expect(windows).toBeGreaterThan(1);
    expect(joined).toBe(content);
    expect(() => control.readLogWindow("run-log", "stdout", -1)).toThrow("INVALID_LOG_CURSOR");
    expect(() => control.readLogWindow("run-log", "stdout", 1)).toThrow("INVALID_LOG_CURSOR");
    expect(() => control.readLogWindow("run-log", "stdout", cursor + 1)).toThrow("INVALID_LOG_CURSOR");
    database.close(); stores.splice(stores.indexOf(database), 1);
    const reopened = new AppDatabase(path.join(root, "app.db")); stores.push(reopened);
    expect(new RunControl(reopened, artifactRoot).readLogWindow("run-log", "stdout", 0).text).toBeTruthy();
  });

  it("rejects a run-directory junction outside its managed root", () => {
    const { root, addRun, control } = setup();
    const dir = addRun("run-link");
    const outside = path.join(root, "outside"); mkdirSync(outside); writeFileSync(path.join(outside, "stdout.log"), "private");
    rmSync(dir, { recursive: true });
    symlinkSync(outside, dir, "junction");
    expect(() => control.readLogWindow("run-link", "stdout", 0)).toThrow("INVALID_RUN_PATH");
  });
  it("reads a TestRun log from its managed attempt rather than an arbitrary path", () => {
    const { artifactRoot, database, control } = setup();
    database.createAttempt({ id: "A1", taskId: "T1", number: 1, branch: "b", worktreePath: "fixture", status: "ACTIVE", createdAt: new Date().toISOString() });
    database.createRun({ id: "run-test", taskId: "T1", attemptId: "A1", stage: "test:unit", adapter: "test-runner", model: null, reasoning: null, workerClass: null, cwd: "fixture", pid: null, status: "SUCCEEDED", exitCode: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), errorCode: null, failureDomain: null, durationMs: 1, isEscalation: false, isHighTier: false, usageJson: null });
    const dir = path.join(artifactRoot, "attempts", "A1", "tests", "unit"); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "stdout.log"), "test output");
    expect(control.readLogWindow("run-test", "stdout", 0).text).toBe("test output");
  });
});
