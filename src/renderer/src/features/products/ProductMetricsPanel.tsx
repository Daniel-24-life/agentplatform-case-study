import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ProductMetrics, ProductResult } from "../../../../shared/contracts/products.js";
import { Button, InlineError, StatusBadge } from "../../ui/index.js";
import "./ProductMetricsPanel.css";

const unwrap = <T,>(result: ProductResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const numberText = (value: number | null): string => value === null ? "未知" : value.toLocaleString();
const rateText = (value: number | null): string => value === null ? "未知" : `${Math.round(value * 100)}%`;
const durationText = (value: number | null): string => {
  if (value === null) return "未知";
  if (value < 1000) return `${value.toLocaleString()} 毫秒`;
  return `${Math.round(value / 1000).toLocaleString()} 秒`;
};

export const ProductMetricsPanel = ({ productId, disabled = false }: { productId: string; disabled?: boolean }): React.JSX.Element => {
  const [metrics, setMetrics] = useState<ProductMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++generation.current;
    setLoading(true); setError(null);
    try {
      const next = unwrap(await window.platform.products.getMetrics({ productId }));
      if (token === generation.current) setMetrics(next);
    } catch (value) {
      if (token === generation.current) setError(value instanceof Error ? value.message : String(value));
    } finally { if (token === generation.current) setLoading(false); }
  }, [productId]);
  useEffect(() => {
    setMetrics(null); void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  return <section className="product-metrics-panel" aria-label="产品历史运行指标">
    <div className="section-heading"><h3>历史运行指标</h3><StatusBadge>只读</StatusBadge></div>
    <p className="product-help">统计当前产品关联的全部历史任务，不替代当前计划进度。</p>
    {loading && !metrics && <p role="status">读取指标中…</p>}
    {metrics && <>
      <div className="product-metrics-grid">
        <div><span>技术完成率</span><strong>{rateText(metrics.technicalCompletionRate)}</strong><small>{metrics.passedTaskCount} / {metrics.taskCount} 个关联任务</small></div>
        <div><span>执行尝试</span><strong>{metrics.attemptCount}</strong><small>返修 {metrics.repairAttemptCount} · 失败 {metrics.failedAttemptCount}</small></div>
        <div><span>已记录运行时长</span><strong>{durationText(metrics.recordedDurationMs)}</strong><small>{metrics.durationAvailableRuns} / {metrics.runCount} 次有时长记录</small></div>
        <div><span>运行记录</span><strong>{metrics.runCount}</strong><small>AgentRun {metrics.agentRunCount}</small></div>
      </div>
      <div className="product-metrics-confirmations"><h4>关键确认记录</h4><p>记录确认事实，不代表全部人工干预。</p><ul><li>方向 {metrics.directionConfirmations}</li><li>计划 {metrics.planConfirmations}</li><li>规范 {metrics.specApprovals}</li><li>升级 {metrics.escalationApprovals}</li><li>合计 {metrics.keyConfirmationCount}</li></ul></div>
      <div className="product-metrics-usage"><h4>已报告 token</h4><p>时长为运行累计（含平台测试）；usage 统计关联任务的 Agent 已报告字段，缺失为未知，各字段独立累计。</p><p>usage 覆盖率：{rateText(metrics.usageCoverage)}（{metrics.usageAvailableRuns} / {metrics.agentRunCount} 个 AgentRun）</p><dl><dt>输入</dt><dd>{numberText(metrics.inputTokens)}</dd><dt>输出</dt><dd>{numberText(metrics.outputTokens)}</dd><dt>总量（报告值）</dt><dd>{numberText(metrics.totalTokens)}</dd></dl></div>
    </>}
    {error && <InlineError>{error}</InlineError>}
    <Button variant="secondary" disabled={disabled || loading} onClick={() => void refresh()}>刷新指标</Button>
  </section>;
};
