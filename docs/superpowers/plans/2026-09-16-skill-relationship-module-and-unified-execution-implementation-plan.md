# 技能关系模块与统一执行体验实施计划（2026-09-16）

## 状态、依据与边界

- 状态：**后端主线 Task 1、Task 2、Task 3 已完成代码与自动化闭环（2026-09-16）**；Task 4—11 尚未开始（Task 11 为用户可见动作词收敛，2026-09-16 登记）。本计划落实《技能关系模块与统一执行体验设计（2026-09-16）》，不替代其中的产品决策。逐任务进展与提交见「实施进展」。
- 基线：`feat/v0.2.0-product-completion`；现有 Task 5—10 的关系事实、`0014/0015` 存储、关系迁移 prepare/commit/rollback、冲突 AI 分析和操作日志均已可复用。
- 实施方式：每个任务先补失败测试，再做最小实现，最后重构；Rust 契约变更后只能通过 `SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings` 生成 `apps/desktop/src/api/bindings.ts`，不得手改绑定文件。
- 不在本轮做的事：常驻目录监控、可无限展开的系统图谱、图谱画布中的文件修改、AI 自动执行文件变更、图谱专用键盘拖拽/缩放。
- 术语冻结：用户动作叫“纳入集中库管理”；技术细节可说明管理链接。冲突页面叫“冲突处理”，不是通用待办；治理页面叫“关系治理”。**「部署」只能作名词（链接部署/复制部署/部署关系）或技术详情术语，不得作动词**；用户动作一律“添加到 Agent/项目”“从 Agent/项目移除”（规则与实施见任务 11）。

## 实施进展（2026-09-16）

| Task | 状态 | 提交 | 已冻结的契约与行为（下游只能消费，不得另造入口） | 仍未完成 |
|---|---|---|---|---|
| 1 关系投影、关系版本与图谱查询 | **代码与自动化闭环完成** | `0c0b5260`、`f78616bb`、`cd37f5b7`、`4478039e`、`19c30c8f`、`64313923`、`0a4f1287` | `GetSkillRelationshipGraph`、候选 query、单中心有限深度投影、折叠计数与原因、关系 revision 推进点、0015 升级测试；desktop 已接入绑定 | 图谱页面、路由、搜索与筛选 UI（Task 6/5/9） |
| 2 冲突“具体决定”契约 | **代码与自动化闭环完成** | `b1172364`、`bc4b2185`、`92ca8165`、`36aec8a9` | `ResolveConflictCase` command、冲突工作台 query、AI 建议到明确动作的映射、治理预览意图；不重做 AI runner | 冲突处理双侧对比工作台（Task 7） |
| 3 关系治理清单与安全批处理 | **代码与自动化闭环完成** | `54ed6548`、`65ef9f68`、`2f3205a5`、`6e6055b8` | 只读治理清单 query（四桶 all / eligible-to-centralize / needs-validation / blocked，按关系边出账）、`Prepare/Commit/RollbackRelationGovernanceBatch` 三个编排命令、一个父 operation 映射每个子 `migrate_relation`、逐行共享影响确认、部分失败保留成功项与逐项重试信息、取消隔离在单行 | 治理页、解除部署入口收敛与顶栏执行反馈（Task 8、Task 4） |

Task 3 的必须保持：批量只是对单条四段安全链路的编排，逐行仍走 `prepare_relation_migration`，因此指纹校验、共享影响确认与关系锁照常生效；未新增第二套关系表、第二本操作日志或命令级旁路。`undeploy` 走 `DeploymentId` 命名空间，与 `relation_id` 无映射，故批量仅以 `relation_id` 为粒度，解除部署入口收敛留给 Task 8。

### 计划外的必要补完：Windows 目录联接执行器（2026-09-16）

设计第 155 行要求「Windows 根据能力使用符号链接或 junction」，但该能力此前只有形状没有实现：`DeploymentMode::DirectoryJunction`、`select()` 的 symlink → junction → copy 回退、`plan_relation_conversion` 的跨卷拒绝、`apply`/`remove_target` 的 junction 分支都已存在，而 `create_junction` 与 `probe_junction` 恒报不可用。后果是未开启开发者模式的 Windows 账号无法完成「纳入集中库管理」——这属于 Task 6「纳入集中库管理」链路的缺口，不是本计划新提出的功能。

已补齐（`349e81f5` core、`4d254711` adapters，文档 `6961d03d`/`a6f63327`/`2e74c0a7`）。**这不构成对「Task 3 不重写文件系统适配器」边界的破坏**：批量编排没有新增文件操作，改动的是既有部署适配器里本来就该有的执行器。

- 本机 macOS 证据：`deployment_planner` 33/33、工作区 142 套件 / 1094 通过 / 0 失败、fmt 与 core/adapters `clippy -D warnings` 通过。
- Windows 侧**仅类型检查**（`x86_64-pc-windows-msvc`；`skillhub-adapters` 整 crate 无法交叉编译，因为 `reqwest → rustls → aws-lc-sys` 的构建脚本需要 Windows C 工具链）。运行时证据的唯一入口是《人工验收清单-2026-09-16》RC-13/RC-14，**在拿到真机证据前不得表述为「Windows 已验证」**。
- 顺带发现并登记（未改）：`symlink_physical_id_for_path` 的注释与 Windows 分支实际语义不符，改动会让既有符号链接存证失效，需显式迁移决策。

## 完成后的路由与职责

| 路由 | 页面 | 只承担的职责 |
|---|---|---|
| `/relationships?skillId=<id>` | 技能图谱 | 读取一项中心 Skill 的有限深度关系投影、解释与跳转 |
| `/relationships/decisions` | 冲突处理 | 对比一组 `uncertain` 冲突、可选 AI 分析、提交明确人工决定 |
| `/relationships/governance` | 关系治理 | 以关系边为单位预览、确认、批量执行部署/解除部署/纳入集中库管理 |

