# Skill 管理关系闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不重写现有导入、部署和 Agent 适配能力的前提下，补齐 SkillHub 当前版本的关系识别、冲突治理、部署迁移、移除部署、回退和前端操作闭环。

> 本计划是 Task 5—10 的历史实施计划。2026-09-16 确认的后续产品设计已单独记录在 [技能关系模块与统一执行体验设计](../specs/2026-09-16-skill-relationship-module-and-execution-experience-design.md)；本文件的已完成任务、测试和安全证据保留不改写。以下关于 v0.3.0 图谱、不支持图谱画布和旧待办/通知边界的表述，均不再作为后续产品入口。

**Architecture:** 以统一的目录节点、Agent 目录识别能力、来源关系和部署关系作为事实层；扩展现有 `ImportProvenance`、`ObservedDeployment` 和 `DeploymentRecord`，通过应用层关系治理服务统一输出关系视图。导入、Agent 详情、Skill 详情和部署操作复用同一个关系治理 DTO 与 prepare/commit/rollback 事务，不新增第二套页面状态模型。

**Tech Stack:** Rust workspace、SQLite migrations、Serde/Specta IPC bindings、React/TypeScript、Vitest、Rust integration tests、现有 operation journal 和 operation tracker。

**Spec:** `docs/superpowers/specs/2026-09-15-skill-management-closure-design.md`

## Global Constraints

- 本计划完成导入、关系识别、冲突治理、部署、移除部署、复制副本/通用目录关系迁移、回退和既有待处理事项；技能图谱、冲突处理工作台、关系治理关系清单及统一通知体验属于后续实施范围，目标版本为 v0.2.0。
- `.agents/skills` 是独立通用共享目录节点；每个 Agent 单独记录 `supported / unknown / unsupported`，不能从目录存在推断 Agent 一定会读取或执行。
- 集中库是主副本；从 `.agents/skills` 导入默认复制，不能因导入自动替换或删除共享原件。
- 用户层只显示“链接部署”和“复制部署”；符号链接与 Windows Directory Junction 只在技术详情中显示。
- 复制副本或通用目录引用纳入集中库管理时，必须移除原入口，不得留下两个同名入口，并保留备份/回退证据。
- AI 只提供短的决策建议、关键证据和不确定点，不自动合并、删除、替换或选择权威版本。
- 未知关系、共享影响、权限失败和未决冲突必须进入待处理事项，不能静默跳过或报告为成功。
- 保持现有原文件保护、确定性检查优先、网络默认关闭、生成绑定只能由生成器更新和跨平台路径策略。
- 每个实现 Task 必须在开始前读取本 Task 列出的 Skill；没有对应 Skill 的纯后端任务使用仓库既有模式，不引入额外框架。
- 每个行为 Task 必须先把对应用户故事验收标准转成失败测试；前端 Task 必须同时遵守对应交互章节，不得只完成 IPC 而省略用户确认、影响说明、回退和待办入口。

---

## 1. 影响矩阵与范围冻结

