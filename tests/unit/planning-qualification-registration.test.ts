import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { fileHash, verifyPlanningQualification } from "../manual/phase1-22-registration.js";

describe("product qualification registration", () => {
  it("rejects approval drift and a previously used budget", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "planning-registration-"));
    try {
      const source = path.join(root, "source.txt"); writeFileSync(source, "frozen");
      const approval = { phase: "1.22", authorized: true, maxCalls: 1, timeoutSeconds: 300, program: process.execPath,
        programHash: fileHash(process.execPath), model: "gpt-5.6-sol", reasoning: "medium", originalRequest: "Synthetic request",
        sourceHashes: [{ path: source, sha256: fileHash(source) }] };
      const file = path.join(root, "approval.json"); writeFileSync(file, JSON.stringify(approval));
      writeFileSync(path.join(root, "approval.sha256"), fileHash(file));
      expect(verifyPlanningQualification(root).maxCalls).toBe(1);
      writeFileSync(source, "changed");
      expect(() => verifyPlanningQualification(root)).toThrow("drift");
      writeFileSync(source, "frozen"); writeFileSync(path.join(root, "dispatch.json"), "{}");
      expect(() => verifyPlanningQualification(root)).toThrow("already used");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
