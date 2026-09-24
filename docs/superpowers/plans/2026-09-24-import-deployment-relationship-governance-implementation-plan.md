# Import, Deployment, and Relationship Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在不混淆导入、部署和关系治理边界的前提下，建立可追溯的多来源导入模型、可安全清理的本地来源副本、真实关系校验与治理历史，并让单项/批量部署按每个 Skill × 目标明确处理链接受阻与复制降级。

**Architecture:** 保留现有 catalog/version、deployment、operation journal、关系图谱和安全迁移链路；将现有 source_relations 的“导入事件”语义迁为不可变 provenance events，另建“当前来源副本关系”事实。应用层统一负责来源分类、批次映射、文件校验、治理编排和部署逐项预览；前端只消费结构化事实，不根据路径或错误文案反推权限与关系。

**Tech Stack:** Rust workspace（skillhub-core、skillhub-storage、skillhub-adapters、skillhub-application、skillhub-desktop）、SQLite migrations、Tauri 2、React 18、TypeScript 5、TanStack Query、Vitest、Playwright。

**Spec:** docs/superpowers/specs/2026-09-24-import-deployment-and-relationship-governance-design.md

## Global Constraints

- 所有行为变更 Task 开始时加载 tdd，严格执行先写失败测试并确认红灯、再写最小实现、最后重构；不得删测试、降低断言或加入任意延时。
- 每个前端 Task 开始前必须完整加载 frontend-design；涉及 React 的 Task 同时加载 vercel-react-best-practices。E2E Task 使用 playwright-cli；出现失败或意外行为时先加载 systematic-debugging。
- Rust IPC 契约只能通过 PowerShell 命令 $env:SKILLHUB_WRITE_BINDINGS='1'; cargo test -p skillhub-desktop generate_bindings 生成 apps/desktop/src/api/bindings.ts，不得手改生成文件。
- 导入不删除来源、不建立普通部署；部署不跳转治理；治理只操作后端判定为可管理的本地关系。
- 在线来源、下载/解压缓存、集中库和本轮排除的项目目录不得投影为可清理来源副本，也不得展示临时缓存路径。
- “复用已有 Skill”必须追加本次不可变存证，并把可治理来源挂到最终命中的 Skill；跳过、失败、取消不建立来源副本关系。
- 一个 Skill 可有多条来源，一个来源容器可含多个 Skill；治理粒度是具体 Skill 目录对应的关系边。同一物理 Skill 目录最多有一条活动来源副本关系。
- 链接部署被明确选择后不得静默改成复制；复制降级必须显示具体、可理解的原因，经用户确认并重新预览后才能提交。
- 来源副本与部署关系不能混合批处理；批量失败不得拖住其他已确认且可执行的关系项。
- 删除、替换、恢复、转链接前必须重新核验路径身份、表示类型、内容指纹、权限和关系 revision；UI 中较新的状态不能替代提交门禁。
- Agent 展示统一使用 AgentPresentation 的品牌 logo 与用户可理解类型徽标；路径先经 displayPath/物理身份归并；技术 ID 只可出现在折叠技术详情。
- 继续使用现有 operation journal 作为持久化操作记录；新增关系历史只记录关系生命周期快照和外部变化，不复制成第二本通用操作日志。
- Windows 与 macOS 均覆盖路径大小写、斜杠、符号链接、目录联接、权限、离线卷和网络目录差异；自动化结果不得写成人工验收通过。
- 保留工作区中与本计划无关的用户文件和未跟踪 debug.log；每个 Task 提交前运行 git diff --check 并只提交本 Task 文件。

## Review Focus

人工审查本计划时优先确认以下契约，确认后下游 Task 不得自行改口径：

1. 0019 将“导入事件”和“当前来源副本关系”拆成两个实体，而不是继续用 provenance_id 同时承担历史与治理身份。
2. 历史数据只在来源类别可由现有权威事实证明时回填活动来源副本；不确定旧数据保留存证但不开放删除。
3. 路径缺失只有在父目录和文件系统可访问时才自动归档；权限不足、离线、超时均保留当前关系。
4. 来源清理继续复用 original migration 的备份、确认和回滚顺序，但请求主键改为 source_relation_id。
5. 部署逐项预览由后端生成 disposition、reason 和 confirmation fingerprint；前端分组不拥有业务判定权。
6. watcher 事件只是提示，必须经应用层确认检查后才写事实或归档关系。

## Current-Code Map and Change Boundaries

| Current file / seam | Current responsibility | Planned change |
|---|---|---|
| crates/skillhub-core/src/import/provenance.rs:16 | ImportProvenance 同时被当作导入历史和来源关系输入 | 拆为不可变 ImportProvenanceEvent；不再用 SkillId 作为事件唯一身份 |
| crates/skillhub-storage/migrations/0013_observed_deployments.sql:12 | import_provenance 以 skill_id 为主键，只能保存一条 | 保留为兼容投影；0019 新表承载多事件 |
| crates/skillhub-storage/migrations/0014_skill_relationships.sql:22 | source_relations 以 provenance_id 为主键，实质仍是事件表 | 0019 重命名为 import_provenance_events，并重建 source_copy_relations |
| crates/skillhub-application/src/lib.rs:6607 | 单候选 CommitImport；复用时若已有存证会跳过新存证 | 引入稳定 import batch；每次成功导入都追加事件并映射最终 Skill |
| crates/skillhub-application/src/lib.rs:7455 | record_import_evidence 通过路径和 Agent 归属写存证/观察关系 | 改为消费获取阶段盖章的权威来源类别，按条件 upsert 来源副本 |
| crates/skillhub-core/src/api/command.rs:220 | PrepareOriginalMigration 只接收 skill_id | 改为精确 source_relation_id，避免多来源误删 |
| crates/skillhub-application/src/lib.rs:7600 | 原副本迁移从 provenance_for_skill 取单路径 | 从活动来源副本关系取路径，并在提交前完整重验 |
| crates/skillhub-core/src/relationship/governance.rs:130 | RelationGovernanceRow 只包装 DeploymentRelationFact | 改为统一可管理关系行，显式区分 source_copy/deployment |
| crates/skillhub-application/src/relationship_governance_batch.rs | 部署关系按边 prepare/commit/rollback | 复用其逐项、非原子、父子 operation 模式；新增来源保留/清理分支 |
| apps/desktop/src/features/relationships/governance/RelationshipGovernancePage.tsx:683 | “重新校验”只 refetch ledger | 调用真实校验 command，再按 revision 刷新 |
| crates/skillhub-core/src/application/watch_service.rs:219 | 已有 hint 合并与确认边界 | 接入原生 watcher 和应用确认器；hint 永不直接写事实 |
| crates/skillhub-core/src/deployment/planner.rs:188 | 不支持显式 mode 时整份计划报错 | 新增逐物理目标 preview disposition，不改变最终 DeploymentPlan 执行语义 |
| apps/desktop/src/features/deployment/nativeApi.ts:244 | 批量预览按 Skill 调一次，多目标任一错误使整 Skill 失败 | 消费后端 Skill × 目标逐项预览和确认指纹 |
| apps/desktop/src/features/deployment/BatchDeploymentPage.tsx:100 | 全批次使用一个 mode，任一 preview failure 禁止提交 | 分类展示、按原因整组确认复制、逐项排除，提交其余已确认项 |

## Target Data and API Contracts

实现时以以下命名和职责为准；若编译约束要求微调名称，必须保持字段语义并同步更新本计划和设计文档。

    pub enum ImportSourceClass {
        AgentLocal,
        UserLocal,
        RegisteredProject,
        Online,
        OnlineCache,
        CentralLibrary,
        LegacyUnclassified,
    }

    pub struct ImportProvenanceEvent {
        pub provenance_id: String,
        pub batch_id: String,
        pub skill_id: SkillId,
        pub source_class: ImportSourceClass,
        pub source: SourceDescriptor,
        pub local_source_path: Option<String>,
        pub source_container_id: Option<String>,
        pub physical_source_id: Option<String>,
        pub agent_client_id: Option<String>,
        pub content_fingerprint: String,
        pub imported_at: i64,
    }

    pub enum SourceCopyDecision {
        Pending,
        Retained,
    }

    pub enum SourceCopyHealth {
        Normal,
        NeedsValidation,
        ContentChanged,
        PermissionLimited,
        ManagedOccupied,
        OperationFailed,
    }

    pub struct SourceCopyRelationFact {
        pub relation_id: String,
        pub skill_id: SkillId,
        pub latest_provenance_id: String,
        pub source_class: ImportSourceClass,
        pub source_path: String,
        pub source_path_key: String,
        pub physical_source_id: String,
        pub source_container_id: Option<String>,
        pub directory_node_id: Option<String>,
        pub agent_client_id: Option<String>,
        pub expected_fingerprint: String,
        pub current_fingerprint: Option<String>,
        pub decision: SourceCopyDecision,
        pub health: SourceCopyHealth,
        pub active: bool,
        pub last_verified_at: Option<i64>,
        pub archived_at: Option<i64>,
        pub archive_reason: Option<SourceCopyArchiveReason>,
    }

    pub enum GovernableRelationFact {
        SourceCopy(SourceCopyRelationFact),
        Deployment(DeploymentRelationFact),
    }

