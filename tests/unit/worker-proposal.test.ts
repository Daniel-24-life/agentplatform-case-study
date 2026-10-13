import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  validateChangeSet,
  validateWorkerProposalRequest,
  type ChangeSet,
  type WorkerProposalRequest,
  WORKER_PROPOSAL_CONTEXT_LIMITS
} from "../../src/shared/core/worker-proposal.js";
import {
  loadChangeSetSchema,
  loadWorkerProposalRequestSchema
} from "../../src/shared/core/schema-validation.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const baseSha = "0123456789abcdef0123456789abcdef01234567";
const taskSpecSha256 = "a".repeat(64);

const requestFixture = (): WorkerProposalRequest => {
  const content = "export const answer = 42;\n";
  return {
    schema_version: "1.0",
    task_id: "TASK-001",
    base_sha: baseSha,
    task_spec_sha256: taskSpecSha256,
    goal: "Implement the bounded fixture change.",
    scope: {
      allowed_paths: ["src/**"],
      forbidden_paths: ["src/private/**"]
    },
    acceptance_criteria: [
      { id: "AC-01", text: "The fixture exports answer." },
      { id: "AC-02", text: "The result remains UTF-8 text." }
    ],
    context_files: [
      {
        path: "src/answer.ts",
        byte_count: Buffer.byteLength(content, "utf8"),
        sha256: sha256(content),
        content
      }
    ],
    limits: {
      max_operations: 2,
      max_file_bytes: 1024,
      max_total_bytes: 2048
    }
  };
};

const changeSetFixture = (): ChangeSet => ({
  schema_version: "1.0",
  task_id: "TASK-001",
  base_sha: baseSha,
  task_spec_sha256: taskSpecSha256,
  status: "completed",
  summary: "Updated the fixture.",
  operations: [
    {
      type: "replace_file",
      path: "src/answer.ts",
      expected_sha256: sha256("export const answer = 42;\n"),
      content: "export const answer = 43;\n"
    }
  ],
  acceptance_notes: [
    { criterion_id: "AC-01", note: "The fixture exports answer." },
    { criterion_id: "AC-02", note: "The replacement is UTF-8 text." }
  ],
  risks: [],
  blocker: null
});

describe("worker proposal schemas", () => {
  it("loads both strict schemas", () => {
    expect(loadWorkerProposalRequestSchema().valid).toBe(true);
    expect(loadChangeSetSchema().valid).toBe(true);
  });
});

describe("worker proposal request validation", () => {
  it("accepts a bounded, hashed UTF-8 request", () => {
    const result = validateWorkerProposalRequest(requestFixture());
    expect(result.valid).toBe(true);
  });

  it("rejects identity drift, unsafe paths, and Windows case collisions", () => {
    const request = requestFixture();
    request.task_id = "TASK-002";
    request.context_files.push({
      path: "SRC\\answer.ts",
      byte_count: request.context_files[0]!.byte_count,
      sha256: request.context_files[0]!.sha256,
      content: request.context_files[0]!.content
    });
    request.scope.allowed_paths = ["../outside"];

    const result = validateWorkerProposalRequest(request, { taskId: "TASK-001" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.message === "TASK_ID_MISMATCH")).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("case-insensitive path collision"))).toBe(true);
      expect(result.issues.some((issue) => issue.path === "scope.allowed_paths[0]")).toBe(true);
    }
  });

  it("rejects content hash, byte count, and aggregate input overflows", () => {
    const request = requestFixture();
    const content = "x".repeat(WORKER_PROPOSAL_CONTEXT_LIMITS.maxFileBytes + 1);
    request.context_files = [
      {
        path: "src/large.ts",
        byte_count: 0,
        sha256: "0".repeat(64),
        content
      }
    ];

    const result = validateWorkerProposalRequest(request);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path.endsWith(".sha256"))).toBe(true);
      expect(result.issues.some((issue) => issue.path.endsWith(".byte_count"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("per-file byte limit"))).toBe(true);
    }
  });
});

describe("change set validation", () => {
  it("accepts create and replace semantics with request identity", () => {
    const request = requestFixture();
    const changeSet = changeSetFixture();
    changeSet.operations.push({
      type: "create_file",
      path: "src/new.ts",
      expected_sha256: null,
      content: "export const created = true;\n"
    });
    expect(validateChangeSet(changeSet, { request }).valid).toBe(true);
  });

  it("rejects identity drift, expected hash violations, scope escapes, and byte limits", () => {
    const request = requestFixture();
    const changeSet = changeSetFixture();
    changeSet.task_spec_sha256 = "b".repeat(64);
    changeSet.operations[0]!.expected_sha256 = null;
    changeSet.operations.push({
      type: "replace_file",
      path: "src\\ANSWER.ts",
      expected_sha256: sha256("old"),
      content: "y".repeat(3000)
    });

    const result = validateChangeSet(changeSet, { request });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.message === "TASK_SPEC_SHA256_MISMATCH")).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("replace_file requires"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("case-insensitive path collision"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("max_file_bytes"))).toBe(true);
    }
  });

  it("requires blocker only for blocked status and unique acceptance notes", () => {
    const changeSet = changeSetFixture();
    changeSet.status = "blocked";
    changeSet.blocker = null;
    changeSet.operations = [];
    changeSet.acceptance_notes.push({ criterion_id: "AC-01", note: "duplicate" });

    const result = validateChangeSet(changeSet, { request: requestFixture() });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((issue) => issue.path === "blocker")).toBe(true);
      expect(result.issues.some((issue) => issue.path.includes("acceptance_notes"))).toBe(true);
    }
  });
});