| 现有能力/文件 | 本次处理 | 改动边界 | 验证入口 |
|---|---|---|---|
| `crates/skillhub-core/src/import/provenance.rs` | 增量扩展 | 从 `skill_id` 单一存证扩展为一 Skill 多来源；保留旧数据读取兼容 | `crates/skillhub-storage/tests/provenance_repository.rs`、导入集成测试 |
| `crates/skillhub-core/src/deployment/observed.rs` | 增量扩展 | 增加文件表示、链接目标、共享引用和关系类型；保留 ContentVerified/NameOnly/Diverged 的诚实降级 | `crates/skillhub-core/src/deployment/observed.rs` 单测、`facade_observed_deployments.rs` |
| `crates/skillhub-core/src/deployment/model.rs`、`removal.rs` | 复用并补充 | 保留 SymbolicLink/DirectoryJunction/ManagedCopy 选择器；新增关系转换预览和影响计算，不改现有默认链接策略 | `crates/skillhub-core/tests/deploy_flow.rs`、`undeploy_delete.rs` |
| `crates/skillhub-core/src/import/conflict.rs` | 增量扩展 | 在现有确定性冲突上增加冲突组和 same-version/distinct-skill/uncertain 分类 | `crates/skillhub-core/tests/import_conflicts.rs` |
| `crates/skillhub-application/src/lib.rs`、`import_service.rs`、`deployment_service.rs` | 新增关系治理服务并接线 | 复用现有 facade、操作日志、prepare/commit 事务；不重写服务入口 | `crates/skillhub-application/tests/` 定向 facade 测试 |
| `crates/skillhub-storage/migrations/0013_observed_deployments.sql` | 保留 | 0013 作为历史基线，不修改已发布迁移 | 迁移升级/旧库 fixture |
| `crates/skillhub-storage/migrations/0014_skill_relationships.sql` | 新增 | 只增加关系节点、能力、来源多行、冲突组、AI 分析和治理待办表 | `crates/skillhub-storage/tests/migrations.rs` |
| `apps/desktop/src/features/import/*` | 增量扩展 | 保留现有来源、候选、分析进度和导入结果状态；新增关系分类和批量决策阶段 | 现有 import 测试 + 新治理组件测试 |
| `apps/desktop/src/features/agents/*` | 增量扩展 | 保留 Agent 列表和 RelationsView；增加目录识别、关系类型、影响范围和迁移入口 | Agent 页面和 native API 测试 |
| `apps/desktop/src/features/skill-detail/*` | 增量扩展 | 扩展现有 ProvenancePanel/RelationsPanel，不重做详情页 | Skill detail、ProvenancePanel 测试 |
| `apps/desktop/src/platform/operationTracker.ts` | 复用并扩展 | 导入、冲突分析、关系迁移继续进入统一执行状态；后续改为顶栏居中摘要 + 小型逐项任务窗口，并关联通知中心 | operation tracker 测试 |
| `apps/desktop/src/api/bindings.ts` | 生成 | 不手工编辑；由 `cargo test -p skillhub-desktop generate_bindings` 更新 | bindings 漂移测试 |
| 技能图谱（v0.2.0） | 本计划不实施 | 后续读取关系查询结果，提供单 Skill 中心、有限深度节点/边和上下文叶子节点 | 新设计实施计划与契约测试 |

明确不做：重新设计 Agent 适配器、增加新的 Agent 品牌、自动清理通用目录本体、用 AI 替代路径/哈希/所有权判断、重写现有导入向导状态机。本计划不包含新技能关系模块与统一执行反馈的实现；其实施范围见新设计稿。

## 2. 固定实现决策

### 2.1 关系枚举

关系事实使用以下稳定枚举，前后端共享同一序列化名称：

```text
import_copy
shared_directory_read
shared_directory_reference
managed_copy
managed_link
observed_copy
observed_link
unknown
```

文件系统表示另存为：`directory`、`symbolic_link`、`directory_junction`、`copy`、`unknown`。`managed_link` 的用户标签为“链接部署”，`managed_copy` 的用户标签为“复制部署”。

### 2.2 安全转换顺序

复制副本或共享目录关系纳入集中库管理时固定执行：

```text
重新扫描 → 比较内容指纹 → 创建恢复点/备份
→ 创建新链接到集中库 → 验证新链接和目标内容
→ 移除原入口 → 写入关系和审计记录
```

创建新链接或验证失败时保留原入口；移除原入口后关系写入失败时使用恢复点回退。跨卷或权限不支持链接时，不自动降级为复制覆盖，改为给出“链接不可用，保留复制副本/进入待办”的明确选择。

### 2.3 冲突判定

确定性层只输出证据和候选分类：

- 指纹一致：完全相同/可建立来源关系；
- 名称相同且内容不同：建立冲突组；
- 来源、版本字段、描述、结构、入口文件和差异足以支持判断：标记可能同版本或可能不同 Skill；
- 证据不足：`uncertain`，进入待处理。

用户决定“不同 Skill”时建立不同集中库身份；决定“同一 Skill 不同版本”时进入同一 Skill 版本历史。AI 分析只改变建议记录，不直接改变用户决定。

## 3. 需求追溯与任务技能约束

当前计划的 Task 不是脱离产品文档的技术任务，而是以下追溯链的一部分：

