//! OPT-20260914-08 验收回归：已部署 Skill 识别、导入集中库与部署关系。
//!
//! 通过公开 Facade 驱动，全部使用临时目录，绝不触碰真实用户文件。覆盖：
//! - 导入即存证（来源/Agent 形态/原始路径/导入时间/指纹/所有权）与自动建档；
//! - 来源不明标注不猜（无 Agent 目录归属 → client_id 缺省、不建档）；
//! - 扫描识别 → 分叉标注 → 收回 → 重新激活的已观察关系生命周期；
//! - 原始文件迁移的确认门槛（未确认拒绝且不触碰用户文件）、失败中止
//!   （冲突/无存证）与备份回滚；
//! - 重复导入幂等或明确冲突，重复扫描不重复建档。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    agent::{
        ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
        LogicalTarget, OperatingSystem, PhysicalTarget, TargetScope,
    },
    api::{
        CommitImport, CommitOriginalMigration, CreateSkill, GetSkillProvenance, PrepareImport,
        PrepareOriginalMigration, RollbackOriginalMigration, RunInitializationScan,
    },
    import::{CandidateOwnership, ImportAction, ImportCandidate, ImportDecision},
    source::{SourceDescriptor, SourceKind, SourceLocator},
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ObservedMatchState,
    ObservedOrigin, ObservedStatus, OriginalMigrationConflictReason, OriginalMigrationState,
    SkillId,
};
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_ID: &str = "trae.code";
const BODY_V1: &str = "# Notes\n\nshared body\n";
const BODY_V2: &str = "# Notes rewritten\n";

fn register_agent_target(database: &Database, root: &std::path::Path) {
    let physical_id = skillhub_core::physical_id_for_path(root).expect("physical id");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-09-15T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: "trae-cn".into(),
                client_id: CLIENT_ID.into(),
                kind: ClientKind::IdeExtension,
                display_name: "Trae CN".into(),
                supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: vec![LogicalTarget {
                id: "target-1".into(),
                profile_id: "trae-cn".into(),
                client_id: CLIENT_ID.into(),
                scope: TargetScope::Global,
                path: root.to_string_lossy().into_owned(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: physical_id.clone(),
            }],
            physical_targets: vec![PhysicalTarget {
                id: physical_id,
                path: root.to_string_lossy().into_owned(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "unknown".into(),
                logical_target_ids: vec!["target-1".into()],
            }],
        })
        .expect("save discovery");
}

fn facade_with_agent(
    workspace: &std::path::Path,
    agent_root: &std::path::Path,
) -> LocalApplicationFacade {
    // 目标根必须真实存在：物理目录身份按真实路径计算，扫描也只接受
    // 真实目录根（沿用 scanner 的边界裁决）。
    std::fs::create_dir_all(agent_root).expect("agent root");
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    register_agent_target(&database, agent_root);
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, &library_root)
}

fn write_skill(root: &std::path::Path, body: &str) {
    std::fs::create_dir_all(root).expect("skill dir");
    std::fs::write(root.join("SKILL.md"), body).expect("write SKILL.md");
}

async fn prepare(
    facade: &LocalApplicationFacade,
    root: &std::path::Path,
    name: &str,
) -> Box<skillhub_core::PreparedImport> {
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root)),
        root.to_string_lossy(),
        ".",
        "SKILL.md",
        name,
    )
    .with_ownership(
        CandidateOwnership::KnownAgentTarget,
        ImportAction::Review,
        None,
    );
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    prepared
}

async fn commit_copy(
    facade: &LocalApplicationFacade,
    prepared: Box<skillhub_core::PreparedImport>,
) -> Box<skillhub_core::ImportSummary> {
    // 分组按分析结果跟随：关系明确的来源无分组，无需治理确认。
    let governance_decision = skillhub_core::ImportGovernanceDecision {
        group_actions: prepared
            .analysis
            .governance_groups
            .iter()
            .map(|group| (group.group_id.clone(), group.default_action))
            .collect(),
        item_overrides: Default::default(),
    };
    let committed = facade
        .execute(AppCommand::CommitImport(CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision,
            batch_id: None,
            candidate_key: None,
        }))
        .await
        .expect("commit import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary
}

