import { BrowserWindow } from "electron";

/** Product content has no preload, platform IPC, external navigation or shared session. */
export function createProductPreviewWindow(id: string, url: string): BrowserWindow {
  const origin = new URL(url).origin;
  const window = new BrowserWindow({ width: 1100, height: 780, title: "AgentPlatform 本地预览", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `preview:${id}` } });
  const allowed = (target: string): boolean => { try { return new URL(target).origin === origin; } catch { return false; } };
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) && !details.url.startsWith("data:") && !details.url.startsWith(`blob:${origin}/`) }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.on("will-download", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (!allowed(target)) event.preventDefault(); });
  window.webContents.on("will-redirect", (event, target) => { if (!allowed(target)) event.preventDefault(); });
  void window.loadURL(url);
  return window;
}