| Task | 用户故事 | 需求章节 | 交互章节 | 设计/架构章节 | 执行 Skill |
|---|---|---|---|---|---|
| 1 | US-063、US-068 | 5.22、5.23、5.33、5.36 | 8.2、10.4、14 | 关系闭环设计 2～3、架构 6.5 | `tdd` |
| 2 | US-016、US-017、US-063、US-068 | 5.9、5.22、5.33 | 7.5～7.8、15.3 | 关系闭环设计 3.1～3.4 | `tdd` |
| 3 | US-012、US-018、US-033、US-034、US-063、US-067 | 5.6、5.15、5.23、5.36 | 7.2、10.2～10.4、14 | 关系闭环设计 2.3、4.4 | `tdd` |
| 4 | US-016、US-017、US-034、US-066～068 | 5.9、5.22、5.33、5.35～5.36 | 7.5～7.8、10.4、15.3 | 关系闭环设计 3.4、4.4、6 | `tdd` |
| 5 | US-016、US-017、US-018、US-064、US-065、US-068 | 5.9、5.15、5.33 | 7.5～7.8、14 | 关系闭环设计 4.1～4.2、5 | `frontend-design` + `vercel-react-best-practices` + `tdd` |
| 6 | US-031～034、US-066～067 | 5.22、5.23、5.36 | 10.1～10.5、15.3 | 关系闭环设计 2.3、4.3～4.4、6 | `tdd` |
| 7 | US-025、US-033、US-034、US-063、US-066～068 | 5.23、5.33、5.35～5.36 | 8.2、10.2～10.5、14 | 关系闭环设计 5、架构 6.5、9.2 | `frontend-design` + `vercel-react-best-practices` + `tdd` |
| 8 | US-018、US-065、US-068 | 5.15、5.33 | 7.7、13.3、14 | 关系闭环设计 3.4、6 | `tdd` |
| 9 | 全部 US-063～068 及既有导入/部署故事 | 5.9、5.15、5.22、5.23、5.33、5.36 | 7.5～7.8、8.2、10、14、15 | 关系闭环设计 7 | `tdd` + `superpowers:subagent-driven-development` |

执行规则：

- Task 1～4 的 Rust 测试必须覆盖对应用户故事的事实和状态，不允许只测结构体能序列化。
- Task 5、7 的 UI 设计先由 `frontend-design` 产出组件层级、信息优先级、确认/回退/待办状态，再由 React 实现；不使用 `finesse-ui` 重做整套视觉风格。
- 前端实现使用 `vercel-react-best-practices` 检查查询并发、状态更新、列表 key、懒加载和渲染边界；它不能替代产品交互验收。
- Task 8 的 AI 结果必须先通过确定性冲突分组测试，再测试可选 AI；AI 测试不能替代冲突分类测试。
- 任一任务遇到失败或既有回归时，暂停该任务并使用 `systematic-debugging`，先定位原因再修改，不把修复混入无关重构。

### 3.1 执行切片

上面的 9 个 Task 是审查边界；实际执行不能一次性把一个 Task 做完。每个切片都先写失败测试、实现最小行为、运行定向检查并单独提交：

| 切片 | 交付物 | 先行失败测试 | 必用 Skill |
|---|---|---|---|
| 1A | 关系枚举、目录角色、识别状态和兼容序列化 | `relationship` 领域单测 | `tdd` |
| 1B | 冲突分类、来源关系和治理待办事实类型 | `import_conflicts` 与关系单测 | `tdd` |
| 2A | 0014 schema、版本注册和旧库升级 | `migrations.rs` | `tdd` |
| 2B | 目录、关系、冲突、待办仓储读写 | storage repository tests | `tdd` |
| 3A | Agent 目录 capability 解析和 `.agents/skills` 角色判断 | profile/discovery tests | `tdd` |
| 3B | 观察关系分类和 RemovalImpact | `deployment_planner`、`undeploy_delete` | `tdd` |
| 4A | 统一关系查询 DTO 和 facade query | facade relationship query tests | `tdd` |
| 4B | 关系迁移 prepare/commit/rollback | conversion transaction tests | `tdd` |
| 5A | 导入后关系分组和批量决策输入 | `facade_relationship_governance` | `tdd` |
| 5B | 关系治理面板的信息层级、状态和确认交互 | `RelationshipGovernancePanel.test.tsx` | `frontend-design` + `tdd` |
| 5C | 导入向导接入分组确认、单项覆盖和待办跳转 | import component tests | `vercel-react-best-practices` + `tdd` |
| 6A | 复制副本/共享引用转换计划 | core conversion tests | `tdd` |
| 6B | 文件替换事务、备份、失败回退和审计 | application conversion tests | `tdd` |
| 7A | Agent 页面目录矩阵和关系标签 | Agent component tests | `frontend-design` + `tdd` |
| 7B | Skill 详情来源/关系/移除影响入口 | Skill detail tests | `vercel-react-best-practices` + `tdd` |
| 8A | 冲突分析范围、持久化结果和 facade | AI facade tests | `tdd` |
| 8B | 全部/分类/冲突组/单 Skill AI 操作入口 | governance/duplicate panel tests | `frontend-design` + `tdd` |
| 9A | 全链路自动化回归和绑定漂移检查 | core/application/frontend suites | `tdd` |
| 9B | 当前开发状态、测试说明、验收清单和矩阵 | `git diff --check` 与文档交叉检查 | `superpowers:subagent-driven-development` |