async fn scan(facade: &LocalApplicationFacade) {
    let scanned = facade
        .execute(AppCommand::RunInitializationScan(RunInitializationScan {
            scope_ids: Vec::new(),
        }))
        .await
        .expect("scan");
    assert!(matches!(scanned, AppCommandResult::ScanResult(_)));
}

async fn provenance_of(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> skillhub_core::api::SkillProvenanceResult {
    let result = facade
        .query(AppQuery::GetSkillProvenance(GetSkillProvenance {
            skill_id,
        }))
        .await
        .expect("skill provenance");
    let AppQueryResult::SkillProvenance(result) = result else {
        panic!("expected skill provenance");
    };
    result
}

async fn find_skill_by_name(facade: &LocalApplicationFacade, name: &str) -> SkillId {
    let result = facade
        .query(AppQuery::ListSkills(skillhub_core::api::ListSkills {
            text: name.into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list skills");
    let AppQueryResult::SkillPage(page) = result else {
        panic!("expected skill list page");
    };
    page.items
        .into_iter()
        .find(|item| item.display_name == name)
        .expect("created skill in library")
        .skill_id
}

/// 计划 8A：迁移以来源关系为对象。导入提交即建立活动来源副本关系，
/// 测试按路径取出对应 relation_id。
async fn source_relation_id(facade: &LocalApplicationFacade, path: &std::path::Path) -> String {
    let database = facade.database_for_tests().clone();
    let database = database.lock().expect("database lock");
    database
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("source copy relations")
        .into_iter()
        .find(|relation| relation.source_path == path.to_string_lossy())
        .unwrap_or_else(|| panic!("source relation for {}", path.display()))
        .relation_id
}

fn assert_dir_intact(path: &std::path::Path, body: &str) {
    let content = std::fs::read_to_string(path.join("SKILL.md"))
        .expect("user file must still exist and be readable");
    assert_eq!(content, body, "user file content must be untouched");
}

#[tokio::test]
async fn import_records_complete_provenance_and_establishes_the_observed_deployment() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let source = agent_root.join("notes");
    write_skill(&source, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    let prepared = prepare(&facade, &source, "Notes").await;
    let summary = commit_copy(&facade, prepared).await;
    let skill_id = summary.items[0].skill_id.expect("skill in library");

    // 导入即存证：摘要携带完整溯源字段。
    let provenance = summary.items[0]
        .provenance
        .as_ref()
        .expect("commit must carry provenance");
    assert_eq!(provenance.skill_id, skill_id);
    assert_eq!(
        provenance.agent_client_id.as_deref(),
        Some(CLIENT_ID),
        "path inside a known agent directory must be attributed"
    );
    assert_eq!(provenance.original_path, source.to_string_lossy());
    assert_eq!(
        provenance.source,
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(&source))
    );
    assert_eq!(provenance.ownership, CandidateOwnership::KnownAgentTarget);
    assert!(
        !provenance.content_fingerprint.is_empty(),
        "fingerprint must be recorded"
    );
    assert!(provenance.imported_at > 0, "import time must be recorded");

    // 查询视图：溯源 + 已观察关系（导入自动建档，身份可靠）。
    let view = provenance_of(&facade, skill_id).await;
    assert_eq!(view.provenance.as_ref(), Some(provenance));
    assert_eq!(view.observed_deployments.len(), 1);
    let relation = &view.observed_deployments[0];
    assert_eq!(relation.skill_id, skill_id);
    assert_eq!(relation.client_id, CLIENT_ID);
    assert_eq!(relation.original_path, source.to_string_lossy());
    assert_eq!(relation.content_fingerprint, provenance.content_fingerprint);
    assert_eq!(relation.match_state, ObservedMatchState::ContentVerified);
    assert_eq!(relation.origin, ObservedOrigin::Import);
    assert_eq!(relation.status, ObservedStatus::Active);
    assert_eq!(relation.released_at, None);
}

#[tokio::test]
async fn import_outside_known_agent_directories_stays_unattributed_and_builds_no_relation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let source = workspace.path().join("downloads/notes");
    write_skill(&source, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    let prepared = prepare(&facade, &source, "Notes").await;
    let summary = commit_copy(&facade, prepared).await;
    let skill_id = summary.items[0].skill_id.expect("skill in library");

    // 来源不明：归属显式缺省（不猜），且不建立任何已观察关系。
    let provenance = summary.items[0]
        .provenance
        .as_ref()
        .expect("commit must carry provenance");
    assert_eq!(provenance.agent_client_id, None);
    let view = provenance_of(&facade, skill_id).await;
    assert!(view.observed_deployments.is_empty());

    // 非导入链路创建的 Skill：诚实缺省为"无存证、无关系"。
    write_skill(&workspace.path().join("handmade"), BODY_V1);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "HandMade".into(),
            source_path: workspace
                .path()
                .join("handmade")
                .to_string_lossy()
                .into_owned(),
        }))
        .await
        .expect("create skill");
    let view = provenance_of(&facade, find_skill_by_name(&facade, "HandMade").await).await;
    assert!(view.provenance.is_none());
    assert!(view.observed_deployments.is_empty());
}

