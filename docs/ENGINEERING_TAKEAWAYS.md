# 可复用的工程做法与不该照搬的部分

这不是未来开发路线图。本文把已实现的代码、历史验收和停止后的推断分开，帮助读者判断哪些做法值得移植，哪些设计在真实产品体验面前仍需重新验证。整体状态先看[体验地图](EXPERIENCE_MAP.md)和[证据记录](VERIFICATION_RECORD.md)。

## 1. 把 Agent 的建议和平台的事实分开

**问题**：Worker 可以声称测试通过，但它的输出不是测试证据。

**实现**：`TaskSpec` 先经权威 JSON Schema 和跨字段语义校验；测试由平台的 [`runApprovedTests`](../src/main/testing/test-runner.ts) 执行；[`deterministic-gate.ts`](../src/main/gate/deterministic-gate.ts) 核查范围、Diff 和测试结果，失败后不能让 Final Gate “解释放行”。[`TaskOrchestrator`](../src/main/orchestrator/task-orchestrator.ts) 在终审前还核对工作区和证据身份。

**可借鉴**：把模型结果当候选，把退出码、Diff、哈希和平台启动的 TestRun 当事实。若业务结果不能用测试命令表达，还需要单独的人工或产品验收；本项目的单 Task 功能验收不能代替这一层。

## 2. 隔离写入，但不要把 worktree 当沙箱

**问题**：Agent 改代码需要独立工作区，同时避免碰到用户正在使用的主 checkout。

**实现**：[`GitService`](../src/main/git/git-service.ts) 要求目标仓库干净、HEAD 符合批准基线，并为每个 Attempt 建唯一分支和受管 worktree；[`Codex adapter`](../src/main/adapters/codex/codex-adapter.ts) 另要求 Worker 使用 `workspace-write` 沙箱。外部进程由 [`runner.ts`](../src/main/process/runner.ts) 管理。平台不自动提交、推送或合并。

**可借鉴**：Git 工作区解决版本与审查边界，执行沙箱解决 Agent 权限边界；两者职责不同。将此模式用于其他 CLI Agent 前，需重新核对该工具自己的沙箱、环境和取消语义。

## 3. 版本、回执和未知值要有独立身份

**问题**：用户修改目标、重复点击或进程中断后，系统不能把旧结果误归到新目标，也不能凭缺失数据编出指标。

**实现**：[`product-service.ts`](../src/main/products/product-service.ts) 保存目标修订、哈希、事件和幂等请求回执；[数据库迁移](../src/main/db/database.ts) 存储执行关系。产品指标从历史运行事实派生；缺失 token usage 或时长仍显示未知，见 [`ProductMetricsPanel.tsx`](../src/renderer/src/features/products/ProductMetricsPanel.tsx)。

**可借鉴**：业务意图、操作回执、运行事实和展示指标不应混成同一字段。这里的做法支持审计与恢复，但并未证明整个产品流程可用。

## 4. UI 的“技术完成”不能替代用户结果

**观察**：[合成夹具截图](assets/product-metrics-synthetic-fixture.png)显示“100% 技术完成率”，其分母只有 1 个夹具 Task；界面也标明它不代表当前计划进度。首次正式产品试点却在规划前被资格门禁阻断，没有交付产品。

**复盘推断**：如果重新设计 UI，首页应首先显示用户目标是否形成可用交付，再显示 Task、Attempt、Run 等技术指标；区分“已测试”“未运行”“资格阻断”和“用户验收”。该建议来自本项目的误读风险，**不是**经过可用性实验验证的最优布局。

## 5. 先证明端到端价值，再扩大外围能力

**事实**：单 Task 内核有一次受控功能通过；产品层增加了计划、运行、预览、交付和指标，但正式 App 的产品规划仍未取得真实资格，动态多 Agent 产品协作也没有验收。[首次试点](PILOT_CASE_STUDY.md)未创建开发 Task。

**复盘推断**：更早选择一个真实、边界清楚的产品目标，并以“正式 App 发起 → 规划 → 派发 → 验证 → 用户收到可用结果”作为继续投入门槛，可能更快发现偏差。随后应与直接使用现有 Agent 产品做同条件比较，确认平台是否提供了额外价值。项目没有这项比较，不能宣称质量、速度或成本优势。

## 如何使用这份案例

- 要理解运行步骤和未实现能力：读[体验地图](EXPERIENCE_MAP.md)。
- 要核对字段、IPC 与 Schema：读[数据与接口](ARCHIVE_DATA_INTERFACES.md)。
- 要从入口追到测试：按[源码阅读路线](SOURCE_READING_GUIDE.md)。
- 要区分历史真实运行和公开仓库可重做的检查：读[验证记录](VERIFICATION_RECORD.md)。

本仓库是停止开发时的实现快照与去个人化复盘，不是后续开发承诺，也不是生产部署说明。
