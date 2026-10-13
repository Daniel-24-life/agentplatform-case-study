import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../../src/main/process/runner.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("runProcess hash-only logs", () => {
  it("keeps bounded summaries and hashes without creating raw logs", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "runner-hash-only-")); roots.push(root);
    const result = await runProcess({ program: process.execPath, args: ["-e", "process.stdout.write('secret-output');process.stderr.write('warn')"], cwd: root, timeoutSeconds: 5, logDir: root, hashOnlyLogs: true });
    expect(result.stdout).toBe("secret-output");
    expect(result.stdoutSha256).toBe(createHash("sha256").update("secret-output").digest("hex"));
    expect(result.stderrSha256).toBe(createHash("sha256").update("warn").digest("hex"));
    expect(existsSync(path.join(root, "stdout.log"))).toBe(false);
    expect(existsSync(path.join(root, "stderr.log"))).toBe(false);
  });
  it("keeps the default raw-log behavior", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "runner-default-")); roots.push(root);
    const result = await runProcess({ program: process.execPath, args: ["-e", "process.stdout.write('default-out');process.stderr.write('default-err')"], cwd: root, timeoutSeconds: 5, logDir: root });
    expect(readFileSync(path.join(root, "stdout.log"), "utf8")).toBe("default-out");
    expect(readFileSync(path.join(root, "stderr.log"), "utf8")).toBe("default-err");
    expect(result.stdoutSha256).toBe(createHash("sha256").update("default-out").digest("hex"));
    expect(result.stderrSha256).toBe(createHash("sha256").update("default-err").digest("hex"));
  });
});
