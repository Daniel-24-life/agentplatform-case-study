import React, { useState } from "react";
import type { TaskDetailRecord } from "../../../../shared/contracts/records.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { ChecksPanel } from "./ChecksPanel.js";
import { TaskSpecPanel } from "./TaskSpecPanel.js";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer.js";
import { Tabs } from "../../ui/index.js";

export const EVIDENCE_TABS = ["overview", "spec", "changes", "checks", "activity"] as const;
export type EvidenceTab = typeof EVIDENCE_TABS[number];
export type EvidenceWorkspaceProps = { detail: TaskDetailRecord; specText?: string; specEditable?: boolean; onSpecChange?: (_value: string) => void; onSpecSave?: () => void; onSpecCancel?: () => void; specError?: string | null; busy?: boolean; initialTab?: EvidenceTab };
export const EvidenceWorkspace = ({ detail, specText, specEditable = false, onSpecChange, onSpecSave, onSpecCancel, specError, busy = false, initialTab = "overview" }: EvidenceWorkspaceProps): React.JSX.Element => {
  const [tab, setTab] = useState<EvidenceTab>(initialTab);
  const snapshot = detail.snapshot;
  const labels: Record<EvidenceTab, string> = { overview: "Overview", spec: "Spec", changes: "Changes", checks: "Checks", activity: "Activity" };
  const panels: Record<EvidenceTab, React.ReactNode> = {
    overview: <section><h3>Overview</h3><dl><dt>Base SHA</dt><dd><code>{detail.task.baseSha}</code></dd><dt>工作区</dt><dd>{detail.attempt?.worktreePath ?? "尚未创建"}</dd><dt>分支</dt><dd>{detail.attempt?.branch ?? "尚未创建"}</dd><dt>证据</dt><dd>{snapshot ? "已收集" : "暂无"}</dd></dl></section>,
    spec: <TaskSpecPanel value={specText ?? detail.task.specJson} editable={specEditable} onChange={onSpecChange} onSave={onSpecSave} onCancel={onSpecCancel} error={specError} busy={busy} />,
    changes: <UnifiedDiffViewer diff={snapshot?.git.diff} changedFiles={snapshot?.git.changedFiles} />,
    checks: <ChecksPanel snapshot={snapshot} />,
    activity: <ActivityPanel events={detail.events} runs={detail.runs} />
  };
  return <section className="evidence-workspace"><Tabs ariaLabel="证据" value={tab} onChange={value => setTab(value as EvidenceTab)} items={EVIDENCE_TABS.map(item => ({ id: item, label: labels[item], panel: panels[item] }))} /></section>;
};
