//! K2 共享目标回收与多目标删除恢复：prepared 持久化、逐项结果与恢复候选。
//!
//! 约定（K0 契约 §K2）：
//! - prepared 状态持久化到操作日志；重启后对过期预览的提交必须被拒绝，
//!   但用户已给出的共享目标决定与剩余项不得丢失。
//! - `commit_delete` 逐项执行并收集结果；任一失败不得中断后续项，也不得
//!   删除中央 Skill，而是登记恢复候选供重新 prepare 后续作。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, ApplyUninstallDecision, CancelDeleteSkill, CommitDeleteSkill,
    ListDeployments, PrepareDeleteSkill, PrepareUninstall, ResolveRecovery,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::{
    AppCommand, AppQuery, AppResult, ApplicationFacade, DeploymentId, ErrorCode, OperationId,
    PreparedRemovalRecord, PreparedRemovalState, RecoveryCandidate, RemovalChoice, RemovalDecision,
    RemovalImpact, RemovalItemStatus, RemovalResultState, StartupRecoveryState, VersionId,
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
    recovery_candidates(facade)
        .await
        .into_iter()
        .map(|candidate| candidate.operation_id)
        .collect()
}

async fn recovery_candidates(facade: &LocalApplicationFacade) -> Vec<RecoveryCandidate> {
    let list = facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates");
    let AppQueryResult::RecoveryCandidates(candidates): AppQueryResult = list else {
        panic!("expected recovery candidates");
    };
    let candidates: Vec<RecoveryCandidate> = candidates;
    candidates
}

fn persist_undeploy_recovery(
    database: &Database,
    deployment: DeploymentRecord,
    target_entry_identity: Option<String>,
) -> OperationId {
    let operation_id = OperationId::new();
    let impact = RemovalImpact {
        operation_id,
        skill_id: deployment.skill_id,
        deployments: vec![deployment.clone()],
        requires_shared_target_choice: false,
        dependencies: Vec::new(),
        project_configs: Vec::new(),
        pinned_versions: Vec::new(),
        combinations: Vec::new(),
        related_skills: Vec::new(),
        unknown_external_references: Vec::new(),
        draft_count: 0,
    };
    let mut journal = skillhub_core::OperationRecord::planned(
        operation_id,
        "undeploy_skill",
        "undeploy-recovery-fixture",
    );
    journal.phase = skillhub_core::OperationPhase::Applying;
    journal.progress.phase = journal.phase;
    journal.recovery_data = serde_json::to_value(PreparedRemovalRecord {
        kind: skillhub_core::PreparedRemovalKind::UndeploySkill,
        impact,
        central_runtime_name: None,
        target_entry_identity,
        decisions: vec![choice(
            deployment.id,
            RemovalDecision::RemoveOwnedTarget,
            false,
        )],
        applied_deployment_ids: Vec::new(),
        remaining_deployment_ids: vec![deployment.id],
        state: PreparedRemovalState::Applying,
        last_error_code: None,
    })
    .expect("serialize interrupted undeploy");
    database
        .operation_repository()
        .insert_sync(&journal)
        .expect("persist interrupted undeploy");
    operation_id
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

fn persist_applying_delete(
    database: &Database,
    impact: &RemovalImpact,
    decisions: Vec<RemovalChoice>,
    applied: Vec<DeploymentId>,
    remaining: Vec<DeploymentId>,
    runtime_name: &str,
) {
    let mut journal = journal_record(database, impact.operation_id);
    let mut prepared = prepared_payload(database, impact.operation_id);
    prepared.central_runtime_name = Some(runtime_name.to_owned());
    prepared.state = PreparedRemovalState::Applying;
    prepared.decisions = decisions;
    prepared.applied_deployment_ids = applied;
    prepared.remaining_deployment_ids = remaining;
    journal.recovery_data = serde_json::to_value(prepared).expect("serialize delete payload");
    journal.phase = skillhub_core::OperationPhase::Applying;
    journal.progress.phase = skillhub_core::OperationPhase::Applying;
    database
        .operation_repository()
        .update_sync(&journal)
        .expect("persist interrupted delete");
}

fn seed_central_version(library: &CentralLibrary, skill: &Skill) -> VersionId {
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Recoverable delete\n").expect("write source");
    let store = VersionStore::from_library(library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(skill, Some(&version.id))
        .expect("save portable metadata");
    version.id
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

/// A prepared delete is only a read-only impact preview. It must not block
/// normal work by appearing as an unfinished recovery action before commit.
#[tokio::test]
async fn prepared_delete_preview_is_not_a_recovery_candidate() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Preview only").await;
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());

    let impact = prepare_delete(&facade, skill.id()).await;

    assert!(
        !recovery_candidate_ids(&facade)
            .await
            .contains(&impact.operation_id),
        "opening a delete preview must not create a recovery blocker"
    );
    let snapshot = facade
        .query(AppQuery::GetBootstrapSnapshot)
        .await
        .expect("read bootstrap snapshot");
    assert!(
        matches!(
            snapshot,
            AppQueryResult::BootstrapSnapshot(snapshot)
                if snapshot.recovery_state == StartupRecoveryState::Clean
        ),
        "a read-only delete preview must not send the user to a recovery page with no candidate"
    );
}

#[tokio::test]
async fn interrupted_undeploy_resumes_when_the_confirmed_target_is_already_removed() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Interrupted undeploy").await;
    let target_root = ws.scratch_dir.path().join("undeploy-target");
    std::fs::create_dir_all(&target_root).expect("create target root");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let deployment = database
        .deployment_repository()
        .list_all()
        .expect("list deployments")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("seeded deployment");
    let target_entry = target_root.join(&deployment.runtime_name);
    std::fs::create_dir_all(&target_entry).expect("create deployed entry");
    std::fs::write(target_entry.join("SKILL.md"), "# deployed\n").expect("write deployed file");
    let original_entry_identity =
        skillhub_core::physical_id_for_path(&target_entry).expect("entry identity");
    std::fs::remove_dir_all(&target_entry).expect("simulate interruption after target removal");
    let operation_id =
        persist_undeploy_recovery(&database, deployment.clone(), Some(original_entry_identity));

    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&facade)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == operation_id)
        .expect("an interrupted undeploy remains visible");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );

    facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("recovery should reconcile the removed target and close its relation");

    let audit_database = open_database(&ws.database_path);
    let current = audit_database
        .deployment_repository()
        .list_all()
        .expect("list deployments after recovery")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("deployment relation remains in history");
    assert_eq!(current.state, DeploymentState::Removed);
    assert_eq!(
        journal_record(&audit_database, operation_id).phase,
        skillhub_core::OperationPhase::Committed
    );
    assert!(!recovery_candidate_ids(&facade)
        .await
        .contains(&operation_id));
}

