# 静态案例页 UI 审计与实现基线

审计日期：2026-10-15。目标表面：新增的只读静态案例页 `case-study/`。本记录先于实现创建，依据现有公开复盘、源码与 `readable-web-ui` 的可读性门槛；不把源码扫描表述为浏览器验证。以下矩阵保留初轮状态；修复后的最终结果见 [UI_QA.md](UI_QA.md)。

## 读者、任务与保留边界

- **主要读者**：评估该项目工程方法、产品判断和可复用边界的招聘者、工程师与产品开发者。
- **主要任务**：先确认项目已经停止及原因，再区分产品目标、受控单 Task 成果、正式试点结果，最后进入相应源码。
- **保留边界**：只复述公开文档已有事实；保留 Electron 36 + React 18 + TypeScript + SQLite + Git worktree + Codex CLI 技术栈，不改 Electron 内核；截图只使用已有离线合成夹具；页面无网络、托管、字体或脚本依赖。
- **视觉约束**：浅色背景 `#f3f6f8`、内容色 `#102536`、导航/强调色 `#12685f`；正文至少 16px，标签至少 13px；不对中文正文强制字距。

## 按影响排序的发现

### [P0] 停止状态必须成为首屏最高层级事实

- **Layer**: required
- **Evidence**: `docs/PROJECT_RETROSPECTIVE.md:3,17-21` 将状态记录为 `DISCONTINUED`，并说明正式规划在任何 Agent 派发和 Task 创建前停止；`docs/PILOT_CASE_STUDY.md:3,7` 记录 `BLOCKED_RUNTIME_NOT_QUALIFIED` 及模型调用、Task、Attempt、AgentRun 均为 0。
- **Impact**: 若读者先看到技术成果或指标截图，会把已停止的产品误读为可运行平台，或把夹具状态误读为业务交付。
- **Basis**: 内容诚实、页面目的和当前状态不应依赖读完整页才可辨认。
- **Minimal fix**: 在跳转导航后的首屏放置明确的“已停止开发”状态带、日期和一句话边界；在任何成果数字之前呈现正式试点的停止节点。
- **Confidence**: high
- **Verification**: not tested；实现后需在 320、375、768、1440 CSS px 核对首屏阅读顺序。

### [P1] 产品目标、受控单 Task 与正式产品试点必须分为三条证据层级

- **Layer**: required
- **Evidence**: `docs/EXPERIENCE_MAP.md:9-15,17-29` 明确单 Task 指定路径为 `PASS/PARTIAL`，产品级协作未证明，真实交付为 `NOT_RUN`；`src/main/orchestrator/task-orchestrator.ts:434-444,477-505,551-616,668-725` 分别实现规范批准、受管 worktree、Worker、平台测试、确定性 Gate 和只读终审；这是一条顺序角色链。
- **Impact**: 合并叙述会把局部技术验收外推成多 Agent 产品闭环，破坏案例可信度。
- **Basis**: 内容完整性与信息层级；公开复盘明确禁止该外推。
- **Minimal fix**: 使用“目标现实”对照和有顺序的单 Task 流程；把产品试点作为单独的停止轨道，并使用 `PASS / PARTIAL / NOT_RUN / 未实现` 文本而非只靠颜色。
- **Confidence**: high
- **Verification**: not tested；实现后检查无障碍阅读顺序及禁用 CSS 时的语义顺序。

### [P1] 截图必须在可见上下文中标明“离线合成夹具”

- **Layer**: required
- **Evidence**: `docs/EXPERIENCE_MAP.md:31-35` 与 `docs/ENGINEERING_TAKEAWAYS.md:29-33` 说明截图来自 Phase 1.34 离线合成夹具，其中 100% 仅为 1/1 个夹具 Task 的技术状态，不代表真实产品交付。
- **Impact**: 仅靠 alt 文本或远处说明不足以阻止视觉读者误解截图的真实性与指标含义。
- **Basis**: 内容诚实；截图和指标必须可追溯或明确标记为夹具。
- **Minimal fix**: 在图片紧邻位置提供醒目标记，并在 `figcaption` 再次说明来源、分母与不证明的事项；alt 文本同步包含“合成夹具”。
- **Confidence**: high
- **Verification**: not tested；实现后检查图注在 320px、200% 文字缩放下不被裁切。

### [P1] 导航、源码入口和焦点必须可由键盘可靠操作

- **Layer**: required
- **Evidence**: 计划中的交互仅需页内导航和链接；无需自制按钮。`docs/SOURCE_READING_GUIDE.md:5-29` 已给出任务执行、产品流程、数据证据三条阅读路线。
- **Impact**: 若以非语义元素模拟导航或移除焦点，键盘用户无法确认当前位置和目标。
- **Basis**: WCAG 2.2 键盘操作、焦点可见、名称与说明、目标尺寸。
- **Minimal fix**: 使用 `header/nav/main/section/footer`、真实 `<a>` 和有序列表；提供跳到正文链接；焦点指示颜色与背景达到可辨识对比，点击目标至少 24px。
- **Confidence**: high
- **Verification**: not tested；浏览器中完整 Tab 遍历、Enter 激活与焦点遮挡检查由根代理执行。

