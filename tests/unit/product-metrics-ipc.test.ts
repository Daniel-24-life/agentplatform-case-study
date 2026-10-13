import { describe, expect, it, vi } from "vitest";
import { assertProductInput, assertProductResponse } from "../../src/shared/core/product-validation.js";
import type { ProductService } from "../../src/main/products/product-service.js";

const { handlers, invoke } = vi.hoisted(() => ({ handlers: new Map<string, (_event: unknown, _input: unknown) => Promise<unknown>>(), invoke: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, listener: (_event: unknown, _input: unknown) => Promise<unknown>) => handlers.set(channel, listener), removeHandler: (channel: string) => handlers.delete(channel) },
  ipcRenderer: { invoke }
}));
import { initProductIpcHandlers, disposeProductIpcHandlers } from "../../src/main/products/product-ipc.js";
import { productsApi } from "../../src/preload/products.js";

const value = { productId: "P1", scope: "PRODUCT_HISTORY", taskCount: 2, passedTaskCount: 1, technicalCompletionRate: .5, directionConfirmations: 1, planConfirmations: 1, specApprovals: 0, escalationApprovals: 0, keyConfirmationCount: 2, attemptCount: 1, repairAttemptCount: 0, failedAttemptCount: 0, runCount: 1, agentRunCount: 1, durationAvailableRuns: 1, recordedDurationMs: 1, usageAvailableRuns: 1, usageCoverage: 1, inputTokens: 0, outputTokens: null, totalTokens: null };

describe("product metrics IPC contract", () => {
  it("accepts only the product identity input and rejects semantic mismatches", () => {
    expect(() => assertProductInput("getMetrics", { productId: "P1" })).not.toThrow();
    expect(() => assertProductInput("getMetrics", { productId: "P1", other: true })).toThrow();
    expect(() => assertProductResponse("getMetrics", { ok: true, value }, { productId: "P1" })).not.toThrow();
    expect(() => assertProductResponse("getMetrics", { ok: true, value: { ...value, technicalCompletionRate: 1 } }, { productId: "P1" })).toThrow();
    expect(() => assertProductResponse("getMetrics", { ok: true, value }, { productId: "P2" })).toThrow();
    for (const patch of [{ agentRunCount: 2 }, { usageAvailableRuns: 2 }, { usageCoverage: null }, { repairAttemptCount: 2 }, { failedAttemptCount: 2 },
      { recordedDurationMs: null }, { durationAvailableRuns: 0 }, { keyConfirmationCount: 9 }, { specApprovals: 3 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => assertProductResponse("getMetrics", { ok: true, value: { ...value, ...patch } }, { productId: "P1" })).toThrow();
    }
  });

  it("enforces trusted IPC sender and product identity without dispatching any execution", async () => {
    const getMetrics = vi.fn(async () => value);
    initProductIpcHandlers({ getMetrics } as unknown as ProductService, event => event === "trusted" as unknown);
    try {
      const handler = handlers.get("products:getMetrics")!;
      expect(await handler("untrusted", { productId: "P1" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
      expect(await handler("trusted", { productId: "P1", command: "execute" })).toMatchObject({ ok: false });
      expect(getMetrics).not.toHaveBeenCalled();
      expect(await handler("trusted", { productId: "P1" })).toMatchObject({ ok: true, value });
      expect(await handler("trusted", { productId: "P2" })).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
      expect(handlers.has("products:execute")).toBe(false);
    } finally { disposeProductIpcHandlers(); }
  });

  it("validates preload input and response identity and accounting invariants", async () => {
    invoke.mockReset();
    expect(await productsApi.getMetrics({ productId: "bad/path" })).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce({ ok: true, value });
    expect(await productsApi.getMetrics({ productId: "P1" })).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith("products:getMetrics", { productId: "P1" });
    invoke.mockResolvedValueOnce({ ok: true, value: { ...value, productId: "P2" } });
    await expect(productsApi.getMetrics({ productId: "P1" })).rejects.toThrow();
    invoke.mockResolvedValueOnce({ ok: true, value: { ...value, usageCoverage: .5 } });
    await expect(productsApi.getMetrics({ productId: "P1" })).rejects.toThrow();
  });
});