导入批次只通过 batch_id 查询，前端主界面只显示“本次导入”和数量，不显示 batch_id。部署确认使用内部 pair_id / confirmation_fingerprint，同样只放在技术详情或请求载荷中。

## Dependency Order

    Task 1 → Task 2 → Task 3 → Task 4
                  └────→ Task 5 → Task 6
                       → Task 7 → Task 8 → Task 9
    Task 9 → Task 10 → Task 11 → Task 12
    Task 9 → Task 13 → Task 14
    Task 10—14 → Task 15

Task 13 的部署预览领域逻辑在 Task 2 完成后可与 Task 3—8 分支并行，但若执行时使用子代理，必须使用独立 worktree，且不得并行修改 api/query.rs、api/command.rs、apps/desktop/src/api/bindings.ts、router.tsx 或双语 common.json。

## Task 1: Freeze provenance, source-copy, validation, and governance domain contracts

**Files:**

- Modify: crates/skillhub-core/src/import/model.rs:5-87
- Modify: crates/skillhub-core/src/import/provenance.rs:8-118
- Modify: crates/skillhub-core/src/relationship/mod.rs:172-218
- Create: crates/skillhub-core/src/relationship/source_copy.rs
- Create: crates/skillhub-core/src/relationship/governance_v2.rs
- Modify: crates/skillhub-core/src/import/mod.rs
- Modify: crates/skillhub-core/src/relationship/mod.rs
- Test: crates/skillhub-core/tests/source_copy_governance.rs
- Test: crates/skillhub-core/tests/import_flow.rs

**Consumes:** 当前 ImportCandidate、ImportDecision、ImportProvenance、SourceRelationFact、DeploymentRelationFact、RelationGovernanceRow。

**Produces:** 不可变 ImportProvenanceEvent、当前 SourceCopyRelationFact、导入批次 DTO、验证状态转换、统一 GovernableRelationFact；本 Task 不读写数据库或文件系统。

- [ ] 1.1 新增 crates/skillhub-core/tests/source_copy_governance.rs，先钉住一项 Skill 多来源、一来源容器多 Skill、同一物理 Skill 目录不能同时活动映射多个 Skill、用户决策与健康状态正交。
- [ ] 1.2 运行 cargo test -p skillhub-core --test source_copy_governance，确认因新类型/投影缺失而失败。
- [ ] 1.3 在 import/model.rs 增加 ImportSourceClass，并给 ImportCandidate 增加 source_class、source_container_id、physical_source_id；不允许从 absolute_root 推导 OnlineCache。
- [ ] 1.4 将 provenance.rs 的事件模型改为显式 provenance_id 与 batch_id；local_source_path 为 Option，Online/OnlineCache 事件不得携带临时目录。
- [ ] 1.5 在 relationship/mod.rs 增加 SourceCopyDecision、SourceCopyHealth、SourceCopyArchiveReason、SourceCopyRelationFact 和 GovernableRelationFact；DeploymentRelationFact 补 target_scope/project_id 可选字段供项目筛选。
- [ ] 1.6 为来源副本定义纯函数 relationship_id_for_source_copy(skill_id, physical_source_id)，并定义 validate_source_copy_transition(relation, probe, level, at)；缺失只有 MissingWithAccessibleParent 才返回 Archive(ExternalRemoved)。
- [ ] 1.7 在 governance_v2.rs 定义 NeedsAttention、Retained、Normal、NeedsValidation、Blocked 五种投影状态，以及 scope、batch_id、project_id、source_class 过滤值；本 Task 不替换现有 IPC ledger。
- [ ] 1.8 在 governance_v2.rs 定义 tagged relation scope + 稳定 relation_id + 用户可读 endpoint/状态/动作 DTO；Task 7 再把它接入现有 RelationGovernanceRow，避免本 Task 提前破坏生成绑定。
- [ ] 1.9 定义 legacy EstablishManagedRelation 的拒绝 helper；Task 4 再从 ImportDecision::ORDERED/分析动作移除并接入 commit。
- [ ] 1.10 补齐纯函数测试：ReuseExisting 选择最终 Skill；Skip/失败/取消无来源副本；Online/OnlineCache/RegisteredProject/CentralLibrary 不可治理；AgentLocal/UserLocal 默认 Pending。
- [ ] 1.11 运行 cargo test -p skillhub-core --test source_copy_governance --test import_flow。
- [ ] 1.12 运行 cargo fmt --all -- --check 与 git diff --check，提交：git commit -m "model source copy governance facts"。

## Task 2: Add schema v19 and repositories for batches, immutable provenance, current relations, and history

**Files:**

- Create: crates/skillhub-storage/migrations/0019_import_source_governance.sql
- Modify: crates/skillhub-storage/src/database/migrations.rs:7-58
- Modify: crates/skillhub-storage/src/database/provenance_repository.rs:20-420
- Modify: crates/skillhub-storage/src/database/relationship_repository.rs:21-421
- Create: crates/skillhub-storage/src/database/governance_history_repository.rs
- Modify: crates/skillhub-storage/src/database/mod.rs
- Test: crates/skillhub-storage/tests/migrations.rs
- Test: crates/skillhub-storage/tests/database_upgrade.rs
- Test: crates/skillhub-storage/tests/provenance_repository.rs
- Test: crates/skillhub-storage/tests/relationship_repository.rs
- Create: crates/skillhub-storage/tests/governance_history_repository.rs

**Consumes:** Task 1 domain types。

**Produces:** schema 19、事务化 repositories、保守 legacy backfill seam；不做文件删除或 UI。

- [ ] 2.1 在 migrations.rs 测试中新增 v18→v19 升级断言，覆盖旧 source_relations、import_provenance、conflict_case_members 和 original_migrations 的可读性。
- [ ] 2.2 在 provenance_repository 测试中先写红灯：同一 Skill 两次导入产生两个 provenance event；同一路径同 Skill 只保留一条活动 source copy；不同路径分别存在。
- [ ] 2.3 在 relationship_repository 测试中先写红灯：活动 physical_source_id 唯一；归档后可重新建立；decision/health/last_verified_at 更新推进 relationship revision。
- [ ] 2.4 在 governance_history_repository 测试中先写红灯：SkillHub 清理、外部移除、部署移除、解除保留、回滚和终结失败均保存不同 action/result；operation_id 可空。
- [ ] 2.5 运行上述四个测试目标，确认 schema/table/repository 缺失导致失败。
- [ ] 2.6 编写 0019：先把旧 source_relations 重命名为 import_provenance_events，再增加 batch_id/source_class/source_container_id/physical_source_id/upstream_json；保留 provenance_id 主键及 conflict_case_members 外键。
- [ ] 2.7 在 0019 创建 import_batches 与 import_batch_items；batch_items 保存 candidate_key、最终 skill_id、provenance_id、source_relation_id、status/reason，不把显示名当身份。
- [ ] 2.8 在 0019 新建 source_copy_relations，包含 decision、health、active、验证/归档字段；建立 physical_source_id WHERE active=1 的 partial unique index。
- [ ] 2.9 在 0019 给 deployment_relations 增加 target_scope/project_id；给 original_migrations 增加 source_relation_id；新建 relation_history_events，并为 scope/time/skill/relation 建索引。
- [ ] 2.10 对旧事件统一回填 source_class=legacy_unclassified、batch_id=legacy:<provenance_id>；不在纯 SQL 中猜测可清理关系。创建对应 completed legacy batch 只用于可追溯查询。
- [ ] 2.11 将 CURRENT_SCHEMA_VERSION 改为 19，注册 migration；不得改写 0013—0018。
- [ ] 2.12 重写 ProvenanceRepository：append_provenance_event、list_provenance_events_for_skill、begin/finalize_import_batch、record_batch_item；旧 provenance_for_skill 只作“最新兼容投影”并标注弃用。
- [ ] 2.13 扩展 RelationshipRepository：upsert/get/list/archive/restore_source_copy_relation，所有事实变更与 revision bump 在同一 transaction。
- [ ] 2.14 新增 GovernanceHistoryRepository；写历史和归档/恢复关系必须提供共享 transaction helper，避免“列表已消失但历史未写”。
- [ ] 2.15 添加 legacy backfill repository seam：只返回待分类 legacy events，由 Task 5 的权威校验决定是否建立来源副本；migration 自身绝不开放不确定路径删除。
- [ ] 2.16 运行 cargo test -p skillhub-storage --test migrations --test database_upgrade --test provenance_repository --test relationship_repository --test governance_history_repository。
- [ ] 2.17 运行 cargo fmt --all -- --check、cargo clippy -p skillhub-storage --all-targets -- -D warnings、git diff --check，提交：git commit -m "persist import source governance facts"。

