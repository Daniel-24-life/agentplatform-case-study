import React, { useEffect, useState } from "react";
import type { PlanningPurpose, PlanningResult, PlanningState, ProductProposal } from "../../../../shared/contracts/product-planning.js";
import type { ProductPlan } from "../../../../shared/contracts/product-plan.js";
import type { ProductGoal, ProductOverview } from "../../../../shared/contracts/products.js";
import { Button, InlineError, StatusBadge } from "../../ui/index.js";
import { ProductPlanPreview } from "./ProductPlanPanel.js";

type ProposalOptionsProps = { proposal: ProductProposal; disabled: boolean; onUseGoal: (_goal: ProductGoal) => void; onUsePlan?: (_plan: ProductPlan) => void };
export const ProposalOptions = ({ proposal, disabled, onUseGoal, onUsePlan }: ProposalOptionsProps): React.JSX.Element => (
  <div className="planning-proposals">
    <p>{proposal.summary}</p>
    <p className="product-help">{proposal.options.every(option => option.plan) ? "以下是已确认目标下的完整计划建议。" : "以下是方向方案建议，尚未成为已确认的产品目标。"}</p>
    {proposal.options.map(option => (
      <article key={option.id} className="planning-option">
        <div className="section-heading"><h4>{option.title}</h4>
          {option.id === proposal.recommendedOptionId && <StatusBadge>主 Agent 推荐</StatusBadge>}
        </div>
        <p>{option.rationale}</p>
        <dl><dt>目标</dt><dd>{option.goal.goal}</dd><dt>范围</dt><dd>{option.goal.scope}</dd></dl>
        <ul>{option.goal.acceptanceCriteria.map(item => <li key={item.id}>{item.description}{item.required ? "（必需）" : ""}</li>)}</ul>
        {option.plan ? <><ProductPlanPreview plan={option.plan} />{onUsePlan && <Button variant="secondary" disabled={disabled} onClick={() => onUsePlan(option.plan!)}>填入计划草稿</Button>}</> :
          <Button variant="secondary" disabled={disabled} onClick={() => onUseGoal(option.goal)}>将此方案填入草稿</Button>}
      </article>
    ))}
    {proposal.questions.length > 0 && <section><h4>需要判断的问题</h4><ul>{proposal.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></section>}
  </div>
);

export const isProductPlanBoundToGoal = (plan: ProductPlan, overview: ProductOverview): boolean =>
  plan.productId === overview.product.id && plan.goalRevision === overview.goal.revision && plan.goalHash === overview.goal.hash;

function unwrap<T>(result: PlanningResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

type PlanningPanelProps = { overview: ProductOverview; disabled: boolean; dirty: boolean; onUseGoal: (_goal: ProductGoal) => void; onUsePlan?: (_plan: ProductPlan) => void };
export const PlanningPanel = ({ overview, disabled, dirty, onUseGoal, onUsePlan }: PlanningPanelProps): React.JSX.Element => {
  const [state, setState] = useState<PlanningState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizeRequestId, setAuthorizeRequestId] = useState(() => crypto.randomUUID());
  const [proposalRequestId, setProposalRequestId] = useState(() => crypto.randomUUID());
  const [purpose, setPurpose] = useState<PlanningPurpose>("direction");
  const productId = overview.product.id;

  const refresh = async (): Promise<void> => {
    setState(unwrap(await window.platform.productPlanning.getState({ productId })));
  };
  useEffect(() => {
    let active = true;
    void window.platform.productPlanning.getState({ productId }).then(result => {
      if (active) setState(unwrap(result));
    }).catch(value => { if (active) setError(value instanceof Error ? value.message : String(value)); });
    return () => { active = false; };
  }, [productId]);

  const authorize = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      unwrap(await window.platform.productPlanning.authorize({
        requestId: authorizeRequestId, productId, expectedRevision: overview.product.revision
      }));
      setAuthorizeRequestId(crypto.randomUUID());
      setProposalRequestId(crypto.randomUUID());
      await refresh();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };
  const requestProposal = async (): Promise<void> => {
    if (!state?.grant) return;
    if (purpose === "plan" && !state.planAvailable) { setError("当前目标尚未具备完整计划提案资格。"); return; }
    setBusy(true); setError(null);
    try {
      unwrap(await window.platform.productPlanning.requestProposal({
        requestId: proposalRequestId, productId, grantId: state.grant.id, expectedRevision: overview.product.revision, purpose
      }));
      await refresh();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };
  const revoke = async (): Promise<void> => {
    const grantId = state?.action?.status === "RUNNING" ? state.action.grantId : state?.grant?.id;
    if (!grantId) return;
    try {
      unwrap(await window.platform.productPlanning.revoke({ productId, grantId }));
      await refresh();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  const grant = state?.grant;
  const action = state?.action;
  const currentProposal = action?.proposal && action.goalRevision === overview.goal.revision && action.goalHash === overview.goal.hash;
  const planQualified = Boolean(state?.planAvailable && overview.product.confirmedGoalRevision === overview.goal.revision);
  const qualified = purpose === "plan" ? planQualified : Boolean(state?.available);
  const proposalIsPlan = Boolean(action?.proposal?.options.every(option => option.plan !== undefined));
  const proposalMatchesMode = proposalIsPlan === (purpose === "plan");
  const canRun = qualified && grant && !grant.revokedAt && grant.usedCalls === 0;
  const setMode = (next: PlanningPurpose): void => { if (next !== purpose && !busy && !dirty) { setPurpose(next); setProposalRequestId(crypto.randomUUID()); } };

  return (
    <section className="product-planning" aria-label="主 Agent 产品方案">
      <div className="section-heading"><h3>主 Agent 产品方案</h3><StatusBadge>{qualified ? "只读规划" : "待真实资格验证"}</StatusBadge></div>
      <fieldset className="planning-mode"><legend>规划模式</legend><label><input type="radio" checked={purpose === "direction"} disabled={busy || dirty} onChange={() => setMode("direction")} />方向方案</label><label><input type="radio" checked={purpose === "plan"} disabled={busy || dirty} onChange={() => setMode("plan")} />完整计划</label></fieldset>
      <p className="product-help">一次授权只允许一次方案分析，最多300秒。分析不会修改代码或启动开发任务。</p>
      {state && !qualified && <p>方案通道与权限检查已接入；真实模型路线仍待单独验证，目前不会发起调用。</p>}
      {purpose === "plan" && !planQualified && <p className="product-help">完整计划提案要求当前方向已确认且具备独立资格，生成按钮会保持阻断；历史成功建议仍可查看。</p>}
      {dirty && <p className="product-help">请先保存当前目标，再分析或选用方案。</p>}
      <div className="product-actions">
        <Button variant="secondary" disabled={disabled || dirty || busy || !qualified || Boolean(grant && !grant.revokedAt && grant.usedCalls === 0) || action?.status === "RUNNING"}
          onClick={() => void authorize()}>允许一次只读分析</Button>
        <Button loading={busy} disabled={disabled || dirty || busy || !canRun} onClick={() => void requestProposal()}>{purpose === "plan" ? "生成完整计划（消耗模型额度）" : "生成方向方案（消耗模型额度）"}</Button>
        {((grant && !grant.revokedAt) || action?.status === "RUNNING") && <Button variant="ghost" onClick={() => void revoke()}>撤销授权</Button>}
        <Button variant="ghost" onClick={() => void refresh().catch(value => setError(String(value)))}>刷新记录</Button>
      </div>
      {grant && <p className="product-help">授权额度：{grant.usedCalls} / {grant.maxCalls} 次{grant.revokedAt ? " · 已撤销" : ""}</p>}
      {action && <p role="status">分析记录：{action.status === "RUNNING" ? "正在分析" : action.status === "SUCCEEDED" ? "建议已保存" : action.status === "INTERRUPTED" ? "调用已中断，未自动重试" : action.errorCode === "QUOTA_EXHAUSTED" ? "账户额度已耗尽，未自动重试" : `分析未通过（${action.errorCode}）`}</p>}
      {action?.proposal && !currentProposal && <p>此建议基于旧目标，不能选入当前草稿。</p>}
      {currentProposal && action?.proposal && !proposalMatchesMode && <p className="product-help">切换规划模式可查看该建议。</p>}
      {currentProposal && action?.proposal && proposalMatchesMode && <ProposalOptions proposal={action.proposal} disabled={disabled || dirty || busy} onUseGoal={onUseGoal} onUsePlan={purpose === "plan" && onUsePlan ? plan => { if (!dirty && isProductPlanBoundToGoal(plan, overview)) onUsePlan(plan); } : undefined} />}
      {error && <InlineError>{error}</InlineError>}
    </section>
  );
};
