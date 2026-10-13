import React, { type FormEvent } from "react";
import { Button, InlineError } from "../../ui/index.js";

export type CreateTaskFormProps = {
  title: string;
  requestText: string;
  submitting?: boolean;
  disabled?: boolean;
  error?: string | null;
  onTitleChange: (_value: string) => void;
  onRequestTextChange: (_value: string) => void;
  onSubmit: () => void;
};

export const CreateTaskForm = ({ title, requestText, submitting = false, disabled = false, error, onTitleChange: _onTitleChange, onRequestTextChange: _onRequestTextChange, onSubmit: _onSubmit }: CreateTaskFormProps): React.JSX.Element => {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    _onSubmit();
  };
  return (
    <form aria-labelledby="create-task-heading" onSubmit={submit}>
      <h2 id="create-task-heading">创建任务</h2>
      <label htmlFor="task-title">任务标题</label>
      <input id="task-title" value={title} onChange={(event) => _onTitleChange(event.target.value)} disabled={disabled || submitting} required />
      <label htmlFor="task-request">需求</label>
      <textarea id="task-request" value={requestText} onChange={(event) => _onRequestTextChange(event.target.value)} disabled={disabled || submitting} required rows={4} />
      {error && <InlineError>创建任务失败：{error}</InlineError>}
      <Button type="submit" loading={submitting} disabled={disabled || !title.trim() || !requestText.trim()}>{submitting ? "创建中…" : "创建任务"}</Button>
    </form>
  );
};
