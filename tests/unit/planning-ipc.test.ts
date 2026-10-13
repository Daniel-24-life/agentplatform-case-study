import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService } from "../../src/main/products/product-service.js";
import { ProductPlanningService } from "../../src/main/products/product-planning-service.js";

const { handlers, invoke } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, _input: unknown) => unknown>(),
  invoke: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (_event: unknown, _input: unknown) => unknown) => handlers.set(channel, listener),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  ipcRenderer: { invoke }
}));
import { initPlanningIpcHandlers, disposePlanningIpcHandlers } from "../../src/main/products/planning-ipc.js";
import { planningApi } from "../../src/preload/planning.js";

describe("planning IPC and preload", () => {
  beforeEach(() => { handlers.clear(); invoke.mockReset(); });

  it("rejects foreign frames and extra execution fields before calling the service", async () => {
    const getState = vi.fn();
    initPlanningIpcHandlers({ getState } as unknown as ProductPlanningService, event => event === "trusted" as unknown);
    const listener = handlers.get("productPlanning:getState")!;
    expect(await listener("foreign", { productId: "P1" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await listener("trusted", { productId: "P1", command: "execute" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(getState).not.toHaveBeenCalled();
    expect(handlers.size).toBe(4);
    disposePlanningIpcHandlers();
    expect(handlers.size).toBe(0);
  });

  it("preload rejects malformed requests and cross-product responses", async () => {
    await expect(planningApi.getState({ productId: "../unsafe" })).resolves.toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ ok: true, value: {
      available: true, action: null, grant: {
        id: "G1", productId: "OTHER", goalRevision: 1, goalHash: "a".repeat(64), maxCalls: 1,
        usedCalls: 0, timeoutSeconds: 300, revokedAt: null, createdAt: "2026-10-01T00:00:00Z"
      }
    } });
    await expect(planningApi.getState({ productId: "P1" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("round trips durable grants while an unqualified runtime spends no calls", async () => {
    const database = new AppDatabase(":memory:");
    const run = vi.fn();
    try {
      const products = new ProductService(database);
      const created = await products.create({ requestId: "create", name: "Product", initialRequest: "Build product" });
      const productId = created.product.id;
      initPlanningIpcHandlers(new ProductPlanningService(database, products, { available: false, run }), () => true);
      invoke.mockImplementation((channel: string, input: unknown) => handlers.get(channel)!(null, input));
      const granted = await planningApi.authorize({ requestId: "grant", productId, expectedRevision: 1 });
      if (!granted.ok) throw new Error(granted.error.code);
      expect(await planningApi.requestProposal({ requestId: "request", productId, grantId: granted.value.id, expectedRevision: 1 }))
        .toMatchObject({ ok: false, error: { code: "RUNTIME_NOT_QUALIFIED" } });
      expect(await planningApi.getState({ productId })).toMatchObject({ ok: true, value: { available: false, grant: { usedCalls: 0 }, action: null } });
      expect(run).not.toHaveBeenCalled();
      expect(await planningApi.revoke({ productId, grantId: granted.value.id })).toMatchObject({ ok: true, value: { usedCalls: 0 } });
    } finally { disposePlanningIpcHandlers(); database.close(); }
  });
});
