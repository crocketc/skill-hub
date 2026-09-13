# SkillHub 前端体验升级 Goal 实施计划

> 日期：2026-09-11  
> 状态：待创建 Goal  
> 设计依据：`docs/superpowers/specs/2026-09-11-skillhub-frontend-experience-refresh-design.md`  
> 交接指令：`docs/superpowers/plans/2026-09-11-skillhub-frontend-experience-refresh-handoff.md`

## 1. Goal

在不改变 SkillHub 业务、安全和本地优先边界的前提下，建立统一的前端设计基础，重做设置与 LLM 配置体验，将发现页和 Skill 库升级为小卡片浏览模式，并系统迁移其余桌面页面；完整保留 9 个预设主题、现有品牌资产、功能行为和自动化证据。

只有在共享基础、重点页面、其余页面、自动化、独立审查和开发文档全部完成后，Goal 才能标记为完成。

## 2. 启动条件

Goal 主 Agent 开始前必须：

1. 阅读根目录 `AGENTS.md`、`README.md`，以及 `docs/development/` 当前四份文档，顺序为开发状态 → 自动化测试说明 → 功能完成度矩阵；需要真机时再读人工验收清单。
2. 阅读本设计规格和本计划全文。
3. 读取 `frontend-design`、`web-design-guidelines`、`vercel-react-best-practices` 和 `tdd`；每次界面审查前刷新最新 Web Interface Guidelines。
4. 运行 `git fetch --prune origin`，检查当前分支、HEAD、远端分歧、状态和 worktree。
5. 以实际最新稳定提交为基线，不盲目使用本文记录的 `8e267be`。
6. 现有 `.gientech/`、`test-results/` 和其他用户未提交内容不得清理、提交或覆盖。
7. 先运行下方固定的前端测试、check、构建和 E2E 基线；如果基线失败，先报告，不把旧失败归咎于视觉改造。
8. 本计划、设计规格和交接指令必须先进入 Goal 基线提交，新建 worktree 才能直接读取；若没有提交授权，停止派发并请用户确认。

基线命令固定为：

```bash
pnpm --dir apps/desktop test --run
pnpm --dir apps/desktop check
pnpm --dir apps/desktop build
ui_e2e_output="$(mktemp -d /tmp/skillhub-ui-baseline.XXXXXX)"
pnpm test:e2e -- --output="$ui_e2e_output" tests/e2e/keyboard-accessibility.spec.ts tests/e2e/library-preview.spec.ts tests/e2e/llm-settings.spec.ts tests/e2e/bilingual-core-flows.spec.ts
git diff --check
```

Playwright 输出必须写入任务专用 `/tmp` 目录，不得覆盖现有未跟踪的 `test-results/`。基线任一命令失败时，暂停受影响 Task，记录失败命令、首个错误和是否属于基线；其他不依赖该失败的只读规划可以继续。

`vercel-react-best-practices` 只应用于当前 Vite/React 客户端相关规则：消除不必要串行请求、控制包体、避免无效重渲染、优化长列表和高频交互。Next.js、服务端渲染、React Server Components 等不适用规则直接跳过。不得为了套用性能规则改变业务语义、引入新数据框架或进行无证据的 `memo`/缓存优化。

## 3. 测试接缝

所有实施任务使用 TDD：一个失败测试 → 一个最小实现 → 绿灯，再开始下一切片。

- 组件接缝：Vitest＋Testing Library，只通过 role、可访问名称、状态、焦点和用户操作验证。
- 页面接缝：DEV-only 预览路由＋Playwright，验证真实用户流程、尺寸、长文本和滚动。
- 主题接缝：`themeNames`、用户选择、持久化和最终计算样式。
- 视觉接缝：截图用于审查整体层级，不以大面积像素快照替代行为断言。
- 禁止新增依赖 CSS 类名、CSS 文本正则和组件内部状态的测试。
- 不能可靠自动验证的字体观感、图标光学对齐、原生桌面缩放、滚动手感和读屏体验保留人工验收。
- 性能接缝：使用现有 300 Skill、页面加载和交互测试证明没有明显退化；新增优化必须有可复现的前后证据，不以代码形态推断性能收益。

