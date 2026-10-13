const fields = ["inputTokens", "outputTokens", "totalTokens"] as const;
type UsageField = typeof fields[number];
export type UsageSummary = { availableRuns: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
const validTokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Each reported field has its own availability; missing totals are never inferred. */
export function summarizeRunUsage(values: Array<string | null>): UsageSummary {
  const totals: Record<UsageField, number | null> = { inputTokens: null, outputTokens: null, totalTokens: null };
  const overflowed: Record<UsageField, boolean> = { inputTokens: false, outputTokens: false, totalTokens: false };
  let availableRuns = 0;
  for (const raw of values) {
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const usage = parsed as Record<string, unknown>;
    if (!fields.some(field => validTokenCount(usage[field]))) continue;
    availableRuns++;
    for (const field of fields) {
      const value = usage[field];
      if (!validTokenCount(value) || overflowed[field]) continue;
      const current = totals[field] ?? 0;
      if (current > Number.MAX_SAFE_INTEGER - value) {
        overflowed[field] = true;
        totals[field] = null;
      } else totals[field] = current + value;
    }
  }
  return { availableRuns, ...totals };
}