技能库继续拥有单个 Skill 的内容、版本、标签、安全、导出与删除，并保留“部署”快捷入口；Agent 与项目页继续管理各自对象。它们的关系摘要只深链到上述页面，不复制关系操作。通用待办继续服务安全、恢复、试用等既有类型，不接管冲突或治理。

## 复审结论：增量扩展约束、公共 seam 与技能使用

本计划经现有代码复核后确认可以进入开发，但须按以下约束实施：它是**在现有关系闭环上加页面、查询投影和少量命令**，不是替换关系模型、重写部署链路或重建操作系统。

### 禁止的重构边界

1. `RelationshipOverview`、`ConflictCaseFact`、`GovernanceTaskFact`、`DeploymentRelationFact`、`source_relations` 及 `0014/0015` 是事实基础。新图谱和工作台只能读取/补充这些事实，不能建第二套并行关系表。
2. 单条关系变更继续由 `relationship_governance_service.rs` 的 `get_relationship_removal_impact`、`prepare_relation_migration`、`commit_relation_migration`、`rollback_relation_migration` 把关；批量是对这些单条安全步骤的编排，不能绕过它们重写文件操作。
3. `operation_repository` 是持久化审计来源；`operationTracker.ts` 只是前端在途投影。不得引入第二本操作日志，也不得把后端执行状态只留在 React 内存中。
4. 已有 `AppShell`、`Sidebar`、`router`、`NotificationBell`、`OverviewPage`、Skill/Agent/项目详情页继续作为宿主。新增 feature 只在必要处接入，不做无关 CSS、导航或页面架构翻新。
5. 关系版本只由实际关系事实写入推进。初始写入范围固定为 `relationship_repository.rs`、`deployment_repository.rs`、`provenance_repository.rs`、`relationship_governance_service.rs` 和 `lib.rs` 中冲突组写入点；先用测试确认每一点，未证明相关的命令不得被“顺手”接入。

### 测试 seam 与逐 Task 技能矩阵

以下 seam 就是实现期间先写测试、再写最小代码的公共接口；它们已经与已确认设计一致。出现测试失败时，先使用调试技能定位根因，不能用降低断言或任意延时绕过。

| Task | 增量复用与明确新增 | 公共测试 seam（不测私有实现） | 执行时技能 |
|---|---|---|---|
| 1 关系投影 | 复用 `RelationshipOverview` 和 relationship/deployment/provenance repositories；新增图谱候选/单中心投影 query 与关系版本，不改既有 overview query 的消费者 | `AppQuery::GetSkillRelationshipGraph`、候选 query、数据库升级后读取结果 | **tdd**；失败时 **systematic-debugging**。无 UI，不用设计技能 |
| 2 冲突具体决定 | 复用 `ConflictCaseFact`、`AnalyzeConflict`、0015 分析记录与 operation journal；新增显式决定 command/workspace query，不重做 AI runner | `AppCommand::ResolveConflictCase`、`AppQuery::GetConflictWorkspace`、操作记录读取 | **tdd**；失败时 **systematic-debugging** |
| 3 治理批处理 | 复用 relation migration 四段安全链路和 removal impact；新增治理清单 query、父子批处理编排，不重写文件系统适配器 | 治理 list query、batch prepare/commit/rollback command、已有单条 migration command | **tdd**；失败时 **systematic-debugging** |
| 4 统一执行桥 | 复用 `OperationPhase`/operation repository、`operationTracker.ts`、通知中心；扩展前端规范化投影和连接层，不新建后端日志系统 | `runTrackedOperation`（新增统一包装）与 `TaskStatusIndicator` 的可访问 UI | **tdd**、**frontend-design**、**vercel-react-best-practices**；失败时 **systematic-debugging** |
| 5 模块外壳 | 复用 BrowserRouter、`AppShell`、`Sidebar`、既有 history 回退；仅注册关系路由和来源状态 | 路由 URL、导航选中态、浏览器 back/forward 状态 | **tdd**、**frontend-design**、**vercel-react-best-practices** |
| 6 技能图谱 | 只消费 Task 1 query；使用 React/SVG 本地布局，不增加图数据库、画布框架或持久化图像 | graph projection 函数、图谱页面 URL/搜索/筛选/点击交互 | **tdd**、**frontend-design**、**vercel-react-best-practices**。只有用户要求产出或维护 Figma 文件时才用 **figma-generate-design**（随后按其前置要求用 **figma-use**）；当前不是 Figma 交付 |
| 7 冲突处理页 | 复用 Task 2 workspace、现有 `RelationshipGovernancePanel`/`SemanticDuplicatePanel` 的只读结论呈现；抽取共享显示逻辑，不复制 AI 业务判断 | 冲突工作台 facade、明确决定动作、治理深链 | **tdd**、**frontend-design**、**vercel-react-best-practices**；失败时 **systematic-debugging** |
| 8 关系治理页 | 复用 Task 3 facade 与 `RelationshipRemovalImpactView`；Skill/Agent/项目只改为深链，保留原对象页职责 | 关系行/批处理 UI facade、preview→confirm→execute 交互、来源回退 | **tdd**、**frontend-design**、**vercel-react-best-practices**；失败时 **systematic-debugging** |
| 9 概览融合 | 复用 `BootstrapSnapshot`、`bootstrap_repository.rs`、现有柱状图/饼图/待办组件；只增加关系摘要字段和一个缩略入口，不改原图表模型 | bootstrap snapshot、`getOverviewMetrics`、Overview 可见布局与深链 | **tdd**、**frontend-design**、**vercel-react-best-practices** |
| 10 全量接入与验收 | 复用所有既有 native facade 与 `pnpm test:e2e`；只迁移实际异步入口，不把同步浏览动作记成任务 | 每个 facade 的异步动作、通知→操作记录、Playwright 用户路径 | **tdd**、**playwright-cli**（E2E 失败复现/视觉 QA）、**vercel-react-best-practices**；失败时 **systematic-debugging** |