#[tokio::test]
async fn scan_establishes_maintains_releases_and_reactivates_observed_relations() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let library_source = workspace.path().join("seed/notes");
    write_skill(&library_source, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    // 集中库先有这个 Skill（从 agent 目录之外导入，不产生关系）。
    let prepared = prepare(&facade, &library_source, "Notes").await;
    let summary = commit_copy(&facade, prepared).await;
    let skill_id = summary.items[0].skill_id.expect("skill in library");
    assert!(provenance_of(&facade, skill_id)
        .await
        .observed_deployments
        .is_empty());

    // Agent 目录出现内容完全相同的目录包 → 扫描识别为已部署（身份可靠）。
    let deployed = agent_root.join("notes");
    write_skill(&deployed, BODY_V1);
    scan(&facade).await;
    let view = provenance_of(&facade, skill_id).await;
    assert_eq!(view.observed_deployments.len(), 1);
    assert_eq!(view.observed_deployments[0].origin, ObservedOrigin::Scan);
    assert_eq!(
        view.observed_deployments[0].match_state,
        ObservedMatchState::ContentVerified
    );
    assert_eq!(view.observed_deployments[0].status, ObservedStatus::Active);
    assert_eq!(view.observed_deployments[0].client_id, CLIENT_ID);

    // 内容分叉 → 明确标注 Diverged，不冒充已验证关系。
    write_skill(&deployed, BODY_V2);
    scan(&facade).await;
    let view = provenance_of(&facade, skill_id).await;
    assert_eq!(view.observed_deployments.len(), 1);
    assert_eq!(
        view.observed_deployments[0].match_state,
        ObservedMatchState::Diverged
    );
    assert_eq!(view.observed_deployments[0].status, ObservedStatus::Active);

    // 路径不再被观察到（部署收回/目录移除）→ 关系收回。
    std::fs::remove_dir_all(&deployed).expect("remove deployed dir");
    scan(&facade).await;
    let view = provenance_of(&facade, skill_id).await;
    assert_eq!(view.observed_deployments.len(), 1);
    assert_eq!(
        view.observed_deployments[0].status,
        ObservedStatus::Released
    );
    assert!(view.observed_deployments[0].released_at.is_some());

    // 重新观察到一致内容 → 关系重新激活。
    write_skill(&deployed, BODY_V1);
    scan(&facade).await;
    let view = provenance_of(&facade, skill_id).await;
    assert_eq!(view.observed_deployments.len(), 1);
    assert_eq!(
        view.observed_deployments[0].match_state,
        ObservedMatchState::ContentVerified
    );
    assert_eq!(view.observed_deployments[0].status, ObservedStatus::Active);
    assert_eq!(view.observed_deployments[0].released_at, None);

    // 重复扫描不重复建档（幂等）。
    scan(&facade).await;
    assert_eq!(
        provenance_of(&facade, skill_id)
            .await
            .observed_deployments
            .len(),
        1
    );
}

