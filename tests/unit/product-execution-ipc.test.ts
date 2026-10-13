import { beforeEach, describe, expect, it, vi } from "vitest";
const { handlers, invoke } = vi.hoisted(() => ({ handlers: new Map<string, (_event: unknown, _input: unknown) => unknown>(), invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, listener: (_event: unknown, _input: unknown) => unknown) => handlers.set(channel, listener), removeHandler: (channel: string) => handlers.delete(channel) }, ipcRenderer: { invoke } }));
import { initProductExecutionIpcHandlers, disposeProductExecutionIpcHandlers } from "../../src/main/products/product-execution-ipc.js";
import { productExecutionApi } from "../../src/preload/product-execution.js";
import { assertProductExecutionResponse } from "../../src/shared/core/product-execution-validation.js";
const state = { productId: "P1", repositoryId: null, planRevision: null, planCurrent: false, planConfirmed: false, link: null, taskStatus: null };
describe("product task boundary", () => {
  beforeEach(() => { handlers.clear(); invoke.mockReset(); });
  it("rejects untrusted senders before service and removes only whitelist channels", async () => {
    const getState = vi.fn();
    initProductExecutionIpcHandlers({ getState } as never, () => false);
    expect(await handlers.get("productExecution:getState")!(null, { productId: "P1" })).toMatchObject({ ok: false });
    expect(getState).not.toHaveBeenCalled(); expect(handlers.size).toBe(3);
    disposeProductExecutionIpcHandlers(); expect(handlers.size).toBe(0);
  });
  it("rejects unknown fields and checks cross-product/contradictory response", async () => {
    expect(await productExecutionApi.createTask({ requestId: "R1", productId: "P1", planRevision: 1, command: "run" } as never)).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
    expect(() => assertProductExecutionResponse("getState", { ok: true, value: { ...state, productId: "P2" } }, "P1")).toThrow();
    expect(() => assertProductExecutionResponse("getState", { ok: true, value: { ...state, taskStatus: "PASSED" } }, "P1")).toThrow();
    invoke.mockResolvedValue({ ok: true, value: state });
    expect(await productExecutionApi.getState({ productId: "P1" })).toEqual({ ok: true, value: state });
  });
});
