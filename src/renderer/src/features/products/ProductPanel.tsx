import { ProductPreviewPanel } from "./ProductPreviewPanel.js";
import React, { useEffect, useRef, useState } from "react";
import type {
  AcceptanceCriterion, GoalHistoryItem, GoalSnapshot, ProductGoal,
  ProductOverview, ProductResult, ProductSummary
} from "../../../../shared/contracts/products.js";
import { Button, EmptyState, InlineError, StatusBadge } from "../../ui/index.js";
import "./products.css";
import { ProductRunPanel } from "./ProductRunPanel.js";
import { ProductExecutionPanel } from "./ProductExecutionPanel.js";
import type { ProductPlan } from "../../../../shared/contracts/product-plan.js";
import { ProductPlanPanel } from "./ProductPlanPanel.js";
import { PlanningPanel } from "./PlanningPanel.js";
import { ProductDeliveryPanel } from "./ProductDeliveryPanel.js";
import { ProductProgressPanel } from "./ProductProgressPanel.js";
import { ProductMetricsPanel } from "./ProductMetricsPanel.js";

export const emptyGoal = (originalRequest = ""): ProductGoal => ({
  schemaVersion: "1.0", originalRequest, goal: "", scope: "",
  assumptions: [], acceptanceCriteria: []
});
export const productTrashLabel = "删除产品";

class ProductRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const unwrap = <T,>(result: ProductResult<T>): T => {
  if (!result.ok) throw new ProductRequestError(result.error.code, result.error.message);
  return result.value;
};
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);
const sameGoal = (left: ProductGoal | null, right: ProductGoal): boolean => JSON.stringify(left) === JSON.stringify(right);

export const isGoalComplete = (goal: ProductGoal): boolean =>
  Boolean(goal.goal.trim() && goal.scope.trim()) &&
  goal.assumptions.every(item => Boolean(item.trim())) &&
  goal.acceptanceCriteria.every(item => Boolean(item.description.trim())) &&
  goal.acceptanceCriteria.some(item => item.required);

export const canConfirmGoal = (
  saved: ProductGoal | null, draft: ProductGoal, confirmedRevision: number | null, revision: number
): boolean => saved !== null && sameGoal(saved, draft) && isGoalComplete(saved) && confirmedRevision !== revision;

type GoalFormProps = {
  goal: ProductGoal;
  disabled?: boolean;
  onChange: (_goal: ProductGoal) => void;
  onAddCriterion: () => void;
  onRemoveCriterion: (_index: number) => void;
};

