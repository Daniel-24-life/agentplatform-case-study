import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ProductExecutionState } from "../../../../shared/contracts/product-execution.js";
import type { ProductRunAction } from "../../../../shared/contracts/product-run.js";
import type { TaskRecord } from "../../../../shared/contracts/records.js";
import { Button, InlineError, StatusBadge } from "../../ui/index.js";
import "./ProductRunPanel.css";

export type ProductRunPanelProps = { productId: string; disabled: boolean; dirty: boolean; onChanged?: () => void };
export type ProductRunEligibility = { eligible: boolean; reason: string | null };

export const eligibleProductRun = (state: ProductExecutionState | null, task: TaskRecord | null, dirty: boolean): ProductRunEligibility => {
  if (dirty) return { eligible: false, reason: "请先保存当前产品修改。" };
  if (!state?.planCurrent || !state.planConfirmed || !state.link) return { eligible: false, reason: "请先确认当前开发计划并关联任务。" };
  if (task?.id === state.link.taskId && task.status === "PASSED") return { eligible: false, reason: "任务已通过，无需重复执行。可继续体验成果和记录产品验收。" };
  if (!task || task.id !== state.link.taskId || !["SPEC_APPROVED", "BUILT", "GATE_READY", "REWORK"].includes(task.status)) return { eligible: false, reason: "关联任务必须处于规范已批准、待有限修复、构建完成或待最终审核状态。" };
  if (!task.specApprovedAt || !task.specJson || (!Number.isSafeInteger(task.specRevision) || task.specRevision < 1)) return { eligible: false, reason: "任务规范尚未批准或缺少有效版本。" };
  return { eligible: true, reason: null };
};

// Display only; Main validates the approved specification and enforces the shared budget.
export const productRunBudget = (task: TaskRecord | null, action: ProductRunAction | null): { limit: number | null; used: number; exhausted: boolean } => {
  const currentAction = action?.taskId === task?.id && action?.specRevision === task?.specRevision ? action : null;
  let approvedLimit: number | null = null;
  try {
    const attempts: unknown = JSON.parse(task?.specJson ?? "null")?.limits?.max_attempts;
    if (typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 1 && attempts <= 3) approvedLimit = attempts * 2;
  } catch { /* Invalid specifications remain subject to Main validation. */ }
  const limit = currentAction?.maxModelCalls ?? approvedLimit;
  const used = currentAction?.usedModelCalls ?? currentAction?.reservedModelCalls ?? 0;
  return { limit, used, exhausted: limit !== null && used >= limit };
};

export const sha256Utf8 = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
};

const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);
const statusLabel: Record<ProductRunAction["status"], string> = { RUNNING: "运行中", PAUSE_REQUESTED: "正在暂停", CANCEL_REQUESTED: "正在取消", PAUSED: "已暂停", CANCELLED: "已取消", SUCCEEDED: "已完成", FAILED: "失败", INTERRUPTED: "已中断" };
const stageLabel = (stage: ProductRunAction["stage"]): string => stage === "build" ? "构建" : stage === "tests" ? "测试" : stage === "review" ? "最终审核" : "准备";