#[tokio::test]
async fn repeated_import_is_an_explicit_conflict_and_keeps_provenance_history() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let first = agent_root.join("alpha");
    let second = agent_root.join("beta");
    write_skill(&first, BODY_V1);
    write_skill(&second, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    let prepared = prepare(&facade, &first, "Notes").await;
    let summary = commit_copy(&facade, prepared).await;
    let skill_id = summary.items[0].skill_id.expect("skill in library");

    // 相同内容的第二个目录：明确冲突，绝不静默处理。
    let reimport = prepare(&facade, &second, "Notes").await;
    assert_eq!(
        reimport.analysis.duplicate_kind,
        Some(skillhub_core::DuplicateKind::ExactContent)
    );

    // 复用确认不覆盖既有存证历史（原始路径保持第一次导入的事实）。
    let reused = facade
        .execute(AppCommand::CommitImport(CommitImport {
            prepared_import_id: reimport.id,
            decision: ImportDecision::ReuseExisting,
            governance_decision: skillhub_core::ImportGovernanceDecision {
                group_actions: reimport
                    .analysis
                    .governance_groups
                    .iter()
                    .map(|group| (group.group_id.clone(), group.default_action))
                    .collect(),
                item_overrides: Default::default(),
            },
            batch_id: None,
            candidate_key: None,
        }))
        .await
        .expect("reuse commit");
    let AppCommandResult::ImportSummary(reused) = reused else {
        panic!("expected import summary");
    };
    assert_eq!(reused.items[0].skill_id, Some(skill_id));
    assert!(reused.items[0].provenance.is_none());
    let view = provenance_of(&facade, skill_id).await;
    assert_eq!(
        view.provenance.expect("provenance kept").original_path,
        first.to_string_lossy()
    );

    // 扫描把第二个路径按观察事实单独建档（指纹一致、归属已知）。
    scan(&facade).await;
    let view = provenance_of(&facade, skill_id).await;
    assert_eq!(view.observed_deployments.len(), 2);
    // 各行保留"观察到的形态"：导入行是用户原始输入；扫描行是 scanner
    // 的 canonical 形态（macOS 临时目录带 /var → /private/var 前缀）。
    let canonical_second = std::fs::canonicalize(&second)
        .expect("canonical second")
        .to_string_lossy()
        .into_owned();
    let mut paths: Vec<String> = view
        .observed_deployments
        .iter()
        .map(|row| row.original_path.clone())
        .collect();
    paths.sort();
    let mut expected = vec![first.to_string_lossy().into_owned(), canonical_second];
    expected.sort();
    assert_eq!(paths, expected);
    // 再扫一次仍然只有两条：重复扫描不重复建档。
    scan(&facade).await;
    assert_eq!(
        provenance_of(&facade, skill_id)
            .await
            .observed_deployments
            .len(),
        2
    );
}