export const ProductGoalForm = ({
  goal, disabled = false, onChange, onAddCriterion, onRemoveCriterion
}: GoalFormProps): React.JSX.Element => {
  const updateCriterion = (index: number, patch: Partial<AcceptanceCriterion>): void => {
    onChange({
      ...goal,
      acceptanceCriteria: goal.acceptanceCriteria.map((item, i) => i === index ? { ...item, ...patch } : item)
    });
  };
  return (
    <fieldset disabled={disabled} className="product-goal-form">
      <label>原始想法（只读）<textarea readOnly value={goal.originalRequest} /></label>
      <label>目标<textarea value={goal.goal} onChange={event => onChange({ ...goal, goal: event.target.value })} /></label>
      <label>范围<textarea value={goal.scope} onChange={event => onChange({ ...goal, scope: event.target.value })} /></label>
      <fieldset>
        <legend>未决假设</legend>
        {goal.assumptions.map((value, index) => (
          <div className="product-item" key={index}>
            <input aria-label={`假设 ${index + 1}`} value={value} onChange={event => onChange({
              ...goal, assumptions: goal.assumptions.map((item, i) => i === index ? event.target.value : item)
            })} />
            <Button size="sm" variant="ghost" onClick={() => onChange({
              ...goal, assumptions: goal.assumptions.filter((_, i) => i !== index)
            })}>移除</Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" disabled={goal.assumptions.length >= 100}
          onClick={() => onChange({ ...goal, assumptions: [...goal.assumptions, ""] })}>添加假设</Button>
      </fieldset>
      <fieldset>
        <legend>验收标准</legend>
        {goal.acceptanceCriteria.map((item, index) => (
          <div className="product-criterion" key={item.id}>
            <input aria-label={`验收标准 ${index + 1}`} value={item.description}
              onChange={event => updateCriterion(index, { description: event.target.value })} />
            <select aria-label={`验证方式 ${index + 1}`} value={item.verification}
              onChange={event => updateCriterion(index, { verification: event.target.value as AcceptanceCriterion["verification"] })}>
              <option value="platform">平台检查</option>
              <option value="review">评审</option>
              <option value="user">用户确认</option>
            </select>
            <label className="product-required">
              <input type="checkbox" checked={item.required}
                onChange={event => updateCriterion(index, { required: event.target.checked })} />必需
            </label>
            <Button size="sm" variant="ghost" onClick={() => onRemoveCriterion(index)}>移除</Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" disabled={goal.acceptanceCriteria.length >= 100}
          onClick={onAddCriterion}>添加验收标准</Button>
      </fieldset>
    </fieldset>
  );
};

type PendingCommand = {
  kind: "create" | "revise" | "confirm";
  productId: string | null;
  run: () => Promise<ProductResult<ProductOverview>>;
};

const verificationLabels = { platform: "平台检查", review: "评审", user: "用户确认" };

export const ProductGoalPreview = ({ snapshot }: { snapshot: GoalSnapshot }): React.JSX.Element => (
  <section className="product-history-preview" aria-label="历史目标只读预览">
    <div className="section-heading"><h4>目标 v{snapshot.revision}</h4><StatusBadge>只读历史</StatusBadge></div>
    <dl>
      <dt>原始想法</dt><dd>{snapshot.goal.originalRequest}</dd>
      <dt>目标</dt><dd>{snapshot.goal.goal || "尚未填写"}</dd>
      <dt>范围</dt><dd>{snapshot.goal.scope || "尚未填写"}</dd>
      <dt>假设</dt><dd>{snapshot.goal.assumptions.length
        ? <ul>{snapshot.goal.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
        : "暂无假设"}</dd>
      <dt>验收标准</dt><dd>{snapshot.goal.acceptanceCriteria.length
        ? <ul>{snapshot.goal.acceptanceCriteria.map(item => (
          <li key={item.id}>{item.description}<small>{item.required ? "必需" : "可选"} · {verificationLabels[item.verification]}</small></li>
        ))}</ul>
        : "尚未添加"}</dd>
    </dl>
  </section>
);

export const ProductPanel = ({ onOpenTask, onOpenRuntime = () => undefined }: { onOpenTask: (_taskId: string) => void; onOpenRuntime?: () => void }): React.JSX.Element => {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [listOnly, setListOnly] = useState(false);
  const [trashSelection, setTrashSelection] = useState<ProductSummary | null>(null);
  const [productCursor, setProductCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overview, setOverview] = useState<ProductOverview | null>(null);
  const [draft, setDraft] = useState<ProductGoal>(emptyGoal);
  const [proposedPlan, setProposedPlan] = useState<ProductPlan | null>(null);
  const [name, setName] = useState("");
  const [idea, setIdea] = useState("");
  const [history, setHistory] = useState<GoalHistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [preview, setPreview] = useState<GoalSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [pendingTrash, setPendingTrash] = useState<{ product: ProductSummary; action: "trash" | "restore" } | null>(null);
  const [progressRefreshRevision, setProgressRefreshRevision] = useState(0);
  const generation = useRef(0);
  const trashRequestIds = useRef(new Map<string, string>());

  const refreshList = async (afterId?: string, deleted = showTrash): Promise<void> => {
    const token = generation.current;
    const page = unwrap(await window.platform.products.list({ limit: 50, deleted, ...(afterId ? { afterId } : {}) }));
    if (token !== generation.current) return;
    setProducts(current => afterId ? [...current, ...page.items] : page.items);
    setProductCursor(page.nextCursor);
  };

  const refreshHistory = async (productId: string, token: number, afterRevision?: number): Promise<void> => {
    const page = unwrap(await window.platform.products.getGoalHistory({
      productId, limit: 20, ...(afterRevision === undefined ? {} : { afterRevision })
    }));
    if (token !== generation.current) return;
    setHistory(current => afterRevision === undefined ? page.items : [...current, ...page.items]);
    setHistoryCursor(page.nextCursor);
  };

  useEffect(() => {
    let active = true;
    void window.platform.products.list({ limit: 50, deleted: showTrash }).then(result => {
      if (!active) return;
      const page = unwrap(result);
      setProducts(page.items);
      setProductCursor(page.nextCursor);
    }).catch(value => { if (active) setError(errorText(value)); });
    return () => { active = false; };
  }, [showTrash]);

  const changeTrashState = async (product: ProductSummary, action: "trash" | "restore"): Promise<void> => {
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const requestKey = `${action}:${product.id}`;
      const input = { requestId: trashRequestIds.current.get(requestKey) ?? crypto.randomUUID(), productId: product.id, expectedRevision: product.revision };
      trashRequestIds.current.set(requestKey, input.requestId);
      setPendingTrash({ product, action });
      const receipt = unwrap(await window.platform.products[action](input));
      if (token !== generation.current) return;
      trashRequestIds.current.delete(requestKey);
      setPendingTrash(null);
      const current = receipt;
      if (action === "restore") setShowTrash(false);
      setTrashSelection(null);
      setListOnly(action === "trash");
      setSelectedId(action === "restore" ? current.product.id : null);
      setOverview(action === "restore" ? current : null);
      setDraft(action === "restore" ? current.goal.goal : emptyGoal());
      setHistory([]); setPreview(null);
      await refreshList(undefined, false);
      if (action === "trash" && showTrash) await refreshList(undefined, true);
    } catch (value) {
      if (token === generation.current) {
        setError(errorText(value));
        if (value instanceof ProductRequestError && !["INTERNAL_ERROR", "INVALID_RESPONSE"].includes(value.code)) {
          trashRequestIds.current.delete(`${action}:${product.id}`); setPendingTrash(null);
        }
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };

  const loadProduct = async (productId: string): Promise<void> => {
    const token = ++generation.current;
    setBusy(true);
    setListOnly(false);
    if (showTrash) {
      setTrashSelection(products.find(item => item.id === productId) ?? null);
      setBusy(false);
      return;
    }
    if (selectedId === productId && overview) { setBusy(false); return; }
    setSelectedId(productId);
    setOverview(null);
    setHistory([]);
    setPreview(null);
    setError(null);
    try {
      const value = unwrap(await window.platform.products.getOverview({ productId }));
      if (token !== generation.current) return;
      setOverview(value);
      setDraft(value.goal.goal);
      await refreshHistory(productId, token);
    } catch (value) {
      if (token === generation.current) setError(errorText(value));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };

  const executeCommand = async (command: PendingCommand): Promise<void> => {
    setPending(command);
    setBusy(true);
    setError(null);
    try {
      const receipt = unwrap(await command.run());
      // The receipt may be an old idempotent response. Always display current state.
      setPending(null);
      const current = unwrap(await window.platform.products.getOverview({ productId: receipt.product.id }));
      const token = ++generation.current;
      setListOnly(false);
      setSelectedId(current.product.id);
      setOverview(current);
      setDraft(current.goal.goal);
      setPreview(null);
      if (command.kind === "create") { setName(""); setIdea(""); }
      await refreshHistory(current.product.id, token);
      await refreshList();
    } catch (value) {
      setError(errorText(value));
      const code = value instanceof Error && "code" in value ? String(value.code) : null;
      if (code && code !== "INTERNAL_ERROR" && code !== "INVALID_RESPONSE") {
        setPending(null);
        if (code === "REVISION_CONFLICT" && command.productId) {
          try {
            const current = unwrap(await window.platform.products.getOverview({ productId: command.productId }));
            setOverview(current); // Preserve the local draft for explicit resubmission.
            await refreshHistory(command.productId, generation.current);
          } catch { /* Keep the draft and original conflict message. */ }
        }
      }
    } finally { setBusy(false); }
  };

  const createProduct = (): void => {
    const input = { requestId: crypto.randomUUID(), name: name.trim(), initialRequest: idea };
    void executeCommand({ kind: "create", productId: null, run: () => window.platform.products.create(input) });
  };

  const reviseGoal = (): void => {
    if (!overview) return;
    const input = {
      requestId: crypto.randomUUID(), productId: overview.product.id,
      expectedRevision: overview.product.revision, goal: draft
    };
    void executeCommand({ kind: "revise", productId: input.productId, run: () => window.platform.products.reviseGoal(input) });
  };

  const confirmDirection = (): void => {
    if (!overview || !canConfirmGoal(overview.goal.goal, draft, overview.product.confirmedGoalRevision, overview.goal.revision)) return;
    const input = {
      requestId: crypto.randomUUID(), productId: overview.product.id,
      expectedRevision: overview.product.revision, goalRevision: overview.goal.revision
    };
    void executeCommand({ kind: "confirm", productId: input.productId, run: () => window.platform.products.confirmDirection(input) });
  };

  const readHistory = async (revision: number): Promise<void> => {
    if (!selectedId) return;
    const token = generation.current;
    setBusy(true);
    try {
      const value = unwrap(await window.platform.products.getGoal({ productId: selectedId, revision }));
      if (token === generation.current) setPreview(value);
    } catch (value) { if (token === generation.current) setError(errorText(value)); }
    finally { if (token === generation.current) setBusy(false); }
  };

  const loadMore = async (kind: "products" | "history"): Promise<void> => {
    setBusy(true);
    try {
      if (kind === "products" && productCursor) await refreshList(productCursor);
      if (kind === "history" && selectedId && historyCursor !== null) {
        await refreshHistory(selectedId, generation.current, historyCursor);
      }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  };

  const locked = busy || pending !== null || pendingTrash !== null;
  const ready = overview !== null && canConfirmGoal(
    overview.goal.goal, draft, overview.product.confirmedGoalRevision, overview.goal.revision
  );

  return (
    <div className="product-panel">
      <aside className="product-list">
        <div className="product-list-heading"><span className="eyebrow">产品空间</span><h2>{showTrash ? "回收站" : "我的产品"}</h2></div>
        <div className="product-actions product-list-switcher">
          <Button size="sm" variant={showTrash ? "secondary" : "primary"} disabled={locked} onClick={() => {
            generation.current += 1; setShowTrash(false); setListOnly(true); setTrashSelection(null); setError(null);
          }}>正常产品</Button>
          <Button size="sm" variant={showTrash ? "primary" : "secondary"} disabled={locked} onClick={() => {
            generation.current += 1; setShowTrash(true); setListOnly(true); setTrashSelection(null); setError(null);
          }}>回收站</Button>
        </div>
        {products.map(product => (
          <Button key={product.id} variant="ghost" className="product-list-item" disabled={locked}
            aria-current={selectedId === product.id ? "page" : undefined}
            onClick={() => void loadProduct(product.id)}>
            <strong>{product.name}</strong>
            <span>目标 v{product.goalRevision} · {showTrash ? `删除于 ${product.deletedAt ?? "未知时间"}` : (product.confirmedGoalRevision === product.goalRevision ? "已确认" : "待确认")}</span>
          </Button>
        ))}
        {productCursor && <Button variant="secondary" disabled={locked} onClick={() => void loadMore("products")}>更多产品</Button>}
        {!showTrash && <Button variant="secondary" disabled={locked} onClick={() => {
          generation.current += 1;
          setListOnly(false); setSelectedId(null); setOverview(null); setDraft(emptyGoal());
          setHistory([]); setPreview(null); setError(null);
        }}>新建产品</Button>}
        {products.length === 0 && <EmptyState title="从一个想法开始" description="先定义产品方向，无需准备仓库。" />}
      </aside>
      <section className="product-editor">
        {listOnly && <EmptyState title={showTrash ? "回收站" : "产品列表"} description="选择左侧产品继续。" />}
        <div hidden={listOnly}>
        {showTrash && trashSelection ? (
          <><h2>{trashSelection.name}</h2><p>目标、任务、分支和历史均已保留，恢复后可继续工作。</p>
          <Button disabled={locked} onClick={() => setListOnly(true)}>返回产品列表</Button>
          <Button disabled={locked} onClick={() => void changeTrashState(trashSelection, "restore")}>恢复产品</Button></>
        ) : !selectedId ? (
          <>
            <div className="product-editor-heading">
              <span className="eyebrow">01 / 产品起点</span>
              <h2>你想做什么产品？</h2>
              <p>描述想服务的人、遇到的问题，以及你希望得到的结果。先保存想法，再逐步明确方向。</p>
            </div>
            <label>产品名称<input disabled={locked} maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
            <label>最初想法<textarea className="product-idea" disabled={locked} value={idea}
              placeholder="例如：帮独立开发者管理用户反馈，让每次迭代都有明确依据。"
              onChange={event => setIdea(event.target.value)} /></label>
            <Button loading={busy} disabled={locked || !name.trim() || !idea.trim()} onClick={createProduct}>创建产品</Button>
            <p className="product-help">当前支持保存目标与确认方向，主 Agent 自动规划将在后续接入。</p>
          </>
        ) : overview ? (
          <>
            <div className="product-editor-heading">
              <span className="eyebrow">02 / 明确方向</span>
              <div className="section-heading">
                <h2>{overview.product.name}</h2>
                <StatusBadge tone={overview.product.confirmedGoalRevision === overview.goal.revision ? "success" : "neutral"}>
                  {overview.product.confirmedGoalRevision === overview.goal.revision ? "方向已确认" : "方向待确认"}
                </StatusBadge>
              </div>
              <p>目标 v{overview.goal.revision} · 填写范围与验收标准，保存后确认当前方向。</p>
            </div>
            <Button variant="secondary" disabled={locked} onClick={() => setListOnly(true)}>返回产品列表</Button>
            <ProductProgressPanel overview={overview} dirty={!sameGoal(overview.goal.goal, draft)} disabled={locked}
              onOpenTask={onOpenTask} onOpenRuntime={onOpenRuntime} refreshRevision={progressRefreshRevision} />
            <ProductMetricsPanel productId={overview.product.id} disabled={locked} />
            <ProductGoalForm goal={draft} disabled={locked} onChange={setDraft}
              onAddCriterion={() => setDraft(value => ({
                ...value, acceptanceCriteria: [...value.acceptanceCriteria, {
                  id: crypto.randomUUID(), description: "", verification: "user", required: true
                }]
              }))}
              onRemoveCriterion={index => setDraft(value => ({
                ...value, acceptanceCriteria: value.acceptanceCriteria.filter((_, i) => i !== index)
              }))} />
            <div className="product-actions">
              <Button disabled={locked || sameGoal(overview.goal.goal, draft)} onClick={reviseGoal}>保存目标</Button>
              <Button variant="secondary" disabled={locked || !ready} onClick={confirmDirection}>确认方向</Button>
            </div>
            <p className="product-help" role="status">
              {!sameGoal(overview.goal.goal, draft) ? "有未保存的修改，请先保存目标。" : "确认方向仅记录当前目标，不会启动开发任务。"}
            </p>
            <PlanningPanel key={`${overview.product.id}:${overview.goal.revision}`} overview={overview}
              disabled={locked} dirty={!sameGoal(overview.goal.goal, draft)} onUseGoal={setDraft}
              onUsePlan={plan => {
                if (plan.productId !== overview.product.id || plan.goalRevision !== overview.goal.revision || plan.goalHash !== overview.goal.hash) return;
                setProposedPlan({ ...plan, workItems: plan.workItems.map(item => ({ ...item })) });
                requestAnimationFrame(() => document.querySelector(".product-plan-panel")?.scrollIntoView({ block: "start" }));
              }} />
            <ProductExecutionPanel key={`execution:${overview.product.id}:${overview.goal.revision}`} overview={overview}
              disabled={busy} dirty={!sameGoal(overview.goal.goal, draft)} onOpenTask={onOpenTask}
              onProductChanged={() => {
                const token = generation.current;
                setProgressRefreshRevision(value => value + 1);
                void window.platform.products.getOverview({ productId: overview.product.id }).then(result => {
                  if (token === generation.current) setOverview(unwrap(result));
                }).catch(value => { if (token === generation.current) setError(errorText(value)); });
              }} />
            <ProductRunPanel key={`run:${overview.product.id}:${overview.goal.revision}`} productId={overview.product.id}
              disabled={busy} dirty={!sameGoal(overview.goal.goal, draft)} onChanged={() => setProgressRefreshRevision(value => value + 1)} />
            <ProductPlanPanel key={`plan:${overview.product.id}:${overview.goal.revision}`} overview={overview}
              disabled={locked} dirty={!sameGoal(overview.goal.goal, draft)} proposedPlan={proposedPlan} onChanged={() => setProgressRefreshRevision(value => value + 1)} />
            <ProductPreviewPanel productId={overview.product.id} disabled={locked} dirty={!sameGoal(overview.goal.goal, draft)} />
            <ProductDeliveryPanel key={`delivery:${overview.product.id}:${overview.goal.revision}`} productId={overview.product.id} goalRevision={overview.goal.revision} onChanged={() => setProgressRefreshRevision(value => value + 1)} />
            <section className="product-history">
              <h3>目标历史</h3>
              <div className="product-actions">
                {history.map(item => (
                  <Button key={item.revision} variant="ghost" disabled={locked}
                    onClick={() => void readHistory(item.revision)}>v{item.revision}{item.confirmedAt ? "（已确认）" : ""}</Button>
                ))}
                {historyCursor !== null && <Button variant="secondary" disabled={locked}
                  onClick={() => void loadMore("history")}>更多版本</Button>}
              </div>
              {preview && <ProductGoalPreview snapshot={preview} />}
            </section>
            <section className="product-danger-zone" aria-label="产品回收站操作">
              <h3>产品管理</h3>
              <p className="product-help">删除会将产品移入回收站，任务、分支和历史都会保留。</p>
              <Button variant="secondary" disabled={locked} onClick={() => void changeTrashState(overview.product, "trash")}>{productTrashLabel}</Button>
            </section>
          </>
        ) : <p>{busy ? "读取产品中…" : "读取失败，请重新选择产品。"}</p>}
        </div>
        {error && <InlineError>{error}</InlineError>}
        {pending && !busy && (
          <Button variant="secondary" onClick={() => void executeCommand(pending)}>重试上一次请求</Button>
        )}
        {pendingTrash && !busy && (
          <Button variant="secondary" onClick={() => void changeTrashState(pendingTrash.product, pendingTrash.action)}>重试上一次回收站操作</Button>
        )}
      </section>
    </div>
  );
};