## Task 3: Stamp authoritative source classification during acquisition and discovery

**Files:**

- Modify: crates/skillhub-application/src/lib.rs:1915-1925, 5895-5921, 6447-6538, 7167-7294
- Modify: crates/skillhub-adapters/src/scanner/skill_detector.rs
- Modify: crates/skillhub-core/src/import/model.rs
- Test: crates/skillhub-adapters/tests/import_detection.rs
- Test: crates/skillhub-application/tests/facade.rs
- Test: crates/skillhub-application/tests/facade_observed_deployments.rs

**Consumes:** Task 1 ImportSourceClass，Task 2 repository seam。

**Produces:** 每个 ImportCandidate 携带后端权威来源类别及可选物理身份；临时下载路径不会退化为 UserLocal。

- [ ] 3.1 在 import_detection.rs 写失败测试：普通用户目录=UserLocal；已识别 Agent 目录=AgentLocal；项目目录=RegisteredProject；集中库=CentralLibrary。
- [ ] 3.2 在 facade.rs 写失败测试：Git/HTTPS 获取落到 tempdir 后候选仍为 OnlineCache，source 仍是上游 URL，UI/存证不得出现 tempdir。
- [ ] 3.3 在 facade_observed_deployments.rs 写失败测试：仓库发现 local_path + UpstreamOrigin 被分类为 OnlineCache，不因本地绝对路径产生治理关系。
- [ ] 3.4 运行三个测试文件的定向测试，确认当前 Candidate 缺少权威分类而失败。
- [ ] 3.5 新增 AcquiredImportSource 记录，保存业务 SourceDescriptor、工作目录、ImportSourceClass、UpstreamOrigin；acquired_import_sources 按原始 descriptor 存整条记录而非只存 TempDir。
- [ ] 3.6 将本地分类集中在应用层 classify_import_source：使用 central root、registered projects、directory nodes/logical targets 和用户明确选择来源；最长物理路径匹配只用于 Agent/项目归属。
- [ ] 3.7 Scanner 只接受并原样复制调用方提供的 source_class/container/physical identity，不在 adapter 根据字符串猜测业务类别。
- [ ] 3.8 对真实本地目录用现有 physical_id_for_path 生成 physical_source_id；失败时保留 None，并使后续治理 fail-closed。
- [ ] 3.9 Online/OnlineCache 候选只保存业务 URL/仓库坐标；absolute_root 仅供本次 capture，不写入 provenance local_source_path。
- [ ] 3.10 运行 cargo test -p skillhub-adapters --test import_detection 与 cargo test -p skillhub-application --test facade --test facade_observed_deployments。
- [ ] 3.11 运行 cargo fmt --all -- --check、相关 clippy、git diff --check，提交：git commit -m "classify import sources authoritatively"。

## Task 4: Persist stable import batches and map every successful source to the resolved Skill

**Files:**

- Modify: crates/skillhub-core/src/api/command.rs:202-214, 1000-1045
- Modify: crates/skillhub-core/src/application/import_service.rs:27-74
- Modify: crates/skillhub-application/src/lib.rs:6607-6965, 7438-7501
- Modify: crates/skillhub-storage/src/database/provenance_repository.rs
- Test: crates/skillhub-core/tests/import_flow.rs
- Test: crates/skillhub-application/tests/facade_import_conflicts.rs
- Test: crates/skillhub-application/tests/facade_observed_deployments.rs
- Test: crates/skillhub-application/tests/facade_operation_journal.rs

**Consumes:** Tasks 1—3。

**Produces:** BeginImportBatch / FinalizeImportBatch，CommitImport 关联 batch；ImportSummary 返回稳定 batch context 与可管理来源数量。

- [ ] 4.1 在 import_flow.rs 写红灯契约：BeginImportBatch 返回 batch_id；CommitImport 必须携带 batch_id/candidate_key；FinalizeImportBatch 返回 manageable_source_count。
- [ ] 4.2 在 facade_import_conflicts.rs 写红灯：ReuseExisting 把新的 provenance event 和 source copy 关系挂到匹配 Skill；Copy/Independent/TakeOver 挂到新 Skill；Skip 无事件/关系映射。
- [ ] 4.3 写同一物理来源重复导入同一 Skill 的测试：追加两个事件，但 batch 均映射到同一个活动 source_relation_id。
- [ ] 4.4 写身份冲突测试：同一 physical_source_id 已活动映射 Skill A 时，导入决策指向 Skill B 必须返回明确 needs_identity_decision，不覆盖旧关系。
- [ ] 4.5 写旧 EstablishManagedRelation 请求测试：返回 InvalidInput + reason=legacy_import_relation_decision，不写文件、不静默转其他决定。
- [ ] 4.6 运行定向测试确认失败。
- [ ] 4.7 在 command.rs 增加 BeginImportBatch、FinalizeImportBatch，并给 CommitImport 增加 batch_id/candidate_key；ImportSummary 增加 batch_id、manageable_source_count、source_relation_ids（仅供路由请求）。
- [ ] 4.8 重构 commit_import_flow：所有成功分支先解析 final_skill_id，再调用一个 record_import_outcome；删除 ReuseExisting “已有存证则跳过”逻辑。
- [ ] 4.9 record_import_outcome 在一个数据库 transaction 中追加 provenance event、写 batch item、按 source_class/物理身份 upsert source copy；Online/缓存/项目/集中库只写事件。
- [ ] 4.10 Import failure/cancel/skip 只记录 batch item 状态，不建立 provenance event/source copy；原始文件始终保留。
- [ ] 4.11 FinalizeImportBatch 从持久化映射计算 count，不信任前端汇总；未 finalize 的批次也能通过 batch_id 恢复已成功关系。
- [ ] 4.12 操作日志继续按每个 import_skill operation 记录；batch_id 只作为结果关联，不替代 operation_id。
- [ ] 4.13 运行 cargo test -p skillhub-core --test import_flow 以及上述三个 application 测试。
- [ ] 4.14 生成绑定并只检查本 Task 契约差异：$env:SKILLHUB_WRITE_BINDINGS='1'; cargo test -p skillhub-desktop generate_bindings。
- [ ] 4.15 运行 cargo fmt --all -- --check、相关 clippy、git diff --check，提交：git commit -m "track import batches and source relations"。

## Task 5: Implement lightweight/full relation checks and safe missing-path archival

**Files:**

- Create: crates/skillhub-core/src/relationship/validation.rs
- Modify: crates/skillhub-core/src/relationship/mod.rs
- Create: crates/skillhub-adapters/src/relationship/filesystem_probe.rs
- Modify: crates/skillhub-adapters/src/lib.rs
- Create: crates/skillhub-adapters/tests/relationship_filesystem_probe.rs
- Create: crates/skillhub-application/src/relationship_validation_service.rs
- Modify: crates/skillhub-application/src/lib.rs:3424-3485, 5280-5310
- Modify: crates/skillhub-core/src/api/command.rs
- Modify: crates/skillhub-core/src/api/query.rs
- Test: crates/skillhub-core/tests/source_copy_validation.rs
- Test: crates/skillhub-application/tests/facade_relationship_validation.rs

**Consumes:** Task 2 当前关系/历史 repositories，Task 3 权威 source class。

**Produces:** RunRelationshipCheck command、light/full probe、真实状态更新、ExternalRemoved 自动归档；不接 watcher。

