import React from "react";
import type { TaskRecord } from "../../../../shared/contracts/records.js";
import { Button, EmptyState, InlineError, Spinner, StatusBadge } from "../../ui/index.js";
import { taskStatusViewModel } from "../tasks/task-view-model.js";

export type TaskListProps = {
  tasks: TaskRecord[];
  selectedTaskId?: string | null;
  loading?: boolean;
  error?: string | null;
  onSelect: (_task: TaskRecord) => void;
};

export const TaskList = ({ tasks, selectedTaskId, loading = false, error, onSelect: _onSelect }: TaskListProps): React.JSX.Element => (
  <section aria-labelledby="tasks-heading" className="task-list">
    <h2 id="tasks-heading">Tasks</h2>
    {loading && <Spinner label="正在加载任务" />}
    {error && <InlineError>加载任务失败：{error}</InlineError>}
    {!loading && !error && tasks.length === 0 && <EmptyState title="该项目还没有任务" description="创建一个任务开始工作。" />}
    {!loading && tasks.length > 0 && (
      <ul aria-label="项目任务">
        {tasks.map((task) => {
          const viewModel = taskStatusViewModel(task.status);
          return (
            <li key={task.id}>
              <Button
                type="button"
                className="list-item"
                aria-current={selectedTaskId === task.id ? "true" : undefined}
                onClick={() => _onSelect(task)}
              >
                <span>{task.title}</span>
                <StatusBadge tone={viewModel.tone} aria-label={`任务状态：${viewModel.label}`}>{viewModel.label}</StatusBadge>
              </Button>
            </li>
          );
        })}
      </ul>
    )}
  </section>
);
