import React from "react";
import type { TaskEvidenceSnapshot } from "../../../../shared/contracts/records.js";
import { EmptyState } from "../../ui/index.js";
export type ChecksPanelProps = { snapshot: TaskEvidenceSnapshot | null };
export const ChecksPanel = ({ snapshot }: ChecksPanelProps): React.JSX.Element => <section className="checks-panel"><h3>Checks</h3>{!snapshot ? <EmptyState title="尚无检查证据" description="测试和 Gate 运行后，结果会显示在这里。" /> : <><h4>测试</h4>{snapshot.tests?.length ? <ul>{snapshot.tests.map(test => <li key={test.id}><strong>{test.id}</strong> · {test.result.status} · exit {test.result.exitCode ?? "—"}</li>)}</ul> : <p>尚无测试结果。</p>}<h4>确定性 Gate</h4><p>{snapshot.gate ? (snapshot.gate.passed ? "通过" : `未通过：${snapshot.gate.failures.join("；") || "请查看失败项"}`) : "尚未运行"}</p><h4>Final Gate</h4><p>{snapshot.final?.verdict ?? "尚未运行"}</p></>}</section>;