这样既保留 Task 的审查边界，又避免一个子任务同时修改数据库、Rust facade 和多个页面，便于回退和定位回归。

## 4. 实施任务

### Task 1: 建立关系领域类型与兼容转换

**Traceability:** US-063、US-068；需求 5.22～5.23、5.33、5.36；交互 8.2、10.4、14；关系闭环设计 2～3。

**Required skills:** `tdd`。

**Files:**

- Create: `crates/skillhub-core/src/relationship/mod.rs`
- Modify: `crates/skillhub-core/src/lib.rs`
- Modify: `crates/skillhub-core/src/import/provenance.rs`
- Modify: `crates/skillhub-core/src/deployment/observed.rs`
- Modify: `crates/skillhub-core/src/deployment/mod.rs`
- Test: `crates/skillhub-core/src/relationship/mod.rs`、`crates/skillhub-core/src/deployment/observed.rs`

**Interfaces:**

- Produces `DirectoryRole`, `DirectoryRecognition`, `RelationshipType`, `FileRepresentation`, `OwnershipState`, `ConflictClassification`, `GovernanceTaskKind`。
- Produces `DirectoryNodeFact`、`AgentDirectoryCapabilityFact`、`SourceRelationFact`、`DeploymentRelationFact`、`ConflictCaseFact` and `GovernanceTaskFact`。
- Produces pure functions `classify_conflict_evidence` and `relation_display_label`；这些函数不得访问文件系统或调用 LLM。

- [ ] 写失败测试：覆盖七种关系类型序列化、通用目录识别状态、符号链接/目录联结用户标签、指纹一致/名称不同内容/证据不足三类冲突证据。
- [ ] 运行 `cargo test -p skillhub-core relationship observed`，确认新类型尚未实现导致失败。
- [ ] 实现最小领域类型，并让旧 `ImportProvenance`、`ObservedDeployment` 能通过兼容转换生成事实关系。
- [ ] 兼容转换不得把 `NameOnly`/`Diverged` 观察误标为已确认 Skill；来源事实保留独立 provenance ID、链接目标目录 ID，冲突组保留成员、冲突类型和用户裁决字段。
- [ ] 运行定向测试和 `cargo fmt --all -- --check`。
- [ ] 提交 `feat: add normalized skill relationship domain`。

### Task 2: 增加 0014 关系存储和多来源存证

**Traceability:** US-016、US-017、US-063、US-068；需求 5.9、5.22、5.33；交互 7.5～7.8、15.3；关系闭环设计 3.1～3.4。

**Required skills:** `tdd`。

**Files:**

- Create: `crates/skillhub-storage/migrations/0014_skill_relationships.sql`
- Create: `crates/skillhub-storage/src/database/directory_repository.rs`
- Create: `crates/skillhub-storage/src/database/relationship_repository.rs`
- Modify: `crates/skillhub-storage/src/database/migrations.rs`
- Modify: `crates/skillhub-storage/src/database/mod.rs`
- Modify: `crates/skillhub-storage/src/database/provenance_repository.rs`
- Modify: `crates/skillhub-storage/src/database/deployment_repository.rs`
- Test: `crates/skillhub-storage/tests/migrations.rs`
- Test: `crates/skillhub-storage/tests/provenance_repository.rs`
- Test: `crates/skillhub-storage/tests/agent_repository.rs`

**Interfaces:**

- `DirectoryRepository::upsert_node` / `list_nodes` / `get_node`。
- `RelationshipRepository::upsert_capability` / `list_capabilities` / `upsert_deployment_relation` / `list_relations` / `list_relation_impact`。
- `ProvenanceRepository` 改为使用独立 provenance ID，旧 `skill_id` 唯一数据迁移为一条来源关系；重复导入使用路径键、指纹和时间事实，不覆盖历史。
- `ConflictRepository::create_case` / `list_cases` / `record_decision`。
- `GovernanceTaskRepository::create` / `list_pending` / `resolve`。

- [ ] 写迁移测试：从 0013 旧库升级到 0014，旧存证、观察关系、部署记录和待处理事项保持可读。
- [ ] 写仓储失败测试：同一 Skill 多来源、同一路径重复 upsert、共享目录多个 Agent 引用、冲突决定和治理待办状态转换。
- [ ] 实现 0014，使用外键、路径键唯一约束和状态枚举约束；不得修改 0013 SQL。
- [ ] 运行 `cargo test -p skillhub-storage --test migrations --test provenance_repository --test agent_repository`。
- [ ] 提交 `feat: persist normalized skill relationships`。

