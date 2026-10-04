//! K2 共享目标回收与多目标删除恢复：prepared 持久化、逐项结果与恢复候选。
//!
//! 约定（K0 契约 §K2）：
//! - prepared 状态持久化到操作日志；重启后对过期预览的提交必须被拒绝，
//!   但用户已给出的共享目标决定与剩余项不得丢失。
//! - `commit_delete` 逐项执行并收集结果；任一失败不得中断后续项，也不得
//!   删除中央 Skill，而是登记恢复候选供重新 prepare 后续作。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CommitDeleteSkill, ListDeployments, PrepareDeleteSkill,
};
use skillhub_core::catalog::Skill;
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::{
    AppCommand, AppQuery, AppResult, ApplicationFacade, DeploymentId, ErrorCode, OperationId,
    PreparedRemovalRecord, PreparedRemovalState, RecoveryCandidate, RemovalChoice, RemovalDecision,
    RemovalImpact, RemovalItemStatus, RemovalResultState, VersionId,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

fn version_id(seed: char) -> VersionId {
    VersionId::parse(&format!("sha256:{}", seed.to_string().repeat(64))).expect("version id")
}

struct Workspace {
    database_path: std::path::PathBuf,
    scratch_dir: tempfile::TempDir,
    library_root: tempfile::TempDir,
}

fn workspace() -> Workspace {
    let scratch_dir = tempfile::tempdir().expect("scratch dir");
    let library_root = tempfile::tempdir().expect("library root");
    Workspace {
        database_path: scratch_dir.path().join("skillhub.sqlite"),
        scratch_dir,
        library_root,
    }
}

fn open_database(path: &std::path::Path) -> Database {
    Database::open(path).expect("open database")
}

async fn seed_skill(database: &Database, name: &str) -> Skill {
    let skill = Skill::new(skillhub_core::SkillId::new(), name);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");
    skill
}

/// Seeds a relation row over a registered target. Point target_path at a
/// directory that does not exist to make any owned-target operation on it
/// fail deterministically (the physical identity lookup returns None).
async fn seed_deployment(
    database: &Database,
    skill_id: skillhub_core::SkillId,
    target_id: &str,
    target_path: &std::path::Path,
) -> DeploymentId {
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_path.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    // deployments.version_id carries a foreign key into versions.
    database
        .connection_for_test()
        .execute(
            "INSERT OR IGNORE INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id('a').to_string(), skill_id.to_string()],
        )
        .expect("insert version");
    let record = DeploymentRecord {
        id: DeploymentId::new(),
        skill_id,
        version_id: version_id('a'),
        target_id: target_id.to_owned(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "fixture".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    };
    database
        .deployment_repository()
        .insert_sync(&record)
        .expect("insert deployment");
    record.id
}

fn choice(id: DeploymentId, decision: RemovalDecision, confirm: bool) -> RemovalChoice {
    RemovalChoice {
        deployment_id: id,
        decision,
        confirm_shared_target_removal: confirm,
    }
}

async fn prepare_delete(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> RemovalImpact {
    let prepared = facade
        .execute(AppCommand::PrepareDeleteSkill(PrepareDeleteSkill {
            skill_id,
        }))
        .await
        .expect("prepare delete");
    let AppCommandResult::RemovalImpact(impact) = prepared else {
        panic!("expected removal impact");
    };
    impact
}

async fn commit_delete(
    facade: &LocalApplicationFacade,
    operation_id: OperationId,
    decisions: Vec<RemovalChoice>,
) -> AppResult<AppCommandResult> {
    facade
        .execute(AppCommand::CommitDeleteSkill(CommitDeleteSkill {
            prepared_delete_id: operation_id,
            decisions,
        }))
        .await
}

async fn active_deployments(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> Vec<DeploymentRecord> {
    let list = facade
        .query(AppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill_id),
        }))
        .await
        .expect("list deployments");
    let AppQueryResult::Deployments(records) = list else {
        panic!("expected deployment list");
    };
    records
}

async fn recovery_candidate_ids(facade: &LocalApplicationFacade) -> Vec<OperationId> {
    let list = facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates");
    let AppQueryResult::RecoveryCandidates(candidates): AppQueryResult = list else {
        panic!("expected recovery candidates");
    };
    let candidates: Vec<RecoveryCandidate> = candidates;
    candidates
        .into_iter()
        .map(|candidate| candidate.operation_id)
        .collect()
}

fn journal_record(
    database: &Database,
    operation_id: OperationId,
) -> skillhub_core::OperationRecord {
    database
        .operation_repository()
        .get_sync(operation_id)
        .expect("read operation journal")
        .expect("operation journal row must exist")
}

fn prepared_payload(database: &Database, operation_id: OperationId) -> PreparedRemovalRecord {
    let record = journal_record(database, operation_id);
    serde_json::from_value(record.recovery_data)
        .expect("the prepared payload must be persisted in the journal")
}

/// RED：prepared 持久化后，重启（新 facade 触发启动清扫）必须拒绝旧预览的
/// 提交；但 journal 载荷必须保留影响快照，供重新预览与恢复核对。
#[tokio::test]
async fn prepared_delete_rejects_commit_after_restart_but_keeps_journal_payload() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Restartable").await;
    seed_deployment(
        &database,
        skill.id(),
        "target-restart",
        ws.scratch_dir.path(),
    )
    .await;
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    let impact = prepare_delete(&facade, skill.id()).await;
    let operation_id = impact.operation_id;

    // 模拟重启：重新打开同一数据库构造新 facade（启动清扫结算 prepared 行）。
    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let error = restarted
        .execute(AppCommand::CommitDeleteSkill(CommitDeleteSkill {
            prepared_delete_id: operation_id,
            decisions: Vec::new(),
        }))
        .await
        .expect_err("stale prepared removal must be rejected after restart");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);

    let audit_database = open_database(&ws.database_path);
    let record = journal_record(&audit_database, operation_id);
    assert_eq!(
        record.phase,
        skillhub_core::OperationPhase::RolledBack,
        "the swept preview row stays in the history but cannot commit"
    );
    let stored = prepared_payload(&audit_database, operation_id);
    assert_eq!(stored.impact.skill_id, skill.id());
    assert_eq!(stored.impact.operation_id, operation_id);
    assert_eq!(
        stored.state,
        PreparedRemovalState::Prepared,
        "a preview never reached a destructive phase"
    );
}