#[tokio::test]
async fn interrupted_undeploy_hides_recovery_when_the_target_entry_was_replaced() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Replaced undeploy target").await;
    let target_root = ws.scratch_dir.path().join("replaced-undeploy-target");
    std::fs::create_dir_all(&target_root).expect("create target root");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let deployment = database
        .deployment_repository()
        .list_all()
        .expect("list deployments")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("seeded deployment");
    let target_entry = target_root.join(&deployment.runtime_name);
    std::fs::create_dir_all(&target_entry).expect("create original deployed entry");
    std::fs::write(target_entry.join("SKILL.md"), "# original\n").expect("write original file");
    let original_entry_identity =
        skillhub_core::physical_id_for_path(&target_entry).expect("original entry identity");
    std::fs::remove_dir_all(&target_entry).expect("simulate interrupted target removal");
    std::fs::create_dir_all(&target_entry).expect("create replacement entry");
    std::fs::write(target_entry.join("SKILL.md"), "# user replacement\n")
        .expect("write replacement file");
    let operation_id =
        persist_undeploy_recovery(&database, deployment.clone(), Some(original_entry_identity));
    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );

    let candidate = recovery_candidates(&facade)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == operation_id)
        .expect("the unsafe record keeps the recovery gate visible");
    assert!(candidate.actions.is_empty());
    let error = facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect_err("a replacement target must not be treated as the old deployment");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        std::fs::read_to_string(target_entry.join("SKILL.md")).expect("replacement survives"),
        "# user replacement\n"
    );
    assert_eq!(
        journal_record(&open_database(&ws.database_path), operation_id).phase,
        skillhub_core::OperationPhase::NeedsRecovery
    );
}

