import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotStaticOutput } from "../../src/main/products/product-preview-files.js";

const roots: string[] = [];
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "preview-files-")); roots.push(root); return root; }
let outputCounter = 0;
async function output(root: string): Promise<{ source: string; destination: string }> { const name = `source-${outputCounter++}`; const source = join(root, name), destination = join(root, `${name}-snapshot`); await mkdir(source); return { source, destination }; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("snapshotStaticOutput", () => {
  it("creates a bounded hash manifest and leaves source unchanged", async () => {
    const root = await directory(); const { source, destination } = await output(root); const html = Buffer.from("<h1>x</h1>"), css = Buffer.from("body{}" ); await writeFile(join(source, "index.html"), html); await mkdir(join(source, "assets")); await writeFile(join(source, "assets", "style.css"), css);
    const result = snapshotStaticOutput(source, destination);
    expect(result.manifest.files).toEqual(expect.arrayContaining([{ path: "index.html", bytes: html.length, sha256: sha256(html) }, { path: "assets/style.css", bytes: css.length, sha256: sha256(css) }]));
    expect(await fs.readFile(join(source, "index.html"))).toEqual(html); expect(await fs.readFile(join(destination, "index.html"))).toEqual(html); expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects missing index and filesystem links", async () => {
    const root = await directory(); const missing = await output(root); await writeFile(join(missing.source, "app.js"), "x"); expect(() => snapshotStaticOutput(missing.source, missing.destination)).toThrow(/index/i);
    const linked = await output(root); await writeFile(join(linked.source, "index.html"), "x"); const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "x"); await symlink(outside, join(linked.source, "linked"), "junction"); expect(() => snapshotStaticOutput(linked.source, linked.destination)).toThrow();
  });
  it("rejects oversized files and more than 512 files", async () => {
    const root = await directory(); const big = await output(root); await writeFile(join(big.source, "index.html"), "x"); await truncate(join(big.source, "index.html"), 8 * 1024 * 1024 + 1); expect(() => snapshotStaticOutput(big.source, big.destination)).toThrow(/32MiB|8MiB|512|large/i);
    const many = await output(root); await writeFile(join(many.source, "index.html"), "x"); for (let i = 0; i < 512; i++) await writeFile(join(many.source, `f${i}.txt`), "x"); expect(() => snapshotStaticOutput(many.source, many.destination)).toThrow(/512|large/i);
  });
  it("rejects excessive depth and handles empty directories", async () => {
    const root = await directory(); const empty = await output(root); await mkdir(join(empty.source, "empty")); expect(() => snapshotStaticOutput(empty.source, empty.destination)).toThrow(/index/i);
    const deep = await output(root); await writeFile(join(deep.source, "index.html"), "x"); let cursor = deep.source; for (let i = 0; i < 34; i++) { cursor = join(cursor, `d${i}`); await mkdir(cursor); } await writeFile(join(cursor, "x.txt"), "x"); expect(() => snapshotStaticOutput(deep.source, deep.destination)).toThrow(/层级|large/i);
  });
});
