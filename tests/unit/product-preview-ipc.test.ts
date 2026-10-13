import { beforeEach, describe, expect, it, vi } from "vitest";
const { handlers, invoke } = vi.hoisted(() => ({ handlers: new Map<string, (_event: unknown, _input: unknown) => unknown>(), invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, listener: (_event: unknown, _input: unknown) => unknown) => handlers.set(channel, listener), removeHandler: (channel: string) => handlers.delete(channel) }, ipcRenderer: { invoke } }));
import { initProductPreviewIpcHandlers, disposeProductPreviewIpcHandlers } from "../../src/main/products/product-preview-ipc.js";
import { productPreviewsApi } from "../../src/preload/product-previews.js";

describe("preview IPC boundary", () => {
  beforeEach(() => { handlers.clear(); invoke.mockReset(); });
  it("rejects an untrusted product window before reaching the service", async () => {
    const start = vi.fn(); initProductPreviewIpcHandlers({ start } as never, () => false);
    expect(await handlers.get("productPreviews:start")!(null, { requestId: "r", productId: "p", buildDirectory: "dist" })).toMatchObject({ ok: false });
    expect(start).not.toHaveBeenCalled(); expect(handlers.size).toBe(4);
    disposeProductPreviewIpcHandlers(); expect(handlers.size).toBe(0);
  });
  it("does not expose arbitrary commands, paths, or external URLs", async () => {
    for (const directory of ["../", "C:/secrets", ".git", "node_modules"]) expect(await productPreviewsApi.start({ requestId: "r", productId: "p", buildDirectory: directory } as never)).toMatchObject({ ok: false });
    expect(invoke).not.toHaveBeenCalled();
    const session = { id: "s", productId: "p", taskId: "t", attemptId: "a", buildDirectory: "dist", status: "RUNNING", url: "http://0.0.0.0:5000/", errorCode: null, createdAt: "now", finishedAt: null, logTail: "" };
    invoke.mockResolvedValue({ ok: true, value: session });
    await expect(productPreviewsApi.getState({ productId: "p" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    invoke.mockResolvedValue({ ok: true, value: { ...session, url: "http://127.0.0.1:70000/" } });
    await expect(productPreviewsApi.getState({ productId: "p" })).rejects.toThrow();
  });
});