#[tokio::test]
async fn interrupted_undeploy_hides_recovery_for_an_unsafe_runtime_name() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Unsafe undeploy runtime name").await;
    let target_root = ws.scratch_dir.path().join("unsafe-undeploy-target");
    std::fs::create_dir_all(&target_root).expect("create target root");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let deployment = database
        .deployment_repository()
        .list_all()
        .expect("list deployments")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("seeded deployment");
    let target_entry = target_root.join(&deployment.runtime_name);
    std::fs::create_dir_all(&target_entry).expect("create deployed entry");
    let target_entry_identity =
        skillhub_core::physical_id_for_path(&target_entry).expect("entry identity");
    let operation_id =
        persist_undeploy_recovery(&database, deployment.clone(), Some(target_entry_identity));

    let unsafe_runtime_name = "../outside";
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET runtime_name=?1 WHERE id=?2",
            rusqlite::params![unsafe_runtime_name, deployment_id.to_string()],
        )
        .expect("inject an invalid stored runtime name");
    let mut journal = database
        .operation_repository()
        .get_sync(operation_id)
        .expect("read journal")
        .expect("journal exists");
    journal.recovery_data["impact"]["deployments"][0]["runtime_name"] =
        serde_json::Value::String(unsafe_runtime_name.to_owned());
    database
        .operation_repository()
        .update_sync(&journal)
        .expect("persist matching invalid recovery facts");

    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&facade)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == operation_id)
        .expect("unsafe recovery record keeps the recovery gate visible");
    assert!(
        candidate.actions.is_empty(),
        "an unsafe runtime name must never be joined to the verified target root"
    );
}

#[tokio::test]
async fn undeploy_ownership_preflight_failure_does_not_create_recovery_blocker() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Undeploy checkpoint").await;
    let target_root = ws.scratch_dir.path().join("undeploy-checkpoint-target");
    std::fs::create_dir_all(&target_root).expect("create target root");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let deployment = database
        .deployment_repository()
        .list_all()
        .expect("list deployments")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("seeded deployment");
    let target_entry = target_root.join(&deployment.runtime_name);
    std::fs::create_dir_all(&target_entry).expect("create deployed entry");
    std::fs::write(target_entry.join("SKILL.md"), "# identity checkpoint\n")
        .expect("write deployed file");
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    facade
        .execute(AppCommand::PrepareUninstall(PrepareUninstall {
            deployment_ids: vec![deployment_id],
        }))
        .await
        .expect("prepare uninstall");

    let error = facade
        .execute(AppCommand::ApplyUninstallDecision(ApplyUninstallDecision {
            actions: vec![skillhub_core::UninstallAction::UndeployAll],
        }))
        .await
        .expect_err("ownership mismatch must stop removal before its checkpoint");
    assert_eq!(error.code, ErrorCode::OwnershipMismatch);

    let audit_database = open_database(&ws.database_path);
    let journal = audit_database
        .operation_repository()
        .list_sync()
        .expect("list operation records")
        .into_iter()
        .find(|record| record.kind == "undeploy_skill")
        .expect("undeploy child operation is recorded");
    assert_eq!(journal.phase, skillhub_core::OperationPhase::Prepared);
    assert!(
        !recovery_candidate_ids(&facade)
            .await
            .contains(&journal.operation_id),
        "read-only ownership validation must not leave a recovery blocker"
    );
    assert!(
        target_entry.exists(),
        "failed preflight must preserve the entry"
    );
}

#[tokio::test]
async fn undeploy_rejects_unsafe_stored_runtime_name_before_touching_outside_path() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Unsafe undeploy runtime name").await;
    let target_root = ws.scratch_dir.path().join("unsafe-runtime-target");
    let outside_target = ws.scratch_dir.path().join("outside");
    std::fs::create_dir_all(&target_root).expect("create target root");
    std::fs::create_dir_all(&outside_target).expect("create outside target");
    let marker = outside_target.join("keep.txt");
    std::fs::write(&marker, "outside data must survive\n").expect("write outside marker");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let outside_hash =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&outside_target)
            .expect("hash outside target");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET runtime_name=?1, expected_hash=?2, observed_hash=?2 WHERE id=?3",
            rusqlite::params!["../outside", outside_hash, deployment_id.to_string()],
        )
        .expect("inject unsafe stored destination facts");

    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    facade
        .execute(AppCommand::PrepareUninstall(PrepareUninstall {
            deployment_ids: vec![deployment_id],
        }))
        .await
        .expect("prepare uninstall preview");
    let error = facade
        .execute(AppCommand::ApplyUninstallDecision(ApplyUninstallDecision {
            actions: vec![skillhub_core::UninstallAction::UndeployAll],
        }))
        .await
        .expect_err("unsafe stored runtime name must be rejected before removal");

    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        std::fs::read_to_string(&marker).expect("outside marker remains"),
        "outside data must survive\n"
    );
    let audit_database = open_database(&ws.database_path);
    let undeploy = audit_database
        .operation_repository()
        .list_sync()
        .expect("list operation records")
        .into_iter()
        .find(|record| record.kind == "undeploy_skill")
        .expect("undeploy operation is recorded");
    assert_eq!(undeploy.phase, skillhub_core::OperationPhase::Prepared);
    assert!(
        !recovery_candidate_ids(&facade)
            .await
            .contains(&undeploy.operation_id),
        "rejected read-only preflight must not leave a recovery blocker"
    );
}

