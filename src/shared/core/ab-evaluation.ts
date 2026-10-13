import type { RunMetrics } from "../contracts/records.js";

export type EvaluationSummary = {
  sameBase: boolean;
  isolated: boolean;
  sourceClean: boolean;
  testsPassed: boolean;
  gatesPassed: boolean;
  finalVerdict: "PASS" | "REWORK" | "BLOCKED" | "FAILED" | string;
  p0Findings: number;
  p1Findings: number;
  metrics: RunMetrics;
  advancedTokens?: number | null;
  /** Runtime/user failures invalidate evidence; task failures are quality results. */
  failureDomain?: "runtime" | "task" | "user" | null;
  evidenceComplete?: boolean;
  specConsistent?: boolean;
  testsConsistent?: boolean;
  acceptanceConsistent?: boolean;
  highTierUsageComplete?: boolean;
};

export type AbEvaluation = { qualityEquivalent: boolean; advancedCallsReduced: boolean; tokenReductionRatio: number | null; passed: boolean; reasons: string[] };

export function evaluateAb(baseline: EvaluationSummary, variant: EvaluationSummary): AbEvaluation {
  const reasons: string[] = [];
  const qualityEquivalent = [baseline, variant].every((item) => item.sameBase && item.isolated && item.sourceClean && item.testsPassed && item.gatesPassed && item.finalVerdict === "PASS" && item.p0Findings === 0 && item.p1Findings === 0);
  if (!baseline.sameBase || !baseline.isolated || !baseline.sourceClean || !baseline.testsPassed || !baseline.gatesPassed || baseline.finalVerdict !== "PASS" || baseline.p0Findings > 0 || baseline.p1Findings > 0) reasons.push("BASELINE_QUALITY_INVALID");
  if (!variant.sameBase) reasons.push("BASE_SHA_MISMATCH");
  if (!variant.isolated) reasons.push("WORKTREES_NOT_ISOLATED");
  if (!variant.sourceClean) reasons.push("SOURCE_CHECKOUT_DIRTY");
  if (!variant.testsPassed || !variant.gatesPassed || variant.finalVerdict !== "PASS") reasons.push("QUALITY_REGRESSION");
  if (variant.p0Findings > 0 || variant.p1Findings > 0) reasons.push("P0_P1_FINDINGS");
  const advancedCallsReduced = variant.metrics.highTierCalls < baseline.metrics.highTierCalls;
  if (!advancedCallsReduced) reasons.push("ADVANCED_CALLS_NOT_REDUCED");
  const baseTokens = baseline.advancedTokens ?? baseline.metrics.highTierTotalTokens;
  const variantTokens = variant.advancedTokens ?? variant.metrics.highTierTotalTokens;
  const tokenReductionRatio = typeof baseTokens === "number" && typeof variantTokens === "number" && baseTokens > 0 ? 1 - variantTokens / baseTokens : null;
  if (tokenReductionRatio !== null && tokenReductionRatio < 0.3) reasons.push("TOKEN_REDUCTION_BELOW_30_PERCENT");
  if (tokenReductionRatio === null) reasons.push("TOKEN_USAGE_UNAVAILABLE_CALL_COUNT_USED");
  const passed = qualityEquivalent && advancedCallsReduced && (tokenReductionRatio === null || tokenReductionRatio >= 0.3);
  return { qualityEquivalent, advancedCallsReduced, tokenReductionRatio, passed, reasons };
}

export type Phase11Pair = { id: string; baseline: EvaluationSummary; variant: EvaluationSummary };
export type Phase11PairResult = AbEvaluation & {
  id: string;
  valid: boolean;
  usageMode: "complete-token" | "call-count-fallback" | "unavailable";
};
export type Phase11Evaluation = {
  validCount: number;
  successCount: number;
  reasons: string[];
  usageMode: "complete-token" | "call-count-fallback" | "mixed" | "unavailable";
  status: "PASS" | "PARTIAL" | "FAIL" | "BLOCKED";
  pairs: Phase11PairResult[];
};

const hasRuntimeOrUserFailure = (s: EvaluationSummary) => s.failureDomain === "runtime" || s.failureDomain === "user";
const evidenceValid = (s: EvaluationSummary) => s.evidenceComplete !== false && s.specConsistent !== false && s.testsConsistent !== false && s.acceptanceConsistent !== false;
const baselineComplete = (s: EvaluationSummary) => s.testsPassed && s.gatesPassed && s.finalVerdict === "PASS" && s.p0Findings === 0 && s.p1Findings === 0;