- [ ] 5.1 在 source_copy_validation.rs 写纯函数红灯，覆盖 AccessibleDirectory、MissingWithAccessibleParent、PermissionDenied、OfflineOrUnknown、WrongRepresentation、PhysicalIdentityChanged、FingerprintChanged、ManagedOccupied。
- [ ] 5.2 明确两级校验断言：Light 只检查可达性/存在/类型/物理身份；Full 额外计算内容指纹和受管占用。
- [ ] 5.3 在 facade_relationship_validation.rs 写红灯：AllActive、RelationIds、Skill、Agent、Project、Batch 六种 scope 只检查范围内活动本地关系。
- [ ] 5.4 写自动归档红灯：只有 MissingWithAccessibleParent 同时归档关系、写 ExternalRemoved 历史、推进 revision；PermissionDenied/OfflineOrUnknown 保留活动关系。
- [ ] 5.5 写重复检查幂等测试：同一缺失关系不会重复写历史；相同状态不无意义推进 revision。
- [ ] 5.6 运行三个新测试文件确认失败。
- [ ] 5.7 在 core 定义 RelationshipCheckLevel、RelationshipCheckScope、RelationshipPathProbe、RelationshipCheckOutcome 和纯状态转换函数。
- [ ] 5.8 在 adapters 实现 FilesystemRelationshipProbe：使用 symlink_metadata 区分真实目录/链接；只有父目录可读取且目标 NotFound 才返回 MissingWithAccessibleParent。
- [ ] 5.9 对 Windows reparse point/目录联接使用现有 reparse identity helper，不把 junction 当普通目录；对 macOS 符号链接不跟随后再判定。
- [ ] 5.10 在 application 新建 RelationshipValidationService，加载关系、调用 probe、在同一 transaction 更新 health/验证证据或归档+历史。
- [ ] 5.11 新增 RunRelationshipCheck command；返回逐项 checked/unchanged/archived/failed 和新的 relationship_revision，检查失败按项返回而非中止整批。
- [ ] 5.12 将初始化扫描、单 Skill 重扫、导入、部署、移除、迁移、恢复、回滚后的受影响关系接到 targeted Light/Full 检查；不得追加全量 hash。
- [ ] 5.13 将 legacy_unclassified backfill 放到启动后的 Light 检查：结合 verified upstream、central root、project roots、Agent directory facts 分类；无法证明时只保留事件。
- [ ] 5.14 在来源清理、部署移除、关系迁移和恢复的 commit 前调用 Full 强校验；revision 或物理身份变化返回 TargetChanged。
- [ ] 5.15 运行 cargo test -p skillhub-core --test source_copy_validation、cargo test -p skillhub-adapters --test relationship_filesystem_probe、cargo test -p skillhub-application --test facade_relationship_validation。
- [ ] 5.16 运行 cargo fmt --all -- --check、相关 clippy、git diff --check，提交：git commit -m "validate governable relationships"。

## Task 6: Connect debounced native filesystem hints to confirmed relationship checks

**Files:**

- Modify: crates/skillhub-adapters/Cargo.toml
- Create: crates/skillhub-adapters/src/watcher/native.rs
- Modify: crates/skillhub-adapters/src/watcher/mod.rs
- Modify: crates/skillhub-adapters/tests/watcher.rs
- Create: crates/skillhub-application/src/relationship_watch_confirmation.rs
- Modify: crates/skillhub-application/src/lib.rs
- Modify: apps/desktop/src-tauri/Cargo.toml
- Modify: apps/desktop/src-tauri/src/lib.rs:206-304
- Test: crates/skillhub-application/tests/facade_relationship_validation.rs
- Test: apps/desktop/src-tauri/src/lib.rs

**Consumes:** 现有 WatchService / WatchCoalescer，Task 5 validation service。

**Produces:** 桌面运行期 watcher 闭环；OS event 仅产生 hint，确认扫描成功后才发布 FactsChanged。

- [ ] 6.1 扩展 watcher.rs 测试：真实临时目录变更进入 coalescer；400ms 窗口合并同一 Skill；停止后不再收 hint。
- [ ] 6.2 在 application 测试中写红灯：WatchHint confirm 只检查映射关系；Overflow/AppResumed/Reconnected 触发 Light compensation scan；普通 change 触发 scoped Full。
- [ ] 6.3 写失败路径测试：确认扫描失败时 hint 留在 pending；不会直接归档或推进 relationship revision。
- [ ] 6.4 运行定向测试确认失败。
- [ ] 6.5 在 adapters 增加 notify 的受控依赖和 NativeRelationshipWatcher；只监听 repository 返回的活动本地关系根，不接受任意前端路径。
- [ ] 6.6 实现 RelationshipWatchConfirmation，持有 LocalApplicationFacade 弱引用并把 hint 转为 Task 5 的 relation scope；禁止在 watcher callback 中直接访问 SQLite。
- [ ] 6.7 在 Tauri setup 显示主界面后启动 watcher 与后台 Light 检查；启动失败写诊断但不阻塞 UI。
- [ ] 6.8 在 app resume、网络/卷重连可观察事件上提交 compensation hint；没有可靠平台事件时不得用固定周期轮询替代。
- [ ] 6.9 每次关系事实变化后刷新 active roots 和 recognized skill roots；先停止旧 watcher，再以精确根集合启动，空集合保持停止。
- [ ] 6.10 确认成功后通过既有 app_event/FactsChanged 让前端 query invalidation 生效；不新增第二套事件总线。
- [ ] 6.11 运行 cargo test -p skillhub-adapters --test watcher、cargo test -p skillhub-application --test facade_relationship_validation、cargo test -p skillhub-desktop。
- [ ] 6.12 运行 cargo fmt --all -- --check、相关 clippy、git diff --check，提交：git commit -m "connect relationship filesystem watcher"。

## Task 7: Build the unified current-governance ledger and separate history query

**Files:**

- Modify: crates/skillhub-core/src/relationship/governance.rs:35-300
- Create: crates/skillhub-core/src/relationship/history.rs
- Modify: crates/skillhub-core/src/relationship/mod.rs
- Modify: crates/skillhub-core/src/api/query.rs:660-757, 793-end
- Modify: crates/skillhub-application/src/relationship_governance_service.rs
- Modify: crates/skillhub-application/src/relationship_governance_batch.rs
- Modify: crates/skillhub-application/src/lib.rs:5957-5971
- Test: crates/skillhub-core/tests/relationship_governance_batch.rs
- Test: crates/skillhub-application/tests/facade_relationship_governance.rs

**Consumes:** Tasks 1、2、5。

**Produces:** 当前全部可管理关系 ledger、batch/deep-link filters、独立 governance history page data。

- [ ] 7.1 扩展 core 治理测试，先覆盖来源副本 Pending/Retained 与六种 health 到五个快捷状态的投影。
- [ ] 7.2 写统一清单红灯：来源副本和部署均可出现在 All；Online provenance 永不出现；已归档关系只进 history。
- [ ] 7.3 写筛选红灯：scope、batch_id、skill、agent、project、source_class、text 可组合；batch_id 只命中 import_batch_items 映射关系。
- [ ] 7.4 写 action 红灯：来源 Pending=Clean/Retain/Revalidate；Retained=Clean/Revalidate；部署保持 Centralize/Undeploy/DetachKeepFiles/Revalidate。
- [ ] 7.5 写批次约束红灯：混合 scope、混合 action、重复 relation_id、非活动 relation 均在 prepare 前拒绝。
- [ ] 7.6 写 history query 红灯：分页/范围/Skill/Agent/项目/结果筛选，按 occurred_at 倒序稳定返回；技术 ID 不作为 display label。
- [ ] 7.7 运行 core/application 治理测试确认失败。
- [ ] 7.8 重写治理投影入口，让 project_relation_governance_ledger 同时消费 source copies、deployments、目录能力、名称和 batch map。
- [ ] 7.9 RelationGovernanceLedger 返回五个快捷状态计数、scope 计数、relationship_revision 和范围内 last_verified_at；不在 query 中做文件 I/O。
- [ ] 7.10 新增 ListGovernanceHistory query 和 GovernanceHistoryPage DTO；从 relation_history_events 读取显示快照，不把通用 operations 全量混入。
- [ ] 7.11 保留 GetRelationshipOverview/graph 的完整信息职责：provenance events 全量可见，governance ledger 只可管理本地关系。
- [ ] 7.12 更新 batch prepare 的前置分类，但本 Task 不执行来源清理；source clean/retain 暂返回明确 unsupported，供 Task 8 接通。
- [ ] 7.13 运行 cargo test -p skillhub-core --test relationship_governance_batch 与 cargo test -p skillhub-application --test facade_relationship_governance。
- [ ] 7.14 运行 cargo fmt --all -- --check、相关 clippy、git diff --check，提交：git commit -m "project unified governance ledger"。

## Task 8: Make source-copy retain/cleanup/batch/history use the existing safe migration chain

**Files:**

- Modify: crates/skillhub-core/src/import/migration.rs
- Modify: crates/skillhub-core/src/api/command.rs:216-380
- Modify: crates/skillhub-application/src/lib.rs:7524-7815
- Modify: crates/skillhub-application/src/relationship_governance_batch.rs
- Modify: crates/skillhub-storage/src/database/provenance_repository.rs
- Modify: crates/skillhub-storage/src/database/relationship_repository.rs
- Modify: crates/skillhub-storage/src/database/governance_history_repository.rs
- Test: crates/skillhub-core/tests/source_copy_governance.rs
- Test: crates/skillhub-application/tests/facade_observed_deployments.rs
- Test: crates/skillhub-application/tests/facade_relationship_governance.rs
- Test: crates/skillhub-application/tests/facade_operation_journal.rs