### Task 3: 实现确定性目录识别、关系聚合和移除影响

**Traceability:** US-012、US-018、US-033、US-034、US-063、US-067；需求 5.6、5.15、5.23、5.36；交互 7.2、10.2～10.4；关系闭环设计 2.3、4.4。

**Required skills:** `tdd`。

**Files:**

- Create: `crates/skillhub-core/src/relationship/classifier.rs`
- Create: `crates/skillhub-core/src/relationship/impact.rs`
- Modify: `crates/skillhub-core/src/agent/profile.rs`
- Modify: `crates/skillhub-core/src/agent/discovery.rs`
- Modify: `crates/skillhub-core/src/deployment/reconcile.rs`
- Modify: `crates/skillhub-core/src/deployment/removal.rs`
- Test: `crates/skillhub-core/tests/deployment_planner.rs`
- Test: `crates/skillhub-core/tests/undeploy_delete.rs`
- Test: `crates/skillhub-core/tests/import_conflicts.rs`

**Interfaces:**

- `classify_directory_capability(profile, path) -> DirectoryRecognition`。
- `classify_observed_relation(path, target_facts, directory_capabilities) -> DeploymentRelationFact`。
- `calculate_removal_impact(relation_id, facts) -> RemovalImpactFact`。
- `recommend_removal_action(impact) -> MinimalImpactAction`。

- [ ] 写失败测试：原生目录移除只影响当前 Agent；共享目录直接读取列出全部识别者；共享目录链接引用只移除当前别名；复制副本显示可转管理链接；权限或识别未知生成待办。
- [ ] 实现路径边界、符号链接/目录联结识别和 Windows 大小写折叠，复用现有 `PathPolicy` 和 `observed_path_key`。
- [ ] 保持未验证名称匹配为 `NameOnly`，不自动建立可靠 Skill 身份。
- [ ] 运行 `cargo test -p skillhub-core --test deployment_planner --test undeploy_delete --test import_conflicts`。
- [ ] 提交 `feat: classify skill relationships and removal impact`。

### Task 4: 接入应用层关系查询和 prepare/commit/rollback

**Traceability:** US-016、US-017、US-034、US-066～068；需求 5.9、5.22、5.33、5.35～5.36；交互 7.5～7.8、10.4、15.3；关系闭环设计 3.4、4.4、6。

**Required skills:** `tdd`。

**Files:**

- Create: `crates/skillhub-application/src/relationship_governance_service.rs`
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `crates/skillhub-core/src/api/query.rs`
- Modify: `crates/skillhub-core/src/operation.rs`
- Test: `crates/skillhub-application/tests/facade_observed_deployments.rs`
- Test: `crates/skillhub-application/tests/facade_import_conflicts.rs`
- Create: `crates/skillhub-application/tests/facade_relationship_governance.rs`

**Interfaces:**

- Query `get_relationship_overview(scope) -> RelationshipOverview`。
- Query `get_removal_impact(relation_id) -> RemovalImpact`，保留现有结果类型并增加关系类型、共享消费者、回退信息。
- Command `prepare_relation_migration(input) -> PreparedRelationMigration`。
- Command `commit_relation_migration(prepared_id) -> RelationMigrationResult`。
- Command `rollback_relation_migration(operation_id) -> RelationMigrationResult`。
- `RelationshipOverview` 统一供导入、Agent 详情和 Skill 详情消费，包含目录节点、关系、冲突和待办，不直接返回运行时“已加载”结论。

- [ ] 写 facade 失败测试：批量关系查询按目录合并逻辑目标；转换 prepare 不写文件；commit 只在指纹和路径仍匹配时替换；取消/失败可恢复。
- [ ] 实现应用层服务，复用现有 operation journal 和原始迁移恢复点；关系转换单独命名，不复用会删除原始文件的 `original_migration` 语义。
- [ ] 生成绑定：`SKILLHUB_WRITE_BINDINGS=1 cargo test -p skillhub-desktop generate_bindings`。
- [ ] 运行 `cargo test -p skillhub-application --test facade_relationship_governance --test facade_observed_deployments --test facade_import_conflicts`。
- [ ] 提交 `feat: expose relationship governance operations`。

### Task 5: 扩展单个和批量导入的分类确认

**Traceability:** US-016、US-017、US-018、US-064、US-065、US-068；需求 5.9、5.15、5.33；交互 7.5～7.8、14；关系闭环设计 4.1～4.2、5。

