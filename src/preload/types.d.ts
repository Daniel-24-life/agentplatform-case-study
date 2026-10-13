import type { ProductPreviewsApi } from "../shared/contracts/product-preview.js";
/* eslint-disable no-unused-vars */
import type { ProjectRecord, TaskRecord, TaskDetailRecord } from "../shared/contracts/records.js";
import type { EventRecord } from "../shared/contracts/records.js";
import type { ProductsApi } from "../shared/contracts/products.js";
import type { ProductPlanApi } from "../shared/contracts/product-plan.js";
import type { PlanningApi } from "../shared/contracts/product-planning.js";
import type { ProductExecutionApi } from "../shared/contracts/product-execution.js";
import type { ProductRunsApi } from "../shared/contracts/product-run.js";
export type PlatformPingResult = {
  ok: boolean;
  app: string;
};
export type RuntimePreflightSummary = { passed: boolean; startedAt: string; finishedAt: string; steps: Array<{ id: string; status: string; durationMs: number }>; failure?: { code: string; diagnosticSummary: string } };
export type LogWindow = { runId: string; stream: "stdout" | "stderr"; cursor: number; nextCursor: number; text: string; eof: boolean };

import type { ProductDeliveriesApi } from "../shared/contracts/product-delivery.js";
export interface PlatformBridgeApi {
  productDeliveries: ProductDeliveriesApi;
  products: ProductsApi;
  productPlanning: PlanningApi;
  productPlans: ProductPlanApi;
  productExecution: ProductExecutionApi;
  productRuns: ProductRunsApi;
  productPreviews: ProductPreviewsApi;
  ping: () => Promise<PlatformPingResult>;
  runtime: { preflight: () => Promise<RuntimePreflightSummary>; status: () => Promise<RuntimePreflightSummary | null>; doctor: () => Promise<RuntimePreflightSummary>; doctorStatus: () => Promise<RuntimePreflightSummary | null> };
  projects: { chooseAndRegister:()=>Promise<ProjectRecord|null>; list:()=>Promise<ProjectRecord[]> };
  tasks: { list:(projectId:string)=>Promise<TaskRecord[]>; create:(input:{projectId:string;title:string;requestText:string})=>Promise<TaskRecord>; get:(taskId:string)=>Promise<TaskRecord|null>; detail:(taskId:string)=>Promise<TaskDetailRecord>; startDesign:(taskId:string)=>Promise<TaskRecord>; updateSpec:(taskId:string,revision:unknown)=>Promise<TaskRecord>; approveSpec:(taskId:string)=>Promise<TaskRecord>; approveEscalation:(taskId:string)=>Promise<TaskRecord>; startBuild:(taskId:string)=>Promise<TaskRecord>; startCursorBuild:(taskId:string)=>Promise<TaskRecord>; startTests:(taskId:string)=>Promise<TaskRecord>; startFinalGate:(taskId:string)=>Promise<TaskRecord> };
  runs: { cancel:(runId:string)=>Promise<{cancelled:boolean}>; readLogWindow:(runId:string,stream:"stdout"|"stderr",cursor:number)=>Promise<LogWindow> };
  events: { subscribe:(taskId:string,listener:(event:EventRecord)=>void)=>()=>void };
}

declare global {
  interface Window {
    platform: PlatformBridgeApi;
  }
}

export {};
