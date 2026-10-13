# 阅读 TaskSpec 示例

[`task-spec.example.json`](task-spec.example.json) 是说明跨 Agent 任务契约的**虚构输入**，不是一次真实运行记录或可直接执行的任务。`base_sha` 是占位哈希，`TASK-001` 是示例身份；要用于自己的仓库，必须先由平台锁定真实干净仓库的基线，并由用户批准规范与测试命令。

| 字段 | 阅读时抓住什么 |
| --- | --- |
| `goal`、`acceptance_criteria` | 想实现什么，以及谁来判断结果 |
| `base_sha` | 改动必须相对于哪个 Git 基线 |
| `context_paths` | Agent 可读取的背景；**不扩大写入权限** |
| `scope.allowed_paths` / `forbidden_paths` | 可改与不可改的路径边界 |
| `test_commands` | 平台运行的结构化命令：`program`、`args`、`cwd`、`timeout_seconds`；这里的 Git 集成测试只是示例，不能单独证明全部 UI 验收项 |
| `execution_policy`、`limits` | Worker 路由建议与有界执行的上限 |

权威结构见 [`task-spec.schema.json`](../schemas/task-spec.schema.json)，跨字段语义检查见 [`task-spec.ts`](../src/shared/core/task-spec.ts)。完整执行还要求用户批准、真实 worktree、平台 TestRun 和 Gate；流程见[体验地图](../docs/EXPERIENCE_MAP.md)。
