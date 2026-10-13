import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AcceptanceCriterion } from "../../../../shared/contracts/products.js";
import type { ProductDelivery, ProductCriterionReview } from "../../../../shared/contracts/product-delivery.js";
import type { ProductPlanState } from "../../../../shared/contracts/product-plan.js";
import type { ProductExecutionState } from "../../../../shared/contracts/product-execution.js";
import type { TaskDetailRecord } from "../../../../shared/contracts/records.js";
import { Button, InlineError, StatusBadge } from "../../ui/index.js";
import "./ProductDeliveryPanel.css";

export type ProductDeliveryPanelProps = { productId: string; goalRevision: number; onChanged?: () => void };
const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);
const taskCriteria = (detail: TaskDetailRecord | null): string[] => detail?.snapshot?.final?.criteria.filter(item => item.status === "satisfied").map(item => item.criterion_id) ?? [];

const taskCriterionDescriptions = (detail: TaskDetailRecord | null): Record<string, string> => {
  try {
    const spec = JSON.parse(detail?.task.specJson ?? '{}') as { acceptance_criteria?: Array<{id: string; text: string}> };
    return Object.fromEntries((spec.acceptance_criteria ?? []).map(criterion => [criterion.id, criterion.text]));
  } catch { return {}; }
};

export const ProductDeliveryPanel = ({ productId, goalRevision, onChanged }: ProductDeliveryPanelProps): React.JSX.Element => {
  const [execution, setExecution] = useState<ProductExecutionState | null>(null);
  const [plan, setPlan] = useState<ProductPlanState | null>(null);
  const [detail, setDetail] = useState<TaskDetailRecord | null>(null);
  const [latest, setLatest] = useState<ProductDelivery | null>(null);
  const [current, setCurrent] = useState(true);
  const [criteria, setCriteria] = useState<AcceptanceCriterion[]>([]);
  const [reviews, setReviews] = useState<Record<string, ProductCriterionReview>>({});
  const [runInstructions, setRunInstructions] = useState("");
  const [limitations, setLimitations] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const requestId = useRef(crypto.randomUUID());

  const refresh = useCallback(async (token = generation.current): Promise<void> => {
    const [overview, nextExecution, nextPlan, nextState] = await Promise.all([
      window.platform.products.getOverview({ productId }), window.platform.productExecution.getState({ productId }),
      window.platform.productPlans.getState({ productId }), window.platform.productDeliveries.getState({ productId })
    ]);
    const nextExecutionValue = unwrap(nextExecution); const nextPlanValue = unwrap(nextPlan);
    const link = nextExecutionValue.link;
    const nextDetail = link ? await window.platform.tasks.detail(link.taskId) : null;
    if (token !== generation.current) return;
    const goal = unwrap(overview).goal.goal.acceptanceCriteria;
    const deliveryState = unwrap(nextState);
    setExecution(nextExecutionValue);
    setPlan(nextPlanValue);
    setDetail(nextDetail);
    setLatest(deliveryState.latest);
    setCurrent(deliveryState.current);
    setCriteria(goal);
    setRunInstructions("");
    setLimitations("");
    setReviews(Object.fromEntries(goal.map(item => [item.id, { criterionId: item.id, accepted: false, taskCriterionIds: [], note: "" }] )));
  }, [productId]);

  useEffect(() => { const token = ++generation.current; requestId.current = crypto.randomUUID(); setError(null); void refresh(token).catch(value => { if (token === generation.current) setError(errorText(value)); }); return () => { generation.current++; }; }, [goalRevision, refresh]);

  const save = async (): Promise<void> => {
    const token = generation.current;
    if (!execution?.link || !plan?.saved || !detail?.attempt || detail.task.status !== "PASSED" || !detail.snapshot) return;
    setBusy(true); setError(null);
    try {
      const result = await window.platform.productDeliveries.create({ requestId: requestId.current, productId, planRevision: plan.saved.revision, taskId: detail.task.id, attemptId: detail.attempt.id, reviews: criteria.map(item => reviews[item.id]), runInstructions, limitations });
      if (token === generation.current) { setLatest(unwrap(result)); setCurrent(true); requestId.current = crypto.randomUUID(); onChanged?.(); }
    } catch (value) { if (token === generation.current) setError(errorText(value)); } finally { if (token === generation.current) setBusy(false); }
  };
  const taskIds = taskCriteria(detail);
  const taskDescriptions = taskCriterionDescriptions(detail);
  const valid = Boolean(execution?.link && plan?.saved?.confirmedAt && plan.current && execution.planConfirmed && execution.link.taskId === detail?.task.id && detail.task.status === "PASSED" && detail.snapshot?.final?.verdict === "PASS" && detail.attempt);
  const expired = latest && (!current || !plan?.current || latest.goalRevision !== goalRevision);
  return <section className="product-delivery-panel" aria-label="产品验收与交付">
    <div className="section-heading"><h3>验收与未发布交付</h3><StatusBadge tone={latest?.status === "ACCEPTED_UNPUBLISHED" ? "success" : "neutral"}>{latest ? (latest.status === "ACCEPTED_UNPUBLISHED" ? "已接受，未发布" : "需要业务复核") : "未记录"}</StatusBadge></div>
    <p className="product-help">只引用已通过任务的冻结证据；保存不会运行、发布或启动模型。</p>
    {!valid && <p className="product-help">需要当前计划关联的 PASSED 任务及完整证据后才能保存。</p>}
    <div className="product-delivery-grid">
      <fieldset><legend>产品验收标准</legend>{criteria.length ? criteria.map(item => <label className="product-delivery-check" key={item.id}><input type="checkbox" checked={reviews[item.id]?.accepted ?? false} onChange={event => setReviews(current => ({ ...current, [item.id]: { ...current[item.id], accepted: event.target.checked } }))} /><span>{item.description}<small>{item.required ? "必需" : "可选"} · 业务判断</small></span></label>) : <span>当前目标没有验收标准。</span>}</fieldset>
      <fieldset><legend>关联任务 AC</legend>{criteria.map(item => <div key={item.id}><span>{item.description}</span>{taskIds.map(taskId => <label className="product-delivery-check" key={taskId}><input type="checkbox" checked={reviews[item.id]?.taskCriterionIds.includes(taskId) ?? false} onChange={event => setReviews(current => { const old = current[item.id]; const ids = event.target.checked ? [...old.taskCriterionIds, taskId] : old.taskCriterionIds.filter(id => id !== taskId); return { ...current, [item.id]: { ...old, taskCriterionIds: ids } }; })} /><span>{taskId} · {taskDescriptions[taskId]}</span></label>)}<textarea maxLength={4000} aria-label={`观察说明：${item.description}`} placeholder="观察说明" value={reviews[item.id]?.note ?? ""} onChange={event => setReviews(current => ({ ...current, [item.id]: { ...current[item.id], note: event.target.value } }))} /></div>)}</fieldset>
    </div>
    <label>运行说明<textarea maxLength={8000} value={runInstructions} onChange={event => setRunInstructions(event.target.value)} /></label>
    <label>已知限制<textarea maxLength={8000} value={limitations} onChange={event => setLimitations(event.target.value)} /></label>
    <div className="product-actions"><Button disabled={busy || !valid} onClick={() => void save()}>保存验收与交付记录</Button><Button variant="ghost" disabled={busy} onClick={() => void refresh().catch(value => setError(errorText(value)))}>刷新交付记录</Button></div>
    {latest && <><p className="product-help">技术证据：PASSED · 业务判定：{latest.status === "ACCEPTED_UNPUBLISHED" ? "已接受，未发布" : "需要业务复核"} · 预览：未运行 · 发布：未运行{expired ? " · 当前记录已过期，请基于当前计划重新验收。" : ""}</p><dl className="product-delivery-evidence"><dt>分支 / worktree</dt><dd>{latest.evidence.branch} · {latest.evidence.worktreePath}</dd><dt>任务 / Attempt</dt><dd>{latest.evidence.taskId} · {latest.evidence.attemptId}</dd><dt>Git HEAD</dt><dd>{latest.evidence.head}</dd><dt>冻结验收说明</dt><dd>{latest.reviews.map(review => `${latest.criteria.find(criterion => criterion.id === review.criterionId)?.description ?? review.criterionId}: ${review.accepted ? "已接受" : "待复核"} · ${review.note}`).join("；")}</dd><dt>运行说明 / 限制</dt><dd>{latest.runInstructions || "未填写"} / {latest.limitations || "未填写"}</dd></dl></>}
    {error && <InlineError>{error}</InlineError>}
  </section>;
};
