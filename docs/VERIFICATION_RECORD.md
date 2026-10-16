# 验证记录与证据边界

本页供 GitHub 读者判断哪些结论可以从仓库重做，哪些属于项目当时保存的真实运行记录。它不声称公开仓库包含全部原始证据。

| 结论 | 依据类型 | 结果与限制 |
| --- | --- | --- |
| Git + Codex CLI 单 Task 可信执行路径 | 2026-09 的受控真实运行、阶段评估与 UI 验收 | 指定功能路径 `PASS`；广泛可靠性 `PARTIAL`。读者不能仅用离线测试重现真实模型结论 |
| 产品层 Phase 1.20–1.34 | 离线测试、合成夹具、技术 UI 与 Windows 开发包验收 | 证明相应技术路径，不证明正式产品规划或新产品业务效果 |
| 首次正式产品试点 | 正式桌面 App 的状态与请求结果 | `RUNTIME_NOT_QUALIFIED`；模型调用、开发 Task、Attempt、AgentRun 均为 0。见[案例](PILOT_CASE_STUDY.md) |
| 产品目标到交付 | 完整真实运行 | `NOT_RUN`；核心体验未通过验收 |
| 动态多 Agent 产品协作 | 代码与产品验收范围 | 未实现；Task 内角色顺序不能当成产品级动态分工 |

## 当前源码的离线检查

2026-10-13，在包含停止前全部本地工作区材料的 Windows 工作区执行：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

结果：类型检查、lint、构建通过；普通测试为 **648 passed、39 skipped、0 failed**。测试使用临时仓库或可控 fake executable，不调用真实模型。这个结果只对应当时的完整工作区；精选 GitHub 文件集需要重新安装依赖并复核。

精选本地展示仓库已在 2026-10-13 独立执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`：前四项通过。移除四个只对本机资格环境有效的手动脚本后，最终普通测试 JSON 报告为 **647 passed、37 skipped、0 failed**（106 个测试文件运行通过、28 个测试文件全部按条件跳过）。首次仅复制展示文件时，5 个测试暴露了两种真实依赖：Phase 1.6 计划文件缺失，及预览测试需要先构建本机服务。补入标记为去路径副本的计划，并调整验证顺序后，相关测试通过，最终精选文件集复测通过。与完整本地档案相比，精选集合少 1 项通过；跳过项包含未公开的本机资格条件，不应被解释为真实模型资格变化。

随后为提升展示可读性新增两张 SVG、体验地图、工程沉淀和 TaskSpec 示例导览，并修正示例中的旧路径与虚构测试命令。受示例影响的 `task-spec`、`schema-validation`、`product-run-service` 三个测试文件重新运行，**41 passed、0 failed**。平台测试执行入口 `test-runner.ts` 仅展开格式与类型排版，未改变执行分支；相关单元和集成测试 **5 passed、0 failed**，`typecheck`、`lint` 和 `build` 再次通过。14 个 Markdown 文件的本地链接和 2 张 SVG 的 XML 结构检查通过。这些定向复核不等于重新执行完整 647 项测试；完整测试数字对应展示优化前的精选副本。

2026-10-16 对历史运行指标界面做了可读性调整：将任务技术通过率的统计口径前置，区分产品验收，并重排确认记录与 usage 覆盖情况。`typecheck`、`lint`、`electron-vite build` 通过，定向 UI 测试 **2 passed、0 failed**。以复制的离线合成数据库启动构建后的 Electron 应用，在 1440、768、375 CSS 像素视口检查指标内容和水平溢出；三种宽度的指标面板均未水平溢出。README 的新截图是 1440 视口中指标区域的直接截取。此项是展示与解释优化，不是重新验证正式试点、真实模型资格或完整测试集。

源码中的可检查实现包括 [`task-orchestrator.ts`](../src/main/orchestrator/task-orchestrator.ts)、[`git-service.ts`](../src/main/git/git-service.ts)、[`deterministic-gate.ts`](../src/main/gate/deterministic-gate.ts)、[`database.ts`](../src/main/db/database.ts)、[`schemas/`](../schemas/) 与 [`tests/`](../tests/)。

## 未随展示仓库提供的材料

真实运行日志、用户数据库、原始运行截图、受管 worktree、完整会话、WSL 环境与 Windows 安装包留在本地，不作为公开样例数据。仓库仅保留明确标注的离线合成夹具截图，包括调整前后的两张界面图。原阶段评估和哈希索引仍在项目档案中；哈希索引不是证据文件的备份。因此公开仓库读者可复核代码及离线测试，但不能独立复现所有历史真实运行结论。
