import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ProductDeliveryService } from "../../src/main/products/product-delivery-service.js";
import { ProductPreviewService } from "../../src/main/products/product-preview-service.js";
import { createProductWorkflowFixture, waitForProductRun } from "../helpers/product-workflow.js";

async function fixture(staticWeb = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-preview-"));
  const f = await createProductWorkflowFixture(root, { staticWeb });
  const deliveries = new ProductDeliveryService(f.database, f.products, f.plans, f.execution, f.orchestrator, f.git, f.artifacts);
  const opened: string[] = [];
  const options = { serverPath: path.resolve("out/main/product-preview-server.js"), openWindow: (_id: string, url: string) => { opened.push(url); } };
  const previews = new ProductPreviewService(f.database, deliveries, path.join(root, "previews"), options);
  return { ...f, root, deliveries, previews, options, opened };
}

it("serves only technically passed current static output before business acceptance and closes its real process", async () => {
  const f = await fixture();
  try {
    const input = { requestId: "preview", productId: f.input.productId, buildDirectory: "dist" as const };
    await expect(f.previews.start(input)).rejects.toMatchObject({ code: "NOT_READY" });
    expect(f.database.db.prepare("SELECT COUNT(*) n FROM product_preview_sessions").get()).toMatchObject({ n: 0 });
    await f.runs.start(f.input); expect(await waitForProductRun(f)).toMatchObject({ status: "SUCCEEDED" });
    const [first, same] = await Promise.all([f.previews.start(input), f.previews.start(input)]);
    expect(same.id).toBe(first.id);
    const session = (await f.previews.getState({ productId: f.input.productId }))!;
    expect(session).toMatchObject({ status: "RUNNING", buildDirectory: "dist" });
    expect(session.logTail).toContain("listening");
    expect(await (await fetch(session.url!)).text()).toContain("可体验成果夹具");
    expect(f.database.db.prepare("SELECT COUNT(*) n FROM product_deliveries").get()).toMatchObject({ n: 0 });
    expect(f.database.db.prepare("SELECT COUNT(*) n FROM product_preview_sessions").get()).toMatchObject({ n: 1 });
    await expect(f.previews.start({ ...input, requestId: "other" })).rejects.toMatchObject({ code: "BUSY" });
    await expect(f.previews.start({ ...input, buildDirectory: "build" })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
    await f.previews.open({ productId: f.input.productId, sessionId: session.id }); expect(f.opened).toEqual([session.url]);
    const overview = await f.products.getOverview({ productId: f.input.productId });
    await expect(f.products.trash({ requestId: "trash", productId: f.input.productId, expectedRevision: overview.product.revision })).rejects.toMatchObject({ code: "PRODUCT_BUSY" });
    expect(readFileSync(path.join(f.repo, "value.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(path.join(f.database.getLatestAttempt(f.input.taskId)!.worktreePath, "dist", "index.html"), "utf8")).toContain("可体验成果夹具");
    const stopped = await f.previews.stop({ productId: f.input.productId, sessionId: session.id });
    expect(stopped).toMatchObject({ status: "STOPPED", url: null });
    expect(await f.previews.stop({ productId: f.input.productId, sessionId: session.id })).toEqual(stopped);
    await expect(fetch(session.url!)).rejects.toThrow();
    expect((await f.previews.start({ ...input, requestId: "restart" })).id).not.toBe(session.id);
  } finally { await f.previews.closeAll(); f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
}, 30000);

it("invalidates and stops a running preview when authoritative evidence changes", async () => {
  const f = await fixture();
  try {
    await f.runs.start(f.input); await waitForProductRun(f);
    const session = await f.previews.start({ requestId: "preview", productId: f.input.productId, buildDirectory: "dist" });
    expect(session.status).toBe("RUNNING");
    writeFileSync(path.join(f.database.getLatestAttempt(f.input.taskId)!.worktreePath, "value.txt"), "tampered\n");
    expect(await f.previews.getState({ productId: f.input.productId })).toMatchObject({ status: "STOPPED", url: null, errorCode: "EVIDENCE_CHANGED" });
    await expect(f.previews.open({ productId: f.input.productId, sessionId: session.id })).rejects.toMatchObject({ code: "NOT_READY" });
    await expect(fetch(session.url!)).rejects.toThrow();
  } finally { await f.previews.closeAll(); f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
}, 30000);

it("records missing output without starting a service and marks recovery without touching a reused PID", async () => {
  const f = await fixture(false);
  try {
    await f.runs.start(f.input); await waitForProductRun(f);
    const input = { requestId: "missing", productId: f.input.productId, buildDirectory: "dist" as const };
    const failed = await f.previews.start(input);
    expect(failed).toMatchObject({ status: "FAILED", errorCode: "STATIC_OUTPUT_MISSING", url: null });
    expect((await f.previews.start(input)).id).toBe(failed.id);
    f.database.db.prepare("UPDATE product_preview_sessions SET status='RUNNING',finished_at=NULL,error_code=NULL,pid=?,port=55555 WHERE id=?").run(process.pid, failed.id);
    const recovered = new ProductPreviewService(f.database, f.deliveries, path.join(f.root, "previews"), f.options);
    expect(recovered.recoverInterrupted()).toBe(1);
    expect(await recovered.getState({ productId: f.input.productId })).toMatchObject({ status: "INTERRUPTED", errorCode: "APP_RESTART", url: null });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(await recovered.stop({ productId: f.input.productId, sessionId: failed.id })).toMatchObject({ status: "INTERRUPTED" });
  } finally { await f.previews.closeAll(); f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
}, 30000);

it("rejects a newly saved plan that replaces the binding during awaited Git verification", async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await f.runs.start(f.input); await waitForProductRun(f);
    const original = f.git.collectEvidence.bind(f.git);
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(f.git, "collectEvidence").mockImplementation(async (...args) => { reached(); await gate; return original(...args); });
    const pending = f.previews.start({ requestId: "stale", productId: f.input.productId, buildDirectory: "dist" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "EVIDENCE_CHANGED" });
    await entered;
    const current = await f.plans.getState({ productId: f.input.productId });
    await f.plans.save({ requestId: "replace", productId: f.input.productId, expectedPlanRevision: current.saved!.revision, plan: { ...current.saved!.plan, summary: "A different increment" } });
    release(); await rejected;
    expect(f.database.db.prepare("SELECT COUNT(*) n FROM product_preview_sessions").get()).toMatchObject({ n: 0 });
  } finally { release?.(); await f.previews.closeAll(); f.database.close(); rmSync(f.root, { recursive: true, force: true }); }
}, 30000);