**Required skills:** `frontend-design`、`vercel-react-best-practices`、`tdd`。

**Files:**

- Modify: `crates/skillhub-core/src/import/conflict.rs`
- Modify: `crates/skillhub-core/src/import/decision.rs`
- Modify: `crates/skillhub-application/src/import_service.rs`
- Modify: `apps/desktop/src/features/import/api.ts`
- Modify: `apps/desktop/src/features/import/nativeApi.ts`
- Modify: `apps/desktop/src/features/import/ImportWizard.tsx`
- Modify: `apps/desktop/src/features/import/ConflictResolution.tsx`
- Modify: `apps/desktop/src/features/import/ImportSummary.tsx`
- Create: `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.tsx`
- Create: `apps/desktop/src/features/relationshipGovernance/relationshipGovernance.ts`
- Test: `crates/skillhub-application/tests/facade_relationship_governance.rs`
- Test: `apps/desktop/src/features/import/ImportWizard.test.tsx`
- Test: `apps/desktop/src/features/import/ConflictResolution.test.tsx`
- Test: `apps/desktop/src/features/import/ImportSummary.test.tsx`
- Create: `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`

**Interfaces:**

- `ImportGovernanceGroup`：分组 ID、分类、成员、影响摘要、默认动作和可选动作。
- `ImportGovernanceDecision`：分组动作加单项覆盖，单项覆盖优先。
- `prepare_import` 的结果增加治理分组；`commit_import` 接收最终决策并逐项返回成功、跳过、失败和待办。

- [ ] 先写单 Skill 和批量导入的失败组件测试：分类确认、展开单项、单项覆盖、AI 未配置、部分失败和待办入口。
- [ ] 运行对应 Vitest 文件，确认新分类阶段尚不存在。
- [ ] 保留现有来源门槛、候选选择、冲突分析进度和后台任务；只在冲突分析之后插入关系治理阶段。
- [ ] 实现统一治理面板，并确保导入集中库与清理原始副本是两个可回退的操作，不因导入自动清理源目录。
- [ ] 运行 `pnpm --dir apps/desktop exec vitest run src/features/import/ImportWizard.test.tsx src/features/import/ConflictResolution.test.tsx src/features/import/ImportSummary.test.tsx src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`。
- [ ] 提交 `feat: add grouped import relationship governance`。

### Task 6: 接入复制副本、共享引用和管理链接转换

**Traceability:** US-031～034、US-066～067；需求 5.22、5.23、5.36；交互 10.1～10.5、15.3；关系闭环设计 2.3、4.3～4.4、6。

**Required skills:** `tdd`。

**Files:**

- Modify: `crates/skillhub-core/src/deployment/planner.rs`
- Modify: `crates/skillhub-core/src/deployment/removal.rs`
- Modify: `crates/skillhub-application/src/deployment_service.rs`
- Modify: `crates/skillhub-application/src/relationship_governance_service.rs`
- Test: `crates/skillhub-core/tests/deploy_flow.rs`
- Test: `crates/skillhub-core/tests/undeploy_delete.rs`
- Test: `crates/skillhub-application/tests/facade_relationship_governance.rs`

**Interfaces:**

- `prepare_relation_migration` 接受关系 ID、目标管理模式、备份策略和用户确认 token，返回受影响入口、备份位置、验证指纹和回退动作。
- `commit_relation_migration` 执行“新链接—验证—旧入口移除—关系落库”。
- `rollback_relation_migration` 恢复旧入口并标记新入口为已回退。

- [ ] 先写跨关系类型转换测试：managed copy→managed link、shared reference→managed link、保留复制副本、共享目录仍有其他消费者、链接能力不足、目标被外部修改。
- [ ] 实现同卷/跨卷和权限检查；链接不可用时不静默复制覆盖。
- [ ] 复用现有 `DeploymentMode::select` 和部署恢复机制，技术模式继续由平台能力选择。
- [ ] 运行 `cargo test -p skillhub-core --test deploy_flow --test undeploy_delete` 和关系 facade 测试。
- [ ] 提交 `feat: migrate observed copies to managed links safely`。

### Task 7: 扩展 Agent 页、Skill 详情页和共享治理组件

**Traceability:** US-025、US-033、US-034、US-063、US-066～068；需求 5.23、5.33、5.35～5.36；交互 8.2、10.2～10.5、14；关系闭环设计 5。

**Required skills:** `frontend-design`、`vercel-react-best-practices`、`tdd`。

**Files:**

