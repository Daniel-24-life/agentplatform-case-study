import { dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { AppDatabase } from "./db/database.js";
import type { GitService } from "./git/git-service.js";
import type { TaskOrchestrator } from "./orchestrator/task-orchestrator.js";
import { RunControl } from "./runs/run-control.js";
import { runCodexRuntimePreflight, type CodexRuntimePreflightResult } from "./runtime/codex-runtime-preflight.js";
import { AgentRunError } from "./adapters/agent-adapter.js";
import type { WorkerProfiles } from "./router/worker-router.js";
import type { ProductService } from "./products/product-service.js";
import { initProductIpcHandlers, disposeProductIpcHandlers } from "./products/product-ipc.js";
import { disposeProductDeliveryIpcHandlers } from "./products/product-delivery-ipc.js";
import { disposeProductRunIpcHandlers } from "./products/product-run-ipc.js";
import { disposeProductExecutionIpcHandlers } from "./products/product-execution-ipc.js";
import { disposeProductPlanIpcHandlers } from "./products/product-plan-ipc.js";
import { disposePlanningIpcHandlers } from "./products/planning-ipc.js";

export type PingResponse = { ok: boolean; app: string };
export type RuntimePreflightSummary = { passed: boolean; startedAt: string; finishedAt: string; steps: Array<{ id: string; status: string; durationMs: number }>; failure?: { code: string; diagnosticSummary: string } };
export const summarizePreflight = (result: CodexRuntimePreflightResult): RuntimePreflightSummary => ({ passed: result.passed, startedAt: result.startedAt, finishedAt: result.finishedAt, steps: result.steps.map((step) => ({ id: step.id, status: step.status, durationMs: step.durationMs })), ...(result.failure ? { failure: { code: result.failure.code, diagnosticSummary: result.failure.diagnosticSummary } } : {}) });
export const requireRuntimePreflight = (result: RuntimePreflightSummary | null): void => { if (!result?.passed) throw new Error("RUNTIME_PREFLIGHT_REQUIRED"); };

const subscriptions = new Map<string, { senderId: number; unsubscribe: () => void }>();
const requireId = (value: unknown): string => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error("INVALID_ID"); return value; };
const requireSequence = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("INVALID_EVENT_SEQUENCE"); return value as number; };

export type RuntimeModelAccess = { assertReady: () => void; invoke: <T>(_action: () => Promise<T>) => Promise<T> };

export const initIpcHandlers = (database?: AppDatabase, git?: GitService, orchestrator?: TaskOrchestrator, runtime?: { artifactRoot: string; profiles: WorkerProfiles }, products?: ProductService, isProductSender?: (_event: IpcMainInvokeEvent) => boolean, assertTaskIdle?: (_taskId: string, _stage?: "build" | "review") => void): RuntimeModelAccess | undefined => {
  if (products) initProductIpcHandlers(products, isProductSender ?? (() => false));
  let lastPreflight: RuntimePreflightSummary | null = null;
  let lastDoctor: RuntimePreflightSummary | null = null;
  let inFlight: Promise<RuntimePreflightSummary> | null = null;
  ipcMain.handle("platform:ping", () => ({ ok: true, app: "agentplatform" }));
  if (!database || !git) return;
  ipcMain.handle("projects:choose", async () => { const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] }); if (picked.canceled || !picked.filePaths[0]) return null; const snapshot = await git.inspect(picked.filePaths[0]); return database.createProject({ id: randomUUID(), name: path.basename(snapshot.root), repoPath: snapshot.root, repoRealPath: snapshot.root, lastSeenHead: snapshot.head }); });
  ipcMain.handle("projects:list", () => database.listProjects());
  ipcMain.handle("tasks:list", (_event, projectId: unknown) => { if (typeof projectId !== "string") throw new Error("Invalid projectId"); return database.listTasks(projectId); });
  ipcMain.handle("tasks:create", async (_event, input: unknown) => { if (typeof input !== "object" || input === null) throw new Error("Invalid input"); const value = input as Record<string, unknown>; if (typeof value.projectId !== "string" || typeof value.title !== "string" || typeof value.requestText !== "string") throw new Error("Invalid task input"); const project = database.listProjects().find((p) => p.id === value.projectId); if (!project) throw new Error("Project not found"); const snapshot = await git.inspect(project.repoRealPath); if (!snapshot.clean) throw new Error("REPOSITORY_DIRTY"); return database.createTask({ id: `TASK-${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`, projectId: project.id, title: value.title, requestText: value.requestText, status: "DRAFT", baseSha: snapshot.head }); });
  ipcMain.handle("tasks:get", (_event, taskId: unknown) => { if (typeof taskId !== "string") throw new Error("Invalid taskId"); return database.getTask(taskId) ?? null; });
  ipcMain.handle("runtime:preflight", async () => { if (!runtime) throw new Error("Runtime unavailable"); if (inFlight) return inFlight; const parent = path.join(runtime.artifactRoot, "runtime-preflight"); mkdirSync(parent, { recursive: true }); const artifactRoot = path.join(parent, randomUUID()); inFlight = runCodexRuntimePreflight({ models: [runtime.profiles.strong.model, runtime.profiles.cheap.model], artifactRoot, timeoutSeconds: 120 }).then((result) => { lastPreflight = summarizePreflight(result); return lastPreflight; }).finally(() => { inFlight = null; }); return inFlight; });
  ipcMain.handle("runtime:preflightStatus", () => lastPreflight);
  ipcMain.handle("runtime:doctor", async () => { if (!runtime) throw new Error("Runtime unavailable"); const parent = path.join(runtime.artifactRoot, "runtime-doctor"); mkdirSync(parent, { recursive: true }); const result = await runCodexRuntimePreflight({ models: [], artifactRoot: path.join(parent, randomUUID()), timeoutSeconds: 30, probeModels: false }); lastDoctor = summarizePreflight(result); return lastDoctor; });
  ipcMain.handle("runtime:doctorStatus", () => lastDoctor);