整体架构设计已通过 **superpowers:brainstorming** 完成并获确认；它是本计划的前置，不在每个代码切片重复触发。当前可用技能已覆盖实施需要，无需安装新技能。

### 开始 Task 1 前的固定切分

Task 1 不作为一个大提交实施，固定拆为三个独立的红→绿切片：

1. `relationship_projection.rs`：纯投影、有限深度、节点/边/折叠规则；
2. storage：仅在已列出的关系事实写入点推进 revision，补最小 migration 与 `0015` 升级测试；
3. application/desktop：候选 + 图谱 query、绑定生成、facade 集成测试。

每一切片在对应 seam 的定向测试全绿后再进入下一片；不把 migration、查询、前端页面混在同一切片中。

### 实施并行与合并顺序

并行只用于文件边界清晰的工作单元；共享 `api/query.rs`、`api/command.rs`、`relationship_governance_service.rs`、`AppShell.tsx`、`router.tsx` 或双语 `common.json` 的任务不并行直接合并。每个并行实现单元使用独立 worktree，先通过任务级复审再合入阶段基线。

```text
主线 A（后端契约，串行）  Task 1 → Task 2 → Task 3
并行线 B（执行基础）       Task 4 → Task 5
页面并行                    Task 6 | Task 7 | Task 8 | Task 9
文案线 C（规则先冻结）      Task 11（可任意时候分片实施，但规则须早于 Task 5—9 的文案）
全局收口                    Task 10
```

| Task | 前置条件 | 能否并行 | 原因与合并规则 |
|---|---|---|---|
| 1 | 无 | 仅可与 Task 4 的 tracker 纯前端切片并行 | Task 1 先冻结图谱 query 与关系 revision；不得与 Task 2/3 同时改 core API 或关系服务 |
| 2 | Task 1 已合入 | 否（后端主线） | 与 Task 1/3 共用 core command/query、关系类型和 application facade；串行消除契约/绑定冲突 |
| 3 | Task 2 已合入 | 否（后端主线） | 复用并扩展相同关系服务和 command/query 入口；完成后才冻结治理 facade |
| 4 | 无 | 可与 Task 1 并行 | 仅先做 tracker、通知桥的纯前端 seam；涉及 `AppShell.tsx` 的顶栏挂载留到 Task 5 之后统一合并 |
| 5 | Task 4 已合入 | 否 | 集中修改路由、侧栏、`AppShell` 和来源返回状态，作为页面任务共同稳定外壳 |
| 6 | Task 1、5 已合入 | 可与 7/8/9 并行 | 只消费冻结后的图谱 facade；局部 feature/CSS/worktree，不能修改公共路由或翻译根键 |
| 7 | Task 2、4、5 已合入 | 可与 6/8/9 并行 | 只消费冻结后的冲突 workspace 与执行桥；共享 AI 展示逻辑以提取模块方式交付 |
| 8 | Task 3、4、5 已合入 | 可与 6/7/9 并行 | 只消费冻结后的治理 facade；Agent/项目/Skill 页只提交深链改动，不重做对象页 |
| 9 | Task 1、5 已合入 | 可与 6/7/8 并行 | 只改 bootstrap 汇总、概览 feature 与局部样式；关系入口指向已冻结的三条路由 |
| 10 | Task 1—9 已合入 | 否 | 统一异步入口清单、双语键合并、端到端回归和文档必须面对完整集成态 |
| 11 | 无（但规则冻结须早于 Task 5—9 的文案落地） | 可与任意线并行 | 纯前端文案层，不改契约、不触碰绑定；修改 `common.json` 与共享测试夹具，不得与并行页面任务同时改同一批键 |

子代理不在同一时间修改相同公共文件。页面并行期对 `common.json` 使用各自命名空间；由 Task 10 统一排序、去重和完整性审计。发现契约需要变化时，停止受影响页面分支，先在后端主线裁定并更新 facade/brief，再继续页面实现。

## 任务 1：先锁定领域契约、投影口径与失效语义

**目标**：在不复制现有关系事实的前提下，让图谱、冲突工作台、治理清单和概览都从可追溯的关系投影读取；明确“何时更新、何时失效”。

**先写失败测试**

1. 在 `crates/skillhub-core/tests/relationship_projection.rs` 覆盖：中心 Skill 只携带一跳关联 Skill 与其上下文叶子；Agent、项目、来源、目录均不能反向带出其他 Skill；未确认冲突才作为冲突节点；关系/状态筛选只隐藏展示内容、不改事实。
2. 在 `crates/skillhub-application/tests/facade_relationship_governance.rs` 覆盖：无 `skillId` 的候选查询只返回“有可展示关系”的 Skill；主名称与别名搜索命中、标签候选过滤、稳定关系数量、关系版本/最后验证时间；无可展示关系返回空候选而非伪造节点。
3. 在 `crates/skillhub-storage/tests/relationship_repository.rs`（或现有对应 repository 测试文件）覆盖：关系 repository 的 source/deployment/capability 写入或释放、`deployment_repository.rs` 的托管部署同步、provenance 写入、冲突 case 写入/明确决定都会推进关系版本；单纯 AI 分析记录写入不改变结构版本。删除/恢复命令只要通过上述 repository 改变关系事实，即由同一 repository 事务覆盖，不另建命令级旁路。

**最小实现**