## 4. 依赖与并行图

```text
冻结基线
   │
   ▼
T0 共享基础层
   │
   ├───────────────┬──────────────────┐
   ▼               ▼                  ▼
T1 设置/LLM      T2 发现/卡片       T3-A 概览
                   │
                   ▼
                 T3-B Skill 库

T0 完成后还可并行：
T3-C Skill 详情    T3-D Agent/项目    T3-E Markdown

T0 后可开始 T4-A；其余流程依赖：
T4-A 工作流中心    T4-B 初始化 → T4-C 导入 → T4-D 部署/移除
   └──────────────────┬──────────────────────────────┘
                      ▼
                 T5 集成与独立验收
```

硬依赖：

- T1、T2、T3、T4 均依赖 T0。
- T3-B Skill 库依赖 T2 冻结共享 SkillCard 契约。
- T4-A 只依赖 T0，可与其他文件不重叠的任务并行。
- T4-C 依赖 T0 和 T4-B 已提交的步骤壳层契约。
- T4-D 依赖 T0 和 T4-C 已提交的流程状态/操作区契约。
- T5 必须最后执行，且审查 Agent 不参与对应实现。

## 5. 文件并行规则

下列文件属于共享文件，默认只能由 Goal 主 Agent 或集成 Agent 串行修改：

- `apps/desktop/src/styles/base.css`
- `apps/desktop/src/styles/theme.css`
- `apps/desktop/src/styles/theme.ts`
- `apps/desktop/src/styles/ThemeProvider.tsx`
- `apps/desktop/src/app/AppShell.tsx`
- `apps/desktop/src/app/Sidebar.tsx`
- `apps/desktop/src/app/router.tsx`
- `apps/desktop/src/ui/**`
- `apps/desktop/src/i18n/zh-CN/common.json`
- `apps/desktop/src/i18n/en-US/common.json`
- `package.json`、锁文件、生成绑定
- `docs/development/` 当前四份文档

唯一例外：T0 Agent 在 T0 阶段独占主题、AppShell、Sidebar、`ui/**` 与获准的 `base.css` 区段；T0 合并后这些文件立即冻结。T2 Agent 只可在本计划指定位置创建共享 SkillCard。其他例外必须由 Goal 主 Agent 先更新计划和文件所有权，不能口头放宽。

每个并行 Agent：

- 使用独立 `codex/` 分支和独立 worktree。
- 只修改任务明确分配的 feature 目录及专属 CSS。
- 翻译和预览路由只提交“键名/中英文”和“路由/组件”清单。每个 Task 提交后立即执行一次波次集成：Goal 主 Agent 串行应用清单并运行该 Task 的完整 Green，之后才能声明 Task 完成；不能拖到 T5 一次处理。
- 发现共享组件缺口时返回 T0 或创建基础层 follow-up，不复制局部 Input、Button、Icon 或 Status。
- 不推送、不合并，提交后将哈希和验证结果交回 Goal 主 Agent。

页面 Task 的文件所有权只包含展示组件、测试、预览夹具和专属 CSS。`api.ts`、`nativeApi.ts`、`llmApi.ts`、facade、reducer、状态机、生成绑定和 Rust 均明确排除；确需修改时必须返回 Goal 主 Agent 重新定范围。

## 6. Task 0：共享基础层

建议分支：`codex/ui-foundation`

### 范围

- 完整锁定 9 个主题及持久化兼容。
- 补齐语义 token 和现有未定义变量，保留 `--color-*` 兼容层。
- 新增 Field、Input、Select、CheckboxField、Switch、Icon、IconButton、PageFrame、PageHeader、首错聚焦辅助。
- 改进 Button 加载态。
- 修复 Drawer/ConfirmDialog 焦点、滚动边界和统一关闭图标。
- AppShell 增加 Skip Link、唯一 main 标识和容器查询基础。
- 建立 `/__preview/ui-foundations` 基础展板。
- 只将设置、发现等首批并行页面已有样式机械拆入 feature-scoped CSS；每次拆分前后运行同一预览和布局断言，不进行全量 `base.css` 重构。
- 修改前保存 9 主题基础展板临时基线到任务专用 `/tmp`；版本化快照只保留稳定基础展板，临时审查图不得提交。

