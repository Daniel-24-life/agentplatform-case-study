import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductOverview } from "../../src/shared/contracts/products.js";
import type { ProductService } from "../../src/main/products/product-service.js";

const { handlers, invoke } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, _input: unknown) => unknown>(),
  invoke: vi.fn()
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, listener: (_event: unknown, _input: unknown) => unknown) => handlers.set(channel, listener), removeHandler: (channel: string) => handlers.delete(channel) },
  ipcRenderer: { invoke }
}));

import { initProductIpcHandlers, disposeProductIpcHandlers } from "../../src/main/products/product-ipc.js";
import { productsApi } from "../../src/preload/products.js";
import { ProductError } from "../../src/shared/core/product-validation.js";
import { AppDatabase } from "../../src/main/db/database.js";
import { ProductService as RealProductService } from "../../src/main/products/product-service.js";

const overview: ProductOverview = {
  product: { id: "P1", name: "产品", repositoryId: null, revision: 1, goalRevision: 1, confirmedGoalRevision: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  goal: { revision: 1, hash: "a".repeat(64), createdAt: "2026-10-01T00:00:00.000Z", goal: { schemaVersion: "1.0", originalRequest: "想法", goal: "想法", scope: "", assumptions: [], acceptanceCriteria: [] } }
};

describe("products IPC and preload", () => {
  const create = vi.fn(async () => overview);
  const service = { create } as unknown as ProductService;
  beforeEach(() => { handlers.clear(); invoke.mockReset(); create.mockReset().mockResolvedValue(overview); });

  it("allows only the trusted platform frame, never arbitrary commands or actors", async () => {
    initProductIpcHandlers(service, event => event === "trusted" as unknown);
    const input = { requestId: "R1", name: "产品", initialRequest: "想法" };
    const handle = handlers.get("products:create")!;
    expect(await handle("untrusted", input)).toMatchObject({ ok: false });
    expect(create).not.toHaveBeenCalled();
    expect(await handle("trusted", { ...input, actor: "user" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await handle("trusted", input)).toMatchObject({ ok: true, value: overview });
    expect(handlers.has("products:execute")).toBe(false);
    expect(handlers.has("products:authorize")).toBe(false);
    disposeProductIpcHandlers();
    expect(handlers.size).toBe(0);
  });

  it("sanitizes unexpected database errors but preserves domain conflict codes", async () => {
    initProductIpcHandlers(service, () => true);
    create.mockImplementationOnce(() => { throw new Error("private database path and internals"); });
    const handle = handlers.get("products:create")!;
    const input = { requestId: "R1", name: "产品", initialRequest: "想法" };
    const result = await handle(null, input);
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("private");
    create.mockImplementationOnce(() => { throw new ProductError("REQUEST_ID_CONFLICT"); });
    expect(await handle(null, input)).toMatchObject({ error: { code: "REQUEST_ID_CONFLICT" } });
  });

  it("preload validates both directions and cannot forward an unsafe request", async () => {
    await expect(productsApi.create({ requestId: "bad/id", name: "产品", initialRequest: "想法" })).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce({ ok: true, value: overview });
    await expect(productsApi.create({ requestId: "R1", name: "产品", initialRequest: "想法" })).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith("products:create", { requestId: "R1", name: "产品", initialRequest: "想法" });
    invoke.mockResolvedValueOnce({ ok: true, value: { product: {} } });
    await expect(productsApi.getOverview({ productId: "P1" })).rejects.toThrow();
  });

  it("routes trash and restore through the trusted whitelist", async () => {
    const trash = vi.fn(async () => ({ ...overview, product: { ...overview.product, deletedAt: "2026-10-01T00:00:00.000Z" } }));
    const restore = vi.fn(async () => ({ ...overview, product: { ...overview.product, deletedAt: null } }));
    const routed = { trash, restore } as unknown as ProductService;
    initProductIpcHandlers(routed, event => event === "trusted" as unknown);
    expect(await handlers.get("products:trash")!("untrusted", { requestId: "R1", productId: "P1", expectedRevision: 1 })).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(await handlers.get("products:trash")!("trusted", { requestId: "R1", productId: "P1", expectedRevision: 1 })).toMatchObject({ ok: true });
    expect(await handlers.get("products:restore")!("trusted", { requestId: "R2", productId: "P1", expectedRevision: 1 })).toMatchObject({ ok: true });
    expect(trash).toHaveBeenCalled();
    expect(restore).toHaveBeenCalled();
    expect([...handlers.keys()]).toContain("products:trash");
    expect([...handlers.keys()]).toContain("products:restore");
    disposeProductIpcHandlers();
  });

  it("awaits the actual service through preload and IPC for the full direction workflow", async () => {
    const database = new AppDatabase(":memory:");
    try {
      initProductIpcHandlers(new RealProductService(database), () => true);
      invoke.mockImplementation((channel: string, input: unknown) => handlers.get(channel)!(null, input));
      const created = await productsApi.create({ requestId: "ipc-create", name: "Product", initialRequest: "Build a product" });
      if (!created.ok) throw new Error(created.error.code);
      const edited = await productsApi.reviseGoal({
        requestId: "ipc-edit", productId: created.value.product.id, expectedRevision: 1,
        goal: { ...created.value.goal.goal, scope: "Local workflow", acceptanceCriteria: [{ id: "done", description: "Can reopen the product", verification: "platform", required: true }] }
      });
      if (!edited.ok) throw new Error(edited.error.code);
      const confirmed = await productsApi.confirmDirection({ requestId: "ipc-confirm", productId: edited.value.product.id, expectedRevision: 2, goalRevision: 2 });
      expect(confirmed).toMatchObject({ ok: true, value: { product: { confirmedGoalRevision: 2, revision: 3 } } });
      const events = await productsApi.readEvents({ productId: created.value.product.id });
      expect(events.ok && events.value.items.map(event => event.type)).toEqual(["PRODUCT_CREATED", "GOAL_REVISED", "DIRECTION_CONFIRMED"]);
    } finally {
      database.close();
      disposeProductIpcHandlers();
    }
  });
});
