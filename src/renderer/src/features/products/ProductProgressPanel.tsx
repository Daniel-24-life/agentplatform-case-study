import React, { useEffect, useRef, useState } from "react";
import type { ProductOverview } from "../../../../shared/contracts/products.js";
import type { ProductProgressSnapshot } from "./product-progress.js";
import { getProductProgress } from "./product-progress.js";
import { Button, StatusBadge } from "../../ui/index.js";
import "./ProductProgressPanel.css";

type Props = {
  overview: ProductOverview;
  dirty: boolean;
  disabled: boolean;
  onOpenTask: (_taskId: string) => void;
  onOpenRuntime: () => void;
  refreshRevision?: number;
};

const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const specHash = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), item => item.toString(16).padStart(2, "0")).join("");
};

export const ProductProgressPanel = ({
  overview, dirty, disabled, onOpenTask, onOpenRuntime, refreshRevision = 0
}: Props): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<ProductProgressSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<{ productId: string; taskId: string } | null>(null);
  const generation = useRef(0);
  const refreshRef = useRef<() => Promise<void>>();
  const overviewRef = useRef(overview);
  overviewRef.current = overview;

  const refresh = async (): Promise<void> => {
    const token = ++generation.current;
    const expected = overviewRef.current;
    const input = { productId: expected.product.id };
    setError(null);
    setSnapshot(null);
    try {
      const [currentOverview, plan, execution, run, delivery, runtime, planning] = await Promise.all([
        window.platform.products.getOverview(input),
        window.platform.productPlans.getState(input),
        window.platform.productExecution.getState(input),
        window.platform.productRuns.getState(input),
        window.platform.productDeliveries.getState(input),
        window.platform.runtime.status(),
        window.platform.productPlanning.getState(input)
      ]);
      const value = unwrap(currentOverview);
      if (value.product.revision !== expected.product.revision ||
          value.goal.revision !== expected.goal.revision || value.goal.hash !== expected.goal.hash) {
        throw new Error("产品总览已变化，请重新选择当前产品");
      }
      const executionValue = unwrap(execution);
      const task = executionValue.link ? await window.platform.tasks.get(executionValue.link.taskId) : null;
      const hash = task?.specJson ? await specHash(task.specJson) : null;
      if (token !== generation.current) return;
      setSubscription(task ? { productId: value.product.id, taskId: task.id } : null);
      setSnapshot({
        overview: value, plan: unwrap(plan), execution: executionValue, task,
        specHash: hash, run: unwrap(run), delivery: unwrap(delivery), runtime,
        planningAvailable: unwrap(planning).available
      });
    } catch (value) {
      if (token === generation.current) setError(value instanceof Error ? value.message : String(value));
    }
  };
  refreshRef.current = refresh;

  useEffect(() => {
    void refreshRef.current?.();
    return () => { generation.current += 1; };
  }, [overview.product.id, overview.product.revision, refreshRevision]);

  // Preload replays history on each subscription. Keep the subscription stable
  // while refreshing the snapshot, so replayed events cannot cause a refresh loop.
  const taskId = subscription?.productId === overview.product.id ? subscription.taskId : null;
  useEffect(() => {
    if (!taskId) return undefined;
    let cursor = 0;
    let timer: number | undefined;
    let active = true;
    const off = window.platform.events.subscribe(taskId, event => {
      if (!active || event.taskId !== taskId || event.sequence <= cursor) return;
      cursor = event.sequence;
      if (!["STATUS_CHANGED", "RUN_FINISHED", "RUN_CLASSIFIED"].includes(event.type)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshRef.current?.(), 80);
    });
    return () => {
      active = false;
      window.clearTimeout(timer);
      off();
    };
  }, [taskId]);

  const current = snapshot?.overview.product.id === overview.product.id &&
    snapshot.overview.product.revision === overview.product.revision ? snapshot : null;
  const progress = current ? getProductProgress(current, dirty) : null;
  const navigate = (): void => {
    if (!progress || !current) return;
    if (progress.action === "task" && current.task) return onOpenTask(current.task.id);
    if (progress.action === "runtime") return onOpenRuntime();
    const selectors = {
      goal: ".product-goal-form", plan: ".product-plan-panel", repository: ".product-execution-panel",
      run: ".product-run-panel", delivery: ".product-delivery-panel", task: ".product-execution-panel"
    };
    document.querySelector(selectors[progress.action])?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const badge = error ? "读取失败" : progress?.tone === "success" ? "已接受未发布" : progress ? "当前阶段" : "读取中";

  return (
    <section className="product-progress-panel" aria-label="产品推进总览">
      <div className="product-progress-heading">
        <div>
          <span className="eyebrow">当前产品进展</span>
          <h3>{progress?.title ?? (error ? "无法判断当前进展" : "正在读取当前进展")}</h3>
          <p className="product-progress-description">{progress?.description ?? (error ? "请核对读取错误后刷新。" : "正在读取最新状态…")}</p>
        </div>
        <StatusBadge tone={error ? "danger" : progress?.tone ?? "neutral"}>{badge}</StatusBadge>
      </div>
      {error && <p className="product-progress-error" role="alert">无法判断：{error}</p>}
      <div className="product-actions">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void refresh()}>刷新产品进展</Button>
        {progress && <Button size="sm" disabled={disabled} onClick={navigate}>{progress.actionLabel}</Button>}
      </div>
      {progress && <ul className="product-progress-milestones">
        {progress.milestones.map(item => <li key={item.label} data-complete={item.complete}>
          {item.complete ? "✓ " : "○ "}{item.label}
        </li>)}
      </ul>}
      {current && !current.planningAvailable && <p className="product-help">
        主 Agent 规划提案当前未获得资格；可继续手动编辑计划、绑定仓库和推进已有流程。
      </p>}
    </section>
  );
};
