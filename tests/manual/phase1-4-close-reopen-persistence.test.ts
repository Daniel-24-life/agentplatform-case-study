import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppDatabase } from "../../src/main/db/database.js";

const now = (): string => new Date().toISOString();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const requestedEvidenceRoot = process.env.PHASE1_4_PERSISTENCE_EVIDENCE;
const evidenceRoot = requestedEvidenceRoot
  ? path.resolve(requestedEvidenceRoot)
  : path.resolve(mkdtempSync(path.join(os.tmpdir(), "agentplatform-p14-persistence-")));

afterEach(() => {
  if (!requestedEvidenceRoot) rmSync(evidenceRoot, { recursive: true, force: true });
});

describe("Phase 1.4 close/reopen persistence smoke", () => {
  it("preserves task, approval, attempt, runs, events, artifacts and snapshot across reopen", () => {
    if (requestedEvidenceRoot) expect(existsSync(evidenceRoot)).toBe(false);
    mkdirSync(evidenceRoot, { recursive: true });
    const databasePath = path.join(evidenceRoot, "application-data", "agentplatform.db");
    const snapshotPath = path.join(evidenceRoot, "application-data", "runs", "attempt-p14", "snapshot.json");
    const projectId = "project-p14-persistence";
    const taskId = "task-p14-persistence";
    const attemptId = "attempt-p14-persistence";
    const runId = "run-p14-persistence";
    const spec = JSON.stringify({
      version: 1,
      title: "Offline persistence smoke",
      objective: "Verify durable close/reopen state without model execution.",
      baseSha: "a".repeat(40),
      contextPaths: ["README.md"],
      scope: { allowedPaths: ["src/example.ts"], forbiddenPaths: [".env"] },
      acceptanceCriteria: ["state survives application close and reopen"],
      testCommands: [{ program: "node", args: ["--version"], cwd: ".", timeoutSeconds: 5 }],
      maxAttempts: 2,
      workerPreference: "cheap"
    });
    const snapshot = { attemptId, branch: "agentplatform/p14-persistence", worktreePath: path.join(evidenceRoot, "managed-worktree"), status: "PASSED", artifact: "final-gate.json" };
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    const artifactHash = hash(JSON.stringify(snapshot, null, 2));
    const startedAt = now();

    const before = (() => {
      const database = new AppDatabase(databasePath);
      database.createProject({ id: projectId, name: "Phase 1.4 disposable project", repoPath: path.join(evidenceRoot, "fixture-repo"), repoRealPath: path.join(evidenceRoot, "fixture-repo"), lastSeenHead: "a".repeat(40) });
      database.createTask({ id: taskId, projectId, title: "Offline persistence smoke", requestText: "Verify close/reopen persistence", status: "DRAFT", baseSha: "a".repeat(40) });
      database.transitionTask(taskId, "DESIGNING");
      database.transitionTask(taskId, "SPEC_READY");
      database.saveSpec(taskId, spec);
      database.approveSpec(taskId, spec);
      database.transitionTask(taskId, "SPEC_APPROVED");
      database.transitionTask(taskId, "PREPARING_WORKTREE");
      database.createAttempt({ id: attemptId, taskId, number: 1, branch: "agentplatform/p14-persistence", worktreePath: path.join(evidenceRoot, "managed-worktree"), status: "READY", createdAt: startedAt });
      database.transitionTask(taskId, "BUILDING");
      database.transitionTask(taskId, "BUILT");
      database.transitionTask(taskId, "TESTING");
      database.createRun({ id: runId, taskId, attemptId, stage: "final-gate", adapter: "offline-fake", model: null, reasoning: null, workerClass: null, cwd: path.join(evidenceRoot, "managed-worktree"), pid: null, status: "COMPLETED", exitCode: 0, startedAt, endedAt: now(), errorCode: null, failureDomain: null, durationMs: 12, isEscalation: false, isHighTier: false, usageJson: null });
      database.createArtifact({ id: "artifact-p14-snapshot", runId, kind: "snapshot", path: snapshotPath, sha256: artifactHash, sizeBytes: readFileSync(snapshotPath).byteLength });
      database.appendEvent({ id: randomUUID(), taskId, runId, sequence: database.listEvents(taskId).length + 1, type: "TEST_RUN_COMPLETED", payloadJson: JSON.stringify({ status: "PASSED", exitCode: 0 }), createdAt: now() });
      database.transitionTask(taskId, "DETERMINISTIC_GATE");
      database.transitionTask(taskId, "GATE_READY");
      database.transitionTask(taskId, "REVIEWING");
      database.transitionTask(taskId, "PASSED");
      const record = { task: database.getTask(taskId), attempt: database.getLatestAttempt(taskId), runs: database.listTaskRuns(taskId), events: database.listEvents(taskId), artifacts: database.listArtifacts(runId), metrics: database.taskRunMetrics(taskId), snapshot: JSON.parse(readFileSync(snapshotPath, "utf8")) };
      writeFileSync(path.join(evidenceRoot, "before-close.json"), JSON.stringify(record, null, 2));
      database.close();
      return record;
    })();

    const reopened = new AppDatabase(databasePath);
    const after = { task: reopened.getTask(taskId), attempt: reopened.getLatestAttempt(taskId), runs: reopened.listTaskRuns(taskId), events: reopened.listEvents(taskId), artifacts: reopened.listArtifacts(runId), metrics: reopened.taskRunMetrics(taskId), snapshot: JSON.parse(readFileSync(snapshotPath, "utf8")) };
    writeFileSync(path.join(evidenceRoot, "after-reopen.json"), JSON.stringify(after, null, 2));
    reopened.close();
    const comparison = {
      sameTaskId: before.task?.id === after.task?.id,
      sameTaskStatus: before.task?.status === after.task?.status,
      sameSpecAndApproval: before.task?.specJson === after.task?.specJson && Boolean(before.task?.specApprovedAt) === Boolean(after.task?.specApprovedAt),
      sameAttempt: JSON.stringify(before.attempt) === JSON.stringify(after.attempt),
      sameRuns: JSON.stringify(before.runs) === JSON.stringify(after.runs),
      sameEvents: JSON.stringify(before.events) === JSON.stringify(after.events),
      sameArtifacts: JSON.stringify(before.artifacts) === JSON.stringify(after.artifacts),
      sameMetrics: JSON.stringify(before.metrics) === JSON.stringify(after.metrics),
      sameSnapshot: JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot),
      noAutomaticRerun: after.runs.length === 1
    };
    writeFileSync(path.join(evidenceRoot, "comparison.json"), JSON.stringify(comparison, null, 2));
    writeFileSync(path.join(evidenceRoot, "result.json"), JSON.stringify({ pathId: "P14-SMOKE-03", result: Object.values(comparison).every(Boolean) ? "PASS" : "FAIL", offline: true, startedAt, endedAt: now(), databasePath, taskId, evidence: ["before-close.json", "after-reopen.json", "comparison.json"] }, null, 2));
    expect(Object.values(comparison).every(Boolean)).toBe(true);
    expect(after.task?.status).toBe("PASSED");
    expect(after.task?.specApprovedAt).toBeTruthy();
    expect(after.runs).toHaveLength(1);
    expect(after.events.length).toBeGreaterThanOrEqual(9);
    expect(os.platform()).toBeTruthy();
  });
});
