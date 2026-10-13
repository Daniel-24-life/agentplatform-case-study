import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { P16_ARCH_01_CONSTRAINT, ISSUE_CODES, replayP16Arch01, replayRegistrationIdentity, evaluationConstraintSha256 } from "../manual/phase1-7-contract-replay.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/phase1-7/p16-arch-01-task-spec.json", import.meta.url), "utf8")) as Record<string, unknown>;
const result = { id: "P16-ARCH-01", schemaValid: true };
const run = (taskSpec: unknown = fixture, extra: Record<string, unknown> = {}) => replayP16Arch01({ taskSpec, result, ...extra });

describe("Phase 1.7 contract replay", () => {
  it("replays the copied TaskSpec and accepts structured npm commands", () => {
    expect(run()).toMatchObject({ valid: true, issues: [] });
  });
  it.each([
    ["wrong task id", { task_id: "WRONG" }, ISSUE_CODES.IDENTITY],
    ["wrong base sha", { base_sha: "1".repeat(40) }, ISSUE_CODES.IDENTITY],
    ["unsafe command cwd", { test_commands: [{ ...(fixture.test_commands as any[])[0], cwd: "../outside" }] }, ISSUE_CODES.COMMAND],
    ["shell-shaped command", { test_commands: [{ ...(fixture.test_commands as any[])[0], program: "npm test" }] }, ISSUE_CODES.COMMAND],
    ["duplicate command ids", { test_commands: [...(fixture.test_commands as any[]), (fixture.test_commands as any[])[0]] }, ISSUE_CODES.DUPLICATE_ID],
  ])("rejects %s deterministically", (_name, mutation, code) => {
    expect(run({ ...fixture, ...mutation }).issues.map((x) => x.code)).toContain(code);
  });
  it("rejects missing result, artifact tamper, and fixture drift", () => {
    expect(replayP16Arch01({ taskSpec: fixture }).issues.map((x) => x.code)).toContain(ISSUE_CODES.RESULT_MISSING);
    expect(run(fixture, { artifact: "tampered" }).issues.map((x) => x.code)).toContain(ISSUE_CODES.ARTIFACT_TAMPERED);
    expect(run(fixture, { fixtureSha256: "f".repeat(64) }).issues.map((x) => x.code)).toContain(ISSUE_CODES.FIXTURE_DRIFT);
  });
  it("does not depend on the Phase 1.6 executor or private semanticIssues", () => {
    expect(Object.keys(P16_ARCH_01_CONSTRAINT)).toContain("version");
    expect(replayP16Arch01({ taskSpec: fixture, result }).valid).toBe(true);
  });
  it("binds registration identity to canonical constraint content", () => {
    expect(replayRegistrationIdentity(P16_ARCH_01_CONSTRAINT).artifactSha256).toBe(P16_ARCH_01_CONSTRAINT.artifactSha256);
    expect(evaluationConstraintSha256({ ...P16_ARCH_01_CONSTRAINT, expectedTaskId: "MUTATED" })).not.toBe(evaluationConstraintSha256(P16_ARCH_01_CONSTRAINT));
  });
});
