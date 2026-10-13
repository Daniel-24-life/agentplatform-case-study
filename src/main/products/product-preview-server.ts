import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type PreviewManifestFile = { path: string; bytes: number; sha256: string };
export type PreviewManifest = { files: PreviewManifestFile[] };
export type PreviewServerAddress = { host: "127.0.0.1"; port: number; pid: number };
export type PreviewServer = { close: () => Promise<void>; address: PreviewServerAddress };
export type PreviewServerOptions = { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number; log?: (_line: string) => void };

const MAX_FILES = 512, MAX_TOTAL = 32 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function validPath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes("\\") || value.includes(":") || value.includes("\0")) return false;
  return !value.split("/").some(part => part === "" || part === "." || part === "..");
}
async function ensureSafeFile(root: string, rel: string, expected: PreviewManifestFile): Promise<Buffer> {
  if (!validPath(rel)) throw new Error(`invalid manifest path: ${rel}`);
  const target = resolve(root, ...rel.split("/"));
  const rootReal = await fs.realpath(root);
  const targetReal = await fs.realpath(target);
  if (relative(rootReal, targetReal).startsWith(`..${sep}`) || relative(rootReal, targetReal) === "..") throw new Error("file escapes snapshot");
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("snapshot contains symlink or non-file");
  let cursor = rootReal;
  for (const part of rel.split("/")) { cursor = join(cursor, part); const segment = await fs.lstat(cursor); if (segment.isSymbolicLink()) throw new Error("snapshot contains symlink or junction"); }
  if (stat.size !== expected.bytes || stat.size > MAX_FILE) throw new Error("file size mismatch");
  const data = await fs.readFile(target);
  if (createHash("sha256").update(data).digest("hex") !== expected.sha256) throw new Error(`hash mismatch: ${rel}`);
  return data;
}

export async function createPreviewServer(snapshotDir: string, manifest: PreviewManifest, options: PreviewServerOptions = {}): Promise<PreviewServer> {
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_FILES) throw new Error("invalid manifest file count");
  if (!manifest.files.some(file => file.path === "index.html")) throw new Error("manifest must contain index.html");
  const rootStat = await fs.lstat(snapshotDir); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid snapshot directory");
  const root = await fs.realpath(snapshotDir);
  const files = new Map<string, Buffer>(); let total = 0;
  for (const entry of manifest.files) { if (!validPath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error("invalid manifest entry"); if (files.has(entry.path)) throw new Error("duplicate manifest path"); total += entry.bytes; if (total > MAX_TOTAL) throw new Error("snapshot too large"); files.set(entry.path, await ensureSafeFile(root, entry.path, entry)); }
  const server = createServer((req, res) => respond(req, res, files));
  let closed = false;
  const close = async (): Promise<void> => { if (closed) return; closed = true; server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); };
  server.on("error", error => { options.log?.(`server error: ${error.message}`); void close(); });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server address unavailable");
  options.log?.(`listening ${address.port}`);
  return { address: { host: "127.0.0.1", port: address.port, pid: process.pid }, close };
}
function respond(req: IncomingMessage, res: ServerResponse, files: Map<string, Buffer>): void {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", CSP);
  if (req.method !== "GET" && req.method !== "HEAD") { res.statusCode = 405; res.setHeader("Allow", "GET, HEAD"); res.end(); return; }
  const host = req.headers.host; const expected = `127.0.0.1:${(res.socket as { localPort?: number }).localPort}`; if (host !== expected) { res.statusCode = 400; res.end(); return; }
  let pathname: string; try { const rawPath = (req.url ?? "/").split("?", 1)[0]!; if (rawPath.split("/").some(part => part === ".." || part.toLowerCase() === "%2e%2e" || part.toLowerCase() === "%2f" || part.includes("\\") || part.toLowerCase().includes("%5c"))) { res.statusCode = 404; res.end(); return; } pathname = decodeURIComponent(rawPath).replace(/^\//, ""); } catch { res.statusCode = 400; res.end(); return; }
  if (pathname === "") pathname = "index.html";
  if (!validPath(pathname)) { res.statusCode = 404; res.end(); return; }
  const body = files.get(pathname); if (!body) { res.statusCode = 404; res.end(); return; }
  res.statusCode = 200; res.setHeader("Content-Type", MIME[extname(pathname).toLowerCase()] ?? "application/octet-stream"); res.setHeader("Content-Length", body.byteLength); if (req.method === "GET") res.end(body); else res.end();
}
export async function servePreview(args: [string, string, string, string], options: PreviewServerOptions = {}): Promise<PreviewServer> {
  const [snapshotDir, manifestPath, readyPath, heartbeatPath] = args;
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as PreviewManifest;
  const preview = await createPreviewServer(snapshotDir, manifest, options);
  try { await fs.writeFile(readyPath, JSON.stringify(preview.address), { flag: "wx" }); } catch (error) { await preview.close(); throw error; }
  let lastHeartbeat = await fs.readFile(heartbeatPath, "utf8").catch(() => "");
  let changedAt = performance.now();
  const check = async () => {
    try {
      const token = await fs.readFile(heartbeatPath, "utf8");
      if (token.length > 128) throw new Error("invalid heartbeat");
      if (token !== lastHeartbeat) { lastHeartbeat = token; changedAt = performance.now(); }
      else if (performance.now() - changedAt > (options.heartbeatTimeoutMs ?? 10000)) await preview.close();
    } catch { await preview.close(); }
  };
  const timer = setInterval(() => void check(), options.heartbeatIntervalMs ?? 2000); timer.unref();
  const originalClose = preview.close; preview.close = async () => { clearInterval(timer); await originalClose(); };
  return preview;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.length === 6) {
  void servePreview(process.argv.slice(2) as [string, string, string, string], { log: line => process.stdout.write(line + "\n") }).then(preview => {
    const shutdown = () => { void preview.close().finally(() => process.exit(0)); };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  }).catch(error => { process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`.slice(0, 8192)); process.exitCode = 1; });
}