### Red-Green 切片

1. 主题名称、顺序、映射、旧持久化值和 token 完整性。
2. Field/Input 的标签、帮助、错误、属性透传。
3. Select 的键盘、主题和 Windows 深色外观。
4. Checkbox/Switch 的点击范围、状态和禁用行为。
5. 首个无效字段聚焦。
6. Button 加载时保留原文字。
7. Icon/IconButton 的无障碍名称和 Sidebar 单次朗读。
8. Drawer/Dialog 的焦点进入、限制、Escape、恢复和减少动效。
9. AppShell Skip Link、单 main、滚动所有者和基础无横溢。
10. 9 主题基础展板和 320/800/1024/1440px 浏览器验证。

### 禁止事项

- 不修改设置、发现、Skill 页面最终布局。
- 不修改 Rust、绑定、数据库、业务路由和安全边界。
- 不新增图标依赖、在线字体或远程资源。
- 不改品牌 SVG 和许可证。
- 功能图标与品牌 Logo 使用两个独立注册表；新增本地功能图标必须记录来源和许可证，禁止根据名称猜测品牌映射。

### 完成门槛

- 定向测试、全量前端测试、check、build、E2E、`git diff --check` 全部通过。
- 9 个主题的主强调色、画布明暗关系和深浅属性与修改前基线一致，不得因 token 统一而同质化。
- 一个英文动词开头提交，并报告每个红/绿证据、文件和遗留项。

## 7. Task 1：设置与 LLM

建议分支：`codex/ui-settings`

### 文件所有权

- `SettingsPage.tsx`、`GeneralSettings.tsx`、`ViewSettings.tsx`、`AiNetworkSettings.tsx`、`AutomationSettings.tsx`
- `LlmProvidersSettings.tsx`、`LlmCapabilitiesSettings.tsx`、`SettingsLlmPreview.tsx`
- 上述展示组件对应测试及新增的设置展示组件
- 新增 `apps/desktop/src/features/settings/settings.css`
- 设置相关预览和 E2E
- 数据保护仅包含 `features/backup/**` 的视觉迁移，不修改备份 API 或业务语义

明确排除：`features/settings/api.ts`、`nativeApi.ts`、`llmApi.ts`、所有 facade/adapter、生成绑定和 Rust。

### 切片

1. 6 个设置分区及键盘可用的当前分区导航。
2. 通用、语言、密度和 9 主题迁移到共享表单。
3. 完整宽度供应商实体列表，显示类型、端点、模型、启用、默认和凭据状态。
4. 新增/编辑供应商抽屉；凭据不回显，取消恢复焦点。
5. 必填错误逐字段展示并聚焦首错，不恢复浏览器原生英文气泡。
6. 删除供应商确认、取消和失败保留。
7. 服务/模型三级场景：服务失败、服务成功模型失败、两级都成功。
8. AI 能力开关和输出语言迁移；默认值与发送范围不变。
9. 800/1024/1280/1440px、长名称/端点/模型/错误码和多供应商布局。
10. 9 主题设置页关键区域验收。

### 禁止事项

- 不修改 LLM facade、协议、凭据、安全存储、网络闸门和后端。
- 不修改主题实现和共享组件。
- 不借页面重构改变保存、删除、测试和能力开关语义。

## 8. Task 2：发现与共享 Skill 卡片

建议分支：`codex/ui-discovery-cards`

### 文件所有权

- `DiscoveryPage.tsx`、`OnlineDiscovery.tsx`、`RepoDiscovery.tsx`、`AgentsLockDiscovery.tsx`、`LocalDiscovery.tsx`、`LocalDiscoveryWorkbench.tsx` 及其测试/预览
- 新增发现专属 CSS
- 显式例外：T2 独占创建 `apps/desktop/src/features/shared/skill-card/**`，包含共享 SkillCard、ViewModel、样式和测试；完成后冻结，T3-B 只消费
- 发现相关单元测试、预览和 E2E