- Modify: `apps/desktop/src/features/agents/api.ts`
- Modify: `apps/desktop/src/features/agents/nativeApi.ts`
- Modify: `apps/desktop/src/features/agents/AgentDetailPage.tsx`
- Modify: `apps/desktop/src/features/agents/RelationsView.tsx`
- Modify: `apps/desktop/src/features/agents/AgentDetailPage.test.tsx`
- Modify: `apps/desktop/src/features/agents/nativeApi.test.ts`
- Modify: `apps/desktop/src/features/skill-detail/api.ts`
- Modify: `apps/desktop/src/features/skill-detail/nativeApi.ts`
- Modify: `apps/desktop/src/features/skill-detail/ProvenancePanel.tsx`
- Modify: `apps/desktop/src/features/skill-detail/RelationsPanel.tsx`
- Modify: `apps/desktop/src/features/skill-detail/ProvenancePanel.test.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SkillDetailPage.test.tsx`
- Modify: `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.tsx`
- Modify: `apps/desktop/src/i18n/zh-CN/common.json`
- Modify: `apps/desktop/src/i18n/en-US/common.json`

**Interfaces:**

- `AgentDirectoryView`：目录路径、目录角色、识别状态、优先级证据、Skill 数量和共享消费者。
- `RelationshipView`：Skill、来源目录、目标 Agent、关系类型、文件表示、所有权、指纹状态、可执行动作和待办。
- `RelationshipGovernancePanel` 只消费 `RelationshipOverview` 和 typed facade，不直接访问 bindings 或文件系统。

- [ ] 先写 Agent 详情测试：通用 Agent 卡片、Agent 自有目录、通用目录直接读取、通用目录链接引用、未确认目录和共享消费者。
- [ ] 写 Skill 详情测试：多来源存证、复制副本、管理链接、冲突处理记录和移除影响入口。
- [ ] 复用现有 RelationsView 的物理目录合并展示，不改变已有 Agent/项目导航和部署入口。
- [ ] 加入简短中文/英文关系标签和影响说明；不出现“外部链接”作为关系名称，不出现“已加载/一定会调用”。
- [ ] 运行 Agent、Skill detail 和 relationshipGovernance 定向测试及 i18n parity。
- [ ] 提交 `feat: show governed skill relationships in agent and skill views`。

### Task 8: 接入可选 AI 冲突分析

**Traceability:** US-018、US-065、US-068；需求 5.15、5.33；交互 7.7、13.3、14；关系闭环设计 3.4、6。

**Required skills:** `tdd`。

**Files:**

- Modify: `crates/skillhub-core/src/duplicate/model.rs`
- Modify: `crates/skillhub-core/src/duplicate/mod.rs`
- Modify: `crates/skillhub-application/src/lib.rs`
- Modify: `crates/skillhub-core/src/api/command.rs`
- Modify: `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.tsx`
- Modify: `apps/desktop/src/features/skill-detail/SemanticDuplicatePanel.tsx`
- Test: `crates/skillhub-application/tests/facade_ai.rs`
- Test: `apps/desktop/src/features/relationshipGovernance/RelationshipGovernancePanel.test.tsx`
- Test: `apps/desktop/src/features/skill-detail/SemanticDuplicatePanel.test.tsx`

**Interfaces:**

- `AnalyzeConflictScope`：`all`、`category`、`case`、`skill`。
- `AnalyzeConflict` 输入范围、冲突事实指纹和确定性基线；输出 `ConflictAnalysis`，包含推荐动作、推荐保留版本、关键证据、不确定点、置信度和失败码。
- AI 结果持久化为分析记录，但不改变 `ConflictCase.user_decision`。

- [ ] 先写测试：未配置 LLM、分析失败、全部/分类/冲突组/单 Skill 范围、结果短结论和用户未采纳结果。
- [ ] 复用现有语义重复分析任务和供应商配置，不新增模型路由或向量索引。
- [ ] 将 AI 按钮接入关系治理组件和现有语义重复面板，确保确定性证据先展示。
- [ ] 运行 `cargo test -p skillhub-application --test facade_ai` 和前端冲突面板测试。
- [ ] 提交 `feat: add optional conflict decision analysis`。

### Task 9: 完成契约、回归、文档和人工验收入口

**Traceability:** US-063～068 及既有导入/部署用户故事；需求 5.9、5.15、5.22、5.23、5.33、5.36；交互 7.5～7.8、8.2、10、14、15；关系闭环设计 7。

**Required skills:** `tdd`、`superpowers:subagent-driven-development`。

**Files:**

