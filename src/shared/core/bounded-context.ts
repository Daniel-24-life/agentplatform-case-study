import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export type BoundedContextLimits = { maxFiles?: number; maxBytesPerFile?: number; maxTotalBytes?: number };
export type BoundedContextItem = { path: string; content: string; bytes: number; sha256: string; truncated: boolean };
export type BoundedContext = { items: BoundedContextItem[]; sha256: string; totalBytes: number; truncated: boolean; truncation: { files: number; bytes: number; paths: string[] } };
const defaults = { maxFiles: 50, maxBytesPerFile: 64 * 1024, maxTotalBytes: 512 * 1024 };
const safe = (p: string): boolean => p.length > 0 && !path.isAbsolute(p) && !/^[A-Za-z]:[\\/]/.test(p) && p.split(/[\\/]/).every(s => s !== "" && s !== "." && s !== "..");

export function readBoundedContext(root: string, requested: readonly string[], limits: BoundedContextLimits = {}): BoundedContext {
  const lim = { ...defaults, ...limits }; if (![lim.maxFiles, lim.maxBytesPerFile, lim.maxTotalBytes].every(n => Number.isInteger(n) && n >= 0)) throw new Error("invalid bounded context limits");
  const rootReal = realpathSync(root); if (requested.some((p) => typeof p !== "string" || !safe(p))) throw new Error("bounded context path must be a safe relative path");
  const paths = [...new Set(requested)].sort();
  const items: BoundedContextItem[] = []; const truncated: string[] = []; let totalBytes = 0; let truncFiles = 0; let truncBytes = 0;
  for (const relative of paths) {
    if (items.length >= lim.maxFiles) { truncated.push(relative); truncFiles++; continue; }
    const absolute = path.resolve(rootReal, relative); let stat; try { stat = lstatSync(absolute); } catch { truncated.push(relative); truncFiles++; continue; }
    if (!stat.isFile()) { truncated.push(relative); truncFiles++; continue; }
    let real; try { real = realpathSync(absolute); } catch { truncated.push(relative); truncFiles++; continue; }
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) throw new Error("bounded context path escapes root through symlink");
    const raw = readFileSync(real); const allowed = Math.min(raw.byteLength, lim.maxBytesPerFile, Math.max(0, lim.maxTotalBytes - totalBytes));
    const bytes = raw.subarray(0, allowed); const wasTruncated = allowed < raw.byteLength; if (wasTruncated) { truncated.push(relative); truncFiles++; truncBytes += raw.byteLength - allowed; }
    const content = bytes.toString("utf8"); items.push({ path: relative.replaceAll("\\", "/"), content, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), truncated: wasTruncated }); totalBytes += bytes.byteLength;
  }
  const canonical = items.map(i => `${i.path}\0${i.sha256}\0${i.bytes}`).join("\n");
  return { items, sha256: createHash("sha256").update(canonical).digest("hex"), totalBytes, truncated: truncated.length > 0, truncation: { files: truncFiles, bytes: truncBytes, paths: truncated } };
}

export const buildBoundedContext = readBoundedContext;
