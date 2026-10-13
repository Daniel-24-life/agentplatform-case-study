import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveWindowsUserProxy, proxyEnvPresence, type ProxyResolution } from "./windows-user-proxy.js";

export const RUNTIME_FINGERPRINT_VERSION = "agentplatform-runtime-fingerprint-v1";

export type RuntimeFingerprintOptions = {
  executable?: string;
  configPath?: string;
  doctorEvidencePath?: string;
  model?: string;
  reasoning?: string;
  proxyResolver?: () => ProxyResolution;
  versionRunner?: (_executable: string) => string;
};

export type RuntimeFingerprint = {
  schemaVersion: typeof RUNTIME_FINGERPRINT_VERSION;
  capturedAt: string;
  executable: { requested: string; absolutePath: string | null; version: string | null; sha256: string | null; sizeBytes: number | null };
  config: { present: boolean; sha256: string | null; keyCount: number };
  features: { multiAgent: "disabled"; agentsEnabled: false; sandbox: "read-only"; structuredOutput: "json"; network: "unspecified" };
  model: string | null;
  reasoning: string | null;
  proxy: { source: ProxyResolution["source"]; envPresence: Record<string, boolean> };
  telemetry: { promptBytes: number | null; schemaBytes: number | null; contextBytes: number | null };
  doctor: { evidencePath: string | null; diagnosticOnly: true };
};

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

const findExecutable = (requested: string): string | null => {
  if (path.isAbsolute(requested) && existsSync(requested)) return path.resolve(requested);
  try {
    const result = execFileSync(process.platform === "win32" ? "where.exe" : "which", [requested], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const first = result.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first ? path.resolve(first) : null;
  } catch { return null; }
};

const versionOf = (executable: string, runner: (_executable: string) => string): string | null => {
  try { return runner(executable).trim().slice(0, 256) || null; } catch { return null; }
};

/** Redact values before hashing so credentials, paths, and raw config never enter evidence. */
const sanitizedConfigFingerprint = (configPath: string | undefined): { present: boolean; sha256: string | null; keyCount: number } => {
  if (!configPath || !existsSync(configPath)) return { present: false, sha256: null, keyCount: 0 };
  try {
    const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
    const keys: string[] = [];
    const normalized = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return "";
      const match = /^([A-Za-z0-9_.-]+)\s*=/.exec(trimmed);
      if (!match) return trimmed.replace(/\s+/g, " ");
      keys.push(match[1].toLowerCase());
      return `${match[1].toLowerCase()}=<redacted>`;
    }).filter(Boolean).sort();
    return { present: true, sha256: sha256(normalized.join("\n")), keyCount: keys.length };
  } catch { return { present: true, sha256: null, keyCount: 0 }; }
};

export const collectRuntimeFingerprint = (options: RuntimeFingerprintOptions = {}): RuntimeFingerprint => {
  const requested = options.executable ?? "codex";
  const absolutePath = findExecutable(requested);
  const stat = absolutePath ? (() => { try { return statSync(absolutePath); } catch { return null; } })() : null;
  const versionRunner = options.versionRunner ?? ((executable: string) => execFileSync(executable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  const proxy = (options.proxyResolver ?? (() => resolveWindowsUserProxy()))();
  return {
    schemaVersion: RUNTIME_FINGERPRINT_VERSION,
    capturedAt: new Date().toISOString(),
    executable: { requested, absolutePath, version: absolutePath ? versionOf(absolutePath, versionRunner) : null, sha256: absolutePath && stat?.isFile() ? sha256(readFileSync(absolutePath)) : null, sizeBytes: stat?.isFile() ? stat.size : null },
    config: sanitizedConfigFingerprint(options.configPath),
    features: { multiAgent: "disabled", agentsEnabled: false, sandbox: "read-only", structuredOutput: "json", network: "unspecified" },
    model: options.model ?? null,
    reasoning: options.reasoning ?? null,
    proxy: { source: proxy.source, envPresence: proxyEnvPresence(proxy) },
    telemetry: { promptBytes: null, schemaBytes: null, contextBytes: null },
    doctor: { evidencePath: options.doctorEvidencePath ?? null, diagnosticOnly: true }
  };
};
