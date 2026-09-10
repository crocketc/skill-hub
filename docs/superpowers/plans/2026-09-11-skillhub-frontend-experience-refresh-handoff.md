# SkillHub 前端体验升级 Goal 交接指令

将下面整段内容发送给负责实施的主 Agent。该 Agent 应创建并管理 Goal，不应一次性在当前工作区直接修改全部页面。

---

你现在负责 SkillHub 前端体验升级 Goal。请先创建一个 Goal，目标是：

> 在不改变 SkillHub 业务、安全和本地优先边界的前提下，建立统一的前端设计基础，重做设置与 LLM 配置体验，将发现页和 Skill 库升级为小卡片浏览模式，并系统迁移其余桌面页面；完整保留 9 个预设主题、现有品牌资产、功能行为和自动化证据。完成共享基础、重点页面、其余页面、自动化、独立审查和开发文档后，才能标记 Goal 完成。

开始前必须完整阅读：

1. 仓库根目录 `AGENTS.md`
2. 仓库根目录 `README.md`
3. 通过 `find docs/development -maxdepth 1 -name '开发状态-*.md'` 解析唯一最新文件并阅读
4. 通过 `find docs/development -maxdepth 1 -name '自动化测试说明-*.md'` 解析唯一最新文件并阅读
5. 通过 `find docs/development -maxdepth 1 -name '功能完成度与验收状态矩阵-*.md'` 解析唯一最新文件并阅读
6. `docs/superpowers/specs/2026-09-11-skillhub-frontend-experience-refresh-design.md`
7. `docs/superpowers/plans/2026-09-11-skillhub-frontend-experience-refresh-goal.md`

如果上述三份前端规划文档尚未进入提交，先将它们作为 Goal 的协调基线提交；若没有提交授权，停止派发并请用户确认。任何子 worktree 都必须从包含这些计划的提交创建。

Goal 主 Agent、所有实施子 Agent 和独立审查 Agent 都必须使用并遵守 `frontend-design`、`web-design-guidelines`、`vercel-react-best-practices` 和 `tdd`。每次审查界面前刷新最新 Web Interface Guidelines。所有行为变化严格执行一条失败测试、一项最小实现、一次绿灯的垂直切片；测试公开 DOM、可访问名称、状态、焦点和用户操作，不新增依赖 CSS 类名、CSS 文本正则或内部实现的测试。

`vercel-react-best-practices` 只应用于 Vite/React 客户端相关规则：请求瀑布、包体、重渲染、渲染效率、长列表和 JavaScript 热路径。跳过 Next.js、服务端渲染和 React Server Components 专属规则。任何性能修改都要先有可复现证据，不为套用规则改变业务语义、引入新框架或进行无证据的缓存优化。

先执行只读基线检查：

- `git fetch --prune origin`
- 当前分支、HEAD、远端分歧和 `git status`
- `git worktree list --porcelain`
- 当前未提交内容归属
- Goal 计划第 2 节列出的固定前端测试、check、build 和 E2E 基线

不要假设计划中记录的 `8e267be` 仍是最新基线。Playwright 使用 `--output` 写入任务专用 `/tmp` 目录；不得清理、提交或覆盖 `.gientech/`、`test-results/` 及其他用户未提交内容。

实施顺序严格按照 Goal 计划：