#[tokio::test]
async fn undeploy_recovery_resumes_after_target_removal_precedes_relation_checkpoint() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Undeploy checkpoint").await;
    let target_root = ws.scratch_dir.path().join("undeploy-checkpoint-target");
    std::fs::create_dir_all(&target_root).expect("create target root");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let deployment = database
        .deployment_repository()
        .list_all()
        .expect("list deployments")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("seeded deployment");
    let target_entry = target_root.join(&deployment.runtime_name);
    std::fs::create_dir_all(&target_entry).expect("create deployed entry");
    std::fs::write(target_entry.join("SKILL.md"), "# identity checkpoint\n")
        .expect("write deployed file");
    let target_entry_identity =
        skillhub_core::physical_id_for_path(&target_entry).expect("entry identity");
    let expected_hash =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&target_entry)
            .expect("hash owned deployment");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET expected_hash=?1, observed_hash=?1 WHERE id=?2",
            rusqlite::params![expected_hash, deployment_id.to_string()],
        )
        .expect("persist matching ownership proof");
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER block_undeploy_relation_checkpoint
             BEFORE UPDATE OF state ON deployments
             WHEN NEW.state='removed'
             BEGIN SELECT RAISE(ABORT, 'injected undeploy relation checkpoint failure'); END;",
        )
        .expect("inject relation checkpoint failure");
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    facade
        .execute(AppCommand::PrepareUninstall(PrepareUninstall {
            deployment_ids: vec![deployment_id],
        }))
        .await
        .expect("prepare uninstall");

    facade
        .execute(AppCommand::ApplyUninstallDecision(ApplyUninstallDecision {
            actions: vec![skillhub_core::UninstallAction::UndeployAll],
        }))
        .await
        .expect_err("the injected database failure follows physical removal");
    assert!(!target_entry.exists(), "the selected target was removed");

    let audit_database = open_database(&ws.database_path);
    let journal = audit_database
        .operation_repository()
        .list_sync()
        .expect("list operation records")
        .into_iter()
        .find(|record| record.kind == "undeploy_skill")
        .expect("undeploy child operation is recorded");
    assert_eq!(journal.phase, skillhub_core::OperationPhase::Applying);
    let checkpoint: PreparedRemovalRecord =
        serde_json::from_value(journal.recovery_data).expect("decode undeploy checkpoint");
    assert_eq!(
        checkpoint.target_entry_identity.as_deref(),
        Some(target_entry_identity.as_str()),
        "recovery must retain the identity of the confirmed physical entry"
    );
    let candidate = recovery_candidates(&facade)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == checkpoint.impact.operation_id)
        .expect("the interrupted operation stays visible");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );

    audit_database
        .connection_for_test()
        .execute_batch("DROP TRIGGER block_undeploy_relation_checkpoint")
        .expect("remove injected database failure");
    facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: checkpoint.impact.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("recovery reconciles the completed file removal");
    let completed = open_database(&ws.database_path);
    let relation = completed
        .deployment_repository()
        .list_all()
        .expect("list deployments after recovery")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("deployment relation remains in history");
    assert_eq!(relation.state, DeploymentState::Removed);
    assert_eq!(
        journal_record(&completed, checkpoint.impact.operation_id).phase,
        skillhub_core::OperationPhase::Committed
    );
}