#[tokio::test]
async fn original_migration_requires_explicit_confirmation_and_never_touches_files_without_it() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let source = agent_root.join("notes");
    write_skill(&source, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    let prepared = prepare(&facade, &source, "Notes").await;
    let summary = commit_copy(&facade, prepared).await;
    let _skill_id = summary.items[0].skill_id.expect("skill in library");
    let relation_id = source_relation_id(&facade, &source).await;

    // 准备只读：给出冲突清单与确认要求，绝不删除。计划绑定来源关系。
    let planned = facade
        .execute(AppCommand::PrepareOriginalMigration(
            PrepareOriginalMigration {
                source_relation_id: relation_id.clone(),
            },
        ))
        .await
        .expect("prepare migration");
    let AppCommandResult::OriginalMigrationPlan(plan) = planned else {
        panic!("expected migration plan");
    };
    assert!(
        plan.conflicts.is_empty(),
        "clean facts must have no conflicts"
    );
    assert!(
        plan.requires_confirmation,
        "deletion always needs confirmation"
    );
    assert_eq!(plan.original_path, source.to_string_lossy());
    assert_eq!(plan.relation_id, relation_id);
    assert_eq!(plan.agent.client_id.as_deref(), Some(CLIENT_ID));
    assert_eq!(
        plan.target_context.agent_client_id.as_deref(),
        Some(CLIENT_ID)
    );
    assert_dir_intact(&source, BODY_V1);

    // 未知准备 id：拒绝且不触碰文件。
    let unknown = facade
        .execute(AppCommand::CommitOriginalMigration(
            CommitOriginalMigration {
                prepared_migration_id: skillhub_core::OperationId::new(),
                ownership_confirmed: true,
            },
        ))
        .await;
    assert_eq!(
        unknown.expect_err("unknown id").code,
        skillhub_core::ErrorCode::ObjectNotFound
    );
    assert_dir_intact(&source, BODY_V1);

    // 硬边界：未确认 → 拒绝执行，用户文件原样保留。
    let denied = facade
        .execute(AppCommand::CommitOriginalMigration(
            CommitOriginalMigration {
                prepared_migration_id: plan.operation_id,
                ownership_confirmed: false,
            },
        ))
        .await;
    assert_eq!(
        denied
            .expect_err("unconfirmed migration must be denied")
            .code,
        skillhub_core::ErrorCode::InvalidInput
    );
    assert_dir_intact(&source, BODY_V1);

    // 明确确认所有权 → 备份 → 记录 → 删除。
    let committed = facade
        .execute(AppCommand::CommitOriginalMigration(
            CommitOriginalMigration {
                prepared_migration_id: plan.operation_id,
                ownership_confirmed: true,
            },
        ))
        .await
        .expect("confirmed migration");
    let AppCommandResult::OriginalMigrationResult(result) = committed else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, OriginalMigrationState::Migrated);
    assert_eq!(result.original_path, source.to_string_lossy());
    assert!(
        !source.exists(),
        "confirmed migration removes the original directory"
    );
    let backup = std::path::PathBuf::from(&result.backup_path);
    assert_dir_intact(&backup, BODY_V1);
    assert!(
        backup.starts_with(workspace.path().join("library")),
        "backup lives inside the central library"
    );
}

#[tokio::test]
async fn original_migration_aborts_on_conflicts_and_preserves_the_scene() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let source = agent_root.join("notes");
    write_skill(&source, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    // 场景一：导入后内容分叉 → ContentDiverged 冲突，确认也拒绝，现场保留。
    let prepared = prepare(&facade, &source, "Notes").await;
    let summary = commit_copy(&facade, prepared).await;
    let _skill_id = summary.items[0].skill_id.expect("skill in library");
    let relation_id = source_relation_id(&facade, &source).await;
    write_skill(&source, BODY_V2);

    let planned = facade
        .execute(AppCommand::PrepareOriginalMigration(
            PrepareOriginalMigration {
                source_relation_id: relation_id.clone(),
            },
        ))
        .await
        .expect("prepare migration");
    let AppCommandResult::OriginalMigrationPlan(plan) = planned else {
        panic!("expected migration plan");
    };
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(
        plan.conflicts[0].reason,
        OriginalMigrationConflictReason::ContentDiverged
    );
    let denied = facade
        .execute(AppCommand::CommitOriginalMigration(
            CommitOriginalMigration {
                prepared_migration_id: plan.operation_id,
                ownership_confirmed: true,
            },
        ))
        .await;
    assert_eq!(
        denied.expect_err("conflicting migration must abort").code,
        skillhub_core::ErrorCode::OperationConflict
    );
    assert_dir_intact(&source, BODY_V2);

    // 场景二（计划 8A 语义）：没有来源关系的目录无从授权清理——
    // 未知 source_relation_id 一律拒绝（ObjectNotFound），现场不动。
    let handmade_source = workspace.path().join("handmade");
    write_skill(&handmade_source, BODY_V1);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "HandMade".into(),
            source_path: handmade_source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");
    let _handmade_skill = find_skill_by_name(&facade, "HandMade").await;
    let unknown_relation = facade
        .execute(AppCommand::PrepareOriginalMigration(
            PrepareOriginalMigration {
                source_relation_id: "rel-unknown".into(),
            },
        ))
        .await;
    assert_eq!(
        unknown_relation
            .expect_err("unknown relation must abort")
            .code,
        skillhub_core::ErrorCode::ObjectNotFound
    );
    assert_dir_intact(&handmade_source, BODY_V1);
}

