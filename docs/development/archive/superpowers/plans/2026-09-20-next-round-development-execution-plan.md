# 下一轮开发实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按依赖顺序完成当前所有未闭环开发项，恢复可验证的真实桌面体验，并以新的 release 产物完成对应人工复验。

**Architecture:** 本轮先修复会阻断导入、安全、冲突、部署和运行要求事实的后端/绑定/read model，再接入抽屉、详情、列表和概览。图谱、关系治理和发现页面只消费统一的用户视角 presenter 与结构化事实，避免各页面再次直出技术 ID 或自行推导状态。

**Tech Stack:** Rust、SQLite、Tauri 2、Specta bindings、React、TypeScript、React Query、Vitest、Playwright、pnpm、Cargo。

**Spec:** `docs/development/开发状态-2026-09-18.md` 的「下一轮开发代办编排」、`docs/development/人工验收清单-2026-09-18.md`、`人工复验用例-2026-09-20.md`。

## Global Constraints

- 保持纯本地产品边界；不加入跨设备 Git 同步。
- 行为变化必须 TDD（测试驱动开发）：先红、最小实现、重构、回归。
- 不手工编辑 `apps/desktop/src/api/bindings.ts`；契约变化后执行绑定生成并验证不动点。
- 每批至多 3 个独立 worktree（工作树）；同一共享文件、绑定和当前开发文档只能由一个负责人写入。
- 每批合并前执行 `git diff --check`；完成后执行相关 Rust/前端检查、release 构建和人工复验，自动化不得代替人工证据。
- 不提交密钥、个人绝对路径、真实 Skill 内容、缓存或构建产物。
- Windows/macOS 差异经适配器和夹具隔离；链接、目录联接、路径格式、权限和大小写必须有平台边界测试。

## Review Focus

- 缺失/未知 Agent 调用策略必须与“默认模型与用户”区分，且不能将 UI 默认值伪装为已识别事实；由 Task 4 测试。
- 运行要求只能陈述 Skill 声明及来源，不得把字符串命中写成“本机已安装/可运行”；由 Task 4 测试。
- 安全检查失败、取消、冲突同步失败或远程来源超预算时不得留下半成品导入/关系；由 Tasks 5、6、10 测试。
- 同名/重复 Skill 在集中库、部署目标、重启恢复与回滚时必须保留用户可理解的两端身份；由 Task 7 测试。
- 所有新增 UI 在 800×600、窄窗口、键盘与辅助技术下不丢操作、不出现裸 ID；由 Tasks 2、8、9、11 的浏览器与 release 复验测试。

---

## 执行机制与统一 skill（技能）映射

| 阶段 | 适用 skill（技能） | 使用方式 |
|---|---|---|
| 所有行为改动 | `tdd`（测试驱动开发） | 每个子任务先写目标 Rust/Vitest/Playwright 失败测试，再实现最小行为。 |
| 已定位缺陷 | `superpowers:systematic-debugging`（系统化调试） | 先固定复现、数据流和根因，禁止根据截图猜改。 |
| React 页面/组件 | `frontend-design`（前端设计）、`vercel-react-best-practices`（React 最佳实践） | 先明确视觉层级和无障碍，再检查状态、派生数据和渲染性能。 |
| 真实桌面复验 | `agent-browser`（浏览器/桌面自动化） | 仅用于探索、截图与回归辅助；最终以 macOS/Windows 真机人工记录为准。 |
|                 |                                                              |                                                              |
| 每批收口 | `superpowers:requesting-code-review`（请求代码审查） | 相关测试通过后做独立审查，再由主负责人整合、构建和更新四份当前文档。 |

## 并行规则

```text
Wave 0：基线与契约盘点（单负责人）
Wave 1：A 部署/概览修复 ─┬─ B 运行要求/安全/冲突契约 ─┬─ C 图标候选
                           │                                 │
Wave 2：D 详情/列表数据 ───┘                                 └─ E 同名/冲突历史
Wave 3：F Agent presenter → G 图谱/关系页面 → H 发现/导入流程
Wave 4：I 共享目录拓扑 + J 列表/图谱新增交互
Wave 5：各平台 release 构建与人工复验（串行）
```