- 扩展 `crates/skillhub-core/src/api/query.rs` 与 `crates/skillhub-core/src/relationship/`：新增面向 UI 的 `GetSkillRelationshipGraph`、候选/搜索结果、有限节点/边 DTO、`relationship_revision`、`last_verified_at` 与折叠计数。DTO 必须保留已有事实 ID、来源和状态，不把渲染文案或推测性“可执行”结论放进 core。
- 扩展 `crates/skillhub-application/src/relationship_governance_service.rs`：由现有 `RelationshipImpactSnapshot` 组装单中心投影。查询只读数据库事实，绝不触发磁盘扫描；节点多时按已确定的关系簇/类别返回折叠节点。
- 在 storage 事务内维护单一 `relationship_projection_state` revision：只接入 `relationship_repository.rs` 的 source/deployment/capability 事实写入/释放、`deployment_repository.rs` 的托管部署同步、`provenance_repository.rs` 的来源写入和冲突 case repository 的写入/明确决定。由 repository 统一推进，导入、扫描、部署、解除部署、关系迁移、删除/恢复等上层命令只要经过这些事实写入便自然失效，避免在每个 application command 重复插桩。AI `AnalyzeConflict` 只写 `conflict_analysis_records` 与审计，不推进图谱结构版本。
- 新增最小 SQL migration `crates/skillhub-storage/migrations/0016_relationship_projection_state.sql`（如合并时已有同编号迁移，则使用下一个空闲编号并同步本计划）；升级测试必须覆盖 `0015` 到新版本，且不改历史 migration。
- 在 `crates/skillhub-application/src/lib.rs` 的 query 分派和 `crates/skillhub-desktop/` 的 invoke 边界接入新查询，再生成绑定。

**验收与命令**

```powershell
cargo test -p skillhub-core --test relationship_projection
cargo test -p skillhub-storage --test relationship_repository
cargo test -p skillhub-application --test facade_relationship_governance
SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings
git diff --exit-code -- apps/desktop/src/api/bindings.ts
```

## 任务 2：补全冲突“具体决定”契约，而非采纳空状态

**目标**：让 `uncertain` 冲突有可审计的人工决定；AI 建议只能映射到明确业务动作。只写结论的动作立即完成，涉及文件的动作必须转入治理预览。

**先写失败测试**

1. 在 `crates/skillhub-core/tests/conflict_resolution.rs` 覆盖：只允许待确认的 `uncertain` 进入工作台；“保留独立”“确认同一 Skill”各自的状态、时间、历史记录；“暂不处理”只离开当前焦点、不写决定或伪历史，之后仍可回到工作台；已确定/已处理组不回流当前队列。
2. 覆盖 AI 推荐映射：`distinct_skill` 与 `same_skill_version` 产生对应明确决定；“纳入集中库管理”只返回携带 `conflict_id`/`relation_id` 的治理预览意图，不能直接变更文件；输入指纹变化后旧分析标为过期。
3. 在 `crates/skillhub-application/tests/facade_ai.rs` 与 `facade_relationship_governance.rs` 覆盖：未配置 LLM 仍可人工决定；AI 分析不改决定；决定/失败/取消均写操作记录；同一冲突并发决定被对象级锁拒绝或幂等处理。

**最小实现**

- 扩展 `crates/skillhub-core/src/api/command.rs`、`crates/skillhub-core/src/relationship/`：新增显式 `ResolveConflictCase` command、决定类型、结果 DTO、可选治理交接 DTO；移除 UI 对 `conflict_analysis_records.adopted` 的独立“采纳”依赖。保留该字段只作“具体动作完成后”的审计关联。
- 在 `crates/skillhub-application/src/lib.rs` 和关系治理服务实现：验证冲突仍是 `uncertain`、验证输入版本；仅事实决定更新 `ConflictCase.user_decision/decided_at` 与处理历史；文件类建议创建/返回关系迁移 prepare 所需的上下文，不提交迁移。
- 新增 `GetConflictWorkspace` query：返回当前事实、最近分析、分析是否因输入指纹失效、累计已处理数与已处理历史。不要把确定性结论混进默认 `uncertain` 工作区。
- 加入 operation journal 的 `conflict_resolution` 语义记录；沿用现有 `OperationPhase`，无需为了 UI 重造第二本日志。

**验收与命令**

```powershell
cargo test -p skillhub-core --test conflict_resolution
cargo test -p skillhub-application --test facade_ai
cargo test -p skillhub-application --test facade_relationship_governance
SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings
```

## 任务 3：把关系治理收敛为“关系边清单 + 安全批处理”

**目标**：复用已完成的单条关系迁移安全链路，新增列表、预检和批处理编排；不把 Skill 列表或通用待办复制到治理页。

**先写失败测试**

1. 在 `crates/skillhub-core/tests/relationship_governance_batch.rs` 覆盖按关系边返回 all / eligible-to-centralize / needs-validation / blocked，行上必须包含对象、关系类型、影响、可执行与受阻原因。
2. 覆盖批量解除部署、批量纳入集中库管理：每行独立 prepare、备份、校验与确认；可执行/受阻分组；用户取消某一行不影响其余行；部分失败保留成功项并返回逐项重试/回退信息。
3. 在 `crates/skillhub-application/tests/facade_relationship_governance.rs` 覆盖：批量命令不会绕过 `PrepareRelationMigration` 的指纹、共享影响和对象锁；一次操作日志能关联每个子项。

**最小实现**

- 以 `crates/skillhub-application/src/relationship_governance_service.rs` 既有 `get_relationship_overview`、`get_relationship_removal_impact`、`prepare_relation_migration`、`commit_relation_migration`、`rollback_relation_migration` 为唯一事实和安全执行来源。
- 在 `crates/skillhub-core/src/api/query.rs` 添加治理清单 query/分页/筛选 DTO；在 `api/command.rs` 添加批次 prepare/commit/rollback 编排命令或严格的客户端子操作协议。若后端批次能保留一个父 operation 与子 operation 映射，则优先后端编排；不得在 UI 静默并发文件操作。
- 单条“部署”只跳转既有部署流程；单条“解除部署”走既有移除影响预览；“纳入集中库管理”走既有 required-backup `ManagedLink` prepare/commit。页面只呈现用户术语，技术详情再显示链接实现。
- 为治理来源/目标增加稳定深链参数：例如 `?from=library&skillId=…`、`?from=conflict&conflictId=…`。提交成功后返回来源页保存的视图状态，而不是一律回到技能库。

