import { productPreviewsApi } from "./product-previews.js";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { PlatformBridgeApi } from "./types.js";
import type { EventRecord } from "../shared/contracts/records.js";
import { productsApi } from "./products.js";
import { productDeliveriesApi } from "./product-deliveries.js";
import { productRunsApi } from "./product-runs.js";
import { productExecutionApi } from "./product-execution.js";
import { productPlansApi } from "./product-plans.js";
import { planningApi } from "./planning.js";

const validId = (value: string): string => { if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error("INVALID_ID"); return value; };
const subscribe: PlatformBridgeApi["events"]["subscribe"] = (taskId, listener) => {
  validId(taskId);
  let cursor = 0;
  let cancelled = false;
  let active = false;
  let pending = false;
  let subscriptionId: string | null = null;
  const drain = async (): Promise<void> => {
    if (active || cancelled || !subscriptionId) { pending = true; return; }
    active = true;
    try {
      do {
        pending = false;
        let batch: EventRecord[];
        do {
          batch = await ipcRenderer.invoke("events:since", taskId, cursor) as EventRecord[];
          if (!Array.isArray(batch) || batch.length > 256) throw new Error("INVALID_EVENT_BATCH");
          for (const event of batch) {
            if (event.taskId !== taskId || !Number.isSafeInteger(event.sequence) || event.sequence !== cursor + 1 || typeof event.id !== "string" || typeof event.type !== "string" || typeof event.payloadJson !== "string" || typeof event.createdAt !== "string" || !(event.runId === null || typeof event.runId === "string")) throw new Error("INVALID_EVENT_SEQUENCE");
            cursor = event.sequence;
            if (!cancelled) listener(event);
          }
        } while (!cancelled && batch.length === 256);
      } while (!cancelled && pending);
    } finally { active = false; }
  };
  const onChanged = (_event: IpcRendererEvent, value: unknown): void => {
    const record = value as { subscriptionId?: unknown; taskId?: unknown };
    if (record?.subscriptionId === subscriptionId && record.taskId === taskId) void drain().catch(() => undefined);
  };
  ipcRenderer.on("events:changed", onChanged);
  void ipcRenderer.invoke("events:subscribe", taskId).then((id: unknown) => {
    if (typeof id !== "string") throw new Error("INVALID_SUBSCRIPTION");
    subscriptionId = id;
    if (cancelled) void ipcRenderer.invoke("events:unsubscribe", id);
    else void drain().catch(() => undefined);
  }).catch(() => undefined);
  return () => {
    cancelled = true;
    ipcRenderer.removeListener("events:changed", onChanged);
    if (subscriptionId) void ipcRenderer.invoke("events:unsubscribe", subscriptionId);
  };
};

const api: PlatformBridgeApi = {
  products: productsApi,
  productPlanning: planningApi,
  productPlans: productPlansApi,
  productExecution: productExecutionApi,
  productRuns: productRunsApi,
  productPreviews: productPreviewsApi,
  productDeliveries: productDeliveriesApi,
  ping: () => ipcRenderer.invoke("platform:ping"),
  runtime: { preflight: () => ipcRenderer.invoke("runtime:preflight"), status: () => ipcRenderer.invoke("runtime:preflightStatus"), doctor: () => ipcRenderer.invoke("runtime:doctor"), doctorStatus: () => ipcRenderer.invoke("runtime:doctorStatus") },
  projects: { chooseAndRegister:()=>ipcRenderer.invoke("projects:choose"),list:()=>ipcRenderer.invoke("projects:list") },
  tasks: { list:(projectId)=>ipcRenderer.invoke("tasks:list",projectId),create:(input)=>ipcRenderer.invoke("tasks:create",input),get:(taskId)=>ipcRenderer.invoke("tasks:get",taskId),detail:(taskId)=>ipcRenderer.invoke("tasks:detail",taskId),startDesign:(taskId)=>ipcRenderer.invoke("tasks:startDesign",taskId),updateSpec:(taskId,revision)=>ipcRenderer.invoke("tasks:updateSpec",{taskId,revision}),approveSpec:(taskId)=>ipcRenderer.invoke("tasks:approveSpec",taskId),approveEscalation:(taskId)=>ipcRenderer.invoke("tasks:approveEscalation",taskId),startBuild:(taskId)=>ipcRenderer.invoke("tasks:startBuild",taskId),startCursorBuild:(taskId)=>ipcRenderer.invoke("tasks:startCursorBuild",{schema_version:"1.0",task_id:validId(taskId),provider:"cursor"}),startTests:(taskId)=>ipcRenderer.invoke("tasks:startTests",taskId),startFinalGate:(taskId)=>ipcRenderer.invoke("tasks:startFinalGate",taskId) },
  runs: {
    cancel:(runId)=>ipcRenderer.invoke("runs:cancel",validId(runId)),
    readLogWindow:async(runId,stream,cursor)=>{
      if (stream!=="stdout"&&stream!=="stderr") throw new Error("INVALID_LOG_STREAM");
      if (!Number.isSafeInteger(cursor)||cursor<0) throw new Error("INVALID_LOG_CURSOR");
      const value=await ipcRenderer.invoke("runs:readLogWindow",validId(runId),stream,cursor);
      if (value?.runId!==runId||value?.stream!==stream||value?.cursor!==cursor||!Number.isSafeInteger(value?.nextCursor)||value.nextCursor<cursor||value.nextCursor-cursor>32768||typeof value?.text!=="string"||typeof value?.eof!=="boolean") throw new Error("INVALID_LOG_WINDOW");
      return value;
    }
  },
  events: { subscribe }
};

contextBridge.exposeInMainWorld("platform", api);