**Consumes:** Tasks 5、7。

**Produces:** 精确 relation-level retain/cleanup/rollback，来源批处理，历史记录和“部署到此 Agent”上下文。

- [ ] 8.1 将现有 original migration 测试复制为多来源场景红灯：同一 Skill 两条来源只清理指定 relation，另一条不受影响。
- [ ] 8.2 写阻断红灯：内容变化、链接、junction、权限受限、managed occupied、revision/physical identity 变化均不得备份或删除。
- [ ] 8.3 写清理成功红灯：先备份、再写 migration audit、再删目录、归档 source relation、写 CleanedBySkillHub history；集中库 Skill 保留。
- [ ] 8.4 写删除失败/备份失败红灯：原目录保留；relation health=OperationFailed；历史标 Failed；可重试且不伪报成功。
- [ ] 8.5 写 KeepSourceCopy 红灯：只把 decision 改为 Retained 并记录历史，不读写来源目录。
- [ ] 8.6 写 rollback 红灯：原路径存在时拒绝覆盖；恢复成功后 Full 校验并重新投影活动关系，历史追加 RolledBack，不简单复活旧 UI 行。
- [ ] 8.7 写重新关联红灯：ExternalRemoved 关系由用户选择新目录后，只有完整校验确认 Skill 身份/内容且新 physical_source_id 无冲突时才建立新活动关系；不得按名称自动猜测。
- [ ] 8.8 写 batch 红灯：同为 source_copy + 同动作才允许；逐项 prepare/确认；取消/失败不影响其余项；父 operation 关联子 operation。
- [ ] 8.9 运行定向测试确认失败。
- [ ] 8.10 将 PrepareOriginalMigration 请求从 skill_id 改为 source_relation_id；OriginalMigrationPlan/Result 携带 relation id、agent/client display context 和 relationship_revision。
- [ ] 8.11 collect_migration_facts 只从活动 SourceCopyRelationFact 取得路径/期望指纹，并调用 Task 5 Full probe；删除旧 provenance_for_skill 单行查找。
- [ ] 8.12 backup root 改为 .skillhub/original-migrations/<source_relation_id-safe-key>/<operation_id>；safe-key 必须经过内部编码，不能把任意 relation 字符串直接当路径。
- [ ] 8.13 在成功 transaction 中关联 original_migrations.source_relation_id、归档关系、写历史并 bump revision；文件删除失败时保留备份并补偿 DB 状态。
- [ ] 8.14 新增 RetainSourceCopy 与 RelinkSourceCopy command；重新关联使用目录 picker 授权后的规范化路径，并始终创建新关系/历史事件，不改写旧 provenance event。
- [ ] 8.15 扩展 RelationGovernanceBatchAction 为 RetainSourceCopy/CleanSourceCopy，并按 action dispatch 既有单条安全链路。
- [ ] 8.16 扩展 deployment governance history hooks：Undeploy、DetachKeepFiles、关系迁移 rollback/failed 写 relation lifecycle event，但 operation journal 仍是执行详情来源。
- [ ] 8.17 清理成功结果返回 follow_up_deployment_target_id（仅 AgentLocal 且目标仍登记时）；它只用于打开部署选择，不自动部署。
- [ ] 8.18 运行 cargo test -p skillhub-core --test source_copy_governance 及上述 application 测试。
- [ ] 8.19 运行 cargo fmt --all -- --check、相关 clippy、git diff --check，提交：git commit -m "govern source copies safely"。

## Task 9: Finalize typed desktop commands, regenerate bindings, and add frontend-native facades

**Files:**

- Modify: crates/skillhub-core/src/api/mod.rs
- Modify: crates/skillhub-core/src/api/command.rs
- Modify: crates/skillhub-core/src/api/query.rs
- Modify: apps/desktop/src-tauri/src/lib.rs:86-120, 395-end
- Generate: apps/desktop/src/api/bindings.ts
- Modify: apps/desktop/src/features/import/api.ts:46-170
- Modify: apps/desktop/src/features/import/nativeApi.ts:190-445
- Modify: apps/desktop/src/features/relationships/governance/api.ts:1-199
- Modify: apps/desktop/src/features/relationships/governance/nativeApi.ts:1-118
- Modify: apps/desktop/src/features/relationships/api.ts
- Modify: apps/desktop/src/features/relationships/nativeApi.ts
- Test: apps/desktop/src/features/import/nativeApi.test.ts
- Test: apps/desktop/src/features/relationships/nativeApi.test.ts
- Test: apps/desktop/src/features/relationships/api.test.ts

**Consumes:** Tasks 4—8 stable Rust contracts。

**Produces:** 生成后的 TypeScript 类型和无业务猜测的 native facades；不改页面布局。

- [ ] 9.1 在 Tauri binding generation test 注册所有新增 event、source copy、history、check、batch command/query 类型。
- [ ] 9.2 运行 $env:SKILLHUB_WRITE_BINDINGS='1'; cargo test -p skillhub-desktop generate_bindings，确认 bindings 只反映预期契约。
- [ ] 9.3 在 import nativeApi 测试写红灯：一次 commitImport 只创建一个 batch；每项 commit 复用 batch_id；结果带 governanceContext；online-only count=0。
- [ ] 9.4 在 relationships nativeApi 测试写红灯：listGovernance 透传 scope/status/batch filters；revalidate 调 RunRelationshipCheck 而非再次 query；history 使用独立 query。
- [ ] 9.5 在 governance api 测试写红灯：URL 支持 from=import、scope=source_copy、status=needs_attention、batch；未知值 fail-safe 回退。
- [ ] 9.6 运行三个前端测试文件确认失败。
- [ ] 9.7 更新 ImportFacade：beginBatch/finalizeBatch 在 nativeApi 内部编排，ImportResult 暴露 batchContext/skillId/sourceRelationId，不暴露缓存路径。
- [ ] 9.8 更新 RelationGovernanceFacade：listHistory、revalidate、retain/clean/relink source copy、prepare/commit/rollback source batch；所有 command 返回结构化错误。
- [ ] 9.9 删除前端通过 relation_id 前缀判断 scope 的逻辑；scope/action 只能读生成 DTO。
- [ ] 9.10 更新 mock fixtures，覆盖 AgentLocal、UserLocal、Online、Retained、NeedsValidation 和 ExternalRemoved history。
- [ ] 9.11 运行 pnpm --filter @skillhub/desktop test -- import/nativeApi relationships/nativeApi relationships/api。
- [ ] 9.12 运行 pnpm check:frontend、cargo test -p skillhub-desktop、git diff --check，提交：git commit -m "expose source governance contracts"。

## Task 10: Update import completion UX and restore the exact “this import” governance context

**Required skills before editing:** frontend-design, vercel-react-best-practices；测试失败时 systematic-debugging。

**Files:**

- Modify: apps/desktop/src/features/import/ImportSummary.tsx:10-135
- Modify: apps/desktop/src/features/import/ImportSummary.test.tsx
- Modify: apps/desktop/src/features/import/ImportWizard.tsx:389-404, 1297-1304
- Modify: apps/desktop/src/features/import/ImportWizard.test.tsx
- Modify: apps/desktop/src/features/import/api.ts:87-107
- Modify: apps/desktop/src/app/DiscoveryRoute.tsx:83-114
- Modify: apps/desktop/src/app/DiscoveryRoute.test.tsx
- Modify: apps/desktop/src/i18n/zh-CN/common.json
- Modify: apps/desktop/src/i18n/en-US/common.json
- Modify: apps/desktop/src/features/import/import.css

**Consumes:** Task 9 ImportResult.batchContext。

**Produces:** 失败优先/来源整理/在线来源三种结果按钮组合，稳定 batch 深链；不执行清理。