**验收与命令**

```powershell
cargo test -p skillhub-core --test relationship_governance_batch
cargo test -p skillhub-application --test facade_relationship_governance
cargo test -p skillhub-core --test undeploy_delete
SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings
```

## 任务 4：建立统一的异步执行桥、通知和持久化审计关联

**目标**：使所有会等待、会改数据或文件的操作都具有同一生命周期、顶栏状态、通知与操作记录；浏览、筛选、图谱选点仍同步且不留日志。

**固定分类（Task 10 按此清单逐项迁移）**

| 分类 | 当前项目中的范围 | 顶栏/通知/审计要求 |
|---|---|---|
| 同步浏览 | 路由切换、搜索、筛选、排序、分页、图谱选点/缩放/拖拽、展开详情 | 不显示顶栏状态，不发通知，不写操作记录 |
| 即时写入 | 直接返回结果的元数据、标签、偏好、轻量关系决定等 command | 不占用在途顶栏；成功/失败给结果反馈，并写可追溯操作记录 |
| 分阶段或可等待执行 | 初始化/重新扫描、导入、部署/批量部署、解除部署、关系迁移/批量治理、删除/恢复、备份/还原/导出、源更新、修复、安全检查、AI 分析、网络更新/下载 | `queued → running → success/partial/failed/cancelled/needs_user`；顶栏、通知中心、操作记录三者都必须关联同一 operation id |

“即时”由 command 的单次同步响应特性决定，不按毫秒阈值猜测；只要 command 已返回、没有后台阶段，就不能为了视觉效果强行闪烁顶栏。Task 10 对 `AppCommand` 清单逐项归类，新增 command 同样必须在提交前归类。

**先写失败测试**

1. 扩展 `apps/desktop/src/platform/operationTracker.test.tsx`：`queued`、`running`、`needs_user`、`success`、`partial`、`failed`、`cancelled` 的转换；多任务顺序、当前项、目标深链、百分比未知、完成项从在途分页移除。
2. 在 `apps/desktop/src/app/TaskStatusIndicator.test.tsx` 覆盖固定 360px 摘要、单项/多项 `1/3`、溢出滚动、点击浮层一页一项、前后翻页、点击外部/Escape 关闭、焦点返回；无在途时完全不渲染。
3. 在 `apps/desktop/src/ui/notifications.test.tsx`（新增）覆盖成功/部分失败/失败/需人工确认的通知深链到操作记录；清除通知不删除后端操作记录。
4. 在已有导入、部署、删除、恢复、AI 检查/分析测试中增加“每种异步命令均开始/更新/结束统一 tracker，异常不吞掉”的断言。

**最小实现**

- 扩展 `apps/desktop/src/platform/operationTracker.ts` 为前端的规范化投影，但不把它当持久化来源：加入状态、父子任务、`operationId`、`targetHref`、阶段/摘要与取消能力。
- 新建 `apps/desktop/src/platform/runTrackedOperation.ts`（名称可在实现时微调）：统一包装 native command、进度回调、query invalidation、`useAppNotifications()` 通知和 `/operations/:id` 深链。迁移所有已有异步入口，不允许新功能直接裸调 `facade.execute()`。
- 后端沿用 `OperationPhase` 和现有 operation repository；对目前没有 journal 的新命令，在 application 层补持久化 record。把“相同对象/关系加锁”放在后端；不锁全应用。
- 改造 `apps/desktop/src/app/TaskStatusIndicator.tsx` 为顶栏居中无按钮感摘要 + 小浮层，不再使用全屏 `Drawer`；移动其挂载位置至 `AppShell` 的 `topbar-context` 并保持标题/窗口控制不受遮挡。
- 删除或停用 `apps/desktop/src/app/OperationIndicator.tsx` 的底部重复提示及其样式/测试，避免两个执行状态竞争。`NotificationBell` 与操作记录页保留。
- 在 `apps/desktop/src/i18n/zh-CN/common.json` 和 `en-US/common.json` 添加同构键，运行 CJK 审计。

**验收与命令**

```powershell
pnpm --filter @skillhub/desktop test -- operationTracker TaskStatusIndicator notifications
pnpm check:frontend
node scripts/i18n-cjk-audit.mjs
```

## 任务 5：搭建技能关系模块路由、导航和可恢复返回状态

**目标**：建立三个一级页面的共同壳层与来源感知返回，先不实现具体业务画布。

**先写失败测试**

1. 在 `apps/desktop/src/app/router.test.tsx` 覆盖三条路由、懒加载预取、`/relationships` 标题及嵌套路由回退。
2. 在 `apps/desktop/src/app/Sidebar.test.tsx` 覆盖“技能关系”位于技能库与发现之间、选中态与预取。
3. 在 `apps/desktop/src/app/AppShell.test.tsx` 覆盖关系页回退规则：图谱保持中心/筛选/视口，治理保持筛选/选中行/滚动，技能库保持原有列表状态；跨模块回退不串状态。

**最小实现**

- 新建 `apps/desktop/src/features/relationships/` feature 根目录以及 `RelationshipsLayout.tsx`、共享 query keys、native facade、`relationships.css`。
- 修改 `apps/desktop/src/app/router.tsx`：懒加载 `/relationships`、`/relationships/decisions`、`/relationships/governance`；修改 `routePreloaders`。
- 修改 `apps/desktop/src/app/Sidebar.tsx`、`AppShell.tsx` 与图标类型/资源：添加 `relationships` 导航项与 `RouteTitleKey`。若现有 `IconName` 无适用图标，加入语义明确、可访问的图标，不通过颜色替代标签。
- 设计 URL 是可复现状态来源：图谱至少保存 `skillId`、标签/关系/状态筛选；治理保存已提交的筛选；冲突页保存类别和冲突 ID。仅滚动、画布坐标等使用 `history.state`/session 状态按来源隔离。

**验收与命令**

