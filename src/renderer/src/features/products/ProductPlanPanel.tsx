import React, { useEffect, useRef, useState } from "react";
import type { ProductOverview } from "../../../../shared/contracts/products.js";
import type { ProductPlan, ProductPlanState, ProductPlanResult, ProductWorkItem } from "../../../../shared/contracts/product-plan.js";
import { Button, InlineError, StatusBadge } from "../../ui/index.js";
import "./ProductPlanPanel.css";

type ProductPlanPanelProps = { overview: ProductOverview; disabled: boolean; dirty: boolean; proposedPlan?: ProductPlan | null; onChanged?: () => void };
const unwrap = <T,>(result: ProductPlanResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);

export const createProductPlanDraft = (overview: ProductOverview): ProductPlan => ({
  schemaVersion: "1.0", productId: overview.product.id, goalRevision: overview.goal.revision, goalHash: overview.goal.hash,
  summary: overview.goal.goal.goal,
  workItems: [{
    id: "w1", title: "完成当前产品方向的核心工作", objective: overview.goal.goal.goal,
    deliverable: overview.goal.goal.scope,
    acceptanceCriterionIds: overview.goal.goal.acceptanceCriteria.filter(item => item.required).map(item => item.id),
    dependsOn: []
  }]
});

export function removeProductWorkItem(plan: ProductPlan, id: string): ProductPlan {
  return { ...plan, workItems: plan.workItems.filter(item => item.id !== id).map(item => ({
    ...item, dependsOn: item.dependsOn.filter(dependency => dependency !== id)
  })) };
}

export function sameProductPlan(left: ProductPlan, right: ProductPlan): boolean {
  if (left.productId !== right.productId || left.goalRevision !== right.goalRevision || left.goalHash !== right.goalHash ||
      left.summary !== right.summary || left.workItems.length !== right.workItems.length) return false;
  return left.workItems.every((item, index) => {
    const other = right.workItems[index]!;
    return item.id === other.id && item.title === other.title && item.objective === other.objective && item.deliverable === other.deliverable &&
      JSON.stringify(item.acceptanceCriterionIds) === JSON.stringify(other.acceptanceCriterionIds) && JSON.stringify(item.dependsOn) === JSON.stringify(other.dependsOn);
  });
}

export const ProductPlanPreview = ({ plan }: { plan: ProductPlan }): React.JSX.Element => (
  <div className="product-plan-preview">
    <p>{plan.summary}</p>
    {plan.workItems.map(item => <article key={item.id}>
      <h4>{item.title}</h4><p>目标：{item.objective}</p><p>交付物：{item.deliverable}</p>
      <p>依赖：{item.dependsOn.length ? item.dependsOn.join("、") : "无"}</p>
    </article>)}
  </div>
);