共享 ViewModel 只允许可证实字段：ID、名称、来源类型、来源标签/地址、可选描述、可选本地化数量、可选分支/目录、状态、主次操作插槽；不得补造作者、评分或兼容性。

明确排除：`features/discovery/api.ts`、`nativeApi.ts`、facade/adapter、ImportWizard、生成绑定和 Rust。

### 切片

1. 建立卡片公开语义：标题、来源、可选描述、状态、元数据和操作区。
2. 在线搜索结果卡片化；保留普通搜索、AI 扩展、回退、重复和不可安装语义。
3. 仓库与 lock 结果映射到同一卡片模型；缺少字段时诚实省略。
4. 发现主页和子页持续来源导航；替换字体字符图标。
5. 3/2/1 列容器响应式、长文本和稳定操作区。
6. 9 主题、简中/英文、空/错/加载/下载中/已在库/AI 回退视觉回归。

### 禁止事项

- 不修改网络、下载、导入、安全确认和重复判断。
- 不伪造作者、评分、兼容 Agent 或描述。
- 不仅凭仓库 owner 套用 Agent 品牌 Logo。
- 不修改 ImportWizard、Rust、绑定和主题实现。

## 9. Task 3：核心浏览页面

T3 子任务都依赖 T0；T3-B 额外依赖 T2。文件不重叠时可以并行。

每个 T3 子任务都按以下垂直切片执行，不得先重写整页再补测试：

1. Red：用现有公开行为建立预览夹具和失败断言；Green：只补夹具，不改变业务。
2. Red：目标信息层级或键盘路径不可达；Green：只调整对应展示结构。
3. Red：该页面既有失败、空、取消、重复或恢复状态退化；Green：复用原状态并完成新布局。
4. Red：800/1024/1280/1440px、长文本或末项操作出现重叠/裁切；Green：只调整专属 CSS。
5. Red：默认主题、`grok-night` 和本页状态/图标不满足契约；Green：只消费 T0 token 和图标。

单元测试放在对应 feature 的现有 `*.test.tsx`；每个子任务新增一个确定性 DEV-only 预览状态和一个专属 Playwright 文件。测试不得依赖真实磁盘、网络或供应商。

### T3-A 概览

分支：`codex/ui-overview`

- 所有权：`features/overview/**` 和 `overview.css`。
- 实现 1/2/4 列指标响应式；只保留一个首要指标，其他转为紧凑统计。
- 窄窗口图表和待处理区域单列，无嵌套不可发现滚动。
- 9 主题图表取色不写死，保留无动画和可访问明细。
- 替换本范围内作为正式操作的字符图标，文本内容中的普通字符除外。

### T3-B Skill 库

分支：`codex/ui-library`

- 所有权：`features/skills/**` 的展示组件、测试、预览和 `skills.css`；明确排除 native API、facade 和业务查询语义。T2 的公共 SkillCard 只消费或按向后兼容方式扩展。
- 默认增强卡片视图；表格保留为专业模式。
- 卡片展示来源、版本、部署、风险和升级；操作区稳定。
- 筛选在窄窗口折叠并显示已生效条件。
- 表格减少固定宽列和双层横向滚动，保留分页、排序、选择和快速抽屉。
- 继续通过 300 Skill 性能与翻页测试。
- 替换本范围内作为正式操作的字符图标。

### T3-C Skill 详情

分支：`codex/ui-skill-detail`

- 所有权：`features/skill-detail/**` 的展示组件、测试和预览；不修改 native API、facade 和 Markdown。
- 重组身份、状态、正文、关系和生命周期；不删章节。
- 窄窗口章节导航退化为可访问的横向导航或选择器。
- 保留查询失败、删除确认、撤销部署、相邻导航、滚动与焦点恢复。
- `features/security/**` 的安全结果视觉迁移归本任务，安全扫描与 LLM 判断逻辑明确排除。
- 替换本范围内作为正式操作的字符图标。

### T3-D Agent 与项目

分支：`codex/ui-agents-projects`

