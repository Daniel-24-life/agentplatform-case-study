import { spawnSync } from "node:child_process";
import path from "node:path";

export type ProxyRegistryReader = () => Record<string, string | undefined>;
export type ProxyResolution = { env: Record<string, string>; source: "process" | "registry" | "none" };

const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;
const lower = keys.map((key) => key.toLowerCase());

const registryReader: ProxyRegistryReader = () => {
  if (process.platform !== "win32") return {};
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) return {};
  const result = spawnSync(path.join(systemRoot, "System32", "reg.exe"), ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {
    shell: false, windowsHide: true, timeout: 1500, encoding: "utf8", maxBuffer: 64 * 1024
  });
  if (result.error || result.status !== 0) return {};
  const values: Record<string, string> = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.+?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
};

const safeUrl = (value: string): string | null => {
  if (!value || /[\r\n@]/.test(value)) return null;
  const candidate = value.includes("://") ? value : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" || url.username || url.password || !url.hostname || !url.port) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return `http://${url.hostname}:${port}`;
  } catch { return null; }
};

const processProxy = (env: Record<string, string | undefined>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of keys) { const value = env[key] ?? env[key.toLowerCase()]; if (value) result[key] = value; }
  return result;
};

export const resolveWindowsUserProxy = (env: Record<string, string | undefined> = process.env, platform: string = process.platform, reader: ProxyRegistryReader = registryReader): ProxyResolution => {
  const existing = processProxy(env);
  if (Object.keys(existing).length) return { env: existing, source: "process" };
  if (platform !== "win32") return { env: {}, source: "none" };
  const values = reader();
  if (!/^(?:1|0x0*1)$/i.test(values.ProxyEnable ?? "")) return { env: {}, source: "none" };
  const raw = values.ProxyServer ?? "";
  const parsed: Record<string, string> = {};
  const entries = raw.split(";").map((part) => part.trim()).filter(Boolean);
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = separator < 0 ? (entry.toLowerCase().startsWith("https://") ? "https" : "http") : entry.slice(0, separator).toLowerCase();
    const value = separator < 0 ? entry : entry.slice(separator + 1);
    if (name !== "http" && name !== "https") continue;
    const url = safeUrl(value); if (!url) continue;
    parsed[name] = url;
  }
  if (!Object.keys(parsed).length) return { env: {}, source: "none" };
  if (parsed.http && !parsed.https) parsed.https = parsed.http;
  const result: Record<string, string> = {};
  if (parsed.http) result.HTTP_PROXY = parsed.http;
  if (parsed.https) result.HTTPS_PROXY = parsed.https;
  result.ALL_PROXY = parsed.https ?? parsed.http;
  if (values.ProxyOverride) result.NO_PROXY = values.ProxyOverride.split(";").map((v) => v.trim()).filter((v) => v && v !== "<local>").join(",");
  for (const key of Object.keys(result)) result[key.toLowerCase()] = result[key];
  return { env: result, source: "registry" };
};

export const proxyEnvPresence = (resolution: ProxyResolution): Record<string, boolean> => Object.fromEntries([...keys, ...lower].map((key) => [key, Boolean(resolution.env[key] ?? resolution.env[key.toUpperCase()])]));
