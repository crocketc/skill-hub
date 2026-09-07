# Desktop Agent and Project Workspaces Design

> 日期：2026-08-27
> 实施依据：`docs/superpowers/plans/2026-08-22-skillhub-07-desktop-experience.md` Task 8

## Goal

为 SkillHub 桌面端补齐 Agent 与项目工作区的事实展示和安全入口。页面消费现有查询/命令契约，通过可注入 Facade 与确定性 fixtures 测试；在原生能力尚未接入时明确显示不可用，不伪造扫描、授权、可用性或运行成功。

## Scope and boundaries

- Agent 页面分开显示品牌、逻辑客户端、实例和物理 Skill 目录。
- RelationsView 将多个逻辑客户端合并到一个物理目录事实下，避免重复计数或重复展示。
- Usage evidence 标记为“实验功能，仅供参考”；Runtime Hook 标记为“研发中”。
- 项目页面支持标签交集筛选、保存视图入口、快速抽屉和批量入口，但不构造目录树。
- 共享配置只展示项目身份提示、Skill 要求和目标关系；不会把共享配置写入磁盘。
- best-effort assembly 逐项展示 satisfied、skipped、conflict、failed，不声称全有或全无成功。
- 不修改 Rust、Specta bindings 或 native contract；不在 React 中访问文件、网络、进程或执行 Skill。

## Architecture

新增 `agents` 与 `projects` feature 目录。每个页面接收可选的查询/操作 Facade；默认 Facade 返回结构化 unavailable 状态。组件只接收已解析的视图模型，避免把 bindings 类型和渲染逻辑耦合在一起。

Agent 视图模型包含 `brand`、`client`、`instance`、`discoveredPaths` 和 `relations`。关系模型把 `logicalTargetId` 与 `physicalTargetId` 分开，RelationsView 用 `data-testid="logical-target"` 和 `data-testid="physical-target"` 表达数量关系。

Project 视图模型包含项目元数据、标签、共享配置摘要和组装条目。标签筛选使用集合交集；空筛选显示全部。组装结果按条目保留状态和消息，冲突条目必须有明确处理状态。

## User flow

1. Agent 列表显示发现数量和目录事实；点击进入详情。
2. Agent 详情先显示客户端/实例，再显示物理目录关系；实验能力和 Runtime Hook 单独标注。
3. 项目列表提供文本搜索和多个标签筛选；筛选结果以卡片/表格展示，不出现 `role="tree"`。
4. 项目详情通过快速抽屉查看共享配置和组装预览；组装条目按状态逐项列出。
5. 原生查询不可用时，页面显示可重试的 unavailable 状态，不显示 Mock 项目或 Agent。

## Accessibility and visual direction

复用现有 SkillHub semantic tokens、Button、DataState、StatusBadge 和 Drawer。工作区保持紧凑密度、独立滚动和 sticky 操作区；长路径允许换行。状态同时使用文字、图标/标记和语义色，支持键盘焦点与 `MotionConfig reducedMotion="user"`。

## Testing strategy

- AgentDetailPage：发现事实不产生“已授权/可用/验证通过”等运行时声明。
- RelationsView：两个逻辑客户端连接一个物理目录。
- ProjectListPage：一个项目通过多个标签交集筛选，且不出现目录树。
- BestEffortAssembly：保留 satisfied、skipped、conflict、failed 的每条结果。
- 生产路由使用 unavailable Facade；fixtures 只在测试中注入。

## Acceptance

`pnpm --dir apps/desktop test --run src/features/agents src/features/projects`、`pnpm --dir apps/desktop check` 通过；所有新增用户可见文案同时存在于 `zh-CN` 与 `en-US`；安全扫描不出现进程、文件系统或网络调用。