/// RED：3 目标中第 2 项失败 → 结果逐项可归属、恢复候选存在、用户决定与
/// 剩余项持久化；重启（清扫只处理 prepared 相位）后决定仍在。
#[tokio::test]
async fn a_partially_failed_delete_registers_recovery_and_preserves_decisions() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Partial").await;
    let first = seed_deployment(&database, skill.id(), "target-ok-1", ws.scratch_dir.path()).await;
    let failing = seed_deployment(
        &database,
        skill.id(),
        "target-missing",
        &ws.scratch_dir.path().join("nonexistent-removal-target"),
    )
    .await;
    let third = seed_deployment(&database, skill.id(), "target-ok-3", ws.scratch_dir.path()).await;
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    let impact = prepare_delete(&facade, skill.id()).await;
    let decisions = vec![
        choice(first, RemovalDecision::RemoveRelationOnly, false),
        choice(failing, RemovalDecision::RemoveOwnedTarget, false),
        choice(third, RemovalDecision::RemoveRelationOnly, false),
    ];

    let result = commit_delete(&facade, impact.operation_id, decisions.clone())
        .await
        .expect("commit delete must return a per-item outcome");
    let AppCommandResult::RemovalResult(result) = result else {
        panic!("expected removal result");
    };
    assert_eq!(result.state, RemovalResultState::PartiallyCommitted);
    assert_eq!(result.recovery_operation_id, Some(impact.operation_id));
    assert!(!result.central_skill_deleted);
    let by_id = |id: DeploymentId| {
        result
            .decisions
            .iter()
            .find(|item| item.deployment_id == id)
            .unwrap_or_else(|| panic!("missing per-item row for {id}"))
    };
    assert_eq!(by_id(first).status, RemovalItemStatus::Applied);
    assert_eq!(by_id(failing).status, RemovalItemStatus::Failed);
    assert_eq!(
        by_id(failing).error_code,
        Some(ErrorCode::OwnershipMismatch),
        "the vanished target directory is the deterministic failure"
    );
    assert_eq!(by_id(third).status, RemovalItemStatus::Applied);

    assert!(recovery_candidate_ids(&facade)
        .await
        .contains(&impact.operation_id));

    let audit_database = open_database(&ws.database_path);
    let record = journal_record(&audit_database, impact.operation_id);
    assert_eq!(record.phase, skillhub_core::OperationPhase::Applying);
    let stored = prepared_payload(&audit_database, impact.operation_id);
    assert_eq!(stored.decisions, decisions);
    assert_eq!(stored.remaining_deployment_ids, vec![failing]);
    assert_eq!(stored.applied_deployment_ids.len(), 2);

    // 重启：清扫只结算 prepared 相位，已产生真实副作用的 applying 行保留，
    // 用户决定与剩余项不得丢失。
    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    assert!(recovery_candidate_ids(&restarted)
        .await
        .contains(&impact.operation_id));
    let audit_database = open_database(&ws.database_path);
    let stored = prepared_payload(&audit_database, impact.operation_id);
    assert_eq!(stored.decisions, decisions);
    assert_eq!(stored.remaining_deployment_ids, vec![failing]);
}