- Wave 1 最多并行 A、B、C；A 不写 bindings，B 独占 bindings 与 `ApplicationFacade`，C 只写品牌资产/图标脚本。
- Wave 2 的 D、E 可并行；均不得同时改同一前端 facade 或生成绑定。
- Wave 3 的 F 必须先完成；G 与 H 可在不同 worktree 并行，但 G 独占 `features/relationships/**`/图谱样式，H 独占 `features/discovery/**`、`features/import/**`。
- Wave 4 的 I、J 可并行；I 独占发现快照/关系图契约，J 独占列表和图谱搜索组件。
- Wave 5 不并行跑 CPU 重的 Cargo 与 Vitest；按当前文档的串行验证口径执行。

## 编号到 skill（技能）与并行线的逐项映射

| 编号 | 首选 skill（技能） | 并行线 | 前置依赖 |
|---|---|---|---|
| DEV-1 | `agent-browser`、`tdd` | 外部阻塞 | macOS 可写第二卷 |
| DEV-8 | `tdd`、`frontend-design` | 外部阻塞 | 官方素材 |
| DEV-18-A | `systematic-debugging`、`tdd` | A | 无 |
| DEV-21-A | `systematic-debugging`、`tdd`、`frontend-design` | A | DEV-18-A 可并行 |
| DEV-22-A | `systematic-debugging`、`tdd` | A | DEV-21-A 的部署事实 |
| D5-11 | `tdd`、`frontend-design` | C | 无 |
| DEV-25 | `systematic-debugging`、`tdd`、`frontend-design` | A | 无 |
| DEV-26 | `systematic-debugging`、`tdd` | D | 无 |
| DEV-27 | `tdd`、`frontend-design` | D | 无 |
| DEV-28 | `systematic-debugging`、`tdd`、`frontend-design` | B | bindings 独占 |
| DEV-29 | `tdd`、`vercel-react-best-practices` | D | 上游状态 read model |
| DEV-30 | `frontend-design`、`vercel-react-best-practices`、`tdd` | G | DEV-29 可并行、共享技能库样式需串行 |
| DEV-31 | `systematic-debugging`、`tdd` | G | 无 |
| DEV-32 | `systematic-debugging`、`tdd` | G | 无 |
| DEV-33 | `frontend-design`、`tdd` | G | 无 |
| DEV-34 | `frontend-design`、`tdd` | G | DEV-32 后 |
| DEV-35 | `frontend-design`、`tdd` | G | DEV-39 后 |
| DEV-36 | `frontend-design`、`tdd` | G | DEV-35 可并行 |
| DEV-37 | `frontend-design`、`tdd` | G | 无 |
| DEV-38 | `frontend-design`、`vercel-react-best-practices`、`tdd` | G | DEV-37 可并行 |
| DEV-39 | `frontend-design`、`tdd` | F | 无，先于 DEV-35/46 |
| DEV-40 | `systematic-debugging`、`tdd` | G | 无 |
| DEV-41 | `frontend-design`、`tdd` | G | DEV-40 后 |
| DEV-42 | `frontend-design`、`tdd` | G | DEV-41 后 |
| DEV-43 | `systematic-debugging`、`tdd` | G | DEV-40/42 后 |
| DEV-44 | `frontend-design`、`tdd` | G | DEV-39 后 |
| DEV-45 | `frontend-design`、`tdd` | G | DEV-31/35/44 后 |
| DEV-46 | `frontend-design`、`tdd` | D | DEV-39 后 |
| DEV-47 | `frontend-design`、`tdd` | D | 无 |
| DEV-48 | `systematic-debugging`、`tdd` | B | bindings 独占 |
| DEV-49 | `frontend-design`、`tdd` | H | 无 |
| DEV-50 | `systematic-debugging`、`tdd` | H | 无 |
| DEV-51 | `frontend-design`、`tdd` | H | DEV-50 后 |
| DEV-52 | `frontend-design`、`tdd` | H | DEV-50 后 |
| DEV-53 | `systematic-debugging`、`tdd` | H | DEV-52、DEV-48 后 |
| DEV-54 | `tdd`、`frontend-design` | H | DEV-48、DEV-53 后 |
| DEV-55 | `tdd`、`frontend-design` | H | DEV-54 后 |
| DEV-56 | `frontend-design`、`tdd` | H | 无 |
| DEV-57 | `systematic-debugging`、`tdd` | E | DEV-58 后 |
| DEV-58 | `systematic-debugging`、`tdd`、`frontend-design` | B | DEV-48 后 |
| DEV-59 | `systematic-debugging`、`tdd` | I | 无 |
| DEV-60 | `systematic-debugging`、`tdd` | I | DEV-59 后 |
| DEV-61 | `tdd`、`frontend-design` | B | DEV-48 后 |
| DEV-62 | `tdd`、`frontend-design` | B | DEV-48、DEV-61 后 |
| DEV-63 | `systematic-debugging`、`tdd` | E | DEV-58 可并行 |
| DEV-64 | `frontend-design`、`tdd` | J | DEV-38 后 |
| DEV-65 | `frontend-design`、`tdd` | J | DEV-39、DEV-46 后 |

