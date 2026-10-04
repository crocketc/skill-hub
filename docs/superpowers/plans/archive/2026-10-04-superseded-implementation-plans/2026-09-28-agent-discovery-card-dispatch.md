# Agent 识别、卡片归并与派发展示实施计划

> 实施状态（2026-09-29）：代码与自动化回归已完成；前端 2013/2013、Agent/发现/关系定向浏览器 E2E 53/53 通过。当前仅剩 Windows/macOS 真实桌面人工验收，入口为 `docs/development/人工验收清单-2026-09-29.md` 流程 L。本文保留为实施过程记录，产品边界以对应设计文档为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有发现快照、Profile（配置档案）、物理目录归并和派发流程上做增量调整，使项目所有 Agent 入口统一采用“已识别 Agent 目录”、按品牌与实际 Skill 路径归并卡片、独立展示共享目录，并在卡片上展示路径状态、共享能力和三种派发方式能力；不增加软件安装检测，不重构现有部署执行器或关系治理。

**Architecture:** Profile 为每个 Skill 目录候选补充 Agent 根目录识别规则；适配器只读验证根目录和 Skill 目录，快照同时保留候选路径与已验证物理身份。应用层以快照事实生成 Agent/共享目录/派发目标投影，前端用统一的 `AgentCardModel` 和 presenter（展示转换层）消费，所有卡片只负责展示和进入详情页。待创建目录由用户在详情页确认后通过一个薄的原生命令创建并重新扫描，随后复用现有派发预览、物理身份复核、部署执行和回滚链路。

