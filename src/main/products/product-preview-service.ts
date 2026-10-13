import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../db/database.js";
import { cancelActiveProcess, runProcess, type ProcessResult } from "../process/runner.js";
import type { ProductDeliveryService, ProductPreviewEvidence } from "./product-delivery-service.js";
import { ProductDeliveryError } from "../../shared/contracts/product-delivery.js";
import { ProductPreviewError, type ControlProductPreviewInput, type ProductPreviewSession, type StartProductPreviewInput } from "../../shared/contracts/product-preview.js";
import { assertProductPreviewInput, type ProductPreviewMethod } from "../../shared/core/product-preview-validation.js";
import { canonicalProductJson } from "../../shared/core/product-validation.js";
import { snapshotStaticOutput } from "./product-preview-files.js";

type Row = Record<string, unknown>;
type EvidenceAccess = Pick<ProductDeliveryService, "readPreviewEvidence" | "assertPreviewEvidenceCurrent">;
type PreviewOptions = { serverPath: string; program?: string; env?: Record<string, string>; openWindow?: (_id: string, _url: string) => void; closeWindow?: (_id: string) => void };
const ACTIVE = ["STARTING", "RUNNING", "STOPPING"];
const digest = (value: unknown): string => createHash("sha256").update(canonicalProductJson(value)).digest("hex");
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Owns only the platform's trusted static service; it never executes a product command. */
export class ProductPreviewService {
  private readonly processes = new Map<string, Promise<ProcessResult>>();
  private readonly database: AppDatabase;
  private readonly deliveries: EvidenceAccess;
  private readonly artifactRoot: string;
  private readonly options: PreviewOptions;
  constructor(database: AppDatabase, deliveries: EvidenceAccess, artifactRoot: string, options: PreviewOptions) {
    this.database = database;
    this.deliveries = deliveries;
    this.artifactRoot = artifactRoot;
    this.options = options;
    mkdirSync(artifactRoot, { recursive: true });
  }

  async getState(input: { productId: string }): Promise<ProductPreviewSession | null> {
    assertProductPreviewInput("getState", input);
    const row = this.database.db.prepare("SELECT * FROM product_preview_sessions WHERE product_id=? ORDER BY rowid DESC LIMIT 1").get(input.productId) as Row | undefined;
    if (!row) return null;
    if (ACTIVE.includes(String(row.status)) && row.status !== "STOPPING") {
      try {
        const current = await this.deliveries.readPreviewEvidence(input.productId);
        if (digest(current) !== digest(JSON.parse(String(row.evidence_json)))) throw new ProductPreviewError("EVIDENCE_CHANGED");
      } catch { await this.stopSession(String(row.id), "EVIDENCE_CHANGED"); }
    }
    return this.session(this.row(String(row.id))!);
  }

