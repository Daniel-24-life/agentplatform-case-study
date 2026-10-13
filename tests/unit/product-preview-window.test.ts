import { expect, it, vi } from "vitest";
const { preferences, request, permissions, events, navigations, popup, load } = vi.hoisted(() => ({ preferences: vi.fn(), request: vi.fn(), permissions: vi.fn(), events: new Map<string, (..._args: unknown[]) => unknown>(), navigations: new Map<string, (..._args: unknown[]) => unknown>(), popup: vi.fn(), load: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: vi.fn(function (options) { preferences(options); return { webContents: { session: { webRequest: { onBeforeRequest: request }, setPermissionRequestHandler: permissions, on: (name: string, callback: (..._args: unknown[]) => unknown) => events.set(name, callback) }, setWindowOpenHandler: popup, on: (name: string, callback: (..._args: unknown[]) => unknown) => navigations.set(name, callback) }, loadURL: load }; }) }));
import { createProductPreviewWindow } from "../../src/main/products/product-preview-window.js";

it("opens a separate unprivileged session and blocks outside requests, permissions and navigation", () => {
  createProductPreviewWindow("session", "http://127.0.0.1:51234/");
  expect(preferences.mock.calls[0][0].webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "preview:session" });
  const filter = request.mock.calls[0][0];
  const callback = vi.fn();
  filter({ url: "http://127.0.0.1:51234/assets/app.js" }, callback); expect(callback).toHaveBeenLastCalledWith({ cancel: false });
  for (const url of ["https://example.invalid/", "file:///C:/secrets", "http://127.0.0.1:80/", "http://localhost:51234/"]) { filter({ url }, callback); expect(callback).toHaveBeenLastCalledWith({ cancel: true }); }
  const denied = vi.fn(); navigations.get("will-navigate")!({ preventDefault: denied }, "https://example.invalid/"); expect(denied).toHaveBeenCalledTimes(1);
  expect(popup.mock.calls[0][0]()).toEqual({ action: "deny" });
  permissions.mock.calls[0][0](null, "media", callback); expect(callback).toHaveBeenLastCalledWith(false);
  expect(load).toHaveBeenCalledWith("http://127.0.0.1:51234/");
});