export const ProductPlanPanel = ({ overview, disabled, dirty, proposedPlan, onChanged }: ProductPlanPanelProps): React.JSX.Element => {
  const [state, setState] = useState<ProductPlanState | null>(null);
  const [draft, setDraft] = useState<ProductPlan>(() => createProductPlanDraft(overview));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveRequestId, setSaveRequestId] = useState(() => crypto.randomUUID());
  const [confirmRequestId, setConfirmRequestId] = useState(() => crypto.randomUUID());
  const initialized = useRef(false);
  const productId = overview.product.id;
  const refresh = async (): Promise<void> => {
    setState(unwrap(await window.platform.productPlans.getState({ productId })));
  };
  useEffect(() => {
    let active = true;
    void window.platform.productPlans.getState({ productId }).then(result => {
      if (!active) return;
      const next = unwrap(result);
      setState(next);
      if (!initialized.current && !proposedPlan) {
        setDraft(next.current && next.saved ? next.saved.plan : createProductPlanDraft(overview));
        initialized.current = true;
      }
    }).catch(value => { if (active) setError(errorText(value)); });
    return () => { active = false; };
  }, [productId, overview.goal.revision, overview.goal.hash, overview.product.confirmedGoalRevision]);

  useEffect(() => {
    if (!proposedPlan || proposedPlan.productId !== productId || proposedPlan.goalRevision !== overview.goal.revision || proposedPlan.goalHash !== overview.goal.hash) return;
    setDraft(proposedPlan);
    setSaveRequestId(crypto.randomUUID());
    initialized.current = true;
  }, [proposedPlan, productId, overview.goal.revision, overview.goal.hash]);

  const saved = state?.saved ?? null;
  const current = state?.current === true && saved?.plan.goalRevision === overview.goal.revision && saved.plan.goalHash === overview.goal.hash;
  const editing = !saved || !sameProductPlan(draft, saved.plan);
  const canConfirm = Boolean(saved && current && state?.directionConfirmed && !editing && !dirty && !saved.confirmedAt);
  const completeGoal = Boolean(overview.goal.goal.goal.trim() && overview.goal.goal.scope.trim() && overview.goal.goal.acceptanceCriteria.some(item => item.required));
  const completeDraft = Boolean(draft.summary.trim() && draft.workItems.length && draft.workItems.every(item => item.title.trim() && item.objective.trim() && item.deliverable.trim() && item.acceptanceCriterionIds.length));
  const locked = disabled || busy || dirty || !state;
  const changeDraft = (next: ProductPlan | ((_current: ProductPlan) => ProductPlan)): void => {
    setDraft(next);
    setSaveRequestId(crypto.randomUUID());
  };
  const updateItem = (id: string, change: Partial<ProductWorkItem>): void => {
    changeDraft(value => ({ ...value, workItems: value.workItems.map(item => item.id === id ? { ...item, ...change } : item) }));
  };
  const addItem = (): void => {
    const ids = new Set(draft.workItems.map(item => item.id));
    let number = 1;
    while (ids.has(`w${number}`)) number++;
    changeDraft({ ...draft, workItems: [...draft.workItems, {
      id: `w${number}`, title: "新工作项", objective: "", deliverable: "", acceptanceCriterionIds: [], dependsOn: []
    }] });
  };
  const save = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const next = unwrap(await window.platform.productPlans.save({
        requestId: saveRequestId, productId, expectedPlanRevision: saved?.revision ?? 0, plan: draft
      }));
      setDraft(next.plan);
      setSaveRequestId(crypto.randomUUID());
      setConfirmRequestId(crypto.randomUUID());
      await refresh(); onChanged?.();
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  };
  const confirm = async (): Promise<void> => {
    if (!saved) return;
    setBusy(true); setError(null);
    try {
      unwrap(await window.platform.productPlans.confirm({ requestId: confirmRequestId, productId, planRevision: saved.revision }));
      setConfirmRequestId(crypto.randomUUID());
      await refresh(); onChanged?.();
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  };
  const label = !state ? "读取中" : saved && !current ? "已过期" : editing ? "草稿" : saved?.confirmedAt ? "已确认" : "已保存";

  return (
    <section className="product-plan-panel" aria-label="产品开发计划">
      <div className="section-heading"><h3>产品开发计划</h3><StatusBadge>{label}</StatusBadge></div>
      <p className="product-help">从验收标准起草工作项，再补充目标、交付物和依赖。确认计划只记录安排，不启动开发任务。</p>
      {!completeGoal && <p className="product-help">请先保存完整目标、范围和必需验收标准。</p>}
      {dirty && <p className="product-help">当前产品目标有未保存修改，请先保存目标。</p>}
      {saved && !current && <details><summary>上次计划已过期（目标 v{saved.plan.goalRevision}）</summary><ProductPlanPreview plan={saved.plan} /></details>}
      <label>计划摘要<textarea value={draft.summary} disabled={locked} onChange={event => { const summary = event.target.value; changeDraft(value => ({ ...value, summary })); }} /></label>
      <div className="product-plan-actions">
        <Button variant="secondary" disabled={locked || !completeGoal} onClick={() => changeDraft(createProductPlanDraft(overview))}>从验收标准起草计划</Button>
        <Button disabled={locked || !editing || !completeGoal || !completeDraft} onClick={() => void save()}>保存计划</Button>
        <Button variant="secondary" disabled={locked || !canConfirm} onClick={() => void confirm()}>确认计划</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void refresh().catch(value => setError(errorText(value)))}>刷新计划记录</Button>
      </div>
      {draft.workItems.map(item => (
        <article className="product-plan-item" key={item.id}>
          <div className="section-heading"><h4>{item.id} · 工作项</h4>
            {draft.workItems.length > 1 && <Button variant="ghost" disabled={locked} onClick={() => changeDraft(value => removeProductWorkItem(value, item.id))}>移除工作项</Button>}
          </div>
          <label>标题<input value={item.title} disabled={locked} onChange={event => updateItem(item.id, { title: event.target.value })} /></label>
          <label>工作目标<textarea value={item.objective} disabled={locked} onChange={event => updateItem(item.id, { objective: event.target.value })} /></label>
          <label>交付物<textarea value={item.deliverable} disabled={locked} onChange={event => updateItem(item.id, { deliverable: event.target.value })} /></label>
          <fieldset><legend>覆盖的产品验收</legend>
            {overview.goal.goal.acceptanceCriteria.map(criterion => (
              <label className="product-plan-check" key={criterion.id}>
                <input type="checkbox" checked={item.acceptanceCriterionIds.includes(criterion.id)} disabled={locked}
                  onChange={event => updateItem(item.id, { acceptanceCriterionIds: event.target.checked
                    ? [...item.acceptanceCriterionIds, criterion.id] : item.acceptanceCriterionIds.filter(id => id !== criterion.id) })} />
                {criterion.description}{criterion.required ? "（必需）" : ""}
              </label>
            ))}
          </fieldset>
          <fieldset><legend>依赖工作项</legend>
            {draft.workItems.filter(dependency => dependency.id !== item.id).map(dependency => (
              <label className="product-plan-check" key={dependency.id}>
                <input type="checkbox" checked={item.dependsOn.includes(dependency.id)} disabled={locked}
                  onChange={event => updateItem(item.id, { dependsOn: event.target.checked
                    ? [...item.dependsOn, dependency.id] : item.dependsOn.filter(id => id !== dependency.id) })} />
                {dependency.title}
              </label>
            ))}
            {!draft.workItems.some(dependency => dependency.id !== item.id) && <p className="product-help">暂无其他工作项。</p>}
          </fieldset>
        </article>
      ))}
      {draft.workItems.length < 50 && <Button variant="ghost" disabled={locked} onClick={addItem}>添加工作项</Button>}
      {saved && <p className="product-help">计划 v{saved.revision} · 依据目标 v{saved.plan.goalRevision} · {saved.confirmedAt ? "已确认" : "尚未确认"}</p>}
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
};
