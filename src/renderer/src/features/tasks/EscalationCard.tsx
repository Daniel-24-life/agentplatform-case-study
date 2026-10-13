import React from "react";
import { Button } from "../../ui/index.js";
export type EscalationCardProps = { pending: boolean; onApprove?: () => void; busy?: boolean };
export const EscalationCard = ({ pending, onApprove, busy = false }: EscalationCardProps): React.JSX.Element | null => pending ? <aside className="escalation-card" role="status"><h3>需要批准升级</h3><p>Cheap Worker 未完成任务。批准后将使用 Strong Codex Worker 重试；这会消耗一次高级模型调用。</p>{onApprove && <Button type="button" onClick={onApprove} loading={busy}>批准强模型升级</Button>}</aside> : null;
