import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProductPreviewError } from "../../shared/contracts/product-preview.js";
import type { PreviewManifest } from "./product-preview-server.js";

/** Copies bounded static output; product files and filesystem links are never executed. */
export function snapshotStaticOutput(source: string, destination: string): { manifest: PreviewManifest; hash: string } {
  if (lstatSync(path.dirname(source)).isSymbolicLink()) throw new ProductPreviewError("UNSAFE_OUTPUT", "预览工作目录不能使用文件系统链接。");
  const sourceStat = lstatSync(source, { throwIfNoEntry: false });
  if (sourceStat?.isSymbolicLink()) throw new ProductPreviewError("UNSAFE_OUTPUT", "预览目录不能使用文件系统链接。");
  if (!sourceStat?.isDirectory()) throw new ProductPreviewError("STATIC_OUTPUT_MISSING", "未找到静态构建目录。");
  const root = realpathSync(source);
  const manifest: PreviewManifest = { files: [] };
  const payloads: Array<{ relative: string; data: Buffer }> = [];
  let total = 0, entries = 0;
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || /[\\/:]/.test(entry.name) || entry.name.includes("\0")) throw new ProductPreviewError("UNSAFE_OUTPUT", "静态目录包含不支持的文件名。");
      if (++entries > 1024 || path.relative(root, directory).split(path.sep).length > 32) throw new ProductPreviewError("OUTPUT_TOO_LARGE", "静态目录层级或条目数量过多。");
      const file = path.join(directory, entry.name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new ProductPreviewError("UNSAFE_OUTPUT", "静态目录不能包含文件系统链接。");
      const relative = path.relative(root, realpathSync(file));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ProductPreviewError("UNSAFE_OUTPUT", "静态文件越出预览目录。");
      if (stat.isDirectory()) { collect(file); continue; }
      if (!stat.isFile()) throw new ProductPreviewError("UNSAFE_OUTPUT", "静态目录包含非常规文件。");
      total += stat.size;
      if (manifest.files.length >= 512 || stat.size > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new ProductPreviewError("OUTPUT_TOO_LARGE", "静态预览最多512个文件、32MiB总量，单文件最多8MiB。");
      const data = readFileSync(file);
      if (data.length !== stat.size || path.relative(root, realpathSync(file)) !== relative || lstatSync(file).isSymbolicLink()) throw new ProductPreviewError("UNSAFE_OUTPUT", "静态文件在读取期间发生变化。");
      const name = relative.split(path.sep).join("/");
      manifest.files.push({ path: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
      payloads.push({ relative, data });
    }
  };
  collect(root);
  if (!manifest.files.some(file => file.path === "index.html")) throw new ProductPreviewError("STATIC_OUTPUT_MISSING", "构建目录需要包含index.html。");
  mkdirSync(destination);
  for (const payload of payloads) { const file = path.join(destination, payload.relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, payload.data, { flag: "wx" }); }
  const bytes = JSON.stringify(manifest);
  writeFileSync(path.join(path.dirname(destination), "manifest.json"), bytes, { flag: "wx" });
  return { manifest, hash: createHash("sha256").update(bytes).digest("hex") };
}
