import { beforeEach, describe, expect, it, vi } from "vitest";
const { handlers, invoke } = vi.hoisted(() => ({ handlers: new Map<string, (_event: unknown, _input: unknown) => unknown>(), invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, listener: (_event: unknown, _input: unknown) => unknown) => handlers.set(channel, listener), removeHandler: (channel: string) => handlers.delete(channel) }, ipcRenderer: { invoke } }));
import { initProductRunIpcHandlers, disposeProductRunIpcHandlers } from "../../src/main/products/product-run-ipc.js";
import { productRunsApi } from "../../src/preload/product-runs.js";
import { assertProductRunResponse } from "../../src/shared/core/product-run-validation.js";
const state = null;
describe("product task boundary", () => {
  beforeEach(() => { handlers.clear(); invoke.mockReset(); });
  it("rejects untrusted senders before service and removes only whitelist channels", async () => {
    const getState = vi.fn();
    initProductRunIpcHandlers({ getState } as never, () => false);
    expect(await handlers.get("productRuns:getState")!(null, { productId: "P1" })).toMatchObject({ ok: false });
    expect(getState).not.toHaveBeenCalled(); expect(handlers.size).toBe(4);
    disposeProductRunIpcHandlers(); expect(handlers.size).toBe(0);
  });
  it("rejects inconsistent shared counts at preload and preserves budget error codes", async () => {
    const action = { id: "A1", productId: "P1", planRevision: 1, taskId: "T1", specRevision: 1, specHash: "a".repeat(64), status: "PAUSED", stage: null, reservedModelCalls: 3, maxModelCalls: 4, usedModelCalls: 2, errorCode: null, createdAt: "now", finishedAt: "now" };
    invoke.mockResolvedValue({ ok: true, value: action });
    await expect(productRunsApi.getState({ productId: "P1" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    invoke.mockResolvedValue({ ok: false, error: { code: "BUDGET_EXHAUSTED", message: "预算已耗尽" } });
    expect(await productRunsApi.getState({ productId: "P1" })).toMatchObject({ ok: false, error: { code: "BUDGET_EXHAUSTED" } });
  });
  it("validates exact spec-bound request and response identity", async () => {
    expect(await productRunsApi.start({ requestId: "R", productId: "P1", planRevision: 1, taskId: "T1", specRevision: 1, specHash: "a".repeat(64), approveSpec: true } as never)).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ ok: true, value: state });
    expect(await productRunsApi.getState({ productId: "P1" })).toEqual({ ok: true, value: null });
    expect(() => assertProductRunResponse("start", { ok: true, value: { id: "A1", productId: "P2", planRevision: 1, taskId: "T1", specRevision: 1, specHash: "a".repeat(64), status: "RUNNING", stage: null, reservedModelCalls: 0, maxModelCalls: 2, errorCode: null, createdAt: "now", finishedAt: null } }, "P1")).toThrow();
  });
});
