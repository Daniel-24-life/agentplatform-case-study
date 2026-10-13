import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";

const roots: string[] = [];
const stores: AppDatabase[] = [];
const now = "2026-09-20T00:00:00.000Z";

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-run-persistence-"));
  roots.push(root);
  const file = path.join(root, "application.db");
  const store = new AppDatabase(file);
  stores.push(store);
  store.createProject({ id: "P1", name: "fixture", repoPath: root, repoRealPath: root, lastSeenHead: "a".repeat(40) });
  store.createTask({ id: "T1", projectId: "P1", title: "fixture", requestText: "persist run", status: "DRAFT", baseSha: "a".repeat(40) });
  store.createAttempt({ id: "A1", taskId: "T1", number: 1, branch: "agentplatform/T1/1", worktreePath: path.join(root, "worktree"), status: "ACTIVE", createdAt: now });
  return { root, file, store };
};

describe("run evidence persistence", () => {
  it("reopens terminal result, usage, failure, termination evidence and artifacts", () => {
    const { root, file, store } = setup();
    const runId = "R1";
    const termination = { requested: "TIMEOUT", forceIssued: true, directKillAttempts: 1, directKillSucceeded: 1, taskkill: [], settledWithoutClose: false };
    store.createRun({ id: runId, taskId: "T1", attemptId: "A1", stage: "builder", adapter: "codex", model: "gpt-5.6-luna", reasoning: "low", workerClass: "cheap", cwd: root, pid: 1234, status: "RUNNING", exitCode: null, startedAt: now, endedAt: null, errorCode: null, failureDomain: null, durationMs: null, isEscalation: false, isHighTier: false, usageJson: null });
    store.updateRun(runId, { status: "TIMED_OUT", exitCode: null, endedAt: now, errorCode: "PROCESS_TIMEOUT", failureDomain: "runtime", durationMs: 3210, usageJson: JSON.stringify({ inputTokens: 18, outputTokens: 7, totalTokens: 25, termination }) });
    store.appendEvent({ id: "E1", taskId: "T1", runId, sequence: 1, type: "RUN_TERMINAL", payloadJson: JSON.stringify({ status: "TIMED_OUT", exitCode: null, termination }), createdAt: now });
    store.appendEvent({ id: "E2", taskId: "T1", runId, sequence: 2, type: "RUN_CLASSIFIED", payloadJson: JSON.stringify({ code: "PROCESS_TIMEOUT", domain: "runtime", retryable: false }), createdAt: now });
    const artifactPath = path.join(root, "termination.json");
    writeFileSync(artifactPath, JSON.stringify(termination));
    store.createArtifact({ id: "AR1", runId, kind: "termination", path: artifactPath, sha256: "b".repeat(64), sizeBytes: 147 });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new AppDatabase(file);
    stores.push(reopened);
    expect(reopened.listRuns("A1")).toContainEqual(expect.objectContaining({ id: runId, status: "TIMED_OUT", errorCode: "PROCESS_TIMEOUT", failureDomain: "runtime", durationMs: 3210, usageJson: expect.stringContaining('"totalTokens":25') }));
    expect(reopened.listEvents("T1").map((event) => event.type)).toEqual(["RUN_TERMINAL", "RUN_CLASSIFIED"]);
    expect(JSON.parse(reopened.listEvents("T1")[0].payloadJson)).toMatchObject({ status: "TIMED_OUT", termination: { requested: "TIMEOUT", settledWithoutClose: false } });
    expect(reopened.listArtifacts(runId)).toEqual([expect.objectContaining({ kind: "termination", sha256: "b".repeat(64), sizeBytes: 147 })]);
  });

  it("marks active runs and active task state interrupted during recovery", () => {
    const { store } = setup();
    store.transitionTask("T1", "DESIGNING");
    store.createRun({ id: "R2", taskId: "T1", attemptId: "A1", stage: "architect", adapter: "codex", model: "gpt-5.6-luna", reasoning: "low", workerClass: null, cwd: "C:/fixture", pid: 4321, status: "CANCELLING", exitCode: null, startedAt: now, endedAt: null, errorCode: null, failureDomain: null, durationMs: null, isEscalation: false, isHighTier: false, usageJson: null });
    expect(store.recoverInterrupted()).toBe(1);
    expect(store.listRuns("A1")[0]).toMatchObject({ status: "INTERRUPTED", errorCode: "RUN_INTERRUPTED", exitCode: null });
    expect(store.getTask("T1")?.status).toBe("INTERRUPTED");
    expect(store.listEvents("T1").at(-1)?.payloadJson).toContain("APP_RESTART");
  });

  it("rejects oversized event payloads", () => {
    const { store } = setup();
    expect(() => store.appendEvent({ id: "E-big", taskId: "T1", runId: null, sequence: 1, type: "DIAGNOSTIC", payloadJson: "x".repeat(65537), createdAt: now })).toThrow("Event payload too large");
  });
});