```powershell
pnpm --filter @skillhub/desktop test -- router Sidebar AppShell
pnpm check:frontend
```

## 任务 6：实现单中心、有限深度的技能图谱

**目标**：默认图谱可理解、有中心、无空画布，不制造无限层级或关系幻觉。

**先写失败测试**

1. 新建 `apps/desktop/src/features/relationships/graph/graphProjection.test.ts`：中心/一跳/上下文叶子边界、边文本+线型+颜色状态、上下文不得生成到其他 Skill 的边、折叠计数、过滤不改查询事实。
2. 新建 `SkillGraphPage.test.tsx`：首次无 `skillId` 只在候选中随机一次并 replace URL；刷新/回退/深链不重新随机；“换一个 Skill”只选非空候选；零候选展示发现 CTA；别名搜索多结果必须选择；标签只限制中心候选。
3. 新建 `SkillGraphCanvas.test.tsx`：鼠标点关联 Skill 重新聚焦；来源/Agent/项目/目录/冲突节点只开右侧详情/跳转；关系/状态控制与显示设置浮层可键盘访问；没有键盘画布拖拽/缩放承诺。

**最小实现**

- 增加 `apps/desktop/src/features/relationships/graph/SkillGraphPage.tsx`、`SkillGraphCanvas.tsx`、`GraphSearch.tsx`、`GraphDetailsPanel.tsx`、`graphProjection.ts` 与局部 CSS。优先用现有 React/SVG + 稳定分层布局，不新引入图数据库、图渲染框架或持久化图像。
- native facade 调用任务 1 的候选与图谱查询；TanStack Query key 必须包含 `skillId`、筛选和 `relationship_revision`。打开页面绝不触发扫描。
- 在顶部放原名/别名搜索、标签、关系/状态筛选；“显示设置”为按需浮层。当前中心 Skill 始终在页面标题、URL 和右侧详情可见。
- 当图谱进入折叠状态时显示原因/数量与“前往关系治理或发现”的明确入口，不能静默删节点。节点/边详情展示最后验证和不可访问/待校验状态。
- 所有图谱跳转带 `from=relationships` 与返回状态；“查看 Skill”到详情、浏览器后退时回到相同中心/筛选/视口。

**验收与命令**

```powershell
pnpm --filter @skillhub/desktop test -- graphProjection SkillGraphPage SkillGraphCanvas
pnpm check:frontend
pnpm build:frontend
```

## 任务 7：实现“冲突处理”双侧对比工作台

**目标**：把冲突从导入时的可选后续处理变成专用对比空间，不变成列表式待办。

**先写失败测试**

1. 新建 `ConflictDecisionPage.test.tsx`：默认只显示 `uncertain`；类别 chip 和前后导航；确定性/已处理项不混入；无 LLM 不阻止人工决定；单项、当前类别、全部三个 AI 范围正确请求。
2. 覆盖 AI 结论显示证据、不确定点和可执行方案；“按建议”立即执行具体人工决定，绝不只写 adopted；涉及文件的建议跳到携带冲突/关系上下文的治理预览。
3. 覆盖空态：累计大于零显示“干得漂亮”和累计处理数；累计为零用中性文案；没有“刷新冲突”按钮；关系刷新/重新扫描后的新冲突重新出现，旧分析显示过期。

**最小实现**

- 新建 `apps/desktop/src/features/relationships/decisions/ConflictDecisionPage.tsx`、`ConflictComparison.tsx`、`ConflictActions.tsx` 与对应 facade/hooks。读取任务 2 的工作台 DTO。
- 从 `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.tsx` 和 `apps/desktop/src/features/skill-detail/SemanticDuplicatePanel.tsx` 提取可复用的只读 AI 结论展示与 i18n 键；删除这两个旧位置中会造成重复“AI 冲突入口”的 UI，只保留与其页面边界相符的确定性关系摘要和深链。
- 仅在用户点击明确处理动作时运行任务 4 的统一异步包装；成功后刷新关系/冲突 query，通知与日志可跳到操作记录。暂不处理不写伪决定。
- 文件相关动作不跨页自动提交：跳转 `/relationships/governance?from=conflict&conflictId=…&relationId=…`，由治理页展示影响预览和最终确认。

**验收与命令**

```powershell
pnpm --filter @skillhub/desktop test -- ConflictDecisionPage SemanticDuplicatePanel RelationshipGovernancePanel
pnpm test:e2e -- --grep "conflict|relationship"
node scripts/i18n-cjk-audit.mjs
```

## 任务 8：实现关系治理清单、预览和批量执行

**目标**：面向每一条关系边安排变更，支撑单条和批量安全操作，并从 Skill 库、Agent、项目和冲突处理顺畅进入。

**先写失败测试**

1. 新建 `RelationshipGovernancePage.test.tsx`：行按关系而非 Skill 渲染；四个筛选计数；搜索、受阻说明、关系/来源/目标/影响；部署入口与治理执行区分。
2. 覆盖单条纳入集中库管理、解除部署的 preview → confirmation → run → verify → result；后端拒绝时保留预览，不更新 UI 为成功。
3. 覆盖批量选择：默认不选受阻项；可执行/受阻摘要；可取消单项；部分失败显示逐项成功/失败、重试和回退；相同关系按钮互斥而其他关系仍可操作。
4. 覆盖来源返回：从技能库、图谱、冲突处理、Agent/项目详情进入后，浏览器后退回到各自原始状态；治理页内部详情返回不丢筛选/滚动/选择。

**最小实现**

- 新建 `apps/desktop/src/features/relationships/governance/RelationshipGovernancePage.tsx`、`GovernanceRelationTable.tsx`、`GovernanceImpactPreview.tsx`、`GovernanceBatchDialog.tsx` 和 facade。
- 复用 `RelationshipRemovalImpactView.tsx`，并以任务 3 的 query/commands 驱动。对“纳入集中库管理”解释为“保留当前位置的可用入口，改为使用集中库中的统一版本”；在确认界面展示备份、共享影响、校验和回退信息。
- 将已有 Agent/项目页的关系行、Skill 详情关系区和部署页的“管理关系”动作改为深链本页；不拆走它们的对象信息或普通部署快捷入口。
- 批处理逐项展示子 operation，并由任务 4 的父子 tracker 同步顶栏、通知和操作日志；任何 partial/needs recovery 都不能被汇总成成功。

