import React from "react";
import { EmptyState } from "../../ui/index.js";
export type UnifiedDiffViewerProps = { diff: string | null | undefined; changedFiles?: readonly string[] };
const fileKind = (chunk: string): string => chunk.includes("/dev/null") ? (chunk.includes("+++ /dev/null") ? "删除" : "新增") : "修改";
export const UnifiedDiffViewer = ({ diff, changedFiles = [] }: UnifiedDiffViewerProps): React.JSX.Element => {
  const sections = React.useMemo(() => (diff ?? "").split(/^diff --git /m).filter(Boolean).map(chunk => `diff --git ${chunk}`), [diff]);
  const [selected, setSelected] = React.useState(0);
  const parsed = sections.length === changedFiles.length && sections.length > 0;
  const current = parsed ? sections[selected] : diff;
  return <section className="unified-diff"><div className="panel-heading"><h3>Changes</h3><span>{changedFiles.length} 个文件</span></div>{changedFiles.length > 0 && <div role="listbox" aria-label="Changed files">{changedFiles.map((file, index) => <button type="button" role="option" aria-selected={selected === index} key={file} onClick={() => setSelected(index)}><code>{file}</code><span> · {parsed ? fileKind(sections[index]) : "修改"}</span></button>)}</div>}{current ? <pre aria-label="只读 unified diff">{current}</pre> : <EmptyState title="暂无 Diff 证据" description="构建完成后，变更文件和只读 Diff 会显示在这里。" />}</section>;
};
