import React from "react";
import { TASK_STAGE_LABELS, type TaskViewModel } from "./task-view-model.js";
export type StageProgressProps = { task: Pick<TaskViewModel, "stageIndex" | "stage" | "status"> };
export const StageProgress = ({ task }: StageProgressProps): React.JSX.Element => <nav aria-label="任务阶段" className="stage-progress"><ol>{TASK_STAGE_LABELS.map((label, index) => <li key={label} className={index < task.stageIndex ? "complete" : index === task.stageIndex ? "current" : "upcoming"} aria-current={index === task.stageIndex ? "step" : undefined}><span>{index + 1}</span>{label}{index === task.stageIndex && <small>{task.stage}</small>}</li>)}</ol></nav>;
