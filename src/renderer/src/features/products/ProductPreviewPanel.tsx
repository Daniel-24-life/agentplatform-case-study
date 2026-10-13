import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ProductPreviewSession, PreviewBuildDirectory } from "../../../../shared/contracts/product-preview.js";
import { Button, InlineError, StatusBadge } from "../../ui/index.js";
import "./ProductPreviewPanel.css";

export type ProductPreviewPanelProps = { productId: string; disabled: boolean; dirty: boolean };
const activeStatuses = ["STARTING", "RUNNING", "STOPPING"] as const;
const statusLabel: Record<ProductPreviewSession["status"], string> = { STARTING: "启动中", RUNNING: "运行中", STOPPING: "停止中", STOPPED: "已停止", FAILED: "失败", INTERRUPTED: "已中断" };

export const canStartProductPreview = (session: ProductPreviewSession | null, disabled: boolean, dirty: boolean, busy: boolean): { eligible: boolean; reason: string | null } => {
  if (disabled) return { eligible: false, reason: "当前不可操作。" };
  if (dirty) return { eligible: false, reason: "请先保存当前产品修改。" };
  if (busy) return { eligible: false, reason: "预览操作进行中。" };
  if (session && activeStatuses.includes(session.status as typeof activeStatuses[number])) return { eligible: false, reason: "已有预览会话正在运行或停止。" };
  return { eligible: true, reason: null };
};

const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);

export const ProductPreviewPanel = ({ productId, disabled, dirty }: ProductPreviewPanelProps): React.JSX.Element => {
  const [session, setSession] = useState<ProductPreviewSession | null>(null);
  const [buildDirectory, setBuildDirectory] = useState<PreviewBuildDirectory>("dist");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const requestId = useRef(crypto.randomUUID());

  const refresh = useCallback(async (token = generation.current): Promise<void> => {
    const next = unwrap(await window.platform.productPreviews.getState({ productId }));
    if (token !== generation.current) return;
    setSession(next);
  }, [productId]);

  useEffect(() => {
    const token = ++generation.current;
    requestId.current = crypto.randomUUID();
    setBuildDirectory("dist"); setSession(null); setError(null); setBusy(false);
    let alive = true;
    void refresh(token).catch(value => { if (alive && token === generation.current) setError(errorText(value)); });
    return () => { alive = false; generation.current++; };
  }, [productId, refresh]);

  useEffect(() => {
    if (!session || !activeStatuses.includes(session.status as typeof activeStatuses[number])) return;
    const token = generation.current;
    const timer = window.setInterval(() => { if (token === generation.current) void refresh(token).catch(() => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [productId, refresh, session?.status]);

  const changeBuildDirectory = (value: PreviewBuildDirectory): void => {
    setBuildDirectory(value);
    requestId.current = crypto.randomUUID();
  };

  const start = async (): Promise<void> => {
    const eligibility = canStartProductPreview(session, disabled, dirty, busy);
    if (!eligibility.eligible) return;
    const token = generation.current;
    setBusy(true); setError(null);
    try {
      const result = await window.platform.productPreviews.start({ requestId: requestId.current, productId, buildDirectory });
      if (token !== generation.current) return;
      setSession(unwrap(result));
      requestId.current = crypto.randomUUID();
      if (token !== generation.current) return;
      await refresh(token);
    } catch (value) { if (token === generation.current) setError(errorText(value)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const control = async (kind: "stop" | "open"): Promise<void> => {
    if (!session) return;
    const token = generation.current;
    setBusy(true); setError(null);
    try { const next = unwrap(await window.platform.productPreviews[kind]({ productId, sessionId: session.id })); if (token !== generation.current) return; setSession(next); }
    catch (value) { if (token === generation.current) setError(errorText(value)); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const active = session && activeStatuses.includes(session.status as typeof activeStatuses[number]);
  const startEligibility = canStartProductPreview(session, disabled, dirty, busy);
  const tone = session?.status === "RUNNING" ? "success" : session?.status === "FAILED" || session?.status === "INTERRUPTED" ? "danger" : "neutral";
  return <section className="product-preview-panel" aria-label="本地静态预览">
    <div className="section-heading"><h3>本地静态预览</h3><StatusBadge tone={tone}>{session ? statusLabel[session.status] : "未开始"}</StatusBadge></div>
    <p className="product-help">预览当前已通过任务的构建产物，不表示业务验收或生产发布。</p>
    <div className="product-preview-controls"><label>构建目录<select value={buildDirectory} disabled={busy || Boolean(active)} onChange={event => changeBuildDirectory(event.target.value as PreviewBuildDirectory)}><option value="dist">dist</option><option value="build">build</option><option value="out">out</option></select></label><Button disabled={!startEligibility.eligible} onClick={() => void start()}>启动本地预览</Button><Button variant="secondary" disabled={disabled || busy || session?.status !== "RUNNING"} onClick={() => void control("open")}>打开预览窗口</Button><Button variant="secondary" disabled={disabled || busy || !(session && ["STARTING", "RUNNING"].includes(session.status))} onClick={() => void control("stop")}>停止预览</Button><Button variant="ghost" disabled={busy} onClick={() => { const token = generation.current; void refresh(token).catch(value => { if (token === generation.current) setError(errorText(value)); }); }}>刷新预览记录</Button></div>
    {session && <div className="product-preview-details"><p>状态：{statusLabel[session.status]}{session.url ? ` · ${session.url}` : ""}</p>{session.errorCode && <p>错误：{session.errorCode}</p>}<pre aria-label="预览日志">{session.logTail || "暂无日志"}</pre></div>}
    {!startEligibility.eligible && startEligibility.reason && <p className="product-help">{startEligibility.reason}</p>}
    {error && <InlineError>{error}</InlineError>}
  </section>;
};