**验收与命令**

```powershell
pnpm --filter @skillhub/desktop test -- RelationshipGovernancePage RelationshipRemovalImpactView
cargo test -p skillhub-application --test facade_relationship_governance
pnpm test:e2e -- --grep "relationship governance|managed library"
```

## 任务 9：融合概览的关系入口与冻结的指标口径

**目标**：保留现有概览的整页密度、部署柱状图、标签饼图和弱化的通用待办，将关系内容融合进去而不是替换掉。

**先写失败测试**

1. 新建 `apps/desktop/src/features/overview/api.test.ts`：断言五个准确显示名称与口径：`技能总数`、`Agent（已配置 N 个 · 已发现 N 个）`、`管理项目`、`Skill 部署关系（部署到 Agent N 条 · 项目 N 条）`、`待确认的关系冲突`。
2. 扩展 `OverviewPage.test.tsx`：保留 Agent/项目切换的 Skill 使用分布柱状图、标签饼图和通用待办；关系缩略网络与计数深链到三个关系子页；窗口 100% 比例下页面外层无滚动，局部列表可滚动。
3. 覆盖空关系状态不吞没已有概览内容，冲突数只统计未确认关系冲突。

**最小实现**

- 扩展 `apps/desktop/src/features/overview/api.ts` 以任务 1/2 的聚合数据构造指标与关系缩略入口；必要时在 bootstrap snapshot 添加只读汇总字段，避免 Overview 自行全量拼关系。
- 重构 `OverviewPage.tsx`、`overview.css`：保持 `PageFrame fill` 与现有两层图表；新关系缩略网络作为组织/关系区域的一部分，点击进入图谱、冲突处理或治理。通用待办只作小型弱化摘要，不与冲突计数重复。
- 更新中英文文案与图表 aria 标签。任何 “Agent 已发现” 仍指发现快照而不是可管理部署目标。

**验收与命令**

```powershell
pnpm --filter @skillhub/desktop test -- overview
pnpm check:frontend
pnpm test:e2e -- --grep "overview"
```

## 任务 10：系统性接入既有异步入口、可访问性与回归

**目标**：把统一执行约束真正施加到本项目所有新增和既有异步入口，并完成双端自动化与人工验收准备。

**先写失败测试与审计**

1. 列出 `apps/desktop/src/features/**/nativeApi.ts` 和所有 `execute`/长轮询入口；为导入、扫描、部署、批量部署、解除部署、关系迁移、删除/恢复、备份/还原、安全检查、AI 分析、关系确认分别增加或更新统一 tracker、通知、日志测试。
2. 新建/扩展 Playwright 场景：顶栏多任务分页、通知→操作记录、关系图谱深链与回退、冲突处理空态、治理批量部分失败、概览不溢出。
3. 更新 `docs/development/人工验收清单-2026-09-16.md` 的 J 节：Windows/macOS 下顶栏 360px、滚动摘要、点击外部关闭、缩放/读屏、真实链接权限、批次部分失败与恢复操作记录。

**最小实现与清理**

- 对未纳入任务 4 统一包装的入口逐项迁移，执行一项就补一项测试；异步状态只从一个顶栏入口呈现。同步浏览操作不得错误写入操作日志。
- 全量更新 `apps/desktop/src/i18n/zh-CN/common.json`、`en-US/common.json`，保持键集合对称；删除无调用的旧采用状态文案、重复的底部操作指示器文案及样式。
- Rust API 变更后重新生成绑定；运行格式、静态检查、构建、全量测试和 E2E。代码/行为变更完成后同步更新四份 `docs/development/` 当前文档、原子测试目录和完成度矩阵；设计/计划仍明确区分“已实施”与“待人工”。

**最终验证电池**

```powershell
pnpm test:frontend
pnpm check:frontend
pnpm build:frontend
pnpm test:e2e
cargo fmt --check --all
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
node scripts/i18n-cjk-audit.mjs
node scripts/verify_frontend_lifecycle_scripts.mjs
node scripts/ci-local.mjs
SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings
git diff --exit-code -- apps/desktop/src/api/bindings.ts
git diff --check
```

## 任务 11：把用户可见动作词从「部署」收敛到「添加到 Agent/项目」

**目标**：把用户能点到的动作词统一为“添加到 Agent/项目”“从 Agent/项目移除”，让「部署」只作为名词和技术详情术语存在。这是**文案层收敛**，不是交互或契约变更。

**依据（现状是实现偏离设计，不是新决策）**

- `docs/需求文档.md` 概念定义表：“部署｜将指定 Skill 版本放入指定 Agent 或项目的目标目录并建立管理关系。**面向普通用户称为“添加到 Agent/项目”**；不代表 Agent 已加载或能够调用。”
- `docs/产品与交互设计.md` §2.2 中文术语：“主要操作使用“添加到 Agent/项目”“从 Agent/项目移除”；**技术详情中可以显示“部署/解除部署”**。”
- 现状：主操作位置实际使用「部署…」（批量操作区）、「发起部署」、「取消部署」、「提交部署」、「预览部署」。

**固定规则（不得两可）**