## Task 0：基线、共同契约与工作树划分

**Covers:** 全部任务的前置工作。

**Skills:** `tdd`、`superpowers:requesting-code-review`。

**Files:**
- Read: `AGENTS.md`、四份当前开发文档、`人工复验用例-2026-09-20.md`。
- Read: `crates/skillhub-application/src/lib.rs`、`apps/desktop/src/api/bindings.ts`、各目标 feature 的 `api.ts`/`nativeApi.ts`。
- Modify: 仅在后续任务落地时修改四份当前文档；本任务不改产品代码。

- [ ] 运行 `git fetch origin`、`git checkout feat/v0.2.0-product-completion`、`git pull --ff-only origin feat/v0.2.0-product-completion`，先保存现有未提交文档改动的 diff 范围，不覆盖用户工作。
- [ ] 用 `graphify query` 或定向 `rg` 列出每个 Wave 的共享文件；将 worktree 所有权写入任务开始说明。
- [ ] 为每个 worktree 运行最小基线：`pnpm --dir apps/desktop check` 或受影响的 `cargo test -p <crate>`；记录实际失败，不把旧环境失败归因于新任务。
- [ ] 主负责人统一生成 bindings、整合提交、运行 `git diff --check` 和更新文档；子任务不得推送。

## Task 1：部署、概览与 macOS 图标收口

**Covers:** `DEV-18-A`、`DEV-21-A`、`DEV-22-A`、`DEV-25`、D5-11 / `OPT-20260914-06`。

**Skills:** `tdd`、`superpowers:systematic-debugging`、`frontend-design`、`vercel-react-best-practices`、`agent-browser`。

**Files:**
- Modify: deployment preview/result/operation presenter、`apps/desktop/src/features/agents/nativeApi.ts`、`apps/desktop/src/features/overview/**`、相关 i18n、`assets/branding/generate-macos-icon.py` 和其资源测试。
- Test: 受影响 Rust deployment facade 测试、`apps/desktop/src/features/overview/**/*.test.tsx`、部署 Playwright spec、图标资源测试。

**Design:**

1. 将失败预览中的 `SkillId` 映射为 display name/runtime name；错误行保留技术 ID 仅供展开诊断。
2. 将「目录联接/不支持符号链接」收敛为主文案「链接部署/复制部署」，实现类型放在技术细节；成功结果、详情和治理页提供同一可达的“解除部署并恢复原状”操作。
3. 修复 Agent 页按逻辑目标/物理目标错配的投影，并将概览图表维度 key 转成用户可读 Agent/项目名。
4. 概览使用可用高度分配而非固定视口魔数：主容器 `min-height: 0`，可压缩区明确 `flex`/grid track，页面根不出现滚动，卡片内部需要时独立滚动。
5. D5-11 只增加 macOS 图标透明外边距的候选，不改 Windows `.ico`；保留当前资产作为可回滚基线，重新生成 `.icns` 后同一 Dock 设置人工对照。

