import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
const { run, cancel } = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn() }));
vi.mock("../../src/main/process/runner.js", () => ({ runProcess: run, cancelActiveProcess: cancel }));
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPreviewService } from "../../src/main/products/product-preview-service.js";
import type { ProductPreviewEvidence } from "../../src/main/products/product-delivery-service.js";

it("reports INTERRUPTED instead of claiming success when process close is not confirmed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentplatform-preview-stop-"));
  const database = new AppDatabase(":memory:");
  const product = await new ProductService(database).create({ requestId: "create", name: "product", initialRequest: "request" });
  mkdirSync(path.join(root, "dist")); writeFileSync(path.join(root, "dist", "index.html"), "<h1>Fixture</h1>");
  const evidence: ProductPreviewEvidence = { goalRevision: 1, goalHash: "g", planRevision: 1, planHash: "p", evidence: { taskId: "task", specRevision: 1, specHash: "s", attemptId: "attempt", branch: "branch", worktreePath: root, head: "head", diffHash: "diff", manifestHash: "manifest", finalGateHash: "final", testRunIds: [] } };
  let finish!: (_result: unknown) => void;
  run.mockImplementation(spec => { spec.onSpawn(1234); writeFileSync(spec.args[3], JSON.stringify({ host: "127.0.0.1", port: 51234, pid: 1234 })); return new Promise(resolve => { finish = resolve; }); });
  cancel.mockImplementation(() => { finish({ status: "CANCELLED", closeObserved: false, pid: 1234 }); return true; });
  const previews = new ProductPreviewService(database, { readPreviewEvidence: async () => evidence, assertPreviewEvidenceCurrent: () => {} }, path.join(root, "previews"), { serverPath: "trusted-server.js" });
  try {
    const session = await previews.start({ requestId: "start", productId: product.product.id, buildDirectory: "dist" });
    expect(session.status).toBe("RUNNING");
    expect(run.mock.calls[0][0].args[0]).toBe("trusted-server.js");
    expect(await previews.stop({ productId: product.product.id, sessionId: session.id })).toMatchObject({ status: "INTERRUPTED", errorCode: "STOP_NOT_CONFIRMED", url: null });
  } finally { await previews.closeAll(); database.close(); rmSync(root, { recursive: true, force: true }); }
});
