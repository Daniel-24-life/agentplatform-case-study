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
    <div className="product-metrics-scope" role="note">
      <strong>统计口径：关联任务的技术运行</strong>
      <p>统计当前产品关联的全部历史任务。通过率只反映任务技术状态，不代表产品目标完成、业务验收或当前计划进度。</p>
    </div>
    {loading && !metrics && <p role="status">读取指标中…</p>}
    {metrics && <>
      <div className="product-metrics-grid">
        <div><span>任务技术通过率</span><strong>{rateText(metrics.technicalCompletionRate)}</strong><small>{metrics.passedTaskCount} / {metrics.taskCount} 个关联任务通过</small></div>
        <div><span>执行尝试</span><strong>{metrics.attemptCount}</strong><small>返修 {metrics.repairAttemptCount} · 失败 {metrics.failedAttemptCount}</small></div>
        <div><span>已记录运行时长</span><strong>{durationText(metrics.recordedDurationMs)}</strong><small>{metrics.durationAvailableRuns} / {metrics.runCount} 次运行有时长记录</small></div>
        <div><span>运行记录</span><strong>{metrics.runCount}</strong><small>其中 AgentRun {metrics.agentRunCount} 次</small></div>
      </div>
      <div className="product-metrics-details">
        <div className="product-metrics-confirmations"><h4>关键确认记录</h4><p>只统计已记录的确认，不代表全部人工干预。</p><dl><div><dt>方向</dt><dd>{metrics.directionConfirmations}</dd></div><div><dt>计划</dt><dd>{metrics.planConfirmations}</dd></div><div><dt>规范</dt><dd>{metrics.specApprovals}</dd></div><div><dt>升级</dt><dd>{metrics.escalationApprovals}</dd></div><div className="product-metrics-total"><dt>合计</dt><dd>{metrics.keyConfirmationCount}</dd></div></dl></div>
        <div className="product-metrics-usage"><h4>已报告 token</h4><p className="product-metrics-coverage">有 usage 记录：<strong>{metrics.usageAvailableRuns} / {metrics.agentRunCount} 次 AgentRun</strong>（{rateText(metrics.usageCoverage)}）</p><dl><div><dt>输入</dt><dd>{numberText(metrics.inputTokens)}</dd></div><div><dt>输出</dt><dd>{numberText(metrics.outputTokens)}</dd></div><div><dt>总量（报告值）</dt><dd>{numberText(metrics.totalTokens)}</dd></div></dl><p>缺失的 usage 为未知，各字段独立累计；运行时长包含平台测试。</p></div>
      </div>
    </>}
    {error && <InlineError>{error}</InlineError>}
    <Button variant="secondary" disabled={disabled || loading} onClick={() => void refresh()}>刷新指标</Button>
  </section>;
};