- [ ] 写失败测试：部署失败行以 `display_name` 渲染；预览/结果不含裸 UUID 主文案；成功部署出现 undeploy action；逻辑目标和物理目标映射为同一计数。
- [ ] 写失败测试：1100×760、800×600 与宽屏概览页面根 `scrollHeight <= clientHeight`，并断言内容区不被裁切。
- [ ] 写失败资源测试：新 macOS 候选仍为 1024×1024 RGBA、圆角透明边缘，外层比例改变必须显式更新测试范围及理由。
- [ ] 最小实现并逐项跑相关 Rust/Vitest/Playwright；不通过增加延时或放宽断言。
- [ ] 构建 `SkillHub.app`，在 macOS Dock 与 Finder/TextEdit 对照图标；Windows 真机复验部署文案、清理入口、计数和概览。
- [ ] 提交建议：`fix: close deployment and overview acceptance gaps`；图标候选若需用户裁决则独立提交 `feat: refine macOS Dock icon inset`。

## Task 2：标签、翻译、上游更新与详情版本一致性

**Covers:** `DEV-26`、`DEV-27`、`DEV-29`、`DEV-46`、`DEV-47`。

**Skills:** `tdd`、`superpowers:systematic-debugging`、`frontend-design`、`vercel-react-best-practices`。

**Files:**
- Modify: `MetadataPanel.tsx`、metadata/translation facade、`BootstrapGate` refresh path、`features/skills/nativeApi.ts`、`SkillDetailPage`/关系面板、版本 presenter、i18n。
- Test: metadata、translation、native API、抽屉/详情一致性、版本标签和路径展示测试。

**Design:**

- 标签解析统一把 `,` 与 `，` 当分隔符，trim、过滤空值、保持去重；保存成功同时失效 React Query 与刷新 bootstrap snapshot。
- 翻译只能经现有模型命令，显示进行中/失败；译文必须经用户确认后才写入 `user_purpose`，取消零写入。
- 上游更新以后台 read model 提供 `upgrade_available`，而非渲染期联网；筛选能区分未检查、无来源、不可达、有更新。
- Agent 关系和版本统一由 presenter 产出；所有列表/抽屉/详情/时间线使用相同用户可读名称、类型与版本标签，技术路径/指纹折叠。

- [ ] 分别写中文逗号、重复标签、保存后概览立即刷新、翻译确认/取消/失败、更新筛选状态、版本 `vN` 回退的失败测试。
- [ ] 先修领域/read model，再修 facade，最后调整 UI；任何字段没有真实来源时显示诚实空态而非固定 `false`/`0`。
- [ ] 在 800×600、键盘焦点和长版本/路径场景新增浏览器断言；完整详情页必须覆盖抽屉已有关系信息。
- [ ] 提交建议：按独立可审查单元拆为 `fix: normalize metadata tags and refresh overview`、`feat: complete translation-to-purpose workflow`、`feat: expose upstream status and consistent detail presenters`。

## Task 3：调用策略与运行要求完整接入

**Covers:** `DEV-28`。

**Skills:** `tdd`、`superpowers:systematic-debugging`、`frontend-design`、`vercel-react-best-practices`。

**Files:**
- Modify: `crates/skillhub-adapters/src/invocation.rs`、`requirements/parser.rs`、导入/目录库写入路径、`crates/skillhub-core/src/api/query.rs`、`crates/skillhub-application/src/lib.rs`、`apps/desktop/src/features/skills/nativeApi.ts`、`SkillQuickDrawer.tsx`、`RequirementsPanel.tsx`、bindings/i18n。
- Test: adapter invocation/requirements tests、application facade tests、native API、drawer/detail tests。

**Interfaces:**
- Produces a read-only `InvocationPolicyFact { mode, source, field? }` and `DeclaredRequirementFact { kind, name, version?, explicit, source }` in list/detail query DTOs.
- Does not produce a free-form “调用声明/命令” field.

**Design:**