- [ ] 10.1 完整读取 frontend-design 与 vercel-react-best-practices，并把与本 Task 相关的布局、层级、状态和 React 约束写入本 Task 工作笔记后再编辑。
- [ ] 10.2 在 ImportSummary.test.tsx 写红灯：有失败时主按钮“重试失败项”，来源整理为次按钮；全成功且有来源关系时主按钮“整理来源副本”；online-only 不显示整理入口。
- [ ] 10.3 写文案红灯：结果页说明集中管理的收益、删除后 Agent 不再从原入口使用、后续可从集中库选择 Agent 和链接/复制；不得承诺一定提升准确率。
- [ ] 10.4 在 ImportWizard.test.tsx 写深链红灯：点击整理生成 /relationships/governance?from=import&scope=source_copy&status=needs_attention&batch=<encoded>，但页面文本不显示 batch id。
- [ ] 10.5 写“稍后处理”红灯：结束向导且不调用 retain/cleanup，不改变 Pending。
- [ ] 10.6 运行相关 Vitest 确认失败。
- [ ] 10.7 修改 ImportSummary 只根据后端 manageableSourceCount 和失败数选 CTA；删除 originalsPreserved 作为治理资格判断。
- [ ] 10.8 将 provenance 展示改为多来源安全摘要：Agent 用 AgentPresentation，普通目录用“本地目录”，Online 用服务/仓库地址，绝不显示缓存路径。
- [ ] 10.9 DiscoveryRoute 使用 batchContext 构造治理深链；保留“查看已导入 Skill”和完成/返回入口。
- [ ] 10.10 按多步流程约束保持结果为独立步骤首屏；窄屏按钮顺序与桌面语义一致。
- [ ] 10.11 更新中英文同构键，并运行 node scripts/i18n-cjk-audit.mjs。
- [ ] 10.12 运行 pnpm --filter @skillhub/desktop test -- ImportSummary ImportWizard DiscoveryRoute、pnpm check:frontend、git diff --check。
- [ ] 10.13 提交：git commit -m "guide import source cleanup"。

## Task 11: Redesign current relationship governance for source copies and deployment relations

**Required skills before editing:** frontend-design, vercel-react-best-practices；测试失败时 systematic-debugging。

**Files:**

- Modify: apps/desktop/src/features/relationships/governance/RelationshipGovernancePage.tsx
- Modify: apps/desktop/src/features/relationships/governance/RelationshipGovernancePage.test.tsx
- Modify: apps/desktop/src/features/relationships/governance/GovernanceRelationTable.tsx
- Modify: apps/desktop/src/features/relationships/governance/GovernanceBatchDialog.tsx
- Modify: apps/desktop/src/features/relationships/governance/GovernanceImpactPreview.tsx
- Create: apps/desktop/src/features/relationships/governance/SourceCopyImpactPreview.tsx
- Create: apps/desktop/src/features/relationships/governance/SourceCleanupResult.tsx
- Create: apps/desktop/src/features/relationships/useRelationshipContextCheck.ts
- Create: apps/desktop/src/features/relationships/useRelationshipContextCheck.test.tsx
- Modify: apps/desktop/src/features/relationships/governance/governance.css
- Modify: apps/desktop/src/features/relationships/returnState.ts
- Modify: apps/desktop/src/i18n/zh-CN/common.json
- Modify: apps/desktop/src/i18n/en-US/common.json

**Consumes:** Task 9 governance facade。

**Produces:** “全部可管理关系”主页面、来源清理/保留/真实校验、同类批处理和清理后部署入口。

- [ ] 11.1 加载两项前端 skills，先画出桌面表格与窄屏卡片的信息层级，确认共同字段顺序一致，再开始测试。
- [ ] 11.2 在 RelationshipGovernancePage.test.tsx 写红灯：侧边栏进入默认 All；导入深链自动设 source_copy + needs_attention + batch，并显示“本次导入留下 N 个本地来源副本”。
- [ ] 11.3 写五个快捷状态和 scope 筛选红灯；URL 保存已提交筛选，浏览器前进/后退可恢复。
- [ ] 11.4 写行展示红灯：来源副本和部署使用同一字段顺序；Agent 使用 AgentPresentation；路径经 displayPath；技术 ID 仅 details。
- [ ] 11.5 写真实 revalidate 红灯：按钮调用 facade.revalidate 后再 invalidate ledger；显示逐项进度/结果；不允许仅 refetch。
- [ ] 11.6 写上下文检查 hook 红灯：先渲染持久化 ledger，再异步执行当前 scope 的 Light check；同一会话同一 scope 只自动检查一次，用户主动校验不受此限制。
- [ ] 11.7 写来源操作红灯：Pending 可清理/保留；Retained 可改为清理；NeedsValidation 先校验；Blocked 展示具体原因但不提供危险提交。
- [ ] 11.8 写清理影响预览红灯：明确删除 Agent/类型/路径、原入口停止使用、集中库不受影响、后续重新部署、备份/回滚和阻断原因；必须勾选所有权确认。
- [ ] 11.9 写清理结果红灯：AgentLocal 成功显示“部署到此 Agent”主入口和“稍后部署/完成”；点击只打开目标已预选的部署页，不自动提交。
- [ ] 11.10 写批处理红灯：source/deployment 不能混选；动作不一致不能同批；blocked 项与 executable 项分组；取消单项不影响其余项。
- [ ] 11.11 运行相关 Vitest 确认失败。
- [ ] 11.12 将页面标题和说明改为“全部可管理关系”，并明确在线来源/完整拓扑去技能图谱查看。
- [ ] 11.13 重构 GovernanceRelationTable 读取统一 row DTO，不再访问 row.relation.deployment 内部形状；表格/卡片共用一个 field projection。
- [ ] 11.14 接入 retain、clean prepare/commit/rollback 和 deployment actions；全部异步写操作走 runTrackedOperation 并关联后端 operation id。
- [ ] 11.15 GovernanceBatchDialog 只接受同 scope + 同 action selection；每项显示执行/受阻/取消/失败/回滚结果。
- [ ] 11.16 清理失败保留当前行并展示 Revalidate/Retry/Restore；成功后按返回 revision 刷新，不本地假删。
- [ ] 11.17 更新 returnState 保存筛选、选中行和滚动位置；跨来源返回不串状态。
- [ ] 11.18 更新中英文同构文案并运行 CJK audit。
- [ ] 11.19 运行 pnpm --filter @skillhub/desktop test -- RelationshipGovernancePage GovernanceRelationTable GovernanceBatchDialog useRelationshipContextCheck、pnpm check:frontend、git diff --check。
- [ ] 11.20 提交：git commit -m "manage source copies in governance"。

## Task 12: Add governance history and align graph/detail/overview entry points

**Required skills before editing:** frontend-design, vercel-react-best-practices；测试失败时 systematic-debugging。

**Files:**

- Create: apps/desktop/src/features/relationships/governance/GovernanceHistoryPage.tsx
- Create: apps/desktop/src/features/relationships/governance/GovernanceHistoryPage.test.tsx
- Create: apps/desktop/src/features/relationships/governance/GovernanceHistoryTable.tsx
- Modify: apps/desktop/src/features/relationships/governance/governance.css
- Modify: apps/desktop/src/features/relationships/RelationshipsPages.tsx
- Modify: apps/desktop/src/features/relationships/RelationshipsLayout.tsx
- Modify: apps/desktop/src/app/router.tsx:279-323
- Modify: apps/desktop/src/app/router.test.tsx
- Modify: apps/desktop/src/app/AppShell.test.tsx
- Modify: apps/desktop/src/features/relationships/graph/graphProjection.ts
- Modify: apps/desktop/src/features/relationships/graph/graphProjection.test.ts
- Modify: apps/desktop/src/features/relationships/graph/GraphDetailsPanel.tsx
- Modify: apps/desktop/src/features/relationships/graph/GraphDetailsPanel.test.tsx
- Modify: apps/desktop/src/features/skill-detail/RelationsPanel.tsx
- Modify: apps/desktop/src/features/skill-detail/RelationsPanel.test.tsx
- Modify: apps/desktop/src/features/skill-detail/SkillDetailPage.tsx
- Modify: apps/desktop/src/features/agents/AgentDetailPage.tsx
- Modify: apps/desktop/src/features/agents/AgentDetailPage.test.tsx
- Modify: apps/desktop/src/features/projects/ProjectDetailPage.tsx
- Modify: apps/desktop/src/features/projects/ProjectDetailPage.test.tsx
- Modify: apps/desktop/src/features/overview/OverviewPage.tsx
- Modify: apps/desktop/src/features/overview/OverviewPage.test.tsx
- Modify: apps/desktop/src/i18n/zh-CN/common.json
- Modify: apps/desktop/src/i18n/en-US/common.json

**Consumes:** Task 9 history/query facade，Task 11 current governance UI。

**Produces:** 独立历史路由；图谱/详情/概览只对可管理关系提供治理深链。