/** Evaluates a Phase 1.1 pair while keeping validity separate from quality. */
export function evaluatePhase11Pair(pair: Phase11Pair): Phase11PairResult {
  const { baseline, variant } = pair;
  const reasons: string[] = [];
  const invalid = (condition: boolean, reason: string) => { if (condition) reasons.push(reason); };
  invalid(hasRuntimeOrUserFailure(baseline) || hasRuntimeOrUserFailure(variant), "RUNTIME_OR_USER_FAILURE");
  invalid(!evidenceValid(baseline) || !evidenceValid(variant), "EVIDENCE_INCOMPLETE");
  invalid(!baseline.sameBase || !variant.sameBase, "BASE_SHA_MISMATCH");
  invalid(!baseline.isolated || !variant.isolated, "WORKTREES_NOT_ISOLATED");
  invalid(!baseline.sourceClean || !variant.sourceClean, "SOURCE_CHECKOUT_DIRTY");
  invalid(!baselineComplete(baseline), "BASELINE_NOT_COMPLETE");
  const valid = !reasons.length;
  const usageComplete = baseline.highTierUsageComplete === true && variant.highTierUsageComplete === true && baseline.metrics.highTierTotalTokens !== null && variant.metrics.highTierTotalTokens !== null;
  const usageMode = usageComplete ? "complete-token" : (baseline.metrics.highTierCalls > 0 && variant.metrics.highTierCalls > 0 ? "call-count-fallback" : "unavailable");
  const qualityEquivalent = baselineComplete(variant) && variant.failureDomain !== "task";
  const advancedCallsReduced = variant.metrics.highTierCalls < baseline.metrics.highTierCalls;
  const baseTokens = baseline.advancedTokens ?? baseline.metrics.highTierTotalTokens;
  const variantTokens = variant.advancedTokens ?? variant.metrics.highTierTotalTokens;
  const tokenReductionRatio = usageComplete && typeof baseTokens === "number" && typeof variantTokens === "number" && baseTokens > 0 ? 1 - variantTokens / baseTokens : null;
  if (!valid) return { id: pair.id, valid, qualityEquivalent: false, advancedCallsReduced: false, tokenReductionRatio: null, passed: false, reasons, usageMode };
  if (!qualityEquivalent) reasons.push("QUALITY_REGRESSION");
  if (variant.p0Findings > 0 || variant.p1Findings > 0) reasons.push("P0_P1_FINDINGS");
  if (!advancedCallsReduced) reasons.push("ADVANCED_CALLS_NOT_REDUCED");
  if (usageComplete && (tokenReductionRatio === null || tokenReductionRatio < 0.3)) reasons.push("TOKEN_REDUCTION_BELOW_30_PERCENT");
  if (!usageComplete) reasons.push("TOKEN_USAGE_UNAVAILABLE_CALL_COUNT_USED");
  const passed = qualityEquivalent && variant.p0Findings === 0 && variant.p1Findings === 0 && advancedCallsReduced && (usageComplete ? tokenReductionRatio !== null && tokenReductionRatio >= 0.3 : true);
  return { id: pair.id, valid, qualityEquivalent, advancedCallsReduced, tokenReductionRatio, passed, reasons, usageMode };
}

export function evaluatePhase11(pairs: Phase11Pair[]): Phase11Evaluation {
  const results = pairs.map(evaluatePhase11Pair);
  const valid = results.filter((r) => r.valid);
  const successCount = valid.filter((r) => r.passed).length;
  const modes = new Set(valid.map((r) => r.usageMode));
  const usageMode = modes.size === 0 ? "unavailable" : modes.size === 1 ? [...modes][0] : "mixed";
  const status = valid.length < 3 ? "BLOCKED" : successCount === valid.length ? "PASS" : successCount === 0 ? "FAIL" : "PARTIAL";
  return { validCount: valid.length, successCount, reasons: results.flatMap((r) => r.reasons), usageMode, status, pairs: results };
}

export type Phase12Population = "development" | "holdout";
export type Phase12Pair = Phase11Pair & {
  population: Phase12Population;
  /** Whether the variant eventually completed successfully (after the allowed retry). */
  eventualSuccess?: boolean;
  /** Whether the first variant attempt completed successfully. */
  firstAttemptSuccess?: boolean;
  /** Optional authoritative shared planner calls, counted equally in both arms. */
  sharedPlannerCalls?: number;
  /** Human intervention must be symmetric and zero for controlled evidence. */
  humanIntervention?: number;
  routeConsistent?: boolean;
  artifactConsistent?: boolean;
};

export type Phase12PairResult = Phase11PairResult & {
  population: Phase12Population;
  eventualSuccess: boolean;
  firstAttemptSuccess: boolean;
  supportsCostHypothesis: boolean;
  fairHighTierCallReduction: number;
};

