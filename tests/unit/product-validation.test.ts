import { describe, expect, it } from "vitest";
import type { ProductGoal } from "../../src/shared/contracts/products.js";
import { assertProductGoal, assertProductInput, assertProductResponse, canonicalProductJson, validateDirection } from "../../src/shared/core/product-validation.js";

const goal = (): ProductGoal => ({ schemaVersion: "1.0", originalRequest: "一个产品想法", goal: "保存草稿", scope: "本地保存与恢复", assumptions: [], acceptanceCriteria: [{ id: "AC-1", description: "重启后可读取草稿", verification: "platform", required: true }] });

describe("product contracts", () => {
  it("keeps drafts valid but requires a concrete direction before confirmation", () => {
    const draft = { ...goal(), goal: "", scope: "", acceptanceCriteria: [] };
    expect(() => assertProductGoal(draft)).not.toThrow();
    expect(() => validateDirection(draft)).toThrow("确认前");
    expect(() => validateDirection(goal())).not.toThrow();
  });

  it("rejects unknown fields, impersonated actors and malformed identifiers", () => {
    const input = { requestId: "R1", name: "产品", initialRequest: "想法" };
    expect(() => assertProductInput("create", input)).not.toThrow();
    expect(() => assertProductInput("create", { ...input, actor: "user" })).toThrow();
    expect(() => assertProductInput("create", { ...input, requestId: "../R" })).toThrow();
    expect(() => assertProductInput("create", { ...input, name: " " })).toThrow();
  });

  it("rejects duplicate acceptance identities and whitespace-only entries", () => {
    const value = goal();
    expect(() => assertProductGoal({ ...value, acceptanceCriteria: [...value.acceptanceCriteria, ...value.acceptanceCriteria] })).toThrow();
    expect(() => assertProductGoal({ ...value, assumptions: [" "] })).toThrow();
    expect(() => assertProductGoal({ ...value, acceptanceCriteria: [{ ...value.acceptanceCriteria[0], description: " " }] })).toThrow();
  });

  it("enforces byte limits for multi-byte requests and rejects unsafe revisions", () => {
    expect(() => assertProductInput("create", { requestId: "R1", name: "产品", initialRequest: "中".repeat(24000) })).toThrow("大小");
    // The input fits, but the initial snapshot repeats the request as the draft goal.
    expect(() => assertProductInput("create", { requestId: "R1", name: "产品", initialRequest: "x".repeat(33000) })).toThrow("大小");
    for (const expectedRevision of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertProductInput("reviseGoal", { requestId: "R2", productId: "P1", expectedRevision, goal: goal() })).toThrow();
    }
  });

  it("bounds pages without accepting execution operations", () => {
    expect(() => assertProductInput("readEvents", { productId: "P1", limit: 257 })).toThrow();
    expect(() => assertProductInput("list", { limit: 101 })).toThrow();
    expect(() => assertProductInput("getOverview", { productId: "P1", execute: true })).toThrow();
  });

  it("hashes equivalent object orders identically while preserving arrays and exact text", () => {
    expect(canonicalProductJson({ b: [2, 1], a: "\r\n" })).toBe(canonicalProductJson({ a: "\r\n", b: [2, 1] }));
    expect(canonicalProductJson({ a: "\r\n" })).not.toBe(canonicalProductJson({ a: "\n" }));
    expect(canonicalProductJson([1, 2])).not.toBe(canonicalProductJson([2, 1]));
    expect(() => canonicalProductJson({ bad: undefined })).toThrow();
    expect(() => canonicalProductJson(Infinity)).toThrow();
  });

  it("rejects mismatched versions and cross-product output at the public boundary", () => {
    const timestamp = "2026-10-01T00:00:00.000Z";
    const overview = { product: { id: "P1", name: "产品", repositoryId: null, revision: 1, goalRevision: 1, confirmedGoalRevision: null, createdAt: timestamp, updatedAt: timestamp }, goal: { revision: 1, hash: "a".repeat(64), goal: goal(), createdAt: timestamp } };
    expect(() => assertProductResponse("getOverview", { ok: true, value: overview }, { productId: "P1" })).not.toThrow();
    expect(() => assertProductResponse("getOverview", { ok: true, value: overview }, { productId: "P2" })).toThrow();
    expect(() => assertProductResponse("getOverview", { ok: true, value: { ...overview, goal: { ...overview.goal, revision: 2 } } })).toThrow();
    expect(() => assertProductResponse("getGoal", { ok: true, value: overview.goal }, { revision: 2 })).toThrow();
    expect(() => assertProductResponse("list", { ok: true, value: { items: [], nextCursor: null, surprise: true } })).toThrow();
  });

  it("validates trash and restore inputs and response deletion semantics", () => {
    const timestamp = "2026-10-01T00:00:00.000Z";
    const base = { product: { id: "P1", name: "产品", repositoryId: null, revision: 2, goalRevision: 1, confirmedGoalRevision: null, createdAt: timestamp, updatedAt: timestamp }, goal: { revision: 1, hash: "a".repeat(64), goal: goal(), createdAt: timestamp } };
    expect(() => assertProductInput("trash", { requestId: "R1", productId: "P1", expectedRevision: 2, extra: true })).toThrow();
    for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => assertProductInput("restore", { requestId: "R1", productId: "P1", expectedRevision })).toThrow();
    expect(() => assertProductResponse("trash", { ok: true, value: base }, { productId: "P2" })).toThrow();
    expect(() => assertProductResponse("trash", { ok: true, value: { ...base, product: { ...base.product, deletedAt: timestamp } } }, { productId: "P1" })).not.toThrow();
    expect(() => assertProductResponse("restore", { ok: true, value: { ...base, product: { ...base.product, deletedAt: timestamp } } }, { productId: "P1" })).toThrow();
    expect(() => assertProductResponse("restore", { ok: true, value: { ...base, product: { ...base.product, deletedAt: null } } }, { productId: "P1" })).not.toThrow();
    expect(() => assertProductResponse("list", { ok: true, value: { items: [{ ...base.product, deletedAt: null }], nextCursor: null } }, { deleted: true })).toThrow();
  });
});