/// A decision rejected before the first write settles the preview instead of
/// turning a read-only validation error into a global recovery blocker.
#[tokio::test]
async fn rejected_delete_decision_before_writes_does_not_create_recovery_blocker() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Rejected before write").await;
    seed_deployment(
        &database,
        skill.id(),
        "target-rejected-before-write",
        &ws.scratch_dir.path().join("target-does-not-exist"),
    )
    .await;
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    let impact = prepare_delete(&facade, skill.id()).await;

    let error = commit_delete(&facade, impact.operation_id, Vec::new())
        .await
        .expect_err("every deployment requires an explicit choice");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert!(!recovery_candidate_ids(&facade)
        .await
        .contains(&impact.operation_id));

    let audit_database = open_database(&ws.database_path);
    assert_eq!(
        journal_record(&audit_database, impact.operation_id).phase,
        skillhub_core::OperationPhase::RolledBack,
        "a no-write validation failure is safely settled as rolled back"
    );
}

#[tokio::test]
async fn canceling_delete_preview_settles_it_without_changing_skill_or_relations() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Canceled preview").await;
    let deployment = seed_deployment(
        &database,
        skill.id(),
        "target-cancel",
        ws.scratch_dir.path(),
    )
    .await;
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    let impact = prepare_delete(&facade, skill.id()).await;

    let canceled = facade
        .execute(AppCommand::CancelDeleteSkill(CancelDeleteSkill {
            prepared_delete_id: impact.operation_id,
        }))
        .await
        .expect("canceling an untouched delete preview should succeed");
    assert!(
        matches!(canceled, AppCommandResult::OperationSummary(summary)
        if summary.phase == skillhub_core::OperationPhase::RolledBack)
    );
    assert!(!recovery_candidate_ids(&facade)
        .await
        .contains(&impact.operation_id));
    assert_eq!(active_deployments(&facade, skill.id()).await.len(), 1);
    assert_eq!(
        journal_record(&open_database(&ws.database_path), impact.operation_id).phase,
        skillhub_core::OperationPhase::RolledBack,
    );
    assert!(active_deployments(&facade, skill.id())
        .await
        .iter()
        .any(|row| row.id == deployment));

    let repeated = facade
        .execute(AppCommand::CancelDeleteSkill(CancelDeleteSkill {
            prepared_delete_id: impact.operation_id,
        }))
        .await
        .expect_err("a settled preview cannot be canceled twice");
    assert_eq!(repeated.code, ErrorCode::ObjectNotFound);
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
    let candidate = recovery_candidates(&facade)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("valid delete journal should offer its supported continuation");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );

    let cancel_partial = facade
        .execute(AppCommand::CancelDeleteSkill(CancelDeleteSkill {
            prepared_delete_id: impact.operation_id,
        }))
        .await
        .expect_err("a partially applied deletion must remain recoverable, not be canceled");
    assert_eq!(cancel_partial.code, ErrorCode::ObjectNotFound);
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