export type Phase12Evaluation = {
  validCount: number;
  developmentValidCount: number;
  holdoutValidCount: number;
  holdoutEventualSuccessCount: number;
  holdoutFirstAttemptSuccessCount: number;
  averageFairHighTierCallReduction: number | null;
  usageMode: "complete-token" | "call-count-fallback" | "mixed" | "unavailable";
  status: "PASS" | "PARTIAL" | "FAIL" | "BLOCKED";
  reasons: string[];
  pairs: Phase12PairResult[];
};

/** Phase 1.2 population gate. Runtime/evidence failures are invalid; task quality failures remain valid. */
export function evaluatePhase12Pair(pair: Phase12Pair): Phase12PairResult {
  const result = evaluatePhase11Pair(pair);
  const reasons = [...result.reasons];
  const invalid = (condition: boolean, reason: string) => { if (condition && !reasons.includes(reason)) reasons.push(reason); };
  invalid(pair.routeConsistent === false, "ROUTE_INCONSISTENT");
  invalid(pair.artifactConsistent === false, "ARTIFACT_INCONSISTENT");
  invalid(pair.humanIntervention !== undefined && pair.humanIntervention !== 0, "HUMAN_INTERVENTION");
  // Phase 1.1 already separates structural/runtime validity from task quality.
  // Quality and cost reasons must remain valid negative evidence.
  const valid = result.valid && !reasons.some((reason) => ["ROUTE_INCONSISTENT", "ARTIFACT_INCONSISTENT", "HUMAN_INTERVENTION"].includes(reason));
  const eventualSuccess = pair.eventualSuccess ?? result.qualityEquivalent;
  const firstAttemptSuccess = pair.firstAttemptSuccess ?? eventualSuccess;
  const fairHighTierCallReduction = pair.baseline.metrics.highTierCalls - pair.variant.metrics.highTierCalls;
  const supportsCostHypothesis = valid && pair.variant.metrics.escalationCount === 0 && fairHighTierCallReduction >= 1 && result.qualityEquivalent;
  if (pair.variant.metrics.escalationCount > 0) reasons.push("ESCALATION_UNSUPPORTED_COST_HYPOTHESIS");
  if (!eventualSuccess) reasons.push("QUALITY_REGRESSION");
  return { ...result, valid, reasons, population: pair.population, eventualSuccess, firstAttemptSuccess, supportsCostHypothesis, fairHighTierCallReduction, passed: valid && eventualSuccess && supportsCostHypothesis };
}

export function evaluatePhase12(pairs: Phase12Pair[]): Phase12Evaluation {
  const results = pairs.map(evaluatePhase12Pair);
  const valid = results.filter((r) => r.valid);
  const developmentValidCount = valid.filter((r) => r.population === "development").length;
  const holdouts = valid.filter((r) => r.population === "holdout");
  const eventual = holdouts.filter((r) => r.eventualSuccess).length;
  const first = holdouts.filter((r) => r.firstAttemptSuccess).length;
  // The mean must include every valid, quality-equivalent eventual success.
  // Do not select only pairs that already meet the per-pair reduction target.
  const comparable = holdouts.filter((r) => r.eventualSuccess && r.qualityEquivalent);
  const qualified = comparable.filter((r) => r.supportsCostHypothesis);
  const average = comparable.length ? comparable.reduce((sum, r) => sum + r.fairHighTierCallReduction, 0) / comparable.length : null;
  const modes = new Set(valid.map((r) => r.usageMode));
  const usageMode = modes.size === 0 ? "unavailable" : modes.size === 1 ? [...modes][0] : "mixed";
  const reasons = results.flatMap((r) => r.reasons);
  if (valid.length < 10 || holdouts.length < 6) reasons.push("INSUFFICIENT_VALID_POPULATION");
  const minimumMet = valid.length >= 10 && holdouts.length >= 6;
  const pass = minimumMet && eventual === 6 && first >= 4 && average !== null && average >= 1 && holdouts.every((r) => r.eventualSuccess);
  const hardFailure = reasons.includes("GATE_BYPASS") || reasons.includes("CRITICAL_SAFETY_INVARIANT");
  const status = !minimumMet ? "BLOCKED" : pass ? "PASS" : hardFailure || qualified.length === 0 ? "FAIL" : "PARTIAL";
  return { validCount: valid.length, developmentValidCount, holdoutValidCount: holdouts.length, holdoutEventualSuccessCount: eventual, holdoutFirstAttemptSuccessCount: first, averageFairHighTierCallReduction: average, usageMode, status, reasons, pairs: results };
}