- 所有权：`features/agents/**`、`features/projects/**` 和专属 CSS。
- Agent/项目采用响应式实体卡片；长路径和不可访问状态可读。
- 修复抽屉触发器焦点恢复。
- 项目注册从内联大面板迁移到抽屉/对话框，不改变目录、预览、Agent 选择和重复提交语义。
- 品牌图标保持原色，操作图标使用统一映射。
- 替换本范围内作为正式操作的字符图标。

### T3-E Markdown

分支：`codex/ui-markdown`

- 所有权：`features/markdown/**` 和现有 markdown CSS。
- 保留源码/预览分屏、CodeMirror、草稿、安全过滤和资源加载。
- 验证长代码、宽表格、大图、Mermaid 和 40rem 临界宽度。
- 图片增加明确尺寸或稳定占位；保存和校验状态支持动态播报。
- 替换本范围内作为正式操作的字符图标，不改变 Markdown 正文内容。

## 10. Task 4：流程与高风险操作页面

T4-A 依赖 T0；T4-B 依赖 T0；T4-C 依赖 T4-B 的步骤壳层提交；T4-D 依赖 T4-C 的流程状态/操作区提交。文件不重叠且依赖已满足时可以并行，只消费已冻结公共组件。

每个 T4 子任务至少执行以下垂直切片：

1. Red：当前成功路径的步骤、主操作或结果无法通过公开角色访问；Green：只补对应流程壳层。
2. Red：失败、取消、重复、权限受限和恢复路径中的一个被新布局隐藏或混淆；Green：逐条恢复，不合并状态。
3. Red：长路径、50+ 条目、800/1024px 或 sticky 操作区产生覆盖；Green：只调整专属布局。
4. Red：键盘焦点、动态播报、确认或焦点恢复失败；Green：复用 T0 组件完成。
5. Red：9 主题和正式操作图标不满足契约；Green：只迁移本任务范围。

每个状态必须独立测试，不能用一个“综合流程通过”代替失败、取消、重复、恢复和权限受限断言。

### T4-A 待处理、操作记录、恢复

分支：`codex/ui-workflow-center`

- 所有权：`features/pending/**`、`features/operations/**`、`features/recovery/**`。
- 每条事项按“风险—影响—建议操作”布局。
- 批量操作区不遮挡焦点和末项。
- 保留永久忽略确认、取消、撤销、重复提交保护和单项失败隔离。
- 操作记录使用结构化时间线；时间通过 `Intl.DateTimeFormat`。
- 恢复页 Tabs 补齐方向键、`aria-controls` 和焦点管理。
- 替换本范围内作为正式操作的字符图标。

### T4-B 初始化与重新发现

分支：`codex/ui-onboarding`

- 所有权：`features/onboarding/**` 和 `features/bootstrap/**` 的展示控制器、测试、预览与专属 CSS；明确排除 native API、bootstrap 领域状态和后端命令。
- 统一步骤名称、完成状态、长路径和底部操作区。
- 保留创建、选择、恢复、扫描慢、后台继续、跳过、取消和失败重试。
- 重新发现不得触发初始化完成逻辑。
- 9 主题选择完整保留。
- 替换本范围内作为正式操作的字符图标。

### T4-C 导入

分支：`codex/ui-import`

- 所有权：`features/import/**` 的展示组件、测试、预览与专属 CSS；reducer、阶段机、native API 和 facade 明确排除。
- 不重写 reducer 或阶段机；逐阶段建立 UI 回归。
- 稳定步骤条、返回、取消和主操作位置。
- 长路径和 50+ 条目可用；必要时分页或虚拟化。
- AI 预检查保持可选辅助，不与确定性冲突决策混为一层。
- 替换本范围内作为正式操作的字符图标。

### T4-D 部署与移除

分支：`codex/ui-deployment`

- 所有权：`features/deployment/**`、`features/removal/**` 的展示组件、测试、预览与专属 CSS；native API、facade、部署/移除状态机明确排除。
- 统一“选目标 → 预览影响 → 提交 → 结果”。
- 非原子批量风险紧邻提交动作。
- 保留模式选择、目标不可用、预览警告、失败重试、提交锁和移除影响确认。
- 替换本范围内作为正式操作的字符图标。