1. 对可识别 Agent 使用既有适配器规则；没有明确参数时 policy 为 `model_and_user` + `source: default`，页面可显示“默认规则”，不得把默认当显式声明。
2. 扫描 `SKILL.md`、`requirements.txt`、`pyproject.toml`、`package.json`、`Dockerfile`、`.env.example`；保存解析来源、版本与 explicit 标记。
3. 运行要求是声明事实，不是安装/可执行证明；环境验证未来可独立加状态，不能混入本项。
4. 抽屉/详情只读显示：策略一行、运行要求独立列表；无声明只显示一次“未声明运行要求”，不重复“暂无可靠数据”。

- [ ] 写失败测试：Claude/Codex/OpenCode 的显式参数、未知平台、无参数默认；同一 Skill 在不同 Agent 平台返回不同 policy fact。
- [ ] 写失败测试：依赖文件、环境变量、版本、重复项、解析失败；敏感环境变量值必须被脱敏且只记录变量名/来源位置。
- [ ] 写失败测试：导入后重启仍可查询 requirement facts；drawer/detail 只读、无重复空态、无编辑控件。
- [ ] 将 DTO 加入 Rust query 与 Specta 生成，不手改 bindings；更新 native facade 后运行 bindings 生成两次，校验 SHA-256 不动点。
- [ ] 提交建议：`feat: expose declared runtime requirements and invocation facts`。

## Task 4：安全检查、冲突历史、冲突同步与同名部署边界

**Covers:** `DEV-48`、`DEV-57`、`DEV-58`、`DEV-61`、`DEV-62`、`DEV-63`。

**Skills:** `tdd`、`superpowers:systematic-debugging`、`frontend-design`、`vercel-react-best-practices`、`superpowers:requesting-code-review`。

**Files:**
- Modify: import commit pipeline、basic-check facade/read model、conflict repository/workspace query、security facades、`SkillQuickDrawer`、`SkillDetailPage`、`SkillTable`、deployment planner/presenter、i18n/bindings。
- Test: import governance Rust tests、conflict workspace tests、security UI tests、SkillTable tests、Playwright import/deployment specs。

**Dependencies:** `DEV-48` before `DEV-61/62`; `DEV-58` before true release revalidation of `DEV-57`; `DEV-63` can run in a separate worktree after its deployment DTO ownership is reserved.

**Design:**

- `DEV-48`: basic check is an independent pre-commit gate; AI is optional and never substitutes the gate. Failed/cancelled/over-budget checks create no imported state.
- `DEV-58`: conflict facts become durable only at commit; successful commit invalidates workspace queries; uncommitted wizard plans are not history; manual decision is immutable to AI suggestion.
- `DEV-57`: completed duplicate decisions appear in an “已识别/已处理” history, not the unresolved queue.
- `DEV-61/62`: one shared security action model drives drawer, detail and table; table separates status from result metrics and consumes real aggregate values.
- `DEV-63`: central library permits same-name entities; target name is unique per target. Alias is optional, only managed copy may use it, and it rewrites only the isolated copy with reversible mapping; links/junctions reject alias.

- [ ] Write Rust red tests for basic gate pass/fail/cancel/retry, conflict commit/restart/query invalidation, manual-vs-AI precedence, same-content history, same-name target conflict, alias rejection for links.
- [ ] Write UI red tests for basic/AI independent actions, cancellation state persistence, table two-column headers, real pending/high-risk values, duplicate history wording, and no technical IDs as primary text.
- [ ] Implement in dependency order, regenerating bindings only once after all API shape changes in this task.
- [ ] Run focused tests first, then `cargo test --locked --workspace --all-features`, `pnpm --dir apps/desktop test --run`, `pnpm --dir apps/desktop check` serially.
- [ ] Rebuild release and repeat manual cases 1–3, 8, 10, 11 only after the matching feature is genuinely present.
- [ ] Commit suggestions: `feat: gate imports on basic safety checks`; `feat: persist conflict decisions and history`; `feat: unify security actions and result projection`; `feat: enforce deployment name boundaries`.

## Task 5：Agent 用户视角 presenter、图谱和关系治理重构

**Covers:** `DEV-30`–`DEV-45`。

