import React from "react";
import type { TaskViewModel } from "./task-view-model.js";
import { Button, StatusBadge } from "../../ui/index.js";

export type TaskHeaderProps = { task: TaskViewModel; onPrimaryAction?: () => void; onCursorAction?: () => void; busy?: boolean };
export const TaskHeader = ({ task, onPrimaryAction, onCursorAction, busy = false }: TaskHeaderProps): React.JSX.Element => <header className="task-header">
  <div><StatusBadge tone={task.tone}>{task.label}</StatusBadge><h2>{task.title}</h2><p>{task.requestText}</p></div>
  <div className="task-header-meta"><span>{task.category}</span>{task.attemptLabel && <span>{task.attemptLabel}</span>}<span>更新于 {task.updatedAt}</span>
    {task.nextAction && onPrimaryAction && <Button type="button" onClick={onPrimaryAction} loading={busy}>{task.nextAction}</Button>}
    {onCursorAction && <Button type="button" variant="secondary" onClick={onCursorAction} disabled={busy}>使用 Cursor 构建</Button>}
    {!task.nextAction && task.unavailableReason && <small>{task.unavailableReason}</small>}
  </div>
</header>;
