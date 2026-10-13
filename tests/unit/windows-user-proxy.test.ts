import { describe, expect, it } from "vitest";
import { resolveWindowsUserProxy } from "../../src/main/runtime/windows-user-proxy.js";

describe("Windows user proxy", () => {
  it("prefers existing environment and does not read registry", () => {
    let read = false;
    expect(resolveWindowsUserProxy({ HTTP_PROXY: "http://proxy:8080" }, "win32", () => { read = true; return {}; })).toEqual({ env: { HTTP_PROXY: "http://proxy:8080" }, source: "process" });
    expect(read).toBe(false);
  });
  it("parses safe registry proxies and overrides", () => {
    expect(resolveWindowsUserProxy({}, "win32", () => ({ ProxyEnable: "1", ProxyServer: "http=proxy.local:8080;https=secure.local:8443", ProxyOverride: "localhost;*.internal;<local>" }))).toEqual({ env: { HTTP_PROXY: "http://proxy.local:8080", HTTPS_PROXY: "http://secure.local:8443", ALL_PROXY: "http://secure.local:8443", NO_PROXY: "localhost,*.internal", http_proxy: "http://proxy.local:8080", https_proxy: "http://secure.local:8443", all_proxy: "http://secure.local:8443", no_proxy: "localhost,*.internal" }, source: "registry" });
  });
  it("rejects credentials, invalid ports and PAC only values", () => {
    expect(resolveWindowsUserProxy({}, "win32", () => ({ ProxyEnable: "1", ProxyServer: "http=user:p@host:80" })).source).toBe("none");
    expect(resolveWindowsUserProxy({}, "win32", () => ({ ProxyEnable: "1", ProxyServer: "http://host:70000" })).source).toBe("none");
    expect(resolveWindowsUserProxy({}, "win32", () => ({ ProxyEnable: "1", ProxyServer: "http://pac.local/file.pac" })).source).toBe("none");
  });
  it("does nothing off Windows", () => expect(resolveWindowsUserProxy({}, "linux", () => ({ ProxyEnable: "1", ProxyServer: "host:80" })).source).toBe("none"));
  it("accepts REG_DWORD output and maps an unqualified proxy to all schemes", () => {
    expect(resolveWindowsUserProxy({}, "win32", () => ({ ProxyEnable: "0x1", ProxyServer: "127.0.0.1:17891" })).env).toEqual({ HTTP_PROXY: "http://127.0.0.1:17891", HTTPS_PROXY: "http://127.0.0.1:17891", ALL_PROXY: "http://127.0.0.1:17891", http_proxy: "http://127.0.0.1:17891", https_proxy: "http://127.0.0.1:17891", all_proxy: "http://127.0.0.1:17891" });
  });
});
