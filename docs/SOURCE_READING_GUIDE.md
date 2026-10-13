# 源码阅读路线

这个仓库适合研究“平台怎样控制 Agent 写代码的边界，以及为什么技术闭环没有自动变成产品闭环”。先看 [README](../README.md) 的能力表与[体验地图](EXPERIENCE_MAP.md)，再按感兴趣的路径进入代码。想评估哪些做法能复用，可对照[工程沉淀](ENGINEERING_TAKEAWAYS.md)。普通离线测试须先执行 `pnpm build`，因为本机静态预览测试需要构建出的服务文件。

## 路线一：可信任务执行

1. [`TaskOrchestrator`](../src/main/orchestrator/task-orchestrator.ts)：从 TaskSpec 批准到 Attempt、Worker、TestRun、Gate 和终审的状态推进。
2. [`GitService`](../src/main/git/git-service.ts) 和[进程适配器](../src/main/process/runner.ts)：基线检查、受管 worktree、命令参数、超时与取消。
3. [确定性 Gate](../src/main/gate/deterministic-gate.ts) 与 [`schemas/`](../schemas/)：将模型输出、范围、Diff 与平台测试证据分开检查。
4. [Orchestrator 集成测试](../tests/integration/orchestrator.test.ts) 和 [Git 集成测试](../tests/integration/git-service.test.ts)：用临时仓库和 fake Agent 验证拒绝路径与成功路径。

读到这里可以回答：Worker 说“完成”之后，平台还需要什么证据？若 Reviewer 修改 worktree 或证据在审查前漂移，状态会怎样？

## 路线二：产品目标到单 Task

1. [产品服务](../src/main/products/)：目标版本、方向确认、计划、仓库绑定、运行、预览和未发布交付。
2. [产品共享契约](../src/shared/contracts/) 与 [Preload](../src/preload/)：Renderer 能调用什么、请求/返回怎样验证。
3. [产品工作流测试](../tests/integration/product-workflow.test.ts) 和 [规划测试](../tests/integration/product-planning.test.ts)：观察离线流程及资格门禁。
4. [首次正式试点](PILOT_CASE_STUDY.md)：正式 App 在规划派发前返回 `RUNTIME_NOT_QUALIFIED`，解释了为什么上述离线流程不能证明核心体验。

读到这里应区分：代码有产品数据结构、UI 和单 Task 连接，与“主 Agent 动态安排多个 Agent 做出一个产品”之间还差什么。

## 路线三：数据和证据

1. [数据库迁移](../src/main/db/database.ts) 与 [数据接口导览](ARCHIVE_DATA_INTERFACES.md)：Task/Attempt/Run 与目标、计划、回执如何存储。
2. [运行控制](../src/main/runs/run-control.ts) 和 [数据库测试](../tests/unit/database.test.ts)：重启、事件和运行事实怎样持久化。
3. [验证记录](VERIFICATION_RECORD.md)：仓库可重做的离线检查与本地留存的历史真实运行证据如何区分。

这里可借鉴的是状态、操作回执和证据各有身份；不能用模型的文字结果替代平台执行的测试，也不能用测试数量代替用户产品验收。

## 历史测试材料

`tests/manual/` 包含当时为真实模型或本机 Cursor/WSL 资格评估准备的受门禁保护脚本。它们引用本地档案中的批准文件、环境或证据，**不是公开仓库的一键验收套件**。普通 `pnpm test` 只运行其中可离线执行的部分，其余按条件跳过。分类与边界见[手动测试导览](../tests/manual/README.md)。一个 Phase 1.6 计划的去路径副本作为哈希输入保留在展示仓库；它不授权重新执行历史真实调用。