- [ ] 12.1 加载两项前端 skills，确认历史是独立页面而非主表折叠区。
- [ ] 12.2 在 router.test.tsx 写红灯：注册 /relationships/governance/history；返回锚点为 /relationships/governance；页面各自只有一个 h1。
- [ ] 12.3 在 GovernanceHistoryPage.test.tsx 写红灯：按时间倒序显示关系范围、动作、结果、对象、原/目标路径、备份、回滚和失败原因；ExternalRemoved 文案不得冒充 SkillHub 清理。
- [ ] 12.4 写恢复入口红灯：只有 rollback_available 才显示；执行后重新查询真实 current ledger 和 history。
- [ ] 12.5 在 graphProjection.test.ts 写红灯：Online provenance 显示用户可读 URL/仓库节点且无治理按钮；SourceCopy/Deployment 边有精确 relation 深链。
- [ ] 12.6 在 RelationsPanel/Overview 测试写红灯：Skill 详情来源信息可列多条 provenance；概览“待治理”只计 Pending/需处理可管理关系并深链正确筛选。
- [ ] 12.7 在 SkillDetailPage、AgentDetailPage、ProjectDetailPage 测试写红灯：先显示持久化关系，再复用 useRelationshipContextCheck 对当前对象执行一次 Light check；离开再返回同 scope 不重复自动检查。
- [ ] 12.8 写历史重新关联红灯：ExternalRemoved 且无可用备份时可选择新目录；只有后端 RelinkSourceCopy 成功后才出现新的 current relation。
- [ ] 12.9 运行上述测试确认失败。
- [ ] 12.10 新建 GovernanceHistoryPage/Table，右上与主治理页互相跳转；路径和技术详情遵循全局展示约束。
- [ ] 12.11 更新 graph projection 同时消费 provenance events 和 current source copies；同一在线来源节点按业务 locator 合并，不按 cache path。
- [ ] 12.12 GraphDetailsPanel 只有 manageability=true 且 relation_id 存在时显示治理入口；否则只提供来源详情。
- [ ] 12.13 Skill detail 展示所有不可变来源事件的用户摘要，治理动作仍深链 current relation，不在详情页复制清理流程。
- [ ] 12.14 Agent/Project/Skill 关系视图挂载同一上下文检查 hook；检查状态只用于避免会话内重复请求，不作为持久化事实。
- [ ] 12.15 历史页复用现有目录 picker 取得受控路径 grant，再调用 RelinkSourceCopy；不得把手输任意路径直接交给后端。
- [ ] 12.16 Overview 读取统一 ledger counts 或 bootstrap 新字段，不在前端重算关系状态。
- [ ] 12.17 更新双语键、CJK audit、路由/页面测试与 pnpm check:frontend。
- [ ] 12.18 运行 git diff --check，提交：git commit -m "add relationship governance history"。

## Task 13: Add backend Skill × target deployment preview, fallback reasons, and confirmation fingerprints

**Files:**

- Modify: crates/skillhub-core/src/deployment/model.rs:13-60, 296-484
- Modify: crates/skillhub-core/src/deployment/planner.rs:23-128, 188-240
- Modify: crates/skillhub-core/src/api/query.rs:407-439
- Modify: crates/skillhub-core/src/api/command.rs:395-405
- Modify: crates/skillhub-application/src/lib.rs:6084-6305
- Modify: crates/skillhub-core/src/error.rs:8-124
- Test: crates/skillhub-core/tests/deployment_planner.rs
- Test: crates/skillhub-application/tests/facade_deployment_accounting.rs
- Test: crates/skillhub-application/tests/facade.rs

**Consumes:** 现有 verified targets、DeploymentPlanner、prepare/commit/revalidate。

**Produces:** 后端逐 pair preview，Auto/Link/Copy 用户偏好，可理解 blocker reason，确认指纹；最终执行仍复用 DeploymentPlan。

- [ ] 13.1 在 deployment_planner.rs 测试先覆盖以下公开类型：

        pub enum DeploymentPreference { Automatic, Link, Copy }

        pub enum DeploymentPreviewDisposition {
            SelectedMode,
            RecommendCopy,
            NoChange,
            Blocked,
        }

        pub enum DeploymentBlockReason {
            LinkPermissionUnavailable,
            LinkFilesystemUnsupported,
            TargetOccupied,
            PathUnavailable,
            SharedImpactRequiresResolution,
            CopyUnavailable,
        }

- [ ] 13.2 写红灯：Automatic 对每个 physical target 独立选择最佳安全 mode；不同 target 可有不同 mode。
- [ ] 13.3 写红灯：明确 Link 时，链接不可用且 copy 可用返回 RecommendCopy，不返回自动 ManagedCopy plan；copy 也不可用返回 Blocked。
- [ ] 13.4 写红灯：现有同 Skill/版本/mode 为 NoChange；名称占用、未知 ownership、路径不可达和共享影响分别返回结构化 reason。
- [ ] 13.5 写 confirmation fingerprint 红灯：skill/version/physical target/preference/reason/change/destination/relationship revision 任一变化都会失效。
- [ ] 13.6 在 application 测试写红灯：多 Skill × 多 target 预览逐项返回，单项错误不吞掉同 Skill 其他 target；共享物理 target 仍去重。
- [ ] 13.7 写确认复制红灯：请求携带匹配 fingerprint 后重新规划为最终 ManagedCopy；过期 fingerprint 仍为 RecommendCopy/TargetChanged。
- [ ] 13.8 写提交红灯：只接收 preview 标为 SelectedMode 且最新 revalidate 仍匹配的 TargetPlan；Blocked/未确认 RecommendCopy 不进入 prepare。
- [ ] 13.9 运行 deployment planner 和 application 定向测试确认失败。
- [ ] 13.10 新增 DeploymentPairPreview / DeploymentBatchPreview / GetDeploymentBatchPreview；pair_id 是稳定内部键，不用 display name。
- [ ] 13.11 将现有 planner 的每个 physical target 逻辑抽成 plan_target_preview；最终 DeploymentPlan 仅由 SelectedMode/confirmed copy/no-op 项组装。
- [ ] 13.12 在 application 层解析每个 Skill 的 current version/runtime name、目标事实和 relationship revision；按项捕获 AppError 并映射到 DeploymentBlockReason。
- [ ] 13.13 ErrorCode 增量只用于确有稳定语义的权限/文件系统错误；原始 OS detail 保留在技术参数，用户 reason 不依赖字符串匹配。
- [ ] 13.14 保留 DeploymentService.commit 的 backend.revalidate 门禁；重新规划后目标事实变化必须拒绝，不执行旧 preview。
- [ ] 13.15 运行 cargo test -p skillhub-core --test deployment_planner、cargo test -p skillhub-application --test facade_deployment_accounting --test facade。
- [ ] 13.16 重新生成 bindings，运行 cargo fmt、相关 clippy、git diff --check，提交：git commit -m "preview deployment per target"。

## Task 14: Implement single and categorized batch deployment confirmation UX

**Required skills before editing:** frontend-design, vercel-react-best-practices；测试失败时 systematic-debugging。

**Files:**

- Modify: apps/desktop/src/features/deployment/api.ts:8-146
- Modify: apps/desktop/src/features/deployment/nativeApi.ts:111-293
- Modify: apps/desktop/src/features/deployment/nativeApi.test.ts
- Modify: apps/desktop/src/features/deployment/DeploymentDialog.tsx
- Modify: apps/desktop/src/features/deployment/DeploymentDialog.test.tsx
- Modify: apps/desktop/src/features/deployment/BatchDeploymentPage.tsx:48-390
- Modify: apps/desktop/src/features/deployment/BatchDeploymentPage.test.tsx
- Modify: apps/desktop/src/features/deployment/DeploymentImpactCard.tsx
- Create: apps/desktop/src/features/deployment/DeploymentDispositionGroup.tsx
- Modify: apps/desktop/src/features/deployment/deployment.css
- Modify: apps/desktop/src/i18n/zh-CN/common.json
- Modify: apps/desktop/src/i18n/en-US/common.json

**Consumes:** Task 13 generated DeploymentBatchPreview。

**Produces:** 自动/链接/复制三种用户偏好，单项 fallback 确认，批量按 disposition/reason 分类确认和非原子提交。