**Skills:** `frontend-design`、`vercel-react-best-practices`、`tdd`、`superpowers:systematic-debugging`、`web-design-guidelines`（Web 界面规范审查）。

**Files:**
- Modify: shared Agent presenter/brand assets, `features/relationships/**`, graph canvas/details/search, governance pages, `platform/displayPath.ts`, relevant CSS/i18n.
- Test: graph canvas, relationship navigation/governance, presenter unit tests, Playwright responsive/keyboard tests.

**Sequencing inside task:**

1. `DEV-39` first: shared `AgentPresentation` maps client kind to user labels/logo/type/accessibility name.
2. `DEV-31/32/34/35/36/44/45`: consume presenter in graph, repair path normalization and pointer hit testing, then add layout/type/alias/detail semantics.
3. `DEV-30/33/37/38`: redesign library/graph toolbars, tabs, equal-height graph/details and in-canvas controls.
4. `DEV-40/41/42/43`: repair governance navigation, bottom action bar, one vertical scroll owner, user-facing columns and graph-to-governance deep links.

- [ ] For each numbered issue write a narrow red test before moving CSS: e.g. `displayPath` removes prefixes; blank canvas pans; agent node has accessible brand+type; graph edge types have legend; deep link filters `relationId` and focuses the row.
- [ ] Use `frontend-design` to approve information hierarchy before CSS implementation; use `web-design-guidelines` after implementation for focus, target size, overflow and semantic controls.
- [ ] Keep graph geometry deterministic; avoid random layout or screenshot-only assertions. Assert DOM/ARIA geometry plus targeted Playwright screenshots at 800×600 and desktop width.
- [ ] Commit by cohesive surface: presenter → graph facts/details → graph layout/toolbars → governance information architecture.

## Task 6：发现、导入来源与关系治理 Pipeline

**Covers:** `DEV-49`–`DEV-56`。

**Skills:** `tdd`、`superpowers:systematic-debugging`、`frontend-design`、`vercel-react-best-practices`、`agent-browser`。

**Files:**
- Modify: discovery home/repository pages, import wizard, source parser/facade, remote acquisition adapters, governance handoff, SkillLibrary empty state, bindings/i18n.
- Test: discovery/import React tests, Rust source/security tests, Playwright wizard tests.

**Dependencies:** `DEV-50` → `DEV-51/52` → `DEV-53` → `DEV-54/55`; `DEV-49` and `DEV-56` are independent and can run in the third parallel lane.

**Design:**

- `DEV-49`: configured repositories and management use the same default card projection as online discovery.
- `DEV-50`: remove all lock discovery route/component/parser/binding/test references; old deep link has a truthful fallback.
- `DEV-51/52`: local folder selection directly starts preview; manual source card recognizes local path/URL/Git/`npx skills add`, but only local source enters import until remote fetch exists.
- `DEV-53`: URL/Git acquisition has allowed-source validation, redirects/auth/network errors, extraction budgets, traversal/link checks, temp cleanup and cancellation; `npx` remains parse-only and never runs a command.
- `DEV-54/55`: resolve content conflict before relationship impact; import succeeds independently, then creates a governance task with immediate/later entry; governance failure never rolls back ordinary import.
- `DEV-56`: empty search lives inside existing list workspace and preserves filters, controls and focus.

- [ ] Write red contract tests for every unsupported remote input and every cleanup path before adding fetch code.
- [ ] Write red UI tests for no manual-source duplication, direct candidate transition, conflict-first ordering, governance deferral, retained search controls.
- [ ] Only after `DEV-48` is integrated, wire acquired candidates through the same basic safety gate.
- [ ] Commit by dependency step; never mix lock removal with remote download implementation in one commit.

## Task 7：共享目录拓扑与新增列表/搜索呈现

**Covers:** `DEV-59`、`DEV-60`、`DEV-64`、`DEV-65`。

**Skills:** `tdd`、`superpowers:systematic-debugging`、`frontend-design`、`vercel-react-best-practices`。

