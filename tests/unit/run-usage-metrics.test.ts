import { describe, expect, it } from "vitest";
import { summarizeRunUsage } from "../../src/shared/core/run-usage-metrics.js";

describe("run usage metrics", () => {
  it("handles partial, zero, malformed and non-object usage independently", () => {
    const result = summarizeRunUsage([null, "null", "1", "[]", "{bad", JSON.stringify({ inputTokens: 0 }), JSON.stringify({ outputTokens: 3 })]);
    expect(result).toEqual({ availableRuns: 2, inputTokens: 0, outputTokens: 3, totalTokens: null });
  });
  it("returns null for a field that overflows while preserving other fields", () => {
    const result = summarizeRunUsage([JSON.stringify({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), JSON.stringify({ inputTokens: 1, outputTokens: 2 })]);
    expect(result).toEqual({ availableRuns: 2, inputTokens: null, outputTokens: 3, totalTokens: null });
  });
  it("ignores negative, fractional and non-finite values", () => {
    expect(summarizeRunUsage([JSON.stringify({ inputTokens: -1 }), JSON.stringify({ outputTokens: 1.5 }), JSON.stringify({ totalTokens: NaN })])).toEqual({ availableRuns: 0, inputTokens: null, outputTokens: null, totalTokens: null });
  });
});
