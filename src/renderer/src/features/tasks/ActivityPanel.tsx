import React, { useEffect, useState } from "react";
import type { EventRecord, RunRecord } from "../../../../shared/contracts/records.js";
import { EmptyState } from "../../ui/index.js";

export type ActivityPanelProps = { events: readonly EventRecord[]; runs: readonly RunRecord[] };

export const ActivityPanel = ({ events, runs }: ActivityPanelProps): React.JSX.Element => {
  const [runId, setRunId] = useState<string | null>(null);
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [cursor, setCursor] = useState(0);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = runs.find(run => run.id === runId);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let busy = false;
    const read = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const window = await globalThis.window.platform.runs.readLogWindow(runId, stream, cursor);
        if (alive) setError(null);
        if (alive && window.nextCursor > cursor) {
          setLog(previous => (previous + window.text).slice(-131072));
          setCursor(window.nextCursor);
        }
      } catch (value) {
        if (alive) setError(value instanceof Error ? value.message : String(value));
      } finally { busy = false; }
    };
    void read();
    const timer = globalThis.setInterval(() => { void read(); }, 800);
    return () => { alive = false; globalThis.clearInterval(timer); };
  }, [runId, stream, cursor]);

  const choose = (id: string, nextStream: "stdout" | "stderr" = stream): void => {
    setRunId(id); setStream(nextStream); setCursor(0); setLog(""); setError(null);
  };

  return <section className="activity-panel">
    <h3>Activity</h3>
    <p>只读分析仅生成待批准规范；构建执行已批准范围，独立审查以平台测试和 Gate 为依据。</p>
    {events.length === 0 && runs.length === 0 ? <EmptyState title="暂无活动记录" description="任务运行后，事件和执行记录会显示在这里。" /> : <>
      <ol aria-label="任务事件">{events.map(event => <li key={event.id}><time>{event.createdAt}</time> <strong>{event.type}</strong> <small>#{event.sequence}</small> <details><summary>查看详情</summary><pre>{event.payloadJson}</pre></details></li>)}</ol>
      <h4>运行日志</h4>
      <ul aria-label="运行列表">{runs.map(run => <li key={run.id}><button type="button" onClick={() => choose(run.id)} aria-pressed={run.id === runId}>{run.stage} · {run.adapter} · {run.status}{run.errorCode ? ` · ${run.errorCode}` : ""}</button></li>)}</ul>
      {selected && <div className="run-log-window">
        <p>{selected.stage} · {selected.adapter} · {selected.id}</p>
        <button type="button" onClick={() => choose(selected.id, "stdout")} aria-pressed={stream === "stdout"}>stdout</button>
        <button type="button" onClick={() => choose(selected.id, "stderr")} aria-pressed={stream === "stderr"}>stderr</button>
        {error && <p role="alert">日志读取失败：{error}</p>}
        <pre aria-label={`${selected.stage} ${stream} 日志`}>{log || "暂无日志"}</pre>
      </div>}
    </>}
  </section>;
};
