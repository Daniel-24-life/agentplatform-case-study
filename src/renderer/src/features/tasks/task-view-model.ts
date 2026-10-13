import type { TaskDetailRecord, TaskRecord } from "../../../../shared/contracts/records.js";
import type { TaskStatus } from "../../../../shared/core/task-state.js";

export type TaskTone = "neutral" | "info" | "success" | "warning" | "danger";
export type TaskCategory = "准备" | "进行中" | "待处理" | "已完成" | "已终止";

export type TaskStatusViewModel = {
  status: TaskStatus;
  label: string;
  tone: TaskTone;
  category: TaskCategory;
  stage: string;
  stageIndex: number;
  nextAction: string | null;
  unavailableReason: string | null;
  isTerminal: boolean;
};

const STATUS_META: Record<TaskStatus, Omit<TaskStatusViewModel, "status">> = {
  DRAFT: { label: "草稿", tone: "neutral", category: "准备", stage: "需求", stageIndex: 0, nextAction: "开始设计", unavailableReason: null, isTerminal: false },
  DESIGNING: { label: "设计中", tone: "info", category: "进行中", stage: "设计", stageIndex: 1, nextAction: null, unavailableReason: "设计运行正在进行，请等待完成。", isTerminal: false },
  SPEC_READY: { label: "规范待确认", tone: "warning", category: "待处理", stage: "规范", stageIndex: 2, nextAction: "检查并批准规范", unavailableReason: null, isTerminal: false },
  SPEC_INVALID: { label: "规范无效", tone: "danger", category: "已终止", stage: "规范", stageIndex: 2, nextAction: null, unavailableReason: "规范未通过校验，当前任务不能继续。", isTerminal: true },
  SPEC_APPROVED: { label: "规范已批准", tone: "success", category: "待处理", stage: "规范", stageIndex: 2, nextAction: "开始构建", unavailableReason: null, isTerminal: false },
  PREPARING_WORKTREE: { label: "准备工作区", tone: "info", category: "进行中", stage: "构建", stageIndex: 3, nextAction: null, unavailableReason: "正在准备隔离工作区，请等待完成。", isTerminal: false },
  BUILDING: { label: "构建中", tone: "info", category: "进行中", stage: "构建", stageIndex: 3, nextAction: null, unavailableReason: "构建运行正在进行，请等待完成。", isTerminal: false },
  BUILT: { label: "构建完成", tone: "success", category: "待处理", stage: "构建", stageIndex: 3, nextAction: "运行测试", unavailableReason: null, isTerminal: false },
  TESTING: { label: "测试中", tone: "info", category: "进行中", stage: "验证", stageIndex: 4, nextAction: null, unavailableReason: "测试正在进行，请等待完成。", isTerminal: false },
  DETERMINISTIC_GATE: { label: "确定性检查中", tone: "info", category: "进行中", stage: "验证", stageIndex: 4, nextAction: null, unavailableReason: "正在检查范围、测试与证据，请等待完成。", isTerminal: false },
  GATE_READY: { label: "待最终审核", tone: "warning", category: "待处理", stage: "审核", stageIndex: 5, nextAction: "开始最终审核", unavailableReason: null, isTerminal: false },
  REVIEWING: { label: "最终审核中", tone: "info", category: "进行中", stage: "审核", stageIndex: 5, nextAction: null, unavailableReason: "最终审核正在进行，请等待完成。", isTerminal: false },
  PASSED: { label: "审核通过", tone: "success", category: "已完成", stage: "完成", stageIndex: 6, nextAction: null, unavailableReason: "任务已通过审核；合并仍由你手动决定。", isTerminal: true },
  REWORK: { label: "需要返工", tone: "warning", category: "待处理", stage: "构建", stageIndex: 3, nextAction: "开始新的返工 Attempt", unavailableReason: null, isTerminal: false },
  FAILED: { label: "执行失败", tone: "danger", category: "已终止", stage: "完成", stageIndex: 6, nextAction: null, unavailableReason: "本次执行失败，需检查证据后重新创建任务或修正输入。", isTerminal: true },
  BLOCKED: { label: "已阻塞", tone: "danger", category: "已终止", stage: "完成", stageIndex: 6, nextAction: null, unavailableReason: "任务被阻塞，需先解决阻塞原因。", isTerminal: true },
  CANCELLED: { label: "已取消", tone: "neutral", category: "已终止", stage: "完成", stageIndex: 6, nextAction: null, unavailableReason: "任务已取消，不能继续执行。", isTerminal: true },
  INTERRUPTED: { label: "已中断", tone: "danger", category: "已终止", stage: "完成", stageIndex: 6, nextAction: null, unavailableReason: "应用无法证明进程仍受控，任务已安全中断。", isTerminal: true }
};

export const taskStatusViewModel = (status: TaskStatus): TaskStatusViewModel => ({ status, ...STATUS_META[status] });

export type TaskViewModel = TaskStatusViewModel & {
  id: string;
  title: string;
  requestText: string;
  baseSha: string;
  updatedAt: string;
  attemptLabel: string | null;
  hasSpec: boolean;
  hasEvidence: boolean;
  escalationPending: boolean;
};

export const createTaskViewModel = (task: TaskRecord, detail?: Pick<TaskDetailRecord, "attempt" | "snapshot" | "escalationPending"> | null): TaskViewModel => ({
  ...taskStatusViewModel(task.status),
  id: task.id,
  title: task.title,
  requestText: task.requestText,
  baseSha: task.baseSha,
  updatedAt: task.updatedAt,
  attemptLabel: detail?.attempt ? `Attempt ${detail.attempt.number}` : null,
  hasSpec: task.specJson !== null,
  hasEvidence: detail?.snapshot !== null && detail?.snapshot !== undefined,
  escalationPending: detail?.escalationPending ?? false
});

export const TASK_STAGE_LABELS = ["需求", "设计", "规范", "构建", "验证", "审核", "完成"] as const;
