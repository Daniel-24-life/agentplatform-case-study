import { describe, expect, it } from "vitest";
import { evaluateAb, evaluatePhase11, evaluatePhase12, evaluatePhase12Pair as evaluatePhase12PairCompat } from "../../src/shared/core/ab-evaluation.js";
import type { Phase12Pair } from "../../src/shared/core/ab-evaluation.js";
import type { EvaluationSummary } from "../../src/shared/core/ab-evaluation.js";
const metrics=(highTierCalls:number,totalTokens:number|null)=>({runCount:2,highTierCalls,highTierInputTokens:totalTokens,highTierOutputTokens:totalTokens,highTierTotalTokens:totalTokens,escalationCount:0,totalDurationMs:10,workerRuns:1,cheapRuns:1,strongRuns:highTierCalls,retryCount:0,inputTokens:null,outputTokens:null,totalTokens,usageAvailableRuns:totalTokens===null?0:2,agentRunCount:2});
const base=(m=metrics(2,1000)):EvaluationSummary=>({sameBase:true,isolated:true,sourceClean:true,testsPassed:true,gatesPassed:true,finalVerdict:"PASS",p0Findings:0,p1Findings:0,metrics:m,highTierUsageComplete:true});
describe("A/B evaluation",()=>{it("passes quality-equivalent reduced variant",()=>expect(evaluateAb(base(),base(metrics(1,600))).passed).toBe(true));it("rejects quality regression",()=>expect(evaluateAb(base(),{...base(metrics(1,600)),finalVerdict:"REWORK"}).passed).toBe(false));it("falls back to call count without usage",()=>expect(evaluateAb(base(metrics(2,null)),base(metrics(1,null))).passed).toBe(true));it("rejects insufficient token reduction",()=>expect(evaluateAb(base(),base(metrics(1,800))).passed).toBe(false));it("rejects contamination and non-isolation",()=>expect(evaluateAb(base(),{...base(metrics(1,500)),sameBase:false,isolated:false}).passed).toBe(false));});

describe("Phase 1.1 evaluation", () => {
  const pair = (id: string, variant: EvaluationSummary = base(metrics(1, 600)), baseline: EvaluationSummary = base()) => ({ id, baseline, variant });
  it.each([
    ["runtime failure is invalid, not quality failure", { failureDomain: "runtime" as const }, 0, "RUNTIME_OR_USER_FAILURE"],
    ["user failure is invalid, not quality failure", { failureDomain: "user" as const }, 0, "RUNTIME_OR_USER_FAILURE"],
    ["incomplete evidence is invalid", { evidenceComplete: false }, 0, "EVIDENCE_INCOMPLETE"],
    ["variant task failure remains a valid negative sample", { failureDomain: "task" as const, finalVerdict: "REWORK" }, 1, "QUALITY_REGRESSION"],
    ["partial token usage uses call fallback", { metrics: metrics(1, null) }, 1, "TOKEN_USAGE_UNAVAILABLE_CALL_COUNT_USED"],
  ])("classifies %s", (_label, variantPatch, expectedValid, reason) => {
    const variant = { ...base(metrics(1, 600)), ...variantPatch } as EvaluationSummary;
    const result = evaluatePhase11([pair("x", variant)]);
    expect(result.validCount).toBe(expectedValid);
    expect(result.reasons).toContain(reason);
  });
  it("requires three valid samples", () => {
    expect(evaluatePhase11([pair("a"), pair("b")]).status).toBe("BLOCKED");
  });
  it("passes three complete successful samples", () => {
    const result = evaluatePhase11([pair("a"), pair("b"), pair("c")]);
    expect(result.status).toBe("PASS");
    expect(result.validCount).toBe(3);
    expect(result.successCount).toBe(3);
    expect(result.usageMode).toBe("complete-token");
  });
  it("returns partial when valid samples mix success and failure", () => {
    const result = evaluatePhase11([pair("a"), pair("b", { ...base(metrics(1, 900)) }), pair("c")]);
    expect(result.status).toBe("PARTIAL");
    expect(result.successCount).toBe(2);
  });
  it("does not infer high-tier completeness from cheap-run usage", () => {
    const result = evaluatePhase11([pair("x", { ...base(metrics(1, 600)), highTierUsageComplete: false })]);
    expect(result.pairs[0].usageMode).toBe("call-count-fallback");
    expect(result.pairs[0].tokenReductionRatio).toBeNull();
  });
  it("does not report quality regression for an invalid runtime pair", () => {
    const result = evaluatePhase11([pair("x", { ...base(metrics(1, 600)), failureDomain: "runtime", finalVerdict: "REWORK" })]);
    expect(result.pairs[0].valid).toBe(false);
    expect(result.pairs[0].reasons).not.toContain("QUALITY_REGRESSION");
  });
});