- Modify: `docs/development/开发状态-2026-09-13.md`
- Modify: `docs/development/自动化测试说明-2026-09-13.md`
- Modify: `docs/development/人工验收清单-2026-09-13.md`
- Modify: `docs/development/功能完成度与验收状态矩阵-2026-09-13.md`
- Modify: `README.md`
- Test: `crates/skillhub-core/tests/import_flow.rs`
- Test: `crates/skillhub-core/tests/deploy_flow.rs`
- Test: `crates/skillhub-application/tests/facade_relationship_governance.rs`
- Test: `apps/desktop/src/features/import/ImportWizard.test.tsx`
- Test: `apps/desktop/src/features/agents/AgentDetailPage.test.tsx`

- [ ] 增加端到端回归：单个导入、批量导入、同名冲突分类、共享目录影响、复制副本纳入集中库管理、移除部署、取消、部分失败、权限受限、回退。
- [ ] 重新生成 bindings 并执行 `git diff --exit-code -- apps/desktop/src/api/bindings.ts`。
- [ ] 执行 `cargo fmt --all -- --check`、`cargo test --workspace --all-features`、`pnpm check:frontend`、`pnpm test:frontend`、`pnpm build:frontend` 和 `git diff --check`。
- [ ] 只有真实桌面验收完成后，才把 Windows/macOS 状态写成通过；自动化结果不得替代真机证据。
- [ ] README 只在行为已经实现并验证后更新；当前不提前宣称闭环完成。
- [ ] 提交 `docs: record relationship closure verification`。

## 5. 任务依赖与执行顺序

```text
Task 1 → Task 2 → Task 3 → Task 4
                         ├→ Task 5 → Task 7
                         └→ Task 6
Task 5 + Task 7 → Task 8
Task 6 + Task 7 + Task 8 → Task 9
```

Task 1～4 必须串行完成，因为它们冻结领域类型、数据库事实和 IPC 契约。Task 5 和 Task 6 可以在 Task 4 完成后拆为独立 worktree 并行；Task 7 必须在 Task 5 的共享治理面板基础完成后执行，因为两者共同修改该组件。每个任务只能消费统一关系 DTO，不在前端或应用服务中复制关系判断。Task 8 必须在确定性冲突分组和 Agent/Skill 页面入口可用后进行。Task 9 最后执行。

## 6. 验收矩阵

| 场景 | 确定性结果 | 用户动作 | 预期结果 |
|---|---|---|---|
| `.agents/skills` 导入集中库 | `import_copy` | 纳入集中库 | 通用目录原件保留，来源和指纹入库 |
| Agent 直接读取通用目录 | `shared_directory_read` | 移除当前 Agent | 展示所有识别该目录的 Agent，不删除共享本体 |
| Agent 自有目录链接到通用目录 | `shared_directory_reference` | 迁移当前 Agent | 建立集中库→Agent 管理链接，移除旧入口，其他引用不变 |
| 集中库已部署复制副本 | `managed_copy` 或 `observed_copy` | 纳入集中库管理 | 备份、验证、建立指向集中库主副本的管理链接、移除旧副本、可回退 |
| 同名不同内容且证据不足 | `uncertain` | 冲突处理/AI 分析 | 保留在冲突处理工作台，不进入通用待处理；不合并、不删除、不覆盖 |
| 同名不同内容判定为不同 Skill | `distinct_skill` | 保留两者 | 建立两个集中库身份和独立关系 |
| 同名不同内容判定为不同版本 | `same_skill_version` | 纳入版本历史 | 同一 Skill 下形成新版本，不误建第二对象 |
| 链接权限不足或目标变化 | `operation blocked` | 重试/保留/回退 | 原入口保留，记录失败，不报告为成功 |

## 7. 计划自检结论

- 已覆盖本历史设计稿中的目录角色、关系类型、多来源存证、冲突组、AI 分析、待办、单个/批量导入、部署迁移、移除影响和前端入口。
- 已明确复用现有 `ImportProvenance`、`ObservedDeployment`、`DeploymentRecord`、`RemovalImpact`、操作日志、任务追踪和 Agent RelationsView，而不是重新建设平行系统。
- 新的 v0.2.0 图谱、冲突处理工作台、关系治理清单、批量关系操作和统一异步通知不回填为本历史计划任务，须使用独立实施计划；Agent 适配器重写、自动清理共享目录和自动 AI 决策仍不在范围内。
- 计划中的关系 DTO、命令名、枚举和迁移版本在任务之间保持一致，前端 bindings 只由生成测试更新。