export const ProductRunPanel = ({ productId, disabled, dirty, onChanged }: ProductRunPanelProps): React.JSX.Element => {
  const [execution, setExecution] = useState<ProductExecutionState | null>(null);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [action, setAction] = useState<ProductRunAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const requestId = useRef(crypto.randomUUID());
  const identity = useRef("");

  const refresh = useCallback(async (token = generation.current): Promise<void> => {
    const nextExecution = unwrap(await window.platform.productExecution.getState({ productId }));
    let nextTask: TaskRecord | null = null;
    if (nextExecution.link) nextTask = await window.platform.tasks.get(nextExecution.link.taskId);
    const nextAction = unwrap(await window.platform.productRuns.getState({ productId }));
    if (token !== generation.current) return;
    setExecution(nextExecution); setTask(nextTask); setAction(nextAction);
  }, [productId]);

  useEffect(() => {
    const token = ++generation.current;
    requestId.current = crypto.randomUUID(); identity.current = "";
    setExecution(null); setTask(null); setAction(null); setError(null);
    let active = true;
    void refresh(token).catch(value => { if (active && token === generation.current) setError(errorText(value)); });
    let unsubscribe: (() => void) | undefined;
    void window.platform.productExecution.getState({ productId }).then(value => {
      const state = unwrap(value);
      if (active && state.link) unsubscribe = window.platform.events.subscribe(state.link.taskId, () => { void refresh(token).catch(() => undefined); });
    }).catch(() => undefined);
    return () => { active = false; generation.current++; unsubscribe?.(); };
  }, [productId, refresh]);

  const start = async (): Promise<void> => {
    if (!execution?.link || !task || !eligibleProductRun(execution, task, dirty).eligible) return;
    setBusy(true); setError(null);
    try {
      const hash = await sha256Utf8(task.specJson!);
      const nextIdentity = `${productId}:${execution.link.planRevision}:${task.id}:${task.specRevision}:${hash}`;
      if (identity.current !== nextIdentity) { identity.current = nextIdentity; requestId.current = crypto.randomUUID(); }
      const result = await window.platform.productRuns.start({ requestId: requestId.current, productId, planRevision: execution.link.planRevision, taskId: task.id, specRevision: task.specRevision, specHash: hash });
      setAction(unwrap(result));
      requestId.current = crypto.randomUUID();
      await refresh(); onChanged?.();
    } catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  const control = async (kind: "pause" | "cancel"): Promise<void> => {
    if (!action) return;
    setBusy(true); setError(null);
    try { setAction(unwrap(await window.platform.productRuns[kind]({ productId, actionId: action.id }))); await refresh(); onChanged?.(); }
    catch (value) { setError(errorText(value)); } finally { setBusy(false); }
  };
  const eligibility = eligibleProductRun(execution, task, dirty);
  const budget = productRunBudget(task, action);
  const active = action && ["RUNNING", "PAUSE_REQUESTED", "CANCEL_REQUESTED"].includes(action.status);
  return <section className="product-run-panel" aria-label="执行已批准计划">
    <div className="section-heading"><h3>执行已批准计划</h3><StatusBadge tone={action?.status === "SUCCEEDED" ? "success" : action?.status === "FAILED" || action?.status === "INTERRUPTED" ? "danger" : "neutral"}>{action ? statusLabel[action.status] : "未开始"}</StatusBadge></div>
    <p className="product-help">执行固定的已批准规范，仅对测试或审查要求的工程修复继续下一次尝试。额度、认证、环境或硬 Gate 失败会停止；暂停等待当前阶段收敛，取消请求停止。</p>
    {budget.limit !== null && <p className="product-help">同一批准规范共享预算：已占用 {budget.used} / {budget.limit} 次模型调用（含预留）；重新开始不会重置。{budget.exhausted ? "预算已耗尽。" : ""}</p>}
    {!task && <p className="product-help">尚无当前计划任务；创建后可刷新。</p>}
    {task && <p className="product-help">任务：{task.title} · 规范 v{task.specRevision} · {task.status}</p>}
    {action && <p className="product-run-stage" role="status">阶段：{stageLabel(action.stage)} · 状态：{statusLabel[action.status]}{action.status === "INTERRUPTED" ? "。应用不会自动重跑；请先核对任务与运行状态，再授权剩余阶段。" : ""}</p>}
    {active ? <div className="product-run-actions"><Button disabled={disabled || busy || action.status !== "RUNNING"} onClick={() => void control("pause")}>暂停当前阶段</Button><Button variant="secondary" disabled={disabled || busy} onClick={() => void control("cancel")}>取消当前运行</Button></div> : <Button disabled={disabled || busy || !eligibility.eligible || budget.exhausted} onClick={() => void start()}>开始执行</Button>}
    {!eligibility.eligible && <p className="product-help">{eligibility.reason}</p>}
    {error && <InlineError>{error}</InlineError>}
    <Button variant="ghost" disabled={busy} onClick={() => void refresh().catch(value => setError(errorText(value)))}>刷新执行状态</Button>
  </section>;
};