/// 裁决1：中央 Skill 删除失败是结构化部分结果（目标决定已应用、中央未删除、
/// central_delete_error 与恢复引用可见），journal 行转 applying＝恢复候选，
/// 不被 K1c 的补偿完整结算静默吸收；直接重提交被拒，移除故障后续作必须
/// 重新 prepare（关系已空，只剩主体删除）。
#[tokio::test]
async fn a_failed_central_deletion_is_a_structured_outcome_and_recovers_via_recovery_center() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Central failure").await;
    let facade = LocalApplicationFacade::new_with_library(database, ws.library_root.path());
    // 完整中央夹具：中央删除会走到版本清单枚举。
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Central\n").expect("write source");
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
    // 故障注入（K1c 同款）：版本清单位置放置目录，枚举必然失败；
    // 清单文件先备份，续作前恢复，保证重试面对与首次成功夹具一致。
    let digest = version
        .id
        .as_str()
        .strip_prefix("sha256:")
        .unwrap_or(version.id.as_str());
    let manifest = library
        .paths()
        .versions_dir
        .join(skill.id().to_string())
        .join(format!("{digest}.json"));
    let manifest_backup = manifest.with_extension("json.obstruction-backup");
    std::fs::copy(&manifest, &manifest_backup).expect("back up manifest");
    std::fs::remove_file(&manifest).expect("remove manifest file");
    std::fs::create_dir_all(&manifest).expect("plant manifest obstruction");

    let impact = prepare_delete(&facade, skill.id()).await;
    let result = commit_delete(&facade, impact.operation_id, Vec::new())
        .await
        .expect("a failed central deletion must be a structured outcome, not a bare error");
    let AppCommandResult::RemovalResult(result) = result else {
        panic!("expected removal result");
    };
    assert_eq!(result.state, RemovalResultState::PartiallyCommitted);
    assert_eq!(result.recovery_operation_id, Some(impact.operation_id));
    assert!(!result.central_skill_deleted);
    assert_eq!(result.central_delete_error, Some(ErrorCode::InternalError));

    // journal 行转 applying：真实不一致（目标面已回收、中央仍在）通过
    // 恢复候选可见，启动恢复闸门不会静默吸收它。
    let audit_database = open_database(&ws.database_path);
    let record = journal_record(&audit_database, impact.operation_id);
    assert_eq!(record.phase, skillhub_core::OperationPhase::Applying);
    let stored = prepared_payload(&audit_database, impact.operation_id);
    assert_eq!(stored.state, PreparedRemovalState::PartiallyCommitted);
    assert_eq!(stored.last_error_code, Some(ErrorCode::InternalError));
    assert!(stored.remaining_deployment_ids.is_empty());
    assert!(recovery_candidate_ids(&facade)
        .await
        .contains(&impact.operation_id));
    let candidate = recovery_candidates(&facade)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("central delete failure should remain a candidate");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    assert_eq!(
        stored.central_runtime_name.as_deref(),
        Some(skill.runtime_name())
    );

    // 直接重提交被拒：applying 相位不可提交，续作必须重新 prepare。
    let error = commit_delete(&facade, impact.operation_id, Vec::new())
        .await
        .expect_err("an applying row cannot be recommitted blindly");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
    assert!(
        recovery_candidate_ids(&facade)
            .await
            .contains(&impact.operation_id),
        "a rejected retry must preserve the recovery candidate"
    );
    assert_eq!(
        journal_record(&open_database(&ws.database_path), impact.operation_id).phase,
        skillhub_core::OperationPhase::NeedsRecovery,
        "a rejected retry cannot settle an applying delete as rolled back"
    );

    // 移除故障后通过恢复中心继续已确认的删除决定。
    std::fs::remove_dir_all(&manifest).expect("clear obstruction");
    std::fs::copy(&manifest_backup, &manifest).expect("restore manifest");
    std::fs::remove_file(&manifest_backup).expect("drop backup");
    let retry = facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: impact.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("recovery center should continue the confirmed delete");
    let AppCommandResult::OperationSummary(summary) = retry else {
        panic!("expected recovered operation summary");
    };
    assert_eq!(summary.phase, skillhub_core::OperationPhase::Committed);
    assert!(
        !recovery_candidate_ids(&facade)
            .await
            .contains(&impact.operation_id),
        "the completed retry must not stay a recovery candidate"
    );
    let audit_database = open_database(&ws.database_path);
    let catalog_rows: i64 = audit_database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM skills WHERE id = ?1",
            [skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("count catalog rows");
    assert_eq!(catalog_rows, 0, "the catalog record must be gone");
    assert_eq!(
        journal_record(&audit_database, impact.operation_id).phase,
        skillhub_core::OperationPhase::Committed
    );
}

#[tokio::test]
async fn delete_recovery_reconciles_database_write_before_progress_checkpoint() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Interrupted relation removal").await;
    let deployment_id = seed_deployment(
        &database,
        skill.id(),
        "target-interrupted-relation",
        &ws.scratch_dir.path().join("missing-target-root"),
    )
    .await;
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Interrupted\n").expect("write source");
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
    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    let audit_database = open_database(&ws.database_path);
    persist_applying_delete(
        &audit_database,
        &impact,
        vec![choice(
            deployment_id,
            RemovalDecision::RemoveRelationOnly,
            false,
        )],
        Vec::new(),
        vec![deployment_id],
        skill.runtime_name(),
    );
    audit_database
        .deployment_repository()
        .mark_removed_sync(deployment_id)
        .expect("simulate database mutation before progress checkpoint");

    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&restarted)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("interrupted delete remains recoverable");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: impact.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("resume should recognize the already removed relation");

    let database = open_database(&ws.database_path);
    let catalog_rows: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM skills WHERE id = ?1",
            [skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("count catalog rows");
    assert_eq!(catalog_rows, 0);
    assert_eq!(
        journal_record(&database, impact.operation_id).phase,
        skillhub_core::OperationPhase::Committed
    );
}