const modelAction = async <T>(action: () => Promise<T>): Promise<T> => { requireRuntimePreflight(lastPreflight); try { return await action(); } catch (error) { if (error instanceof AgentRunError && error.classification.domain === "runtime") lastPreflight = null; throw error; } };
  const guardTask = (taskId: string, stage?: "build" | "review"): string => { assertTaskIdle?.(taskId, stage); return taskId; };
  if (orchestrator) {
    const id = (value: unknown): string => { if (typeof value !== "string") throw new Error("Invalid taskId"); return value; };

    ipcMain.handle("tasks:detail", (_e, value) => orchestrator.detail(id(value)));
    ipcMain.handle("tasks:updateSpec", (_e, value: unknown) => { if (typeof value !== "object" || value === null) throw new Error("Invalid input"); const record = value as Record<string, unknown>; return orchestrator.updateSpec(guardTask(id(record.taskId)), record.revision); });
    ipcMain.handle("tasks:approveSpec", (_e, value) => orchestrator.approveSpec(guardTask(id(value))));
    ipcMain.handle("tasks:startDesign", (_e, value) => modelAction(() => orchestrator.startDesign(guardTask(id(value)))));
    ipcMain.handle("tasks:approveEscalation", (_e, value) => orchestrator.approveEscalation(guardTask(id(value))));
    ipcMain.handle("tasks:startBuild", (_e, value) => modelAction(() => orchestrator.startBuild(guardTask(id(value), "build"))));
    ipcMain.handle("tasks:startCursorBuild", (_e, value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_WORKER_SELECTION");
      const selection = value as Record<string, unknown>;
      if (Object.keys(selection).sort().join(",") !== "provider,schema_version,task_id" ||
          selection.schema_version !== "1.0" || selection.provider !== "cursor") throw new Error("INVALID_WORKER_SELECTION");
      return orchestrator.startBuild(guardTask(requireId(selection.task_id), "build"), "cursor");
    });
    ipcMain.handle("tasks:startTests", (_e, value) => orchestrator.startTests(guardTask(id(value))));
    ipcMain.handle("tasks:startFinalGate", (_e, value) => modelAction(() => orchestrator.startFinalGate(guardTask(id(value), "review"))));
  }
  if (runtime) {
    const runs = new RunControl(database, runtime.artifactRoot);
    ipcMain.handle("runs:cancel", (_event, runId: unknown) => runs.cancel(requireId(runId)));
    ipcMain.handle("runs:readLogWindow", (_event, runId: unknown, stream: unknown, cursor: unknown) => {
      if (stream !== "stdout" && stream !== "stderr") throw new Error("INVALID_LOG_STREAM");
      return runs.readLogWindow(requireId(runId), stream, cursor as number);
    });
  }
  ipcMain.handle("events:since", (_event, taskId: unknown, sequence: unknown) => {
    const id = requireId(taskId);
    if (!database.getTask(id)) throw new Error("TASK_NOT_FOUND");
    return database.listEventsAfter(id, requireSequence(sequence));
  });
  ipcMain.handle("events:subscribe", (event, taskId: unknown) => {
    const id = requireId(taskId);
    if (!database.getTask(id)) throw new Error("TASK_NOT_FOUND");
    const subscriptionId = randomUUID();
    const sender = event.sender;
    const unsubscribe = database.subscribeEvents((record) => {
      if (record.taskId === id && !sender.isDestroyed()) sender.send("events:changed", { subscriptionId, taskId: id, sequence: record.sequence });
    });
    const cleanup = (): void => { unsubscribe(); sender.removeListener("destroyed", cleanup); subscriptions.delete(subscriptionId); };
    sender.on("destroyed", cleanup);
    subscriptions.set(subscriptionId, { senderId: sender.id, unsubscribe: cleanup });
    return subscriptionId;
  });
  ipcMain.handle("events:unsubscribe", (event, subscriptionId: unknown) => {
    const subscription = subscriptions.get(requireId(subscriptionId));
    if (subscription?.senderId === event.sender.id) subscription.unsubscribe();
  });
  return { assertReady: () => requireRuntimePreflight(lastPreflight), invoke: modelAction };
};

export const disposeIpcHandlers = (): void => { disposeProductIpcHandlers(); disposePlanningIpcHandlers(); disposeProductPlanIpcHandlers(); disposeProductExecutionIpcHandlers(); disposeProductRunIpcHandlers(); disposeProductDeliveryIpcHandlers(); for (const subscription of subscriptions.values()) subscription.unsubscribe(); for (const channel of ["platform:ping", "projects:choose", "projects:list", "tasks:list", "tasks:create", "tasks:get", "tasks:detail", "tasks:startDesign", "tasks:updateSpec", "tasks:approveSpec", "tasks:approveEscalation", "tasks:startBuild", "tasks:startCursorBuild", "tasks:startTests", "tasks:startFinalGate", "runs:cancel", "runs:readLogWindow", "events:since", "events:subscribe", "events:unsubscribe", "runtime:preflight", "runtime:preflightStatus", "runtime:doctor", "runtime:doctorStatus"]) ipcMain.removeHandler(channel); };
