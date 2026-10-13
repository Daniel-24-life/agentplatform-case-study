import React, { useEffect, useRef, useState } from "react";
import type { ProductOverview } from "../../../../shared/contracts/products.js";
import type { ProductPlanState } from "../../../../shared/contracts/product-plan.js";
import type { ProductExecutionState } from "../../../../shared/contracts/product-execution.js";
import type { ProjectRecord } from "../../../../shared/contracts/records.js";
import { Button, InlineError, StatusBadge } from "../../ui/index.js";
import "./ProductExecutionPanel.css";

export type ProductExecutionPanelProps = {
  overview: ProductOverview;
  disabled: boolean;
  dirty: boolean;
  onOpenTask: (_taskId: string) => void;
  onProductChanged?: () => void;
};

export const canCreateProductTask = (state: ProductExecutionState | null, plan: ProductPlanState | null, dirty: boolean): boolean =>
  !dirty && Boolean(state?.repositoryId && plan?.saved?.confirmedAt && plan.current && plan.saved.revision === state.planRevision && state.planCurrent && state.planConfirmed && !state.link);

const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);

export const ProductExecutionPanel = ({ overview, disabled, dirty, onOpenTask, onProductChanged }: ProductExecutionPanelProps): React.JSX.Element => {
  const productId = overview.product.id;
  const [state, setState] = useState<ProductExecutionState | null>(null);
  const [plan, setPlan] = useState<ProductPlanState | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedRepository, setSelectedRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bindRequestId = useRef(crypto.randomUUID());
  const createRequestId = useRef(crypto.randomUUID());
  const generation = useRef(0);

  const refresh = async (token = generation.current): Promise<void> => {
    const [nextState, nextPlan] = await Promise.all([
      window.platform.productExecution.getState({ productId }),
      window.platform.productPlans.getState({ productId })
    ]);
    if (token !== generation.current) return;
    setState(unwrap(nextState));
    setPlan(unwrap(nextPlan));
  };

  useEffect(() => {
    const token = ++generation.current;
    bindRequestId.current = crypto.randomUUID();
    createRequestId.current = crypto.randomUUID();
    setState(null); setPlan(null); setError(null); setSelectedRepository("");
    let active = true;
    void Promise.all([window.platform.projects.list(), refresh(token)]).then(([items]) => {
      if (active) setProjects(items);
    }).catch(value => { if (active && token === generation.current) setError(errorText(value)); });
    return () => { active = false; generation.current++; };
  }, [productId, overview.goal.revision, overview.goal.hash]);

  const bind = async (): Promise<void> => {
    if (!selectedRepository || !state || state.repositoryId) return;
    setBusy(true); setError(null);
    try {
      const next = unwrap(await window.platform.productExecution.bindRepository({ requestId: bindRequestId.current, productId, expectedRevision: overview.product.revision, repositoryId: selectedRepository }));
      setState(next); bindRequestId.current = crypto.randomUUID();
      onProductChanged?.();
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  };

  const createTask = async (): Promise<void> => {
    if (!state?.planRevision || !canCreateProductTask(state, plan, dirty)) return;
    setBusy(true); setError(null);
    try {
      const link = unwrap(await window.platform.productExecution.createTask({ requestId: createRequestId.current, productId, planRevision: state.planRevision }));
      createRequestId.current = crypto.randomUUID();
      await refresh();
      onOpenTask(link.taskId);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  };

  const bound = Boolean(state?.repositoryId);
  const selected = projects.find(item => item.id === (state?.repositoryId ?? selectedRepository));
  const eligible = canCreateProductTask(state, plan, dirty);
  return <section className="product-execution-panel" aria-label="产品任务执行">
    <div className="section-heading"><h3>进入开发任务</h3><StatusBadge tone={state?.link ? "success" : "neutral"}>{state?.link ? "已有任务" : bound ? "仓库已绑定" : "待绑定仓库"}</StatusBadge></div>
    <p className="product-help">一个计划对应一个完整任务，共用同一工作区；规范批准与执行在任务页完成。</p>
    {state === null ? <p className="product-help">正在读取任务状态…</p> : state.link ? <div className="product-execution-summary"><p>任务已创建：{state.link.taskId}</p><p>状态：{state.taskStatus ?? "DRAFT"}</p><Button onClick={() => onOpenTask(state.link!.taskId)}>打开任务</Button></div> : <>
      {!bound && <div className="product-execution-bind"><label>注册仓库<select value={selectedRepository} disabled={disabled || busy} onChange={event => { setSelectedRepository(event.target.value); bindRequestId.current = crypto.randomUUID(); }}><option value="">请选择仓库</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name} · {item.repoPath}</option>)}</select></label><Button disabled={disabled || busy || dirty || !selectedRepository} onClick={() => void bind()}>绑定仓库</Button></div>}
      {bound && <p className="product-help">工作区：{selected?.repoPath ?? state.repositoryId}</p>}
      <Button disabled={disabled || busy || !eligible} onClick={() => void createTask()}>创建完整计划任务</Button>
      {!eligible && <p className="product-help">请先确认当前计划，并保存产品目标；创建后将生成一个 DRAFT 任务。</p>}
    </>}
    {state?.taskStatus && !state.link && <p className="product-help">任务状态：{state.taskStatus}</p>}
    <Button variant="ghost" disabled={busy} onClick={() => void refresh().catch(value => setError(errorText(value)))}>刷新执行状态</Button>
    {error && <InlineError>{error}</InlineError>}
  </section>;
};