/// RED：重启后重试 → 重新 prepare 只剩剩余项（不重放已成功项），重新核对
/// 身份后继续；全部决定处理完成才删除中央 Skill。
#[tokio::test]
async fn retry_after_partial_failure_reprepares_and_skips_applied_items() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Retry").await;
    let first = seed_deployment(&database, skill.id(), "target-ok-1", ws.scratch_dir.path()).await;
    let failing = seed_deployment(
        &database,
        skill.id(),
        "target-missing",
        &ws.scratch_dir.path().join("nonexistent-removal-target"),
    )
    .await;
    let third = seed_deployment(&database, skill.id(), "target-ok-3", ws.scratch_dir.path()).await;
    {
        let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
        let impact = prepare_delete(&facade, skill.id()).await;
        commit_delete(
            &facade,
            impact.operation_id,
            vec![
                choice(first, RemovalDecision::RemoveRelationOnly, false),
                choice(failing, RemovalDecision::RemoveOwnedTarget, false),
                choice(third, RemovalDecision::RemoveRelationOnly, false),
            ],
        )
        .await
        .expect("commit delete must return a per-item outcome");
    }

    // 重启后重新 prepare：成功项已被真实移除，不得再出现在影响清单中。
    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let fresh = prepare_delete(&restarted, skill.id()).await;
    let fresh_ids = fresh
        .deployments
        .iter()
        .map(|record| record.id)
        .collect::<Vec<_>>();
    assert_eq!(
        fresh_ids,
        vec![failing],
        "only the failed item remains; applied items are never replayed"
    );

    // 中央 Skill 仍可删除：需要完整的四消费面夹具。
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Retry\n").expect("write source");
    let store = VersionStore::from_library(&library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable metadata");

    let result = commit_delete(
        &restarted,
        fresh.operation_id,
        vec![choice(failing, RemovalDecision::RemoveRelationOnly, false)],
    )
    .await
    .expect("retry commit must return a per-item outcome");
    let AppCommandResult::RemovalResult(result) = result else {
        panic!("expected removal result");
    };
    assert_eq!(result.state, RemovalResultState::Committed);
    assert!(result.central_skill_deleted);
    assert!(active_deployments(&restarted, skill.id()).await.is_empty());
}