#[tokio::test]
async fn delete_recovery_resumes_after_visible_tree_and_version_manifest_were_removed() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Interrupted central delete").await;
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    let version_id = seed_central_version(&library, &skill);
    library
        .materialize_current_skill(&skill, &version_id)
        .expect("materialize visible tree");
    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    let audit_database = open_database(&ws.database_path);
    persist_applying_delete(
        &audit_database,
        &impact,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        skill.runtime_name(),
    );

    let visible_backup = library.paths().tmp_dir.join(format!(
        "visible-backup-{}-{}",
        skill.id(),
        impact.operation_id
    ));
    assert!(library
        .prepare_visible_tree_removal(&skill, &visible_backup)
        .expect("move visible tree to the operation backup"));
    let manifest = library
        .paths()
        .versions_dir
        .join(skill.id().to_string())
        .join(format!(
            "{}.json",
            version_id
                .as_str()
                .strip_prefix("sha256:")
                .unwrap_or(version_id.as_str())
        ));
    std::fs::remove_file(&manifest).expect("simulate interruption after manifest removal");

    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&restarted)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("central delete remains recoverable");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: impact.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("resume should finish the interrupted central delete");

    assert!(!visible_backup.exists());
    assert!(!library.visible_skill_path(&skill).exists());
    assert!(library
        .load_portable_skill(skill.id())
        .expect("read portable manifest")
        .is_none());
    let database = open_database(&ws.database_path);
    assert!(database
        .catalog_repository()
        .expect("catalog repository")
        .get_sync(skill.id())
        .expect("read deleted catalog row")
        .is_none());
    assert_eq!(
        journal_record(&database, impact.operation_id).phase,
        skillhub_core::OperationPhase::Committed
    );
}

#[tokio::test]
async fn delete_recovery_refuses_a_replaced_target_without_deleting_it() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Target identity guard").await;
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    seed_central_version(&library, &skill);
    let target_root = ws.scratch_dir.path().join("replacement-root");
    std::fs::create_dir_all(target_root.join("fixture")).expect("create target");
    let protected_file = target_root.join("fixture").join("keep.txt");
    std::fs::write(&protected_file, "belongs to a replacement target")
        .expect("write protected file");
    let deployment_id = seed_deployment(
        &database,
        skill.id(),
        "registered-target-id-that-does-not-match-this-directory",
        &target_root,
    )
    .await;
    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    let audit_database = open_database(&ws.database_path);
    persist_applying_delete(
        &audit_database,
        &impact,
        vec![choice(
            deployment_id,
            RemovalDecision::RemoveOwnedTarget,
            false,
        )],
        Vec::new(),
        vec![deployment_id],
        skill.runtime_name(),
    );

    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&restarted)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("changed target must keep the recovery gate visible");
    assert!(
        candidate.actions.is_empty(),
        "a replaced target must not advertise a continuation action"
    );
    let error = restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: impact.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect_err("a target with a changed physical identity must remain untouched");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        std::fs::read_to_string(&protected_file).expect("protected file remains"),
        "belongs to a replacement target"
    );
    assert!(recovery_candidate_ids(&restarted)
        .await
        .contains(&impact.operation_id));
    assert_eq!(
        journal_record(&open_database(&ws.database_path), impact.operation_id).phase,
        skillhub_core::OperationPhase::NeedsRecovery
    );
}

#[tokio::test]
async fn delete_recovery_hides_action_when_target_ownership_hash_changed() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Changed owned target").await;
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    seed_central_version(&library, &skill);
    let target_root = ws.scratch_dir.path().join("changed-owned-target-root");
    let deployed_path = target_root.join("fixture");
    std::fs::create_dir_all(&deployed_path).expect("create deployed copy");
    std::fs::write(deployed_path.join("keep.txt"), "changed after deployment")
        .expect("write modified deployed copy");
    let target_id = skillhub_core::physical_id_for_path(&target_root)
        .expect("registered target physical identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    persist_applying_delete(
        &open_database(&ws.database_path),
        &impact,
        vec![choice(
            deployment_id,
            RemovalDecision::RemoveOwnedTarget,
            false,
        )],
        Vec::new(),
        vec![deployment_id],
        skill.runtime_name(),
    );

    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&restarted)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("modified target must keep the recovery gate visible");
    assert!(
        candidate.actions.is_empty(),
        "an ownership mismatch must not advertise a continuation action"
    );
}

