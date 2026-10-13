import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewServer, servePreview, type PreviewManifest } from "../../src/main/products/product-preview-server.js";

const dirs: string[] = [];
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function fixture(files: Record<string, string>): Promise<{ root: string; manifest: PreviewManifest }> {
  const root = await mkdtemp(join(tmpdir(), "preview-")); dirs.push(root);
  const entries = [];
  for (const [name, value] of Object.entries(files)) { const target = join(root, ...name.split("/")); await mkdir(join(target, ".."), { recursive: true }); const data = Buffer.from(value); await writeFile(target, data); entries.push({ path: name, bytes: data.length, sha256: hash(data) }); }
  return { root, manifest: { files: entries } };
}
async function request(port: number, path: string, init: Parameters<typeof fetch>[1] = {}) { return fetch(`http://127.0.0.1:${port}${path}`, init); }
function rawStatus(port: number, path: string): Promise<number> { return new Promise((resolve) => { const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }); req.end(); }); }
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe("product preview server", () => {
  it("serves index and assets with read-only HTTP boundaries", async () => {
    const f = await fixture({ "index.html": "hello", "assets/app.js": "1" }); const server = await createPreviewServer(f.root, f.manifest);
    try { const index = await request(server.address.port, "/index.html"); expect(index.status).toBe(200); expect(await index.text()).toBe("hello"); expect(index.headers.get("content-security-policy")).toContain("default-src 'self'"); expect((await request(server.address.port, "/assets/app.js", { method: "HEAD" })).status).toBe(200); expect((await request(server.address.port, "/missing")).status).toBe(404); for (const escaped of ["/../index.html", "/%2e%2e/index.html", "/%2findex.html", "/a%5cb"]) expect(await rawStatus(server.address.port, escaped)).toBe(404); expect((await request(server.address.port, "/index.html", { method: "POST" })).status).toBe(405); } finally { await server.close(); }
  });
  it("rejects bad manifests, hashes, missing entry and symlinks", async () => {
    const f = await fixture({ "index.html": "x" });
    await expect(createPreviewServer(f.root, { files: [{ path: "index.html", bytes: 1, sha256: "0".repeat(64) }] })).rejects.toThrow(/hash/);
    await expect(createPreviewServer(f.root, { files: [] })).rejects.toThrow();
    const outside = join(f.root, "outside.txt"); await writeFile(outside, "x");
    try { await symlink(outside, join(f.root, "link.html")); } catch { return; }
    await expect(createPreviewServer(f.root, { files: [{ path: "index.html", bytes: 1, sha256: hash(Buffer.from("x")) }, { path: "link.html", bytes: 1, sha256: hash(Buffer.from("x")) }] })).rejects.toThrow();
    await expect(createPreviewServer(f.root, { files: Array.from({ length: 513 }, (_, i) => ({ path: i === 0 ? "index.html" : `x${i}.js`, bytes: 0, sha256: "0".repeat(64) })) })).rejects.toThrow();
  });
  it("serves the verified memory snapshot after disk mutation", async () => {
    const f = await fixture({ "index.html": "before" }); const server = await createPreviewServer(f.root, f.manifest); try { await writeFile(join(f.root, "index.html"), "after"); expect(await (await request(server.address.port, "/index.html")).text()).toBe("before"); } finally { await server.close(); }
  });
  it("writes ready exclusively and closes after heartbeat loss", async () => {
    const f = await fixture({ "index.html": "x" }); const manifestPath = join(f.root, "manifest.json"), readyPath = join(f.root, "ready.json"), heartbeatPath = join(f.root, "heartbeat"); await writeFile(manifestPath, JSON.stringify(f.manifest)); await writeFile(heartbeatPath, "1"); await writeFile(readyPath, "existing");
    await expect(servePreview([f.root, manifestPath, readyPath, heartbeatPath], { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 20 })).rejects.toThrow();
    await rm(readyPath); const server = await servePreview([f.root, manifestPath, readyPath, heartbeatPath], { heartbeatIntervalMs: 10, heartbeatTimeoutMs: 20 }); await new Promise(r => setTimeout(r, 50)); await expect(request(server.address.port, "/index.html")).rejects.toThrow();
  });
});