### [P1] 页面在 320px 和文本放大时不能依赖横向滚动

- **Layer**: required
- **Evidence**: 新页面包含状态对照、流程和长源码路径；这些是最可能造成溢出的内容。用户明确要求响应式 320px。
- **Impact**: 手机与 400% reflow 用户可能看不到结论或链接尾部。
- **Basis**: WCAG 2.2 Reflow 与 Resize Text。
- **Minimal fix**: 单列优先；网格只在空间足够时展开；源码路径允许安全断行；图片自适应；不使用必须横向滚动的数据表。
- **Confidence**: high
- **Verification**: not tested；需测 320/375/768/1440px、200% 文字放大与等效 400% reflow。

### [P2] 工程取舍应从结论直接链接到实现，而不是只列技术名词

- **Layer**: contextual
- **Evidence**: `src/main/index.ts:96-97` 创建规划器时未传入资格；`src/main/products/product-planner.ts:45,50` 令资格缺省为 false 并抛出 `RUNTIME_NOT_QUALIFIED`；`src/main/git/git-service.ts:30-43` 检查 clean/base SHA 并创建 worktree；`src/main/orchestrator/task-orchestrator.ts:551-616,668-725` 运行平台测试、Gate、证据身份核对和只读终审。
- **Impact**: 读者若只能看到概念摘要，难以判断案例是否有真实实现支撑，也难以复用取舍。
- **Basis**: 文档型页面的稳定锚点、阅读路径和例证应直接服务主任务。
- **Minimal fix**: 每项取舍同时写“选择 / 代价或边界 / 源码入口”，链接使用相对于 `case-study/index.html` 的本地路径。
- **Confidence**: high
- **Verification**: not tested；静态测试验证目标文件存在，浏览器验证链接可打开或正确导航。

### [P3] 视觉结构应来自“状态与证据链”，避免通用营销落地页节奏

- **Layer**: preference
- **Evidence**: 项目是停止后的工程案例而非产品营销；现有公开材料围绕状态、证据等级、运行链和缺口组织。
- **Impact**: 常见的英雄区—卖点卡片—CTA 结构会弱化失败复盘的严肃性，并让状态与成果竞争视觉注意力。
- **Basis**: 产品特定的信息架构与反模板启发式。
- **Minimal fix**: 采用“状态档案 + 证据轨道 + 源码索引”的编辑式布局；装饰服从阅读路径，不引入渐变、虚构应用框或网络图标库。
- **Confidence**: high
- **Verification**: not tested；1440px 浏览器截图核对视觉层级，由根代理执行。

## 实现前验证矩阵

| 检查 | 状态/视口 | 当前结果 | 实现后的通过条件 |
| --- | --- | --- | --- |
| 内容诚实 | 全页 | fail（页面尚不存在） | 停止状态、0 次调用/Task/Run、夹具性质和未实现能力均与公开文档一致 |
| 语义结构 | 源码 | fail（页面尚不存在） | 唯一 `h1`，标题层级连续，存在 `nav/main/section/footer` 和跳到正文链接 |
| 键盘与焦点 | 浏览器 | not tested | 所有链接可 Tab 到达、Enter 激活，焦点清晰且不被粘性导航遮挡 |
| 文本/非文本对比 | 计算样式 | not tested | 正文至少 4.5:1，焦点与必要边界至少 3:1 |
| Reflow | 320/375/768/1440px | pass（根代理初轮浏览器结果） | 四个宽度无页面级横向滚动 |
| 文字放大 | 375px、根字号 200% | fail（根代理修复前结果） | 已修复全宽背景布局；最终全元素字号加倍复测见 UI_QA.md |
| 文本间距覆盖 | WCAG 1.4.12 参数 | not tested | 无裁切、重叠或隐藏 |
| Reduced motion | reduce | not tested | 无必要信息依赖动画；滚动行为不强制动画 |
| 本地完整性 | 静态测试 | not tested | 无外部 URL 资源；所有相对文件链接和图片存在；Electron 源码无改动 |

## 计划修改范围

- 新增 `case-study/index.html` 与 `case-study/styles.css`。
- 新增静态结构/链接/约束测试，不改已有测试。
- 更新中英文 README 的案例页运行入口与 `CHANGELOG.md`。
- 不修改 `src/main/`、`src/preload/`、`src/renderer/`、依赖、许可证、托管配置或 Electron 构建入口。

浏览器视觉 QA、键盘遍历与截图由根代理执行；在其结果返回前，本记录与交付不得声称这些项目通过。