  async start(input: StartProductPreviewInput): Promise<ProductPreviewSession> {
    assertProductPreviewInput("start", input);
    const requestHash = digest(input);
    const existing = this.receipt(input.requestId, requestHash); if (existing) return this.session(existing);
    let evidence: ProductPreviewEvidence;
    try { evidence = await this.deliveries.readPreviewEvidence(input.productId); }
    catch (error) { throw this.evidenceError(error); }
    const reservation = this.database.transaction(() => {
      const raced = this.receipt(input.requestId, requestHash); if (raced) return { id: String(raced.id), created: false };
      this.deliveries.assertPreviewEvidenceCurrent(input.productId, evidence);
      if (this.database.db.prepare("SELECT 1 FROM product_preview_sessions WHERE product_id=? AND status IN ('STARTING','RUNNING','STOPPING')").get(input.productId)) throw new ProductPreviewError("BUSY", "当前产品已有活动预览，请先停止。");
      const id = `PREVIEW-${randomUUID()}`;
      this.database.db.prepare("INSERT INTO product_preview_sessions(id,request_id,request_hash,product_id,evidence_json,build_directory,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, input.requestId, requestHash, input.productId, JSON.stringify(evidence), input.buildDirectory, "STARTING", new Date().toISOString());
      return { id, created: true };
    });
    if (reservation.created) await this.launch(reservation.id, evidence);
    return this.session(this.row(reservation.id)!);
  }

  async stop(input: ControlProductPreviewInput): Promise<ProductPreviewSession> {
    this.requireSession("stop", input); await this.stopSession(input.sessionId, null);
    return this.session(this.row(input.sessionId)!);
  }

  async open(input: ControlProductPreviewInput): Promise<ProductPreviewSession> {
    this.requireSession("open", input);
    const current = await this.getState({ productId: input.productId });
    if (!current || current.id !== input.sessionId || current.status !== "RUNNING" || !current.url) throw new ProductPreviewError("NOT_READY", "预览尚未运行或证据已过期。");
    this.options.openWindow?.(current.id, current.url);
    return current;
  }

  recoverInterrupted(): number {
    // Never kill a stored PID after restart: it may now belong to another process.
    const result = this.database.db.prepare("UPDATE product_preview_sessions SET status='INTERRUPTED',port=NULL,finished_at=?,error_code='APP_RESTART' WHERE status IN ('STARTING','RUNNING','STOPPING')").run(new Date().toISOString());
    return Number(result.changes);
  }

  async closeAll(): Promise<void> {
    const rows = this.database.db.prepare("SELECT id FROM product_preview_sessions WHERE status IN ('STARTING','RUNNING','STOPPING')").all() as Row[];
    await Promise.all(rows.map(row => this.stopSession(String(row.id), "APP_EXIT")));
  }

  private async launch(id: string, evidence: ProductPreviewEvidence): Promise<void> {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const row = this.row(id)!;
      const directory = this.directory(id); mkdirSync(directory);
      const snapshot = path.join(directory, "site");
      const copied = snapshotStaticOutput(path.join(evidence.evidence.worktreePath, String(row.build_directory)), snapshot);
      this.deliveries.assertPreviewEvidenceCurrent(String(row.product_id), evidence);
      this.database.db.prepare("UPDATE product_preview_sessions SET snapshot_hash=? WHERE id=? AND status='STARTING'").run(copied.hash, id);
      if (this.row(id)?.status !== "STARTING") return;
      const heartbeatPath = path.join(directory, "heartbeat");
      let heartbeatSequence = 0;
      const pulse = () => { try { writeFileSync(heartbeatPath, String(++heartbeatSequence)); } catch { cancelActiveProcess(id); } };
      pulse(); heartbeat = setInterval(pulse, 2000); heartbeat.unref();
      const processPromise = runProcess({ program: this.options.program ?? process.execPath, args: [this.options.serverPath, snapshot, path.join(directory, "manifest.json"), path.join(directory, "ready.json"), heartbeatPath], cwd: directory, env: this.options.env ?? {}, timeoutSeconds: 3600, maxSummaryBytes: 8192, logDir: directory, runId: id,
        onSpawn: pid => { this.database.db.prepare("UPDATE product_preview_sessions SET pid=? WHERE id=? AND status IN ('STARTING','STOPPING')").run(pid, id); }
      }).then(result => {
        if (heartbeat) clearInterval(heartbeat);
        this.processes.delete(id);
        const row = this.row(id);
        if (row && ACTIVE.includes(String(row.status))) {
          const neverStarted = result.status === "START_FAILED" && !result.pid;
          const stopped = row.status === "STOPPING" && result.closeObserved === true;
          this.finish(id, neverStarted ? "FAILED" : stopped ? "STOPPED" : result.closeObserved === false ? "INTERRUPTED" : "FAILED", neverStarted ? "START_FAILED" : stopped ? (row.error_code === null ? null : String(row.error_code)) : result.closeObserved === false ? "STOP_NOT_CONFIRMED" : result.status === "TIMED_OUT" ? "PREVIEW_TIMEOUT" : "PROCESS_EXITED");
        }
        return result;
      });
      this.processes.set(id, processPromise);
      for (let index = 0; index < 200; index++) {
        const current = this.row(id)!;
        if (!ACTIVE.includes(String(current.status)) || current.status === "STOPPING") return;
        if (existsSync(path.join(directory, "ready.json"))) {
          const readyText = readFileSync(path.join(directory, "ready.json"), "utf8");
          if (readyText.length > 2048) throw new ProductPreviewError("START_FAILED");
          let ready: { host: string; port: number; pid: number };
          try { ready = JSON.parse(readyText) as typeof ready; } catch (error) { if (error instanceof SyntaxError) { await pause(50); continue; } throw error; }
          if (ready.host !== "127.0.0.1" || !Number.isSafeInteger(ready.port) || ready.port < 1 || ready.port > 65535 || ready.pid !== Number(current.pid)) throw new ProductPreviewError("START_FAILED", "预览端口公告不正确。");
          this.deliveries.assertPreviewEvidenceCurrent(String(current.product_id), evidence);
          this.database.db.prepare("UPDATE product_preview_sessions SET status='RUNNING',port=? WHERE id=? AND status='STARTING'").run(ready.port, id);
          return;
        }
        await pause(50);
      }
      await this.stopSession(id, "START_TIMEOUT");
    } catch (error) {
      if (this.processes.has(id)) await this.stopSession(id, error instanceof ProductPreviewError ? error.code : "START_FAILED");
      else { if (heartbeat) clearInterval(heartbeat); this.finish(id, "FAILED", error instanceof ProductPreviewError ? error.code : "START_FAILED"); }
    }
  }