1. 先由一个 Agent 在独立 worktree 完成 T0 共享基础并通过完整验证。
2. T0 合并后，可以并行派发 T1 设置/LLM、T2 发现/Skill 卡片和不依赖共享卡片的 T3 子任务。
3. T3-B Skill 库必须等待 T2 冻结共享 SkillCard 契约。
4. T4-A、T4-B 按计划依赖可开始；T4-C 等待 T4-B 步骤壳层提交，T4-D 等待 T4-C 流程状态/操作区提交。
5. 每个 Agent 使用独立 `codex/` 分支和 worktree，只修改任务分配的文件。
6. T0 阶段由 T0 Agent 独占共享基础文件；T0 合并后，`base.css`、主题、AppShell、Sidebar、公共 UI、路由、翻译、锁文件、绑定和开发文档由主 Agent/集成 Agent 串行维护。
7. 并行 Agent 的翻译和预览路由以清单交回；每个 Task 提交后立即做一次波次集成并跑完整 Green，不拖到 T5。
8. 每个子任务必须提交后报告哈希、红/绿证据、测试结果、文件清单和遗留项；不要由子 Agent 推送或合并。
9. 合并后使用独立审查 Agent 检查设计规范、无障碍、响应式、主题和任务范围；审查 Agent 不直接混合修复。
10. 最后更新 `docs/development/` 四份当前文档，保持每类只有一个最新日期入口。

以下为硬性不可破坏条件：

- 保留 `moss-neutral`、`spring-signal`、`terracotta`、`codex-light`、`ocean-cobalt`、`sakura`、`aurora`、`roast`、`grok-night` 9 个主题的名称、顺序、持久化和 system/light/dark 映射。
- 不修改 Rust 后端、数据库、生成绑定、LLM 协议、凭据安全存储、网络闸门、AI 默认关闭和确定性安全检查边界。
- 不新增 Git 同步、OAuth、设备同步、NAS 功能或参考项目特有能力。
- 不新增第三方图标库或在线字体，除非先单独报告理由并取得用户确认。
- 不复制 cc-switch 的凭据 JSON、代理/路由/故障转移；不复制参考项目的渐变、玻璃、全卡点击或 `transition-all`。
- 图标状态必须配文字，图标按钮至少 40×40px 且有无障碍名称。
- 不删除测试、降低断言、使用任意延时或隐藏溢出来获得通过。
- 不将自动化描述成 Windows/macOS 真机视觉验收。

每轮最多并行处理文件不重叠的任务。若共享文件、产品范围、接口或架构发生冲突，停止对应任务并报告；不要自行扩大范围。

Goal 未达到计划第 13 节的全部完成定义前，不得标记为完成。若被阻塞，按 Goal 工具规则保留证据并继续推进其他安全、无冲突的任务。

---

## 子 Agent 派发模板

Goal 主 Agent 为每个子任务复制下面模板，并用 Goal 计划中的具体内容替换方括号：

```text
你负责 SkillHub 前端体验升级的 [Task 编号和名称]。

基线提交：[由 Goal 主 Agent 填写的已验证提交]
分支：[codex/...]
worktree：[独立 worktree 路径]

开始前完整阅读 AGENTS.md、前端体验设计规格和 Goal 计划中的 [对应章节]。只修改该章节列出的文件；共享文件和禁止事项严格按计划执行。

本任务必须使用 frontend-design、web-design-guidelines、vercel-react-best-practices 和 tdd。vercel-react-best-practices 只应用于 Vite/React 客户端相关规则；跳过 Next.js/服务端专属规则，并为实际性能改动提供可复现证据。

本任务必须使用 TDD：每次只完成一个垂直切片，先运行失败测试并记录准确失败原因，再做最小实现并运行绿灯。测试只通过公开 DOM、可访问名称、状态、焦点和用户操作验证，不新增 CSS 类名、CSS 文本正则或内部实现断言。

保留全部 9 个预设主题及其持久化兼容，不写死主题色；不修改业务规则、后端、绑定、数据库、安全边界和不属于本任务的页面。不得处理 .gientech、test-results 或其他用户未提交文件。

完成后运行本任务定向测试、完整前端测试、check、build、相关 E2E 和 git diff --check。Playwright 输出写入任务专用 /tmp 目录，不覆盖现有 test-results。提交一个英文动词开头的独立提交，不推送、不合并。

最终报告必须包含：基线、分支、worktree、修改文件、每个红/绿证据、验证命令与结果、800/1024/1280/1440px 和主题覆盖、适用及跳过的 React 性能规则与证据、提交哈希、遗留问题、人工验收边界，以及是否严格遵守文件所有权。
```