**Tech Stack:** Rust（核心模型、适配器、应用 Facade（门面）、Specta 绑定）、Serde/JSON Profile、SQLite 设置快照、React/TypeScript、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-discovery-card-and-dispatch-design.md`

## Global Constraints

- 只在 `feat/v0.2.0-product-completion` 分支基于当前实现增量修改；不重做 Agent、部署、关系图谱或存储架构。
- 保留 `ClientPresence::Unknown` 的运行时语义；Agent 根目录存在只表示“已识别 Agent 目录”，不表示软件已安装、已登录、会加载或会执行 Skill。
- 所有发现、初始化和重扫保持只读，不创建目录；目录只允许在用户明确确认派发后创建。
- 已存在目录必须以文件系统身份归并；缺失目录只有候选路径，不能用候选路径身份进行永久派发、收回或删除安全判断。现有 `physical_id` 字段可继续兼容保存，但新增“身份是否已验证”事实，所有安全流程只使用已验证身份。
- 共享目录是一个独立目录实体和一张卡片。品牌只是支持/识别关系，不能复制成共享目录的品牌卡。
- 普通 Agent 卡片按“品牌 + 目录角色 + 已验证物理目录”归并；待创建时按“品牌 + 候选路径 + 目录角色”归并。同品牌不同物理目录不合卡，同目录不同类型合并类型徽标。
- 卡片不显示 Skill 数量、安装状态、安装证据、部署摘要、物理身份、技术 ID 或后端枚举；派发、收回和方式切换仅在详情页/现有派发流程中进行。
- 三种派发方式图标都保留：复制、符号链接、目录联接。根据宿主能力与 Profile 能力显示高亮或置灰；现有 `DeploymentMode::select` 的“符号链接 → 目录联接 → 复制”顺序继续作为默认推荐顺序，不在本轮新增第二套优先级配置。
- 后端可以保留精确枚举、错误原因和内部标识；前端所有 Agent 相关入口统一经过 presenter（展示转换层）映射为用户可理解文案。技术事实只进入日志或诊断导出。
- `apps/desktop/src/api/bindings.ts` 只能由生成工具更新。
- 前端改动先加载并遵循 `frontend-design` 与 `vercel-react-best-practices`；前端行为优先用 Playwright 自动化，Rust/TypeScript 行为采用 TDD（测试驱动开发）。
- 不修改用户文件、不自动清理用户目录。派发失败时沿用现有回滚/恢复规则；为派发创建出的空目录不作为 Skill 内容删除。

## Review Focus

- Profile 中 Agent 根目录的声明是否逐项符合调研文档，尤其是 DeepSeek Harness、共享 `.agents/skills`、项目级目录和内置目录。
- 根目录存在但 Skill 子目录不存在时，普通品牌卡是否出现且路径显示“待创建”；根目录不存在时是否没有品牌卡；共享卡上的品牌 Logo 是否只来自 Profile 声明且设备根目录存在。
- 同品牌多类型是否只按同一实际目录合并；候选路径没有已验证身份时是否绝不误合并或作为收回主键。
- Agent 页、初始化/重扫、发现工作台、项目 Agent 选择、部署目标、技能关系和图谱中的 Agent 展示是否全部复用统一事实/presenter，是否仍有纯文本 `client_id` 或技术枚举泄漏。
- 卡片是否只展示信息和详情入口，是否误加入直接派发按钮或 Skill 数量。
- 待创建目录是否只在用户明确确认派发后创建，创建后是否立即重新取得物理身份并复用现有派发安全复核。

---

## 统一卡片模型字段对照

实现时先固定后端事实与前端展示投影，避免页面各自解释枚举：

| 维度 | 后端事实/枚举 | 前端卡片展示 |
| --- | --- | --- |
| 品牌 | Profile `brand`、已有品牌 Logo 映射 | 品牌 Logo + 品牌名称 |
| 类型 | `ClientKind`：`cli`、`desktop`、`ide_extension`、`web`、`mobile`、`bot`、`headless`、`acp`、`tui` | 统一映射为“终端、桌面端、IDE 插件、网页端、移动端、机器人、后台服务、协议接入”；同目录多类型合并徽标 |
| 目录角色 | `agent_native`、`project`、`shared_directory`；`builtin` 为只读属性 | Agent 目录、项目目录、共享目录；内置以只读标记表达 |
| 路径状态 | `existing`、`missing`、`non_directory`、`inaccessible`、`broken_link`；身份变化由重验证错误表达 | 具体路径、待创建、无法访问、路径被文件占用、链接目标失效；技术枚举不出现在界面 |
| 物理身份 | 物理身份字符串 + `physical_identity_verified` | 不展示；只作为合卡、派发写入和收回复核事实 |
| 共享能力 | Profile/候选的共享引用事实 + 当前根目录识别交集 | 普通 Agent 卡显示“支持共享目录”标记；共享卡只显示已识别品牌 Logo |
| 派发状态 | 复用已有 `DeploymentRecord.state`、目标物理身份和现有部署统计 | `未部署`、`已部署`、`部分部署`、`需要处理`四类颜色/图标；不显示数量，详情页显示摘要 |
| 派发方式 | 现有 `DeploymentCapability` 的 `copy/symlink/junction` 与 `DeploymentMode::select` | 复制、符号链接、目录联接三枚图标；支持高亮、不支持置灰、默认选择加推荐标记 |

其中前端只新增“用户视角的 `AgentCardModel`”，不复制部署表或关系表；派发状态由已有部署记录按已验证物理目录投影得到，详情页可继续读取现有数量和关系。

## 任务 1：为 Profile 和发现契约补充 Agent 根目录与路径状态事实

**Files:**

- 修改：`crates/skillhub-core/src/agent/profile.rs`
- 修改：`crates/skillhub-core/src/agent/target.rs`
- 修改：`crates/skillhub-core/src/agent/discovery.rs`
- 修改：`crates/skillhub-adapters/profiles/schema.json`
- 修改：`crates/skillhub-adapters/src/agent/profile_loader.rs`
- 测试：`crates/skillhub-adapters/tests/profile_schema.rs`
- 测试：`crates/skillhub-adapters/tests/builtin_profiles.rs`
- 测试：`crates/skillhub-adapters/tests/custom_agent.rs`

**Steps:**

- [ ] 先写失败测试：Profile 可以声明 `path`（Skill 目录）和可选 `agent_root`（Agent 根目录）；旧 Profile 缺少该字段时按 `path` 作为识别路径兼容；空根目录、越界根目录和不安全通配符被拒绝。
- [ ] 先写失败测试：路径状态覆盖 `existing`、`missing`、`non_directory`、`inaccessible`、`broken_link`；`identity_changed` 保留为重验证阶段的应用错误，不伪造为首次发现事实。
- [ ] 增加 `DirectoryObservationStatus`（目录观察状态）和 `AgentRootObservation`，在 `DiscoverySnapshot` 中增加根目录观察集合；为已存在目录增加 `physical_identity_verified`，缺失/无法取身份的候选保持未验证。
- [ ] 给 `PathCandidate` 增加可选 `agent_root`，用 `serde(default)` 保证旧快照和自定义 Profile 可读取；继续保留现有 `path/scope/precedence/marker/shared_reference/builtin` 语义。
- [ ] 更新严格校验：根目录与 Skill 路径均必须是有限、可展开的候选路径；共享引用不能自动变成目录所有权；没有稳定本地目录的 Profile 可以保留，但不能生成可派发目标。
- [ ] 不扩展 `ClientPresence`，继续保持 `Unknown`，避免把目录识别错误表达成软件安装事实。

**验收:** 核心类型可序列化/反序列化；旧 JSON 无新字段仍可加载；新 Profile 能表达 DeepSeek Harness 的 `.dsh` 根目录 + `.dsh/skills` Skill 目录，以及 `.agents/skills` 共享引用。

## 任务 2：增量实现根目录扫描、物理身份验证和快照历史兼容

**Files:**

- 修改：`crates/skillhub-adapters/src/agent/discovery.rs`
- 修改：`crates/skillhub-adapters/profiles/deepseek-harness.json`
- 修改：需要补根目录声明的其他 `crates/skillhub-adapters/profiles/*.json`
- 修改：`crates/skillhub-storage/src/database/agent_repository.rs`
- 修改：`crates/skillhub-application/src/lib.rs`（发现命令/查询的现有接线和注释）
- 测试：`crates/skillhub-adapters/tests/discovery.rs`
- 测试：`crates/skillhub-storage/src/database/agent_repository.rs`
- 测试：相关 `crates/skillhub-application/tests/facade*.rs` 中的快照构造辅助函数

**Steps:**

- [ ] 先写失败测试：根目录存在、Skill 目录缺失时，快照同时记录根目录存在和 Skill 目录待创建；根目录缺失时不把该客户端当作已识别 Agent；Skill 目录存在时保留现有可读/可写事实。
- [ ] 先写失败测试：同一品牌多个客户端类型指向同一已存在物理 Skill 目录时只产生一个 `PhysicalTarget`；不同目录、不同作用域和内置目录不跨角色合并。
- [ ] 先写失败测试：待创建候选没有已验证物理身份；符号链接目标失效、路径位置是普通文件、权限不足分别得到对应观察状态；扫描本身不创建目录。
- [ ] 让适配器对每个 Profile 候选分别展开 Agent 根目录和 Skill 路径；根目录只用于识别，Skill 路径继续作为逻辑/物理部署目标事实。
- [ ] 对已存在目录继续复用 `metadata`/平台文件身份逻辑；对缺失候选保留候选路径用于展示，但标记身份未验证，禁止把 fallback path id 当安全身份。
- [ ] 更新 `agent_repository` 的 `merge_history`：根目录观察和路径状态按当前扫描更新；旧快照仅在同一 profile/client/scope 且路径等价时吸收，不把历史缺失项重新变成已识别或可用。
- [ ] 更新所有 Rust 快照构造辅助函数和序列化回归测试，避免在生产代码引入兼容性重构。

**验收:** `cargo test -p skillhub-adapters --test discovery --test profile_schema --test builtin_profiles` 和 `cargo test -p skillhub-storage agent_repository` 覆盖成功、缺失、异常、重复扫描；已有 `ClientPresence::Unknown` 断言仍成立。

## 任务 3：应用层统一生成 Agent 卡片事实和共享目录派发目标

**Files:**

- 修改：`crates/skillhub-application/src/lib.rs`
- 修改：`crates/skillhub-core/src/api/query.rs`
- 修改：必要时修改：`crates/skillhub-core/src/api/command.rs`
- 修改：`crates/skillhub-core/src/deployment/model.rs`
- 修改：`crates/skillhub-core/src/deployment/planner.rs`（只在待创建目标的预览/推荐事实确有需要时增量修改）
- 测试：`crates/skillhub-application/tests/facade.rs`
- 测试：`crates/skillhub-application/tests/facade_deployment_accounting.rs`
- 测试：`crates/skillhub-application/tests/facade_observed_deployments.rs`

**Steps:**

- [ ] 先写失败测试：应用层投影只输出根目录已识别的品牌卡候选；根目录存在而 Skill 目录缺失时输出待创建路径；共享目录按物理目录只输出一个独立 `DeploymentTarget`，支持品牌只取“Profile 声明支持 + 根目录已识别”的交集。
- [ ] 先写失败测试：缺失候选不按 fallback `physical_id` 合并为已验证物理目标；已存在目录仍按真实物理身份只规划一次派发写入；收回/复核继续拒绝身份变化。
- [ ] 在 `DeploymentTarget` 中增量加入目录状态、身份是否已验证和默认推荐方式所需的用户可消费事实；保留现有 `modes`、`shared_directory`、`shared_agent_brands` 字段，避免重新设计部署目标契约。
- [ ] 把现有 `offered_modes`/`effective_target_capabilities` 作为唯一能力来源：复制、符号链接、目录联接都能生成图标状态；没有稳定 Skill 目录的 Profile 不凭空提供可派发目标。
- [ ] 采用“确认后创建、创建后复用旧流程”的薄入口：新增一个最小的 `ensure_agent_target_directory` 命令/门面方法，输入现有逻辑目标 ID；执行父目录授权检查、路径冲突/断链检查、创建目标目录、重新发现并取得真实物理身份，然后返回刷新后的快照/目标。
- [ ] 该命令不得创建 Agent 根目录，不得写入 Skill；只在用户明确确认派发后调用。创建后再进入现有部署预览和 `RegisteredTargetIndex`，因此不放宽 `VerifiedTarget::from_fact` 的“必须存在且身份一致”安全前提。
- [ ] 对普通文件占位、断链、无权限、根目录缺失和创建竞态分别返回现有错误体系可映射的结构化原因；不把原始 Rust 错误或 ID 直接作为界面文案。

**验收:** 应用层测试证明共享目录单实体、品牌交集、同物理目录单写入、待创建目标创建后重新验证；现有派发/收回回归测试不改变安全结果。

## 任务 4：生成绑定并建立前端统一 Agent 卡片模型

**Files:**

- 修改：`apps/desktop/src/api/bindings.ts`（仅由生成器产生）
- 修改：`apps/desktop/src/features/agents/api.ts`
- 修改或新增：`apps/desktop/src/features/agents/agentCardModel.ts`
- 修改：`apps/desktop/src/features/agents/agentCards.ts`
- 修改：`apps/desktop/src/ui/AgentPresentation.tsx`
- 修改：`apps/desktop/src/ui/AgentKindBadge.tsx`
- 测试：`apps/desktop/src/features/agents/agentCards.test.ts`
- 测试：新增/修改 `apps/desktop/src/features/agents/agentCardModel.test.ts`
- 测试：`apps/desktop/src/ui/AgentPresentation.test.tsx`

**Steps:**

- [ ] 先写失败的纯函数测试，固定 `AgentCardModel` 的维度：品牌、类型、目录角色、路径显示状态、共享目录支持、内置/只读、三种派发方式支持与推荐、派发状态、详情目标和合并成员。
- [ ] 路径维度只输出两类主展示：已存在显示规范化路径；不存在显示“待创建”。异常只输出用户可理解状态和详情建议，不展示 `DirectoryObservationStatus` 原值。
- [ ] 按“品牌 + 目录角色 + 已验证物理身份”归并；已验证身份缺失时按候选路径归并但不把它标成永久身份。保留现有 `buildAgentCardViews` 导出作为兼容入口，内部改为消费统一模型，减少调用方变更。
- [ ] 普通 Agent 卡保留品牌 Logo、品牌名称、用户类型徽标、路径/待创建、目录角色、共享能力标记、派发状态图标和三种部署方式图标；移除卡片上的 Skill 数量与部署摘要。
- [ ] 共享目录使用固定标题“Agent 共享目录”，加入本地代码绘制的 Vercel 黑色三角 Logo（不新增外部图标依赖）；品牌 Logo 列表仅消费后端过滤后的支持品牌，悬浮/无障碍标签显示品牌和支持类型，卡片不显示类型文字。
- [ ] 自定义 Agent 继续复用现有通用品牌兜底，不增加 Logo 上传字段；自定义目录验证事实接入同一模型。
- [ ] 三种部署图标支持/置灰/推荐状态全部通过 tooltip（悬浮说明）和无障碍标签解释；不得把 `symbolic_link`、`directory_junction`、`managed_copy` 原值直接渲染给用户。

**验收:** 纯函数测试覆盖同品牌同目录合卡、同品牌不同目录分卡、根目录待创建、共享目录独立卡、共享品牌过滤、内置只读、候选身份未验证；旧卡片测试只改行为断言，不删除既有覆盖。

## 任务 5：收口所有 Agent 展示入口，移除卡片级操作和数量

**Files:**

- 修改：`apps/desktop/src/features/agents/nativeApi.ts`
- 修改：`apps/desktop/src/features/agents/AgentListPage.tsx`
- 修改：`apps/desktop/src/features/agents/AgentDetailPage.tsx`
- 修改：`apps/desktop/src/features/agents/DirectoryMatrix.tsx`
- 修改：`apps/desktop/src/features/onboarding/CompatibilityStep.tsx`
- 修改：`apps/desktop/src/features/discovery/LocalDiscoveryWorkbench.tsx`
- 修改：`apps/desktop/src/features/projects/ProjectListPage.tsx`
- 修改：`apps/desktop/src/features/projects/ProjectDetailPage.tsx`
- 修改：`apps/desktop/src/features/deployment/DeploymentTargetPresentation.tsx`
- 修改：`apps/desktop/src/features/skills/AgentDeploymentIcons.tsx`、关系/技能详情中仍直接展示 Agent 的消费点
- 修改：`apps/desktop/src/i18n/zh-CN/common.json`、`apps/desktop/src/i18n/en-US/common.json`
- 测试：上述模块已有 `.test.ts`/`.test.tsx` 文件，新增统一入口回归断言

**Steps:**

- [ ] 先写失败的消费点测试：Agent 页、初始化/重扫、发现工作台和项目选择使用相同卡片事实；不存在根目录的品牌不出卡；共享目录不重复出品牌卡。
- [ ] Agent 页卡片只保留展示和进入详情页，移除派发/收回入口和 Skill 数量；现有自定义 Agent 的编辑/删除保持原有权限边界，不把它们扩展成发现卡片操作。
- [ ] 详情页显示安装/识别说明、路径异常原因、部署摘要、Skill 数量、关系和操作入口；文案统一使用“已识别 Agent 目录”，不使用“已安装 Agent”。
- [ ] 初始化/重扫继续复用同一归并函数；发现工作台的物理目录卡和共享目录语义接入统一 presenter，不另造一套品牌/类型推断。
- [ ] 项目 Agent 选择、部署目标、技能矩阵、关系面板、图谱详情和来源面板统一使用品牌 Logo + 用户类型徽标；消除直接渲染 `client_id` 的存量路径。
- [ ] 更新 i18n：路径“待创建”、目录角色、共享目录、复制/符号链接/目录联接图标 tooltip、异常建议、已识别 Agent 目录说明均提供中英文；技术枚举不进入用户文案。

**验收:** `pnpm --dir apps/desktop test --run` 定向测试证明所有 Agent 入口口径一致；页面查询不到裸 `client_id`、Skill 数量或安装状态文案；卡片点击只进入详情页。

## 任务 6：把待创建目录接入详情页确认后的现有派发流程

**Files:**

- 修改：`apps/desktop/src/features/agents/nativeApi.ts`
- 修改：`apps/desktop/src/features/agents/AgentDetailPage.tsx`
- 修改：`apps/desktop/src/features/deployment/api.ts`
- 修改：`apps/desktop/src/features/deployment/nativeApi.ts`
- 修改：`apps/desktop/src/features/deployment/DeploymentDialog.tsx`
- 修改：`apps/desktop/src/app/router.tsx`（只扩展现有派发深链的目标初始化）
- 测试：`apps/desktop/src/features/agents/AgentDetailPage.test.tsx`
- 测试：`apps/desktop/src/features/deployment/DeploymentDialog.test.tsx`
- 测试：`apps/desktop/src/features/deployment/nativeApi.test.ts`
- E2E：`tests/e2e/` 中已有部署/原生桥接流程，新增待创建目标场景

**Steps:**

- [ ] 先写失败测试：详情页遇到“待创建”路径时显示创建/派发入口；用户取消不写目录；用户确认后只调用一次创建命令，再进入现有派发预览。
- [ ] 将详情页传入的目标 ID与后端逻辑目标 ID对齐，不把品牌卡 ID或候选物理 ID当派发主键；现有 Skill 库派发入口继续接受已验证目标。
- [ ] 派发方式入口继续复用现有 `DeploymentPreference`、`modes`、预览和确认机制；卡片只展示能力图标，详情页保留方式切换和预览。
- [ ] 创建成功后刷新发现快照和部署目标列表，显示真实路径与真实物理身份；创建失败显示用户可理解建议，不显示原始路径授权 ID或内部错误参数。
- [ ] 对现有目录、共享目录、内置目录和待创建目录分别测试：共享目录仍只写一次，内置目录不可选，待创建目录创建后可正常进入现有派发安全复核。

**验收:** Vitest + Playwright 覆盖取消、确认、重复点击、创建竞态、创建失败、共享目标、内置只读和派发预览；不修改 `VerifiedTarget` 的身份校验原则。

## 任务 7：契约、文档和回归闭环

**Files:**

- 修改：`AGENTS.md`（当前工作树已有一条前后端文案分层规则，实施时保留并检查是否需要随最终字段名微调）
- 修改：`docs/development/开发状态-2026-09-29.md`
- 修改：`docs/development/自动化测试说明-2026-09-29.md`
- 修改：`docs/development/功能完成度与验收状态矩阵-2026-09-29.md`
- 必要时更新：`docs/superpowers/specs/2026-09-28-agent-discovery-card-and-dispatch-design.md`（只记录经实现验证后的边界，不改产品裁决）

**Steps:**

- [ ] 运行绑定生成测试：`SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings`；再次生成确认 `apps/desktop/src/api/bindings.ts` 不漂移。
- [ ] 串行运行定向 Rust、前端、E2E、格式、Lint（静态检查）、TypeScript 类型检查和构建；不要并发运行 `cargo test` 与 Vitest。
- [ ] 更新开发状态、自动化测试说明和完成度矩阵，明确区分代码自动化通过、Windows/macOS 平台能力和真实桌面人工验收；不把自动化通过写成人工通过。
- [ ] 检查当前文档不包含个人绝对路径、真实 Skill 内容、密钥、缓存或构建产物。
- [ ] 完成 `git diff --check`，确认只包含本计划范围；按任务拆分提交，提交前不覆盖用户已有的 `AGENTS.md` 工作树修改。

**建议验证顺序:**

```text
cargo test -p skillhub-adapters --test discovery --test profile_schema --test builtin_profiles
cargo test -p skillhub-storage
cargo test -p skillhub-application --test facade --test facade_deployment_accounting --test facade_observed_deployments
pnpm --dir apps/desktop test --run
pnpm --dir apps/desktop check
pnpm --dir apps/desktop build
pnpm test:e2e --grep "agent|deployment|discovery"
cargo fmt --check --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
git diff --check
```

## 完成标准

- [ ] Profile 根目录规则与调研文档逐项对齐，扫描不做软件安装检测、不创建目录。
- [ ] 根目录存在/缺失、Skill 路径存在/待创建、异常路径和身份变化均有后端事实、前端用户文案和自动化测试。
- [ ] 同品牌同物理目录多类型合卡；同品牌不同目录分卡；共享目录独立一张卡且品牌 Logo 经过根目录存在性过滤。
- [ ] 卡片不显示 Skill 数量、安装状态、部署摘要或技术标识；三种派发方式支持状态和推荐状态以图标呈现并可悬浮解释。
- [ ] 待创建目录仅在用户确认派发后创建，创建后重新取得物理身份并复用现有派发/收回安全链路。
- [ ] 所有 Agent 相关入口统一消费事实和 presenter；绑定无漂移，相关测试、检查和构建通过，文档同步。