describe("Phase 1.2 population gate", () => {
  const pair = (id: string, population: "development" | "holdout" = "development", patch: Partial<Phase12Pair> = {}): Phase12Pair => ({ id, population, baseline: base(), variant: base(metrics(1, 600)), ...patch });
  it("requires ten valid pairs and six holdouts", () => {
    expect(evaluatePhase12([pair("x")]).status).toBe("BLOCKED");
  });
  it.each([
    ["runtime invalid", { variant: { ...base(metrics(1, 600)), failureDomain: "runtime" as const } }, "RUNTIME_OR_USER_FAILURE"],
    ["quality regression", { variant: { ...base(metrics(1, 600)), finalVerdict: "REWORK" as const } }, "QUALITY_REGRESSION"],
    ["escalation", { variant: { ...base(metrics(1, 600)), metrics: { ...metrics(2, 600), escalationCount: 1 } } }, "ESCALATION_UNSUPPORTED_COST_HYPOTHESIS"],
  ])("reports %s explicitly", (_name, patch, reason) => {
    const result = evaluatePhase12([pair("x", "holdout", patch)]);
    expect(result.pairs[0].reasons).toContain(reason);
  });
  it("keeps call-count fallback and quality regression as valid evidence", () => {
    const fallback = evaluatePhase12PairCompat(pair("fallback", "holdout", { baseline: base(metrics(2, null)), variant: base(metrics(1, null)) }));
    expect(fallback.valid).toBe(true);
    const regression = evaluatePhase12PairCompat(pair("regression", "holdout", { variant: { ...base(metrics(1, 600)), finalVerdict: "REWORK" } }));
    expect(regression.valid).toBe(true);
  });
  it("passes four development and six successful holdouts", () => {
    const pairs = [...Array.from({ length: 4 }, (_, i) => pair(`d${i}`)), ...Array.from({ length: 6 }, (_, i) => pair(`h${i}`, "holdout", { firstAttemptSuccess: i < 4 }))];
    const result = evaluatePhase12(pairs);
    expect(result.status).toBe("PASS");
    expect(result.holdoutEventualSuccessCount).toBe(6);
    expect(result.holdoutFirstAttemptSuccessCount).toBe(4);
    expect(result.usageMode).toBe("complete-token");
  });
  it("returns FAIL when no valid holdout supports the hypothesis", () => {
    const pairs = [...Array.from({ length: 4 }, (_, i) => pair(`d${i}`)), ...Array.from({ length: 6 }, (_, i) => pair(`h${i}`, "holdout", { variant: base(metrics(2, 1000)) }))];
    expect(evaluatePhase12(pairs).status).toBe("FAIL");
  });
  it("averages all comparable holdouts, including zero or negative reductions", () => {
    const pairs = [...Array.from({ length: 4 }, (_, i) => pair(`d${i}`)), ...Array.from({ length: 5 }, (_, i) => pair(`h${i}`, "holdout")), pair("h5", "holdout", { variant: base(metrics(7, 1000)) })];
    const result = evaluatePhase12(pairs);
    expect(result.averageFairHighTierCallReduction).toBe(0);
    expect(result.status).not.toBe("PASS");
  });
  it("includes escalated calls in the observed average", () => {
    const pairs = [...Array.from({ length: 4 }, (_, i) => pair(`d${i}`)), ...Array.from({ length: 5 }, (_, i) => pair(`h${i}`, "holdout")), pair("h5", "holdout", { variant: { ...base(metrics(2, 1000)), metrics: { ...metrics(2, 1000), escalationCount: 1 } } })];
    expect(evaluatePhase12(pairs).averageFairHighTierCallReduction).toBeCloseTo(5 / 6);
  });
});
