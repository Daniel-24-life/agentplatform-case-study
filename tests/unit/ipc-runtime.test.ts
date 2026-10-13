import { describe, expect, it, vi, beforeEach } from "vitest";

const { handlers, preflight } = vi.hoisted(() => ({ handlers: new Map<string, (..._args: any[]) => any>(), preflight: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn), removeHandler: vi.fn() } }));
vi.mock("../../src/main/runtime/codex-runtime-preflight.js", () => ({ runCodexRuntimePreflight: preflight }));

import { AgentRunError } from "../../src/main/adapters/agent-adapter.js";
import { initIpcHandlers, summarizePreflight } from "../../src/main/ipc.js";

const profiles = { strong: { model: "strong" }, cheap: { model: "cheap" } } as any;
const result = (passed: boolean) => ({ passed, startedAt: "a", finishedAt: "b", artifactRoot: "C:/secret", proxyEnv: {}, steps: [{ id: "version", status: "SUCCEEDED", durationMs: 1 }], ...(passed ? {} : { failure: { code: "PROCESS_TIMEOUT", diagnosticSummary: "timeout" } }) });

describe("runtime IPC gate", () => {
  const design = vi.fn(async () => "ok");
  const tests = vi.fn(async () => "tests");
  beforeEach(() => { handlers.clear(); preflight.mockReset(); design.mockClear(); tests.mockClear(); initIpcHandlers({} as any, {} as any, { startDesign: design, startBuild: design, startFinalGate: design, startTests: tests, detail: vi.fn(), updateSpec: vi.fn(), approveSpec: vi.fn(), approveEscalation: vi.fn() } as any, { artifactRoot: "C:/artifacts", profiles }); });

  it("summarizes without paths, stdout, stderr or proxy", () => { const value = summarizePreflight(result(true) as any); expect(value).not.toHaveProperty("artifactRoot"); expect(value).not.toHaveProperty("stdout"); expect(value).not.toHaveProperty("stderr"); expect(value).not.toHaveProperty("proxyEnv"); });
  it("keeps zero-quota doctor separate from model-action qualification", async () => { preflight.mockResolvedValue(result(true)); await handlers.get("runtime:doctor")!(); expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ probeModels: false, models: [] })); await expect(handlers.get("tasks:startDesign")!(null, "T")).rejects.toThrow("RUNTIME_PREFLIGHT_REQUIRED"); });
  it("rejects model actions until PASS, then allows them", async () => { await expect(handlers.get("tasks:startDesign")!(null, "T")).rejects.toThrow("RUNTIME_PREFLIGHT_REQUIRED"); expect(design).not.toHaveBeenCalled(); preflight.mockResolvedValue(result(true)); await handlers.get("runtime:preflight")!(); await expect(handlers.get("tasks:startDesign")!(null, "T")).resolves.toBe("ok"); expect(design).toHaveBeenCalledTimes(1); });
  it("coalesces concurrent preflight calls", async () => { let resolve!: (_x: any) => void; preflight.mockReturnValue(new Promise((r) => { resolve = r; })); const a = handlers.get("runtime:preflight")!(); const b = handlers.get("runtime:preflight")!(); resolve(result(true)); await Promise.all([a, b]); expect(preflight).toHaveBeenCalledTimes(1); });
  it("does not gate tests", async () => { await expect(handlers.get("tasks:startTests")!(null, "T")).resolves.toBe("tests"); expect(tests).toHaveBeenCalled(); });
  it("accepts only an explicit versioned Cursor build selection", async () => {
    const handler = handlers.get("tasks:startCursorBuild")!;
    await expect(handler(null, { schema_version: "1.0", task_id: "T", provider: "cursor" })).resolves.toBe("ok");
    expect(design).toHaveBeenCalledWith("T", "cursor");
    for (const invalid of [
      { schema_version: "1.0", task_id: "T", provider: "codex" },
      { schema_version: "1.0", task_id: "T", provider: "cursor", fallback: true },
      { schema_version: "2.0", task_id: "T", provider: "cursor" },
      { schema_version: "1.0", task_id: "../T", provider: "cursor" }
    ]) expect(() => handler(null, invalid)).toThrow();
    expect(design).toHaveBeenCalledTimes(1);
  });
  it("clears health after a provider-neutral runtime failure", async () => { preflight.mockResolvedValue(result(true)); await handlers.get("runtime:preflight")!(); const failure = new AgentRunError("second worker runtime failed", { status: "FAILED", exitCode: 1, stdout: "", stderr: "", durationMs: 1, stdoutSha256: "", stderrSha256: "" } as any, { code: "TRANSPORT_FAILURE", domain: "runtime", retryable: true, failFast: true, diagnosticSummary: "transport failed" }); design.mockRejectedValueOnce(failure); await expect(handlers.get("tasks:startDesign")!(null, "T")).rejects.toThrow(); await expect(handlers.get("tasks:startDesign")!(null, "T")).rejects.toThrow("RUNTIME_PREFLIGHT_REQUIRED"); });
  it("shares the same readiness authority with product execution", async () => {
    const access = initIpcHandlers({} as never, {} as never, undefined, { artifactRoot: "C:/artifacts", profiles });
    expect(() => access!.assertReady()).toThrow("RUNTIME_PREFLIGHT_REQUIRED");
    preflight.mockResolvedValueOnce(result(true));
    await handlers.get("runtime:preflight")!();
    access!.assertReady();
    expect(await access!.invoke(async () => "product-stage")).toBe("product-stage");
  });
  it("checks shared budget only for manual worker and reviewer model stages", async () => {
    const idle = vi.fn((_task: string, stage?: "build" | "review") => { if (stage) throw new Error("BUDGET_EXHAUSTED"); });
    initIpcHandlers({} as never, {} as never, { startBuild: design, startFinalGate: design, startTests: tests } as never, { artifactRoot: "C:/artifacts", profiles }, undefined, undefined, idle);
    preflight.mockResolvedValue(result(true)); await handlers.get("runtime:preflight")!();
    await expect(handlers.get("tasks:startBuild")!(null, "TASK-1")).rejects.toThrow("BUDGET_EXHAUSTED");
    await expect(handlers.get("tasks:startFinalGate")!(null, "TASK-1")).rejects.toThrow("BUDGET_EXHAUSTED");
    expect(idle).toHaveBeenCalledWith("TASK-1", "build");
    expect(idle).toHaveBeenCalledWith("TASK-1", "review");
    expect(design).not.toHaveBeenCalled();
    await expect(handlers.get("tasks:startTests")!(null, "TASK-1")).resolves.toBe("tests");
  });
  it("blocks manual task mutation while product execution owns the task", () => {
    const idle = vi.fn(() => { throw new Error("TASK_BUSY"); });
    const detail = vi.fn(() => "read-only");
    initIpcHandlers({} as never, {} as never, { detail, approveSpec: design } as never, undefined, undefined, undefined, idle);
    expect(handlers.get("tasks:detail")!(null, "TASK-1")).toBe("read-only");
    expect(() => handlers.get("tasks:approveSpec")!(null, "TASK-1")).toThrow("TASK_BUSY");
    expect(idle).toHaveBeenCalledWith("TASK-1", undefined);
  });
});
