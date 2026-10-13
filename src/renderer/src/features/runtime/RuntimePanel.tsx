import React from "react";
import type { RuntimePreflightSummary } from "../../../../preload/types.js";
import { Button, InlineError, Spinner, StatusBadge } from "../../ui/index.js";

export type RuntimePanelProps = {
  summary: RuntimePreflightSummary | null;
  doctor?: RuntimePreflightSummary | null;
  loading?: boolean;
  doctorLoading?: boolean;
  error?: string | null;
  onRunPreflight?: () => void;
  onRunDoctor?: () => void;
};

export const RuntimePanel = ({ summary, doctor = null, loading = false, doctorLoading = false, error, onRunPreflight, onRunDoctor }: RuntimePanelProps): React.JSX.Element => {
  const state = loading ? "探针运行中" : summary === null ? "探针未运行" : summary.passed ? "探针 PASS" : "探针 BLOCKED";
  return (
    <section aria-labelledby="runtime-heading" className="runtime-panel">
      <div className="section-heading"><h2 id="runtime-heading">Runtime</h2><StatusBadge tone={state === "探针 PASS" ? "success" : state === "探针 BLOCKED" ? "danger" : state === "探针运行中" ? "warning" : "neutral"} aria-label={`模型资格状态：${state}`}>{state}</StatusBadge></div>
      <p>先运行零额度诊断，只检查 Codex CLI 版本和登录状态。模型资格探针会向每个配置模型发送短请求并消耗账户额度；它不能证明长任务稳定。</p>
      {onRunDoctor && <Button type="button" variant="secondary" onClick={onRunDoctor} loading={doctorLoading}>{doctorLoading ? "诊断中…" : "运行零额度 CLI 诊断"}</Button>}
      {doctor && <p role="status">CLI 诊断：{doctor.passed ? "PASS" : `BLOCKED · ${doctor.failure?.code ?? "UNKNOWN"}`}（{doctor.steps.map(step => step.id).join("、")}）</p>}
      {error && <InlineError>Runtime 检查失败：{error}</InlineError>}
      {summary?.failure && <InlineError>{summary.failure.code}：{summary.failure.diagnosticSummary}</InlineError>}
      {loading && <Spinner label="Runtime preflight 检查中" />}
      {!loading && summary === null && <p role="status">尚未执行 Runtime preflight。</p>}
      {summary && (
        <ol aria-label="Runtime preflight 步骤">
          {summary.steps.map((step) => <li key={step.id}><span>{step.id}</span> <span>{step.status}</span> <small>{step.durationMs}ms</small></li>)}
        </ol>
      )}
      {onRunPreflight && <Button type="button" onClick={onRunPreflight} loading={loading}>{loading ? "探针运行中…" : "运行模型资格探针（消耗额度）"}</Button>}
    </section>
  );
};