1. **动词层面禁用「部署」**：按钮、步骤名、状态转换、空态引导一律用“添加到 Agent/项目”“从 Agent/项目移除”；批量用“添加到…”“添加 N 个 Skill”。
2. **名词层面保留「链接部署/复制部署/部署关系」**：这是 2026-09-15 补充说明冻结的用户层关系类型表达，描述关系的“方式”而非动作，二者不冲突。
3. **技术详情保留原术语**：“部署/解除部署”“符号链接”“目录联接”“受管复制”只在技术详情与诊断信息中出现。
4. **不得换成“装配”**：该词在本项目已指“项目尽力装配”（英文 `assembly`，`docs/需求文档.md` §5.5、`docs/产品与交互设计.md` §9.6），且中文语义偏制造业、撤销说法“拆卸”会误导成内容被删除。
5. **不得换成“安装/卸载”**：与应用自身的安装/更新撞车，且“卸载”暗示删除内容，而解除部署明确保留文件。

**范围与实测规模**

- 必须同时改中英双语文案（键集一致由 `apps/desktop/src/i18n/i18n.test.ts` 断言）。
- 当前规模：zh-CN 文案 156 处、en-US 188 处、前端源码（不含 i18n）379 处、测试中文字面量断言 163 处；集中在 `DeploymentDialog.test.tsx`(30)、`OnboardingWizard.test.tsx`(28)、`BatchDeploymentPage.test.tsx`(26)、`UndeployDialog.test.tsx`(9)、`RemovalImpactDialog.test.tsx`(9)、`ProjectManagedDeployments.test.tsx`(7)、`PendingPage.test.tsx`(6)。
- **不改**：Rust 命令/查询/类型名（`Deploy*`/`Undeploy*`）、i18n 键名本身、数据库与操作日志中的 kind 值、生成的绑定文件。因此本任务不产生契约变更，不需要重新生成绑定。

**先写失败测试**

1. 新增文案术语守护测试（`apps/desktop/src/i18n/terminology.test.ts` 或扩展现有 i18n 测试）：断言用户可见动作键中不出现“部署”作动词，并保留 zh-CN/en-US 键集一致性断言。
2. 在 `DeploymentDialog`、`BatchDeploymentPage`、`UndeployDialog`、`RemovalImpactDialog`、`ProjectManagedDeployments` 的现有用例中先把断言改为新文案，确认变红，再改文案转绿。
3. 补正向用例，锁定技术详情**仍然**显示“部署/解除部署”“符号链接/目录联接”，防止一刀切删词。

**分片（每片一个提交）**

1. 入口动作：批量操作区、Skill 详情操作、组合入口——用户最先看到的位置。
2. 流程文案：部署流程的标题、步骤名、预览/提交按钮与状态。
3. 状态与筛选：已部署/未部署、部署状态、Agent 部署计数、受管部署。
4. 关系与矩阵：技能详情关系区、部署关系矩阵、来源与目标标签——本片只改动词，名词若确需调整单独裁决。

**验收与命令**

```bash
pnpm test:frontend
pnpm check:frontend
node scripts/i18n-cjk-audit.mjs
node scripts/verify_frontend_lifecycle_scripts.mjs
pnpm build:frontend
```

**前置与顺序（重要）**

- 第 1 步是**先冻结规则**（写入 §2.2 与本任务），它必须早于 Task 5—9 的页面文案落地，否则新页面会按旧词写作并返工；实施本身可分片进行。
- 与 Task 10 的异步入口接入有交集：Task 10 新增的顶栏与通知文案必须直接采用新词，不得沿用旧文案。
- 前置依赖：无（纯前端文案层，可与后端主线并行）；但它修改 `common.json` 与共享测试夹具，**不得与并行页面任务同时改同一批键**，合并顺序按「实施并行与合并顺序」的公共文件规则处理。

## 交付核对表

标注口径：`[x]` 表示该项已完整达成；`[ ]` 后写明「已完成」与「仍需」两部分，不写含糊的“部分完成”。

- [x] 关系事实投影有有限深度、版本/最后验证时间、无扫描读取、升级测试（Task 1，`0c0b5260`…`64313923`）。
- [ ] 冲突处理只显示待确认 `uncertain`，AI 建议一定落到明确动作或治理预览。**已完成**：`ResolveConflictCase` 契约、工作台 query 与 AI 建议到明确动作的映射（Task 2）。**仍需**：双侧对比工作台页面与「先影响预览、再异步执行并回写」的 UI 闭环（Task 7）。
- [ ] 关系治理按关系边工作，单/批量操作全程预览、确认、验证、回退可追溯。**已完成**：只读清单 query、批 prepare/commit/rollback 编排、逐行共享影响确认、部分失败保留成功项、取消隔离与逐项重试信息，且逐行仍走单条四段安全链路（Task 3）。**仍需**：治理页面、解除部署入口收敛与顶栏父子任务反馈（Task 8、Task 4）。
- [ ] 图谱没有空画布，单中心深链稳定，搜索包含别名，筛选不生成多根图。**已完成**：投影与查询侧的有限深度、单中心、折叠规则与候选筛选（Task 1）。**仍需**：图谱页面、路由与交互（Task 5/6/9）。
- [ ] 顶栏在途状态居中 360px、可分页查看，通知可清除但日志不可丢失。**仍需**：统一异步执行桥、顶栏摘要与通知中心全部未开始（Task 4/10）。
- [ ] 概览保留既有图表和通用待办，新增关系内容不重复统计也不产生页面滚动条。**仍需**：概览关系缩略入口与冻结指标口径未开始（Task 9）。
- [ ] 全部 Rust/TypeScript 契约绑定由生成器生成；全量自动化通过；Windows/macOS 人工验收记录已回填。**已完成**：绑定生成器不动点已复核（Task 3 后 SHA 前后一致），工作区自动化 142 套件 / 1094 通过 / 0 失败，前端 150 文件 / 1542 通过。**仍需**：Windows/macOS 真机人工验收记录回填，当前发布阻塞项为《人工验收清单-2026-09-16》A—I 节与 RC-13/RC-14。
- [ ] 用户可见动作词统一为“添加到 Agent/项目”“从 Agent/项目移除”，「部署」只作为名词短语（链接部署/复制部署/部署关系）与技术详情术语出现。**仍需**：Task 11 未开始。