#[tokio::test]
async fn delete_recovery_hides_action_when_decisions_do_not_match_the_impact() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Corrupt delete facts").await;
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    seed_central_version(&library, &skill);
    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    let audit_database = open_database(&ws.database_path);
    persist_applying_delete(
        &audit_database,
        &impact,
        vec![choice(
            DeploymentId::new(),
            RemovalDecision::RemoveRelationOnly,
            false,
        )],
        Vec::new(),
        Vec::new(),
        skill.runtime_name(),
    );
    let mut journal = journal_record(&audit_database, impact.operation_id);
    journal.phase = skillhub_core::OperationPhase::NeedsRecovery;
    journal.progress.phase = skillhub_core::OperationPhase::NeedsRecovery;
    audit_database
        .operation_repository()
        .update_sync(&journal)
        .expect("mark invalid record for recovery");

    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&restarted)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("invalid recovery record still keeps the safety gate");
    assert!(candidate.actions.is_empty());
}

#[tokio::test]
async fn delete_recovery_hides_action_for_a_windows_drive_like_runtime_name() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Invalid runtime name").await;
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    seed_central_version(&library, &skill);
    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    persist_applying_delete(
        &open_database(&ws.database_path),
        &impact,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        "C:outside-library",
    );

    let restarted = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let candidate = recovery_candidates(&restarted)
        .await
        .into_iter()
        .find(|candidate| candidate.operation_id == impact.operation_id)
        .expect("invalid recovery record still keeps the safety gate");
    assert!(candidate.actions.is_empty());
}

#[tokio::test]
async fn delete_recovery_can_retry_after_target_removal_outlives_its_database_checkpoint() {
    let ws = workspace();
    let database = open_database(&ws.database_path);
    let skill = seed_skill(&database, "Retry interrupted removal").await;
    let library = CentralLibrary::initialize(ws.library_root.path()).expect("central library");
    seed_central_version(&library, &skill);
    let target_root = ws.scratch_dir.path().join("retry-target-root");
    let deployed_path = target_root.join("fixture");
    std::fs::create_dir_all(&deployed_path).expect("create deployed copy");
    std::fs::write(deployed_path.join("SKILL.md"), "# Owned deployment\n")
        .expect("write deployed copy");
    let target_id = skillhub_core::physical_id_for_path(&target_root)
        .expect("registered target physical identity");
    let deployment_id = seed_deployment(&database, skill.id(), &target_id, &target_root).await;
    let expected_hash =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&deployed_path)
            .expect("hash owned deployment");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET expected_hash=?1, observed_hash=?1 WHERE id=?2",
            rusqlite::params![expected_hash, deployment_id.to_string()],
        )
        .expect("persist deployment ownership proof");

    let facade = LocalApplicationFacade::new_with_library(
        open_database(&ws.database_path),
        ws.library_root.path(),
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    open_database(&ws.database_path)
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER block_delete_relation_checkpoint
             BEFORE UPDATE OF state ON deployments
             WHEN NEW.state='removed'
             BEGIN SELECT RAISE(ABORT, 'injected delete relation checkpoint failure'); END;",
        )
        .expect("inject relation checkpoint failure");

    let partial = commit_delete(
        &facade,
        impact.operation_id,
        vec![choice(
            deployment_id,
            RemovalDecision::RemoveOwnedTarget,
            false,
        )],
    )
    .await
    .expect("the deletion service should report a partial result");
    let AppCommandResult::RemovalResult(partial) = partial else {
        panic!("expected partial removal result");
    };
    assert_eq!(partial.state, RemovalResultState::PartiallyCommitted);
    assert!(!deployed_path.exists(), "the confirmed target was removed");
    assert!(recovery_candidate_ids(&facade)
        .await
        .contains(&impact.operation_id));

    let first_retry = facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: impact.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await;
    assert!(
        first_retry.is_err(),
        "the injected database failure must remain visible"
    );
    assert!(recovery_candidate_ids(&facade)
        .await
        .contains(&impact.operation_id));

    open_database(&ws.database_path)
        .connection_for_test()
        .execute_batch("DROP TRIGGER block_delete_relation_checkpoint;")
        .expect("remove injected failure");
    facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: impact.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("retry should reconcile the missing target and complete deletion");
    assert!(!recovery_candidate_ids(&facade)
        .await
        .contains(&impact.operation_id));
    assert_eq!(
        journal_record(&open_database(&ws.database_path), impact.operation_id).phase,
        skillhub_core::OperationPhase::Committed
    );
}