**Files:**
- Modify: discovery snapshot/projection, directory capability facts, relationship graph projector, `GraphSearch`, `SkillTable`, tooltip/accessibility helpers, i18n/tests.

**Dependencies:** `DEV-59` before `DEV-60`; `DEV-64/65` may run in parallel with `DEV-59`, but `DEV-65` consumes Task 5’s unified Agent/list presenter if it affects Agent fields.

**Design and tests:**

- [ ] `DEV-59`: write a snapshot test with two Agent profiles resolving one physical `.agents/skills`; expect exactly one shared directory entity/card plus supporter count/names. Preserve separate brand-specific directories.
- [ ] `DEV-60`: write graph projection tests for Skill→shared directory→supported Agent edges, and prove it does not emit a fabricated direct Skill→Agent deployment edge.
- [ ] `DEV-64`: write interaction tests for debounce, input-anchored listbox, arrows/Enter/Escape, blur, error/no-result states and selection preserving graph filters/layout.
- [ ] `DEV-65`: write table tests that tags are individual badges and every truncatable field has both hover and keyboard-readable full value, without tooltip obscuring operations.
- [ ] Implement minimal projections/components, run affected Rust/Vitest/Playwright tests, then release-retest shared cards, graph topology, search and tooltips.

## Task 8：平台与素材阻塞项

**Covers:** `DEV-1`、`DEV-8`。

**Skills:** `agent-browser`（真机辅助记录）、`tdd`（只在拿到条件/素材后修改）、`superpowers:requesting-code-review`。

**Execution:**

- [ ] `DEV-1`: 在 macOS 上准备“集中库卷”和可写第二卷；执行一次跨卷纳入集中库，记录两侧条目数/树哈希、源文件零删除和失败恢复。没有可写第二卷时保持阻塞，不以模拟挂载或单元测试替代。
- [ ] `DEV-8`: 收到可信 WorkBuddy 官方绿色 logo 后核验来源和授权边界，接入品牌映射的深浅色/尺寸变体，写渲染测试；素材未到位不自绘、不占用开发并行槽位。

## Task 9：整合、验证与人工验收回写

**Covers:** 全部完成批次。

**Skills:** `superpowers:requesting-code-review`、`agent-browser`、`tdd`。

- [ ] 主负责人按 Wave 合并，逐次运行 `git diff --check`、受影响测试、`pnpm --dir apps/desktop check`；Cargo 与 Vitest 不并发。
- [ ] API 变化后执行 `SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings` 两次，确认第二次无 diff。
- [ ] 每个开发批次完成后执行 release 构建：`pnpm --dir apps/desktop install --frozen-lockfile`、`pnpm --dir apps/desktop build`、`pnpm --dir apps/desktop tauri build --no-bundle --config '{"build":{"beforeBuildCommand":"echo frontend-already-built"}}'`。
- [ ] macOS 用同一 release 产物的 `SkillHub.app` 复验，确认 WebView 页面存在 `main`；Windows/macOS 证据分开记录。
- [ ] 每项人工结果先回查已有 DEV/SR/J-REL，标记为新问题、未修复、回归或数据前置阻塞；更新四份当前开发文档与 `人工复验用例-2026-09-20.md`。
- [ ] 每 Wave 完成后请求独立审查；全部 Wave 后进行全分支审查。只有已验证行为、文档、构建和平台证据齐全才标记完成。

## 自检结果

- **覆盖性：** 已覆盖 `DEV-1`、`DEV-8`、`DEV-25`–`DEV-65`、`DEV-18-A`、`DEV-21-A`、`DEV-22-A` 和 D5-11；仅外部条件项保留阻塞而不伪造实现。
- **并行安全：** bindings/ApplicationFacade、关系图模块、发现/导入模块、品牌资源分别指定独占写入方；最多三条并行工作线。
- **测试与人工边界：** 每项设计都要求先红测试；冲突、安全、平台和视觉项明确保留 release 真机复验。
- **术语一致性：** 调用策略、运行要求、冲突历史、关系治理、部署别名和共享目录的定义与当前验收裁决一致；不再包含已被产品取消的独立“调用声明/命令”字段。
