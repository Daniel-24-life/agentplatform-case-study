import type { ProductOverview } from "../../../../shared/contracts/products.js";
import type { ProductPlanState } from "../../../../shared/contracts/product-plan.js";
import type { ProductExecutionState } from "../../../../shared/contracts/product-execution.js";
import type { ProductRunAction } from "../../../../shared/contracts/product-run.js";
import type { ProductDeliveryState } from "../../../../shared/contracts/product-delivery.js";
import type { TaskRecord } from "../../../../shared/contracts/records.js";
import type { RuntimePreflightSummary } from "../../../../preload/types.js";

export type ProductProgressSnapshot = {
  overview: ProductOverview;
  plan: ProductPlanState;
  execution: ProductExecutionState;
  task: TaskRecord | null;
  specHash: string | null;
  run: ProductRunAction | null;
  delivery: ProductDeliveryState;
  runtime: RuntimePreflightSummary | null;
  planningAvailable: boolean;
};
export type ProductProgressAction = "goal" | "plan" | "repository" | "task" | "runtime" | "run" | "delivery";
export type ProductProgress = {
  title: string;
  description: string;
  action: ProductProgressAction;
  actionLabel: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  milestones: Array<{ label: string; complete: boolean }>;
};

/** Read-only guidance. This view never approves, dispatches, retries or persists state. */
export function getProductProgress(snapshot: ProductProgressSnapshot, dirty: boolean): ProductProgress {
  const { overview, plan, execution, task, run, delivery, runtime } = snapshot;
  const productId = overview.product.id;
  const direction = overview.product.confirmedGoalRevision === overview.goal.revision;
  const currentPlan = direction && plan.directionConfirmed && plan.current && Boolean(plan.saved?.confirmedAt) &&
    plan.saved?.plan.productId === productId && plan.saved.plan.goalRevision === overview.goal.revision && plan.saved.plan.goalHash === overview.goal.hash;
  const link = execution.link;
  const linked = currentPlan && execution.productId === productId && execution.planCurrent && execution.planConfirmed &&
    execution.planRevision === plan.saved?.revision && link?.productId === productId && link.planRevision === plan.saved?.revision &&
    task?.id === link.taskId && task.projectId === execution.repositoryId;
  const currentDelivery = linked && delivery.productId === productId && delivery.current &&
    delivery.latest?.goalRevision === overview.goal.revision && delivery.latest.goalHash === overview.goal.hash &&
    delivery.latest.planRevision === plan.saved?.revision && delivery.latest.planHash === plan.saved?.hash && delivery.latest.evidence.taskId === task?.id;
  const evidenceStale = linked && delivery.latest?.evidence.taskId === task?.id && delivery.latest.goalHash === overview.goal.hash &&
    delivery.latest.planHash === plan.saved?.hash && !delivery.current;
  const milestones = [
    { label: "方向已确认", complete: direction },
    { label: "计划已确认", complete: currentPlan },
    { label: "任务已关联", complete: linked },
    { label: "技术检查通过", complete: linked && task?.status === "PASSED" && !evidenceStale },
    { label: "业务已接受", complete: currentDelivery && delivery.latest?.status === "ACCEPTED_UNPUBLISHED" }
  ];
  const view = (title: string, description: string, action: ProductProgressAction, actionLabel: string, tone: ProductProgress["tone"] = "neutral"): ProductProgress =>
    ({ title, description, action, actionLabel, tone, milestones });

  if (dirty) return view("目标有未保存修改", "先保存并确认当前方向，再推进其对应计划；已完成记录仍保留。", "goal", "查看目标修改", "warning");
  if (!direction) return view("等待确认产品方向", "明确目标、范围和可观察的验收标准，保存后确认。", "goal", "完善并确认方向");
  if (!currentPlan) return view("等待确认开发计划", "为当前方向安排工作项、交付物与验收覆盖；旧版本计划不能继续执行。", "plan", "查看开发计划");
  if (!execution.repositoryId) return view("等待绑定工作仓库", "选择已注册的干净 Git 仓库，整个计划将在一个共同任务中完成。", "repository", "选择工作仓库");
  if (link && (!linked || !task)) return view("任务关联需要核对", "当前计划关联与任务记录不一致，请核对记录后继续。", "repository", "核对任务关联", "warning");
  if (!linked || !task) return view("等待创建完整计划任务", "将已确认计划关联到任务，再由任务页生成并审阅具体规范。", "repository", "查看任务关联");

  const currentRun = run?.productId === productId && run.taskId === task.id && run.planRevision === plan.saved?.revision && run.specRevision === task.specRevision && run.specHash === snapshot.specHash ? run : null;
  if (currentRun?.status === "PAUSE_REQUESTED") return view("正在等待当前阶段暂停", "暂停请求已记录，当前阶段收敛后停止后续派发。", "run", "查看暂停进展", "info");
  if (currentRun?.status === "CANCEL_REQUESTED") return view("正在取消当前运行", "已请求停止当前运行；尚未确认停止时不会显示取消完成。", "run", "查看取消进展", "warning");
  if (currentRun?.status === "RUNNING") return view("平台正在执行计划", "构建、平台测试与只读审查按已批准规范推进；可查看进展、暂停或取消。", "run", "查看执行进展", "info");
  if (["DESIGNING", "PREPARING_WORKTREE", "BUILDING", "TESTING", "DETERMINISTIC_GATE", "REVIEWING"].includes(task.status)) return view("任务正在推进", "当前任务阶段正在运行，平台将记录真实结果。", "task", "查看当前任务", "info");
  if (["REWORK", "FAILED", "BLOCKED", "INTERRUPTED", "CANCELLED", "SPEC_INVALID"].includes(task.status)) {
    const reasons: Partial<Record<TaskRecord["status"], string>> = {
      REWORK: "测试或审查要求返工；查看证据和修复要求，平台不会绕过检查。",
      FAILED: "执行未通过；查看任务证据后决定如何修复。",
      BLOCKED: "任务被阻断；查看运行环境或门禁失败原因。",
      INTERRUPTED: "运行被中断；先核对任务与进程，应用不会自动重复派发。",
      CANCELLED: "任务已取消；保留现有证据，检查后决定后续安排。",
      SPEC_INVALID: "生成的规范未通过校验；需要先处理具体校验问题。"
    };
    return view("任务需要处理", reasons[task.status]!, "task", "查看原因与证据", "danger");
  }
  if (task.status === "PASSED") {
    if (evidenceStale) return view("交付证据需要重新核对", "任务曾通过技术检查，但保存的交付与当前内容或证据不再一致；不能沿用旧验收。", "task", "核对任务证据", "warning");
    if (currentDelivery && delivery.latest?.status === "ACCEPTED_UNPUBLISHED") return view("当前产品增量已接受，未发布", "技术与业务验收已有记录；预览和发布仍未运行。可查看交付或根据反馈修订目标。", "delivery", "查看当前交付", "success");
    return view("等待产品业务验收", "技术检查已通过；逐条记录产品标准、观察说明、运行方式和限制。", "delivery", "完成产品验收");
  }
  if (currentRun?.status === "FAILED" || currentRun?.status === "INTERRUPTED") return view("连续执行需要核对", "上一动作失败或中断；核对原因和剩余阶段后再决定，平台不会自动重试。", "task", "核对执行记录", "warning");
  if (task.status === "DRAFT" || task.status === "SPEC_READY") return view("等待审阅任务规范", task.status === "DRAFT" ? "在任务页生成具体规范；生成规范需要可用的运行环境和模型额度。" : "检查改动范围、测试命令和资源限制，再明确批准。", "task", "查看任务规范");
  if (!task.specApprovedAt || !task.specJson || task.specRevision < 1) return view("任务规范尚未有效批准", "批准的规范是执行权限依据，不能用界面提示代替批准记录。", "task", "核对任务规范", "warning");
  if (!runtime?.passed) return view("运行环境尚未通过检查", "先到运行环境检查可用性；该导航不会发起模型请求。", "runtime", "查看运行环境", "warning");
  if (currentRun?.status === "CANCELLED") return view("上次执行已取消，可重新安排", "平台不会自动恢复；如需继续，请核对任务后明确允许剩余阶段。", "run", "查看执行安排", "warning");
  return view(currentRun?.status === "PAUSED" ? "执行已暂停，可确认后继续" : "已批准计划等待执行", "在执行面板明确允许剩余阶段，平台再按已批准规范推进。", "run", "查看执行安排");
}