#[tokio::test]
async fn original_migration_restores_the_original_directory_from_the_backup_on_rollback() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let source = agent_root.join("notes");
    write_skill(&source, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    let prepared = prepare(&facade, &source, "Notes").await;
    let summary = commit_copy(&facade, prepared).await;
    let _skill_id = summary.items[0].skill_id.expect("skill in library");

    let planned = facade
        .execute(AppCommand::PrepareOriginalMigration(
            PrepareOriginalMigration {
                source_relation_id: source_relation_id(&facade, &source).await,
            },
        ))
        .await
        .expect("prepare migration");
    let AppCommandResult::OriginalMigrationPlan(plan) = planned else {
        panic!("expected migration plan");
    };
    let committed = facade
        .execute(AppCommand::CommitOriginalMigration(
            CommitOriginalMigration {
                prepared_migration_id: plan.operation_id,
                ownership_confirmed: true,
            },
        ))
        .await
        .expect("confirmed migration");
    let AppCommandResult::OriginalMigrationResult(result) = committed else {
        panic!("expected migration result");
    };
    assert!(!source.exists());

    // 回滚：从备份恢复原目录，审计行翻转为 RolledBack，备份保留。
    let rolled_back = facade
        .execute(AppCommand::RollbackOriginalMigration(
            RollbackOriginalMigration {
                migration_id: result.migration_id,
            },
        ))
        .await
        .expect("rollback");
    let AppCommandResult::OriginalMigrationResult(rolled_back) = rolled_back else {
        panic!("expected rollback result");
    };
    assert_eq!(rolled_back.state, OriginalMigrationState::RolledBack);
    assert!(rolled_back.rolled_back_at.is_some());
    assert_dir_intact(&source, BODY_V1);
    assert_dir_intact(&std::path::PathBuf::from(&result.backup_path), BODY_V1);

    // 已回滚的迁移不能再次回滚。
    let again = facade
        .execute(AppCommand::RollbackOriginalMigration(
            RollbackOriginalMigration {
                migration_id: result.migration_id,
            },
        ))
        .await;
    assert_eq!(
        again.expect_err("double rollback").code,
        skillhub_core::ErrorCode::OperationConflict
    );
}

#[tokio::test]
async fn upstream_registered_local_path_classifies_online_with_temporary_cache() {
    // 仓库发现 local_path + UpstreamOrigin：本地绝对路径只是下载缓存，
    // provenance 类别必须仍是 Online，工作区形态 TemporaryCache。
    let database = Database::open_in_memory().expect("database");
    let cache_root = tempfile::tempdir().expect("repo cache");
    std::fs::create_dir_all(cache_root.path().join("pdf")).expect("skill dir");
    std::fs::write(cache_root.path().join("pdf/SKILL.md"), "# PDF\n").expect("marker");
    let facade = LocalApplicationFacade::new(database);
    facade.register_upstream_origin(
        cache_root.path().to_string_lossy().into_owned(),
        skillhub_core::UpstreamOrigin {
            url: "https://example.com/org/repo".into(),
            branch: "main".into(),
            directory: String::new(),
        },
    );

    let result = facade
        .query(AppQuery::DiscoverImportCandidates(
            skillhub_core::api::DiscoverImportCandidates {
                source: SourceDescriptor::new(
                    SourceKind::Local,
                    SourceLocator::local_path(cache_root.path()),
                ),
            },
        ))
        .await
        .expect("discovery");
    let AppQueryResult::ImportCandidates(candidates) = result else {
        panic!("expected import candidates");
    };
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        candidates[0].source_class,
        Some(skillhub_core::import::ImportSourceClass::Online)
    );
    assert!(matches!(
        candidates[0].acquisition,
        Some(skillhub_core::import::ImportAcquisitionContext {
            workspace_kind: skillhub_core::import::AcquisitionWorkspaceKind::TemporaryCache,
            workspace_path: None,
        })
    ));
}
