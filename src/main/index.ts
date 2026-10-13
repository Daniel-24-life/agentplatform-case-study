import { ProductPreviewService } from "./products/product-preview-service.js";
import { initProductPreviewIpcHandlers } from "./products/product-preview-ipc.js";
import { createProductPreviewWindow } from "./products/product-preview-window.js";
import { app, BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { initIpcHandlers } from "./ipc.js";
import { AppDatabase } from "./db/database.js";
import { GitService } from "./git/git-service.js";
import { CodexAdapter } from "./adapters/codex/codex-adapter.js";
import { CheapWorkerAdapter } from "./adapters/cheap-worker/cheap-worker-adapter.js";
import { CursorProposalAdapter } from "./adapters/cursor/cursor-proposal-adapter.js";
import { DEFAULT_WORKER_PROFILES, WorkerRouter } from "./router/worker-router.js";
import { TaskOrchestrator } from "./orchestrator/task-orchestrator.js";
import { ProductService } from "./products/product-service.js";
import { ProductDeliveryService } from "./products/product-delivery-service.js";
import { initProductDeliveryIpcHandlers } from "./products/product-delivery-ipc.js";
import { ProductRunService } from "./products/product-run-service.js";
import { initProductRunIpcHandlers } from "./products/product-run-ipc.js";
import { RunControl } from "./runs/run-control.js";
import { ProductExecutionService } from "./products/product-execution-service.js";
import { initProductExecutionIpcHandlers } from "./products/product-execution-ipc.js";
import { ProductPlanService } from "./products/product-plan-service.js";
import { initProductPlanIpcHandlers } from "./products/product-plan-ipc.js";
import { ProductPlanningService } from "./products/product-planning-service.js";
import { CodexProductPlanner } from "./products/product-planner.js";
import { initPlanningIpcHandlers } from "./products/planning-ipc.js";
import { pathToFileURL } from "node:url";

import type { BrowserWindow as BrowserWindowType } from "electron";

let mainWindow: BrowserWindowType | null = null;

const userDataOverride = process.env.AGENTPLATFORM_USER_DATA_DIR;
if (userDataOverride) {
  if (!isAbsolute(userDataOverride)) throw new Error("AGENTPLATFORM_USER_DATA_DIR must be absolute");
  mkdirSync(userDataOverride, { recursive: true });
  app.setPath("userData", userDataOverride);
}

function getRendererEntry(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return process.env.VITE_DEV_SERVER_URL;
  }

  return join(__dirname, "../renderer/index.html");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "AgentPlatform"
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(getRendererEntry());
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

app.whenReady().then(() => {
  if (!ownsInstance) return;
  const dataRoot=app.getPath("userData");
  const database=new AppDatabase(join(dataRoot,"agentplatform.db"));
  database.recoverInterrupted();
  const git=new GitService("git",join(dataRoot,"managed-worktrees"));
  const schemas=join(app.getAppPath(),"schemas");
  const codex=new CodexAdapter();
  const cheap=new CheapWorkerAdapter();
  const cursor=new CursorProposalAdapter();
  const profiles = DEFAULT_WORKER_PROFILES;
  const orchestrator=new TaskOrchestrator(database,git,codex,codex,[codex,cheap],new WorkerRouter(profiles),profiles,join(dataRoot,"artifacts"),schemas,cursor);
  const products = new ProductService(database);
  const trustedProductSender = (event: import("electron").IpcMainInvokeEvent): boolean => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
    const entry = process.env.VITE_DEV_SERVER_URL ? new URL(getRendererEntry()).href : pathToFileURL(getRendererEntry()).href;
    return event.senderFrame?.url === entry;
  };
  const runtimeAccess = initIpcHandlers(database,git,orchestrator,{artifactRoot:join(dataRoot,"artifacts"),profiles},products,trustedProductSender, (taskId, stage) => productRuns.assertTaskIdle(taskId, stage));
  if (!runtimeAccess) throw new Error("Runtime access unavailable");
  const productPlanner = new CodexProductPlanner(schemas, join(dataRoot, "artifacts", "product-planning"));
  const planning = new ProductPlanningService(database, products, productPlanner);
  initPlanningIpcHandlers(planning, trustedProductSender);
  const productPlans = new ProductPlanService(database, products);
  initProductPlanIpcHandlers(productPlans, trustedProductSender);
  const execution = new ProductExecutionService(database, products, productPlans, git);
  initProductExecutionIpcHandlers(execution, trustedProductSender);
  const productRuns = new ProductRunService(database, execution, orchestrator, runtimeAccess, new RunControl(database, join(dataRoot, "artifacts")));
  productRuns.recoverInterrupted();
  initProductRunIpcHandlers(productRuns, trustedProductSender);
  const deliveries = new ProductDeliveryService(database, products, productPlans, execution, orchestrator, git, join(dataRoot, "artifacts"));
  initProductDeliveryIpcHandlers(deliveries, trustedProductSender);
  const previewWindows = new Map<string, BrowserWindow>();
  const previews = new ProductPreviewService(database, deliveries, join(dataRoot, "artifacts", "product-previews"), {
    serverPath: join(__dirname, "product-preview-server.js"), env: { ELECTRON_RUN_AS_NODE: "1" },
    openWindow: (id, url) => {
      const existing = previewWindows.get(id); if (existing && !existing.isDestroyed()) { existing.focus(); return; }
      const window = createProductPreviewWindow(id, url); previewWindows.set(id, window);
      window.on("closed", () => previewWindows.delete(id));
    },
    closeWindow: id => { const window = previewWindows.get(id); if (window && !window.isDestroyed()) window.close(); }
  });
  previews.recoverInterrupted();
  initProductPreviewIpcHandlers(previews, trustedProductSender);
  let quitting = false, quitReady = false;
  app.on("before-quit", event => {
    if (quitReady) return;
    event.preventDefault(); if (quitting) return;
    quitting = true;
    void previews.closeAll().catch(() => console.error("Preview shutdown was not fully confirmed")).finally(() => { quitReady = true; app.quit(); });
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
