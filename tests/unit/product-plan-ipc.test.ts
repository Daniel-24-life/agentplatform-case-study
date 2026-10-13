import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPlanService } from "../../src/main/products/product-plan-service.js";
const { handlers, invoke } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, _input: unknown) => unknown>(), invoke: vi.fn()
}));
vi.mock("electron", () => ({ ipcMain: {
  handle: (channel: string, listener: (_event: unknown, _input: unknown) => unknown) => handlers.set(channel, listener),
  removeHandler: (channel: string) => handlers.delete(channel)
}, ipcRenderer: { invoke } }));
import { initProductPlanIpcHandlers, disposeProductPlanIpcHandlers } from "../../src/main/products/product-plan-ipc.js";
import { productPlansApi } from "../../src/preload/product-plans.js";

describe("product plan IPC and preload", () => {
  beforeEach(() => { handlers.clear(); invoke.mockReset(); });
  it("rejects foreign frames and command fields without entering the service", async () => {
    const getState = vi.fn();
    initProductPlanIpcHandlers({ getState } as unknown as ProductPlanService, event => event === "trusted" as unknown);
    const listener = handlers.get("productPlans:getState")!;
    expect(await listener("foreign", { productId: "P1" })).toMatchObject({ ok: false });
    expect(await listener("trusted", { productId: "P1", command: "execute" })).toMatchObject({ ok: false });
    expect(getState).not.toHaveBeenCalled();
    expect(handlers.size).toBe(3);
    disposeProductPlanIpcHandlers(); expect(handlers.size).toBe(0);
  });
  it("validates transport input and response envelopes", async () => {
    expect(await productPlansApi.getState({ productId: "../unsafe" })).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce({ ok: true, value: {} });
    await expect(productPlansApi.getState({ productId: "P1" })).rejects.toThrow();
    invoke.mockResolvedValueOnce({ ok: true, value: { saved: null, current: false, directionConfirmed: false } });
    expect(await productPlansApi.getState({ productId: "P1" })).toMatchObject({ ok: true });
  });
  it("round trips a plan without granting or executing a task", async () => {
    const db = new AppDatabase(":memory:");
    try {
      const products = new ProductService(db);
      let overview = await products.create({ requestId: "product", name: "Product", initialRequest: "Build" });
      overview = await products.reviseGoal({ requestId: "goal", productId: overview.product.id, expectedRevision: 1,
        goal: { ...overview.goal.goal, scope: "First workflow", acceptanceCriteria: [{ id: "usable", description: "Works", verification: "platform", required: true }] } });
      overview = await products.confirmDirection({ requestId: "direction", productId: overview.product.id, expectedRevision: 2, goalRevision: 2 });
      initProductPlanIpcHandlers(new ProductPlanService(db, products), () => true);
      invoke.mockImplementation((channel: string, input: unknown) => handlers.get(channel)!(null, input));
      const saved = await productPlansApi.save({ requestId: "save", productId: overview.product.id, expectedPlanRevision: 0, plan: {
        schemaVersion: "1.0", productId: overview.product.id, goalRevision: 2, goalHash: overview.goal.hash, summary: "First increment",
        workItems: [{ id: "w1", title: "Implement", objective: "Workflow", deliverable: "Runnable workflow", acceptanceCriterionIds: ["usable"], dependsOn: [] }]
      } });
      if (!saved.ok) throw new Error(saved.error.code);
      const confirmed = await productPlansApi.confirm({ requestId: "confirm", productId: overview.product.id, planRevision: saved.value.revision });
      expect(confirmed).toMatchObject({ ok: true });
      expect((await productPlansApi.getState({ productId: overview.product.id }))).toMatchObject({ ok: true, value: { current: true, directionConfirmed: true } });
      expect((db.db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n).toBe(0);
      expect(await products.getOverview({ productId: overview.product.id })).toEqual(overview);
    } finally { disposeProductPlanIpcHandlers(); db.close(); }
  });
});