- [ ] 14.1 加载两项前端 skills，先确定四类预览与最终五类汇总的视觉层级、展开规则和键盘交互。
- [ ] 14.2 在 api/nativeApi 测试写红灯：preview 直接返回 pair items，不再按 Skill 将任一失败折叠为 failures；commit 只组装 confirmed executable pairs。
- [ ] 14.3 在 DeploymentDialog.test.tsx 写红灯：明确 Link 被阻止时显示用户可理解原因和“改用复制部署”；未确认前提交禁用；确认后重新预览再显示最终 copy 影响。
- [ ] 14.4 写五类原因文案红灯：权限、文件系统/磁盘、目标占用、路径不可访问、共享影响；原始 code/path identity 只进 details。
- [ ] 14.5 在 BatchDeploymentPage.test.tsx 写红灯：四组“按所选方式执行 / 建议改用复制 / 无需变更 / 无法执行”按 pair 数量分类。
- [ ] 14.6 写分组确认红灯：“本组全部改用复制”只确认相同 reason 的项；展开后取消个别 pair；确认保存在 pair fingerprint 上。
- [ ] 14.7 写重新预览红灯：fingerprint 未变的确认保留；目标/方式/reason/影响变化的确认失效并重新要求用户处理。
- [ ] 14.8 写最终汇总红灯：链接、复制、无需变更、已排除、仍受阻分别计数；仍受阻不提交，其余可执行项继续。
- [ ] 14.9 写部分提交结果红灯：进度按 pair 或实际后端 operation 推进；成功/失败/跳过不按 Skill 去重掩盖目标结果；部署完成不推荐治理。
- [ ] 14.10 运行 deployment 相关 Vitest 确认失败。
- [ ] 14.11 将 UI DeploymentMode selector 替换为 DeploymentPreference；具体 symbolic_link/directory_junction 只在技术详情展示。
- [ ] 14.12 nativeApi 一次调用 GetDeploymentBatchPreview，传 confirmations/exclusions；不再 Promise.all 每 Skill 的整计划查询。
- [ ] 14.13 新建 DeploymentDispositionGroup，提供原因组全选、逐项取消、目标/Skill 用户名称和影响摘要；不显示 pair_id。
- [ ] 14.14 单项和批量页都以“重新生成最终预览”作为 fallback 确认后的下一步，不把确认按钮直接绑定 commit。
- [ ] 14.15 commit 将 final selected pair 按 Skill/版本组装 DeploymentPlan，逐 Skill 复用现有 prepare/commit；blocked/excluded 作为 skipped 结果留痕。
- [ ] 14.16 保持 multi-step 每步独立呈现；重新预览后滚动到预览首部并把焦点移到新标题。
- [ ] 14.17 更新双语键，运行 CJK audit、deployment Vitest、pnpm check:frontend、pnpm build:frontend。
- [ ] 14.18 运行 git diff --check，提交：git commit -m "confirm deployment fallback per target"。

## Task 15: Complete cross-layer regression, E2E flows, and current development handoff

**Required skills before editing/testing:** playwright-cli；E2E 或集成失败时 systematic-debugging。若本 Task 仍需改 React，先加载 frontend-design 与 vercel-react-best-practices。

**Files:**

- Modify: tests/e2e/import-flow.spec.ts
- Modify: tests/e2e/import-governance.spec.ts
- Modify: tests/e2e/import-deploy.spec.ts
- Modify: tests/e2e/workflow-deployment.spec.ts
- Modify: tests/e2e/relationship-views.spec.ts
- Modify: tests/e2e/workflow-operations.spec.ts
- Update/archive: docs/development/开发状态-2026-09-18.md
- Update/archive: docs/development/自动化测试说明-2026-09-18.md
- Update/archive: docs/development/人工验收清单-2026-09-18.md
- Update/archive: docs/development/功能完成度与验收状态矩阵-2026-09-18.md
- Create: docs/development/开发状态-2026-09-24.md
- Create: docs/development/自动化测试说明-2026-09-24.md
- Create: docs/development/人工验收清单-2026-09-24.md
- Create: docs/development/功能完成度与验收状态矩阵-2026-09-24.md

**Consumes:** Tasks 10—14 完整集成态。

**Produces:** 自动化回归证据、按完整用户流程编排的人工验收入口、真实未解决风险。

- [ ] 15.1 完整加载 playwright-cli；先运行现有相关 E2E 建立基线，不在失败时直接改断言。
- [ ] 15.2 扩展 import-flow：AgentLocal/UserLocal 导入产生整理 CTA；Online 导入无 CTA；ReuseExisting 指向已有 Skill；Skip/失败无来源关系。
- [ ] 15.3 扩展 import-governance：本次导入深链只显示对应 Pending 来源；保留后仍可查；清理预览包含完整影响；成功后显示部署入口。
- [ ] 15.4 增加路径缺失/内容变化/权限模拟：缺失进入 ExternalRemoved 历史；内容变化/权限异常保留当前关系且清理受阻。
- [ ] 15.5 扩展 relationship-views：侧边栏默认全部可管理关系；历史独立；在线来源只在图谱/详情；只有可管理边有治理深链。
- [ ] 15.6 扩展 workflow-deployment：明确链接受阻不静默降级；确认 copy 后必须二次预览；批量按原因组确认并排除个别 pair；blocked 不拖住其余项。
- [ ] 15.7 扩展 workflow-operations：导入、关系校验、来源清理、部署的状态栏/通知/operation 深链一致；ExternalRemoved 不伪造用户 operation。
- [ ] 15.8 运行 pnpm test:e2e；失败时保存 Playwright trace/screenshot 到测试产物目录，不把产物提交到仓库。
- [ ] 15.9 运行完整 Rust 验证：

        cargo fmt --all -- --check
        cargo clippy --workspace --all-targets -- -D warnings
        cargo test --workspace

- [ ] 15.10 运行完整前端验证：

        pnpm test:frontend
        pnpm check:frontend
        pnpm build:frontend
        node scripts/i18n-cjk-audit.mjs
        pnpm test:e2e

- [ ] 15.11 运行 pnpm ci:local；若与前述命令重复，仍记录最终一次结果和耗时，不省略失败项。
- [ ] 15.12 用真实 Windows 环境人工验证目录联接/符号链接权限、Agent 来源清理、缺失路径和部署 fallback；用真实 macOS 环境验证 symlink、路径身份和权限。没有证据时状态保持“待验收”。
- [ ] 15.13 将 2026-09-18 四份当前文档吸收后移入 docs/development/archive/2026-09-24-import-deployment-relationship-governance/，不得删除历史证据。
- [ ] 15.14 创建四份 2026-09-24 当前文档：开发状态写分支/基线/完成与仍需；自动化说明写命令/结果/边界；人工清单按完整操作链路合并 DEV 项；矩阵汇总自动化与 Windows/macOS 实测状态。
- [ ] 15.15 检索 docs/development 全部当前入口，确认只保留四份 2026-09-24 文件，引用不再指向旧当前快照。
- [ ] 15.16 运行 git diff --check、git status --short，确认 debug.log 等用户文件未纳入提交。
- [ ] 15.17 提交：git commit -m "verify import deployment governance flow"。

## Final Self-Review Checklist

- [ ] 每个设计验证点都至少对应一个 core/application/frontend/E2E 测试，且不存在未决占位符或“视情况实现”。
- [ ] 所有公开 Rust 枚举与生成 TypeScript union 值一致；不存在手写重复 binding。
- [ ] provenance event、source copy relation、deployment relation、operation journal、relation history 五类身份没有互相复用主键。
- [ ] source copy 的 decision 与 health 分开存储；“已保留但内容变化”可以如实表达。
- [ ] Online/OnlineCache/项目/集中库来源只有来源信息，没有清理按钮、治理行或缓存路径泄漏。
- [ ] ReuseExisting 始终追加来源事件；同一 physical source 不重复当前行，也不同时指向多个 Skill。
- [ ] 启动轻检、上下文检查、主动校验、写后定向检查、提交前强校验、watch hint 确认各有测试，且没有固定周期全量扫描。
- [ ] ExternalRemoved 与 CleanedBySkillHub 在历史中明确区分，归档与历史写入同事务。
- [ ] 清理操作解释为什么建议集中管理、删除影响、后续如何部署；成功后部署入口仍需重新选择方式并确认。
- [ ] 来源和部署关系无法混合批处理；所有批次均保留逐项结果与非原子事实。
- [ ] 明确 Link 受阻时没有任何静默 copy；用户确认 copy 后必须重新预览，过期 fingerprint 不可提交。
- [ ] 批量部署按 Skill × target 分类，无法执行/未确认项不提交，其余项可继续。
- [ ] 页面主文案不出现 SkillId、UUID、operation id、内容哈希、pair id 或临时缓存路径。
- [ ] Agent logo/type、路径归并、多步独立呈现、抽屉/详情一致性和只读调用方式约束均未回归。
- [ ] 自动化记录与真实桌面验收记录严格分离；没有把未执行的平台验收标记通过。

## Execution Handoff

计划获人工确认后，推荐在当前会话使用 superpowers:subagent-driven-development 按 Task 顺序执行：每个 Task 使用独立实现代理并经过规格审查、代码质量审查和主线验证后再进入下一 Task。若不使用子代理，则使用 superpowers:executing-plans 串行执行同一清单。无论选择哪种方式，Task 1 开始前都先确认当前分支、工作区状态和设计提交 8e5abc20，且不得把未跟踪 debug.log 纳入任何提交。
