import React from "react";
import { Button, StatusBadge } from "../../ui/index.js";

export type AgentsPanelProps = { className?: string };

export const AgentsPanel = ({ className }: AgentsPanelProps): React.JSX.Element => (
  <section aria-labelledby="agents-heading" className={className ? `agents-panel ${className}` : "agents-panel"}>
    <h2 id="agents-heading">Agents</h2>
    <p>Codex 是默认执行 Agent。Cursor 可在批准 TaskSpec 后手动选择为构建 Worker；平台负责应用改动、测试和 Gate。</p>
    <ul aria-label="Agent 可用性">
      <li><article><h3>Codex</h3><p>当前 Agent · 已接入</p><StatusBadge tone="success" aria-label="Codex 状态：当前">当前</StatusBadge></article></li>
      <li><article aria-disabled="true"><h3>WorkBuddy / CodeBuddy</h3><p>未接入</p><StatusBadge tone="neutral">未接入</StatusBadge><Button type="button" disabled variant="secondary">不可用</Button></article></li>
      <li><article><h3>Cursor</h3><p>可选提案 Worker · 需要本机 WSL 登录</p><StatusBadge tone="info">手动选择</StatusBadge></article></li>
    </ul>
  </section>
);