## 11. Task 5：集成、审查与文档

建议分支：`codex/ui-integration`

### 合并顺序

1. T0。
2. T1 与 T2。
3. T3-E、T3-A、T3-D。
4. T3-B 与 T3-C，并验证 Skill 库 → 详情 → Markdown 组合。
5. T4-B、T4-C、T4-D、T4-A，并验证初始化 → 导入 → 部署 → 记录/恢复。
6. 集成 Agent 串行处理公共 CSS、路由、翻译和主题变量。
7. 独立审查 Agent 只报告问题，不直接混合修复；问题返回原任务，一次修一个。

### 全局验收

- 800/1024/1280/1440px × 600/720/900px。
- 简中/英文、长名称、长路径、空/单条/50+ 条目。
- 9 主题全部验证；版本化快照只保存稳定、确定性的基础展板和关键页面区域，临时人工审查截图写入任务专用 `/tmp`，不得提交。
- 键盘、焦点、弹层、标签页、锚点、滚动和减少动效。
- 页面根级无横向滚动，无文字逐字压缩，无操作遮挡和不可发现双滚动。
- 相关定向测试、完整前端测试、check、build、E2E、i18n 审计、原子目录校验和 `git diff --check`。
- 最后执行 Windows/macOS 真机视觉验收，自动化不得替代原生控件、缩放和读屏证据。
- 扫描所有 `features/*`，逐个记录“已迁移、保守保留或明确不在范围”；`backup`、`bootstrap`、`security` 不得遗漏。
- 扫描正式操作区域，确认不再以 `↗`、`⌄`、`⌃`、`✎`、`×` 等字体字符代替图标；正文和用户内容中的普通字符除外。
- 品牌 Logo 与功能图标保持两个独立注册表，不允许互相猜测或复用。

风险分层矩阵：

- 每个页面 Task：默认主题和 `grok-night` 跑 800/1024/1280/1440px，高度默认 900px。
- 每个页面 Task：9 个主题在 1280×900px 跑关键控件、焦点、状态和无横溢检查。
- T5：对设置、发现、Skill 库、详情、初始化、导入和部署运行完整宽×高矩阵；其他页面运行四宽度＋最小高度 600px。
- 不要求每个子任务生成 9×12 张像素快照；行为和几何断言优先。

### 文档

- 行为或测试范围改变后，同步当前开发状态、自动化测试说明和完成度矩阵。
- 人工验收后同步人工验收清单和完成度矩阵。
- 如果形成 2026-09-11 新快照，按 `AGENTS.md` 更新四份当前文件全部引用，并将旧的 2026-09-10 快照移入日期归档；不得留下多个当前入口。
- 不提交个人路径、真实 Skill、密钥、缓存、截图临时产物和用户未提交状态。

## 12. 每个 Task 的交付格式

每个 Agent 必须报告：

1. 基线提交、分支和 worktree。
2. 文件所有权及实际修改文件。
3. 每个 Red 测试的失败原因和对应 Green 命令。
4. 定向测试、全量检查及结果。
5. 800/1024/1280/1440px 和主题覆盖证据。
6. 提交哈希。
7. 未解决问题、人工验收边界和后续依赖。
8. 确认未修改任务外文件、未处理 `.gientech/` 和 `test-results/`。
9. 说明适用的 React 性能规则、验证证据，以及明确跳过的不适用规则；不得仅写“已遵循最佳实践”。

## 13. Goal 完成定义

只有同时满足以下条件，才能调用 Goal 完成：

- T0–T5 全部达到完成门槛并合并到 Goal 分支。
- 所有 9 个主题保留且核心页面适配通过。
- 设置、发现、Skill 库和其余页面的目标体验全部落地。
- 自动化与独立审查发现的问题已逐项关闭；不得把可自动或预览验证的问题重新标为人工项。
- 当前开发文档已同步，工作区状态和提交范围清楚。
- 设计规格明确列为“只能真机”的项目可以保留为发布验收阻塞，但必须写明未验证，不得宣称已通过；这些项目不阻止“前端实现 Goal”完成，却继续阻止正式发布完成。
