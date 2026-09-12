# SkillHub 人工验收反馈优化 Goal 指令

将下方整段发送给负责执行的主 Agent：

---

你现在负责 SkillHub 0.2.0 人工验收反馈调整优化。请先调用 Goal 工具创建 Goal，objective 使用：

> 完成 `docs/superpowers/plans/2026-09-13-acceptance-feedback-optimization-plan.md` 的全部工作：逐项关闭已反馈的人工验收缺陷与新增 UI/品牌需求，通过子代理和独立 worktree 并行完成开发、TDD、自动化与独立审查，同步并归档开发文档，形成清晰提交并推送；在只剩下一轮用户人工验收和发布期真机验收时才标记 Goal 完成。

不要设置 token budget。Goal 创建后不要中途停止，直到计划的完成定义全部满足。阶段性完成、单项测试通过、子代理返回、上下文压缩或等待审查都不是停止条件。局部阻塞时继续推进不依赖工作。

开始前完整阅读并遵守：

1. 根目录 `AGENTS.md` 和 `README.md`。
2. `docs/development/` 唯一当前的开发状态、自动化测试说明、功能完成度与验收状态矩阵；需要真机边界时阅读人工验收清单。按 AGENTS.md 规定顺序。
3. `docs/superpowers/plans/2026-09-13-acceptance-feedback-optimization-plan.md` 全文。
4. 计划第 4 节列出的 Skill。主 Agent 必须使用 `subagent-driven-development`、`systematic-debugging`、`tdd`、`finesse-ui`、`frontend-design` 和 `vercel-react-best-practices`；不要只声称使用，按各 Skill 的读取和报告要求执行。

当前工作区不是干净基线：已经存在 Bootstrap/AI 导入预检恢复阻塞修复、对应测试、三份开发文档修改、人工验收清单切换和未跟踪内容。先做只读审计并保存 diff，确认每项归属。验证这组修复后形成独立前置提交；不得 reset、checkout 覆盖、删除或混入无关内容。`.zcode/`、真实 Skill、用户缓存、个人绝对路径和 Typora 证据图不得提交。

按计划 Wave 0→4执行。用子代理并行提升速度，但只能并行文件不重叠、依赖已满足的任务：

- 每个实施子代理使用独立分支和独立 worktree。
- 并发最多为主 Agent＋3个子代理（继承主agent模型）；共享的 AppShell、公共 UI、base/theme CSS、路由、翻译、生成绑定、锁文件和四份当前开发文档由主 Agent/集成 Agent串行维护。
- Wave 1并行 T1 壳层/通知/减少动效、T2 初始化/重新发现、T3 LLM/AI闭环。
- Wave 2并行 T4 导入/冲突、T5 技能库工作台、T6 发现/品牌。
- 每个任务提交后立即做波次集成、定向绿灯和独立审查；发现返回原实现子代理修复并 scoped re-review，不把全部问题堆到最后。
- 子代理不得自行推送或合并；由主 Agent核对提交和文件所有权后集成。

每个修改 UI 的子代理必须使用并完整读取 `finesse-ui`、`frontend-design`、`vercel-react-best-practices` 和 `tdd`；遇到缺陷还必须使用 `systematic-debugging`。非 UI 全栈子代理至少使用 `tdd`、`systematic-debugging` 和适用的 React Skill。派发 brief 中写明：测试接缝、文件所有权、禁止事项、预期 red/green、验证命令和交付格式。子代理报告必须说明具体采用/跳过的 Skill 规则、修改文件、红绿证据、测试结果和提交哈希。

严格执行 TDD：先在公开接缝写一个会因缺失行为而失败的测试，确认准确失败，再做最小实现并绿灯；随后才开始下一切片。不能先重写整页再补测试，不能删测试、降断言、用 CSS 文本正则或私有状态冒充行为，也不能用任意 sleep 掩盖异步问题。M-31、M-13、M-14和技能库偏好读取必须先按 `systematic-debugging` 完成根因链路，不可凭截图猜修复。

UI 设计以现有九主题和产品型桌面工作台为边界：使用 `finesse-ui` 的 product/workflow register（低 spectacle、高 density），保持现有 terracotta 品牌语言，不做营销站风格。实现全局顶部导航、右上通知中心、2秒 toast＋会话历史、页面居上、设置固定左导航、概览两行指标、导入来源/扫描分层、技能库工具栏/底部抽屉等计划明确要求。所有图标按钮至少40×40、可键盘访问且有无障碍名称；减少动效必须同时尊重系统和用户开关。

LLM 不能盲目照抄 cc-switch。仓库后端已有多协议 adapter，先取证 UI draft→IPC→profile→protocol→HTTP链路，再决定最小修复。只借鉴接口格式的公开概念和交互，禁止复制凭据明文、代理、路由或私有实现。真实 API key 只有用户在下一轮人工验收中输入，任何测试、日志、提交和文档都不得包含。

品牌资产优先使用仓库 `assets/branding` 的现有 SkillHub 图标；Pi/DeepSeek Harness 只从官方一手来源获取且记录许可。来源/许可不清就保留诚实 fallback，不要抓取随机图片。网络检索和依赖下载遵守审批与安全边界。

完成实现后必须执行计划第 7 节全部验证和宽高/主题/语言/动效/长数据矩阵。Playwright 输出写入任务专用临时目录，不覆盖现有 `test-results`。所有失败都要修复并重跑相关及全量检查。

最后形成新的同日四份当前开发文档快照：先吸收旧结论，再把旧当前入口移动到日期归档；`docs/development/` 根目录每类只留一个最新文件。人工验收清单只留下用户下一轮需要真实桌面/设备/服务执行的项目，自动化通过不能写成真机通过。删除当前文档中的个人绝对路径和不可推送截图引用，但不要删除用户本地证据。

运行 `git diff --check`、敏感信息和范围审计，按工作包提交英文动词开头的清晰提交，推送 Goal 分支并核对远端 HEAD。最终报告必须包含：分支、merge-base、所有提交哈希、修改文件/工作包、各验证命令与结果、子代理/Skill 使用、独立审查与修复、文档归档位置、远端分支、剩余人工验收项目和风险。只有这些全部完成且只剩下一轮人工验收时，才调用 Goal 工具标记 `complete`；若 Goal 有预算，完成时同时报告最终 token usage。

---