  private async stopSession(id: string, errorCode: string | null): Promise<void> {
    const row = this.row(id); if (!row || !ACTIVE.includes(String(row.status))) return;
    this.database.db.prepare("UPDATE product_preview_sessions SET status='STOPPING',port=NULL,error_code=COALESCE(?,error_code) WHERE id=? AND status IN ('STARTING','RUNNING','STOPPING')").run(errorCode, id);
    const running = this.processes.get(id);
    if (!running) { this.finish(id, "INTERRUPTED", "STOP_NOT_CONFIRMED"); return; }
    cancelActiveProcess(id);
    await running;
  }

  private finish(id: string, status: "STOPPED" | "FAILED" | "INTERRUPTED", errorCode: string | null): void {
    this.database.db.prepare("UPDATE product_preview_sessions SET status=?,port=NULL,finished_at=?,error_code=? WHERE id=? AND status IN ('STARTING','RUNNING','STOPPING')")
      .run(status, new Date().toISOString(), errorCode, id);
    this.options.closeWindow?.(id);
  }
  private directory(id: string): string {
    if (!/^PREVIEW-[a-f0-9-]{36}$/.test(id)) throw new ProductPreviewError("INTERNAL_ERROR");
    return path.join(this.artifactRoot, id);
  }
  private row(id: string): Row | undefined { return this.database.db.prepare("SELECT * FROM product_preview_sessions WHERE id=?").get(id) as Row | undefined; }
  private requireSession(method: ProductPreviewMethod, input: ControlProductPreviewInput): void {
    assertProductPreviewInput(method, input);
    if (this.row(input.sessionId)?.product_id !== input.productId) throw new ProductPreviewError("NOT_FOUND", "预览记录不存在。");
  }
  private receipt(requestId: string, requestHash: string): Row | undefined {
    const row = this.database.db.prepare("SELECT * FROM product_preview_sessions WHERE request_id=?").get(requestId) as Row | undefined;
    if (row && row.request_hash !== requestHash) throw new ProductPreviewError("REQUEST_ID_CONFLICT", "请求编号已用于其他预览。");
    return row;
  }
  private session(row: Row): ProductPreviewSession {
    const value = JSON.parse(String(row.evidence_json)) as ProductPreviewEvidence;
    const tail = (stream: string): string => {
      const file = path.join(this.directory(String(row.id)), stream + ".log"); if (!existsSync(file)) return "";
      const size = statSync(file).size, length = Math.min(size, 8192), bytes = Buffer.alloc(length), fd = openSync(file, "r");
      try { readSync(fd, bytes, 0, length, size - length); return bytes.toString("utf8"); } finally { closeSync(fd); }
    };
    return { id: String(row.id), productId: String(row.product_id), taskId: value.evidence.taskId, attemptId: value.evidence.attemptId, buildDirectory: String(row.build_directory) as ProductPreviewSession["buildDirectory"], status: String(row.status) as ProductPreviewSession["status"], url: row.status === "RUNNING" ? `http://127.0.0.1:${Number(row.port)}/` : null, errorCode: row.error_code === null ? null : String(row.error_code), createdAt: String(row.created_at), finishedAt: row.finished_at === null ? null : String(row.finished_at), logTail: (tail("stdout") + tail("stderr")).slice(-16384) };
  }
  private evidenceError(error: unknown): ProductPreviewError {
    return error instanceof ProductDeliveryError && error.code === "EVIDENCE_CHANGED" ? new ProductPreviewError("EVIDENCE_CHANGED", error.message) : new ProductPreviewError("NOT_READY", "请先完成当前已确认计划的技术检查。");
  }
}
