use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, CommitUsageChange, GetRollbackImpact,
    PrepareUsageChange, ResolveRecovery, SetCurrentVersion,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::relationship::{
    UsageChangeImpact, UsageChangeItemResult, UsageChangeItemStatus, UsageChangeResult,
};
use skillhub_core::ApplicationFacade;
use skillhub_storage::{CentralLibrary, Database, VersionStore};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

struct Fixture {
    _root: TempDir,
    database_path: PathBuf,
    library_root: PathBuf,
    skill: Skill,
    first_version: skillhub_core::VersionRecord,
    target_version: skillhub_core::VersionRecord,
}

async fn fixture() -> Fixture {
    let root = tempfile::tempdir().expect("fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Sync repair");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let library = CentralLibrary::initialize(&library_root).expect("library");
    let store = VersionStore::from_library(&library);
    let first_source = tempfile::tempdir().expect("first source");
    std::fs::write(first_source.path().join("SKILL.md"), "# First\n").expect("first content");
    let first_version = store
        .capture(skill.id(), first_source.path())
        .expect("capture first version");
    let target_source = tempfile::tempdir().expect("target source");
    std::fs::write(target_source.path().join("SKILL.md"), "# Target\n").expect("target content");
    let target_version = store
        .capture(skill.id(), target_source.path())
        .expect("capture target version");
    store
        .set_current(skill.id(), &first_version.id)
        .expect("initial current pointer");
    database
        .record_current_version(skill.id(), &first_version)
        .expect("initial database pointer");
    library
        .materialize_current_skill(&skill, &first_version.id)
        .expect("materialize current");
    library
        .save_portable_skill(&skill, Some(&first_version.id))
        .expect("save portable metadata");

    Fixture {
        _root: root,
        database_path,
        library_root,
        skill,
        first_version,
        target_version,
    }
}

fn facade(fixture: &Fixture) -> LocalApplicationFacade {
    LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    )
}

fn seed_managed_copy(
    fixture: &Fixture,
    name: &str,
    version: &skillhub_core::VersionRecord,
    deployed_content: &str,
    on_disk_content: &str,
) -> (skillhub_core::DeploymentId, PathBuf) {
    let target_path = fixture._root.path().join(name).join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&destination).expect("create target entry");
    std::fs::write(destination.join("SKILL.md"), deployed_content).expect("seed copy");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("copy hash");
    if on_disk_content != deployed_content {
        std::fs::write(destination.join("SKILL.md"), on_disk_content).expect("fork copy");
    }
    let observed_hash = DeploymentFilesystem::hash_tree(&destination).expect("observed hash");
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("physical target identity");
    let database = Database::open(&fixture.database_path).expect("database for seed");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, ?2, 'global', ?3, 0)",
            rusqlite::params![target_id, name, target_path.to_string_lossy().to_string()],
        )
        .expect("insert target");
    database
        .record_version(fixture.skill.id(), version)
        .expect("record version");
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .deployment_repository()
        .insert_sync(&skillhub_core::DeploymentRecord {
            id: deployment_id,
            skill_id: fixture.skill.id(),
            version_id: version.id.clone(),
            target_id,
            state: skillhub_core::DeploymentState::Deployed,
            mode: skillhub_core::DeploymentMode::ManagedCopy,
            managed: true,
            runtime_name: fixture.skill.runtime_name().to_owned(),
            expected_hash: expected_hash.clone(),
            observed_hash: Some(observed_hash),
        })
        .expect("insert managed deployment");
    (deployment_id, destination)
}

fn usage_change(
    action: &str,
    relation_id: &str,
    content_basis: Option<&str>,
) -> PrepareUsageChange {
    serde_json::from_value(serde_json::json!({
        "operation_id": skillhub_core::OperationId::new(),
        "action": action,
        "relation_ids": [relation_id],
        "problem_id": null,
        "skill_id": null,
        "requested_form": null,
        "copy_disposition": null,
        "content_basis": content_basis,
        "retain_entry_key": null,
        "selected_entry_keys": [],
        "runtime_name": null,
        "base_version_id": null,
        "non_recognized_destination": null
    }))
    .expect("deserialize requested usage action")
}

fn deploy_row(
    fixture: &Fixture,
    deployment_id: skillhub_core::DeploymentId,
) -> skillhub_core::DeploymentRecord {
    let database = Database::open(&fixture.database_path).expect("reopen database");
    database
        .deployment_repository()
        .list_all()
        .expect("list deployments")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("managed deployment row")
}

fn prepare_and_commit(
    facade: &LocalApplicationFacade,
    request: PrepareUsageChange,
) -> UsageChangeResult {
    let prepared = facade
        .prepare_usage_change(request)
        .expect("prepare action");
    facade
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("commit action")
}

async fn adopt_target_version(facade: &LocalApplicationFacade, fixture: &Fixture) -> String {
    let result = facade
        .query(AppQuery::GetRollbackImpact(GetRollbackImpact {
            skill_id: fixture.skill.id(),
            target_version_id: fixture.target_version.id.clone(),
        }))
        .await
        .expect("prepare adoption");
    let AppQueryResult::RollbackImpact(impact) = result else {
        panic!("expected rollback impact");
    };
    let result = facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id: impact.preview_id,
        }))
        .await
        .expect("adopt version");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    summary.message_code
}

#[tokio::test]
async fn sync_failure_remains_managed_and_retries_after_restart() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "retry-agent",
        &fixture.first_version,
        "# First\n",
        "# Forked\n",
    );
    let first_facade = facade(&fixture);
    assert_eq!(
        adopt_target_version(&first_facade, &fixture).await,
        "version.adopted_deployment_partial"
    );
    drop(first_facade);
    let restarted_facade = facade(&fixture);
    let after_restart = deploy_row(&fixture, deployment_id);
    assert!(after_restart.managed);
    assert_eq!(after_restart.version_id, fixture.first_version.id);

    let prepared = restarted_facade
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare retry");
    let manifest_path = version_manifest_path(&fixture, &fixture.target_version);
    let manifest = std::fs::read(&manifest_path).expect("save source manifest");
    std::fs::remove_file(&manifest_path).expect("temporarily make source unverifiable");
    let failed = restarted_facade
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return per-target sync failure");
    assert_eq!(failed.item_results[0].status, UsageChangeItemStatus::Failed);
    assert!(deploy_row(&fixture, deployment_id).managed);
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.first_version.id
    );
    let database = Database::open(&fixture.database_path).expect("database after failed sync");
    let failed_relation = database
        .relationship_repository()
        .list_relations()
        .expect("managed relation facts")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relation after failed sync");
    assert_eq!(
        failed_relation.health_reasons,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::ContentChanged,
            skillhub_core::relationship::RelationHealthReason::OperationFailed,
        ])
    );
    drop(database);

    std::fs::write(&manifest_path, manifest).expect("restore source manifest");
    drop(restarted_facade);
    let retry_facade = facade(&fixture);
    let result = prepare_and_commit(
        &retry_facade,
        usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ),
    );
    assert_eq!(result.item_results.len(), 1);
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("synced content"),
        "# Target\n"
    );
    let after_retry = deploy_row(&fixture, deployment_id);
    assert!(after_retry.managed);
    assert_eq!(after_retry.version_id, fixture.target_version.id);
    let database = Database::open(&fixture.database_path).expect("database after retry");
    let recovered_relation = database
        .relationship_repository()
        .list_relations()
        .expect("managed relation facts after retry")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relation after retry");
    assert_eq!(recovered_relation.health_reasons, Some(Vec::new()));
}

#[tokio::test]
async fn interrupted_managed_change_before_first_write_can_be_rolled_back() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "interrupted-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare managed sync");
    let database = Database::open(&fixture.database_path).expect("open database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation")
        .expect("operation exists");
    let deployment_before = deploy_row(&fixture, deployment_id);
    let relation_before = database
        .relationship_repository()
        .list_relations()
        .expect("read original managed relation")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relation exists");
    record.phase = skillhub_core::OperationPhase::Applying;
    record.progress.phase = record.phase;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("simulate interruption after write checkpoint");
    drop(database);
    drop(app);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("interrupted managed change remains visible");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::RollbackOperation]
    );

    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::RollbackOperation,
        }))
        .await
        .expect("settle an untouched managed change");
    let settled = Database::open(&fixture.database_path)
        .expect("reopen database")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read settled operation")
        .expect("operation remains recorded");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::RolledBack);
    assert_eq!(deploy_row(&fixture, deployment_id), deployment_before);
    let relation_after = Database::open(&fixture.database_path)
        .expect("reopen database after recovery")
        .relationship_repository()
        .list_relations()
        .expect("read managed relation after recovery")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relation remains");
    assert_eq!(relation_after, relation_before);
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("target content"),
        "# First\n"
    );
}

#[tokio::test]
async fn managed_sync_after_filesystem_write_can_resume_database_commit_after_restart() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "sync-recovery-agent",
        &fixture.first_version,
        "# First\n",
        "# Forked\n",
    );
    let app = facade(&fixture);
    assert_eq!(
        adopt_target_version(&app, &fixture).await,
        "version.adopted_deployment_partial"
    );
    let prepared = app
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare managed sync");

    let database = Database::open(&fixture.database_path).expect("open database for fault");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_sync_reconcile BEFORE UPDATE ON deployments
             WHEN OLD.id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected reconcile failure'); END;",
            deployment_id
        ))
        .expect("install deployment update fault");
    drop(database);

    let interrupted = app
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return a recoverable per-target failure");
    assert_eq!(
        interrupted.item_results[0].status,
        UsageChangeItemStatus::RecoveryRequired
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("written target"),
        "# Target\n"
    );
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.first_version.id
    );
    drop(app);

    let database = Database::open(&fixture.database_path).expect("open database after fault");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_sync_reconcile;")
        .expect("remove deployment update fault");
    drop(database);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates after restart")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("partially applied sync remains visible");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );

    std::fs::write(destination.join("SKILL.md"), "# User change\n")
        .expect("simulate target drift after candidate listing");
    let stale_completion = restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect_err("completion must recheck the target after listing");
    assert_eq!(
        stale_completion.code,
        skillhub_core::ErrorCode::OperationConflict
    );
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.first_version.id
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("preserved user change"),
        "# User change\n"
    );
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("recheck candidate after target drift")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("drifted operation remains visible")
        .actions
        .is_empty());

    std::fs::write(destination.join("SKILL.md"), "# Target\n")
        .expect("restore exact target content");
    let expected_hash = deploy_row(&fixture, deployment_id).expected_hash;
    let database = Database::open(&fixture.database_path).expect("open database for drift");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET expected_hash='changed-outside-operation' WHERE id=?1",
            rusqlite::params![deployment_id.to_string()],
        )
        .expect("simulate deployment fact drift");
    drop(database);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list candidates after deployment fact drift")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("database-drifted operation remains visible")
        .actions
        .is_empty());
    let database = Database::open(&fixture.database_path).expect("restore database facts");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET expected_hash=?1 WHERE id=?2",
            rusqlite::params![expected_hash, deployment_id.to_string()],
        )
        .expect("restore deployment fact");
    drop(database);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("recheck candidates after restoring facts")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("restored operation remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );

    let database =
        Database::open(&fixture.database_path).expect("open database for recovery fault");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_managed_usage_settlement BEFORE UPDATE ON operations
             WHEN OLD.operation_id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END;",
            prepared.operation_id
        ))
        .expect("install recovery journal fault");
    drop(database);
    let settlement_error = restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect_err("journal settlement fault leaves a resumable operation");
    assert_eq!(
        settlement_error.code,
        skillhub_core::ErrorCode::InternalError
    );
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.target_version.id
    );
    let interrupted_settlement =
        Database::open(&fixture.database_path).expect("open database after recovery fault");
    let still_pending = interrupted_settlement
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read recovery operation")
        .expect("recovery operation remains");
    assert_eq!(
        still_pending.phase,
        skillhub_core::OperationPhase::NeedsRecovery
    );
    interrupted_settlement
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_managed_usage_settlement;")
        .expect("remove recovery journal fault");
    drop(interrupted_settlement);
    drop(restarted);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list candidates after second restart")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("recovery remains visible after partial settlement")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("resume the journal settlement without repeating file work");
    let settled = Database::open(&fixture.database_path)
        .expect("reopen settled database")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read recovered operation")
        .expect("operation remains recorded");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::Committed);
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.target_version.id
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("preserved target"),
        "# Target\n"
    );
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates after settlement")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .all(|candidate| candidate.operation_id != prepared.operation_id));
}

#[tokio::test]
async fn interrupted_managed_change_with_backup_only_can_be_settled_without_touching_it() {
    for backup_checkpointed in [false, true] {
        let fixture = fixture().await;
        let (deployment_id, destination) = seed_managed_copy(
            &fixture,
            "backup-checkpoint-agent",
            &fixture.first_version,
            "# First\n",
            "# First\n",
        );
        let app = facade(&fixture);
        let prepared = app
            .prepare_usage_change(usage_change(
                "sync",
                &format!("managed:{deployment_id}"),
                Some("library_current"),
            ))
            .expect("prepare managed sync");
        let database = Database::open(&fixture.database_path).expect("open database");
        let deployment_before = deploy_row(&fixture, deployment_id);
        let relation_before = database
            .relationship_repository()
            .list_relations()
            .expect("read original managed relation")
            .into_iter()
            .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
            .expect("managed relation exists");
        let mut record = database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read operation")
            .expect("operation exists");
        let backup_path = PathBuf::from(
            record.recovery_data["plans"][0]["backup_path"]
                .as_str()
                .expect("backup path"),
        );
        std::fs::create_dir_all(&backup_path).expect("create operation backup");
        std::fs::copy(destination.join("SKILL.md"), backup_path.join("SKILL.md"))
            .expect("copy original target into backup");
        record.phase = skillhub_core::OperationPhase::Applying;
        record.progress.phase = record.phase;
        record.recovery_data["plans"][0]["backup_created"] = serde_json::json!(backup_checkpointed);
        database
            .operation_repository()
            .update_sync(&record)
            .expect("simulate interruption after backup creation");
        drop(database);
        drop(app);

        let restarted = facade(&fixture);
        let AppQueryResult::RecoveryCandidates(candidates) = restarted
            .query(AppQuery::ListRecoveryCandidates)
            .await
            .expect("list recovery candidates")
        else {
            panic!("expected recovery candidates");
        };
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("interrupted managed change remains visible");
        assert_eq!(
            candidate.actions,
            vec![skillhub_core::RecoveryAction::RollbackOperation],
            "an unchanged target is safe to settle when interruption leaves only its backup"
        );

        restarted
            .execute(AppCommand::ResolveRecovery(ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::RollbackOperation,
            }))
            .await
            .expect("settle managed change without target writes");
        let settled = Database::open(&fixture.database_path)
            .expect("reopen database")
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read settled operation")
            .expect("operation remains recorded");
        assert_eq!(settled.phase, skillhub_core::OperationPhase::RolledBack);
        assert_eq!(deploy_row(&fixture, deployment_id), deployment_before);
        assert_eq!(
            std::fs::read_to_string(destination.join("SKILL.md")).expect("target content"),
            "# First\n"
        );
        assert_eq!(
            std::fs::read_to_string(backup_path.join("SKILL.md")).expect("preserved backup"),
            "# First\n",
            "recovery must not delete or rewrite a backup whose identity was not journaled"
        );
        let relation_after = Database::open(&fixture.database_path)
            .expect("reopen database after recovery")
            .relationship_repository()
            .list_relations()
            .expect("read managed relation after recovery")
            .into_iter()
            .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
            .expect("managed relation remains");
        assert_eq!(relation_after, relation_before);
    }
}

#[tokio::test]
async fn interrupted_managed_change_with_drift_has_no_automatic_action() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "drifted-interrupted-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare managed sync");
    let database = Database::open(&fixture.database_path).expect("open database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation")
        .expect("operation exists");
    let backup_path = PathBuf::from(
        record.recovery_data["plans"][0]["backup_path"]
            .as_str()
            .expect("backup path"),
    );
    std::fs::create_dir_all(&backup_path).expect("create uncheckpointed backup");
    std::fs::copy(destination.join("SKILL.md"), backup_path.join("SKILL.md"))
        .expect("copy original target into backup");
    record.phase = skillhub_core::OperationPhase::Applying;
    record.progress.phase = record.phase;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("simulate interruption after write checkpoint");
    drop(database);
    drop(app);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("interrupted managed change remains visible");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::RollbackOperation]
    );

    std::fs::write(destination.join("SKILL.md"), "# User change\n").expect("simulate target drift");
    let error = match restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::RollbackOperation,
        }))
        .await
    {
        Ok(_) => panic!("stale rollback should be rejected after target drift"),
        Err(error) => error,
    };
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);

    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("recheck candidates after target drift")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("interrupted managed change remains visible");
    assert!(candidate.actions.is_empty());
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("preserved target"),
        "# User change\n"
    );
    drop(restarted);

    std::fs::write(destination.join("SKILL.md"), "# First\n")
        .expect("restore target before database drift case");
    let database = Database::open(&fixture.database_path).expect("open database for drift");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET expected_hash='changed-outside-operation' WHERE id=?1",
            rusqlite::params![deployment_id.to_string()],
        )
        .expect("simulate deployment fact drift");
    drop(database);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list candidates after database drift")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("interrupted managed change remains visible after database drift");
    assert!(candidate.actions.is_empty());
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("target preserved"),
        "# First\n"
    );
    assert_eq!(
        std::fs::read_to_string(backup_path.join("SKILL.md")).expect("backup preserved"),
        "# First\n"
    );
}

fn version_manifest_path(fixture: &Fixture, version: &skillhub_core::VersionRecord) -> PathBuf {
    fixture
        .library_root
        .join(".skillhub")
        .join("versions")
        .join(fixture.skill.id().to_string())
        .join(format!(
            "{}.json",
            version
                .id
                .as_str()
                .strip_prefix("sha256:")
                .unwrap_or(version.id.as_str())
        ))
}

#[tokio::test]
async fn forked_copy_is_not_overwritten_without_content_choice() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "forked-agent",
        &fixture.first_version,
        "# First\n",
        "# User edit\n",
    );
    let app = facade(&fixture);
    let error = app
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            None,
        ))
        .expect_err("forked copy requires an explicit content choice");
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("usage_sync_content_choice_required")
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("user content"),
        "# User edit\n"
    );
    assert!(deploy_row(&fixture, deployment_id).managed);
}

#[tokio::test]
async fn missing_entry_requires_explicit_restore() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "missing-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    std::fs::remove_dir_all(&destination).expect("remove target");
    let app = facade(&fixture);
    let error = app
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect_err("sync must not restore a missing entry implicitly");
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert!(!destination.exists());

    let result = prepare_and_commit(
        &app,
        usage_change("restore", &format!("managed:{deployment_id}"), None),
    );
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored copy"),
        "# First\n"
    );
    let database = Database::open(&fixture.database_path).expect("database after restore");
    let operation = database
        .operation_repository()
        .get_sync(result.operation_id)
        .expect("read restore operation")
        .expect("restore operation exists");
    assert!(
        operation.recovery_data["plans"][0]["created_entry_identity"]
            .as_str()
            .is_some(),
        "the created entry identity is persisted in the operation journal"
    );
}

#[cfg(unix)]
fn seed_managed_link(fixture: &Fixture) -> (skillhub_core::DeploymentId, PathBuf, PathBuf) {
    use std::os::unix::fs::symlink;
    let target_path = fixture._root.path().join("link-agent").join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&target_path).expect("create target");
    let visible_tree = fixture.library_root.join("skills").join(format!(
        "{}-{}",
        fixture.skill.runtime_name(),
        fixture.skill.id()
    ));
    let visible_tree = if visible_tree.exists() {
        visible_tree
    } else {
        std::fs::read_dir(fixture.library_root.join("skills"))
            .expect("skills directory")
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(&fixture.skill.id().to_string())
            })
            .expect("visible skill tree")
            .path()
    };
    symlink(&visible_tree, &destination).expect("create managed link");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash link");
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("physical target identity");
    let database = Database::open(&fixture.database_path).expect("database");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'link-agent', 'global', ?2, 0)",
            rusqlite::params![target_id, target_path.to_string_lossy().to_string()],
        )
        .expect("insert target");
    database
        .record_version(fixture.skill.id(), &fixture.first_version)
        .expect("record version");
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .deployment_repository()
        .insert_sync(&skillhub_core::DeploymentRecord {
            id: deployment_id,
            skill_id: fixture.skill.id(),
            version_id: fixture.first_version.id.clone(),
            target_id,
            state: skillhub_core::DeploymentState::Deployed,
            mode: skillhub_core::DeploymentMode::SymbolicLink,
            managed: true,
            runtime_name: fixture.skill.runtime_name().to_owned(),
            expected_hash: expected_hash.clone(),
            observed_hash: Some(expected_hash),
        })
        .expect("insert managed link");
    (deployment_id, destination, visible_tree)
}

#[cfg(windows)]
fn seed_managed_link(fixture: &Fixture) -> (skillhub_core::DeploymentId, PathBuf, PathBuf) {
    let target_path = fixture._root.path().join("link-agent").join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&target_path).expect("create target");
    let visible_tree = std::fs::read_dir(fixture.library_root.join("skills"))
        .expect("skills directory")
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(&fixture.skill.id().to_string())
        })
        .expect("visible skill tree")
        .path();
    skillhub_adapters::deployment::create_junction(&visible_tree, &destination)
        .expect("create managed junction");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash junction");
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("physical target identity");
    let database = Database::open(&fixture.database_path).expect("database");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'link-agent', 'global', ?2, 0)",
            rusqlite::params![target_id, target_path.to_string_lossy().to_string()],
        )
        .expect("insert target");
    database
        .record_version(fixture.skill.id(), &fixture.first_version)
        .expect("record version");
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .deployment_repository()
        .insert_sync(&skillhub_core::DeploymentRecord {
            id: deployment_id,
            skill_id: fixture.skill.id(),
            version_id: fixture.first_version.id.clone(),
            target_id,
            state: skillhub_core::DeploymentState::Deployed,
            mode: skillhub_core::DeploymentMode::DirectoryJunction,
            managed: true,
            runtime_name: fixture.skill.runtime_name().to_owned(),
            expected_hash: expected_hash.clone(),
            observed_hash: Some(expected_hash),
        })
        .expect("insert managed junction");
    (deployment_id, destination, visible_tree)
}

#[tokio::test]
async fn replaced_link_requires_backup() {
    let fixture = fixture().await;
    let (deployment_id, destination, _visible_tree) = seed_managed_link(&fixture);
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove old symlink");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove old junction");
    std::fs::create_dir_all(&destination).expect("replace link with a directory");
    std::fs::write(destination.join("user.txt"), "keep me").expect("replacement content");
    let app = facade(&fixture);
    let result = prepare_and_commit(
        &app,
        usage_change(
            "repair",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ),
    );
    let item = &result.item_results[0];
    assert_eq!(item.status, UsageChangeItemStatus::Applied, "{item:?}");
    let backup = item
        .recovery_point
        .as_ref()
        .expect("replacement backup retained");
    assert_eq!(
        std::fs::read_to_string(Path::new(&backup.path).join("user.txt"))
            .expect("read backed up replacement"),
        "keep me"
    );
    assert!(deploy_row(&fixture, deployment_id).managed);
}

#[tokio::test]
async fn restore_uses_real_target_mode() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "copy-mode-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    std::fs::remove_dir_all(&destination).expect("remove target");
    let result = prepare_and_commit(
        &facade(&fixture),
        usage_change("restore", &format!("managed:{deployment_id}"), None),
    );
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    let restored = std::fs::symlink_metadata(&destination).expect("restored entry");
    assert!(!restored.file_type().is_symlink());
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored content"),
        "# First\n"
    );
}

#[tokio::test]
async fn managed_batch_stops_after_first_recovery_required_item() {
    let fixture = fixture().await;
    let (first_id, first_destination) = seed_managed_copy(
        &fixture,
        "batch-first-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    let (second_id, second_destination) = seed_managed_copy(
        &fixture,
        "batch-second-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    let app = facade(&fixture);
    let library = CentralLibrary::initialize(&fixture.library_root).expect("open library");
    VersionStore::from_library(&library)
        .set_current(fixture.skill.id(), &fixture.target_version.id)
        .expect("adopt target version in library");
    Database::open(&fixture.database_path)
        .expect("open database")
        .record_current_version(fixture.skill.id(), &fixture.target_version)
        .expect("adopt target version in database");
    library
        .materialize_current_skill(&fixture.skill, &fixture.target_version.id)
        .expect("materialize adopted target version");
    library
        .save_portable_skill(&fixture.skill, Some(&fixture.target_version.id))
        .expect("save adopted target version");
    let mut request = usage_change(
        "sync",
        &format!("managed:{first_id}"),
        Some("library_current"),
    );
    request.relation_ids.push(format!("managed:{second_id}"));
    let prepared = app
        .prepare_usage_change(request)
        .expect("prepare managed sync batch");
    let database = Database::open(&fixture.database_path).expect("open database");
    let record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read prepared batch")
        .expect("prepared operation exists");
    let first_plan_id = record.recovery_data["plans"][0]["deployment_id"]
        .as_str()
        .expect("first plan deployment id");
    let first_plan_is_first = first_plan_id == first_id.to_string();
    let failing_id = if first_plan_is_first {
        first_id
    } else {
        second_id
    };
    let failing_destination = if first_plan_is_first {
        &first_destination
    } else {
        &second_destination
    };
    let untouched_destination = if first_plan_is_first {
        &second_destination
    } else {
        &first_destination
    };
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_batch_first_reconcile BEFORE UPDATE ON deployments
             WHEN OLD.id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected first batch reconcile failure'); END;",
            failing_id
        ))
        .expect("install first target database fault");
    drop(database);

    let result = app
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return the per-target recovery result");
    assert_eq!(result.item_results.len(), 2);
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::RecoveryRequired
    );
    assert_eq!(result.item_results[1].status, UsageChangeItemStatus::Failed);
    assert_eq!(
        result.item_results[1].reason.as_deref(),
        Some("not_attempted_after_recovery")
    );
    assert_eq!(
        std::fs::read_to_string(failing_destination.join("SKILL.md"))
            .expect("first target content"),
        "# Target\n"
    );
    assert_eq!(
        std::fs::read_to_string(untouched_destination.join("SKILL.md"))
            .expect("untouched target content"),
        "# First\n",
        "the batch must stop after plan {failing_id}; untouched path is {}",
        untouched_destination.display()
    );
    drop(app);
    let database = Database::open(&fixture.database_path).expect("open database after batch");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_batch_first_reconcile;")
        .expect("remove first target database fault");
    drop(database);
    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list batch recovery candidate")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("paused batch remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("settle the interrupted first target without starting the tail");
    assert_eq!(
        std::fs::read_to_string(untouched_destination.join("SKILL.md"))
            .expect("untouched target after recovery"),
        "# First\n"
    );
    let settled = Database::open(&fixture.database_path)
        .expect("reopen settled database")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read settled batch")
        .expect("batch operation exists");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::Committed);
    let settled_result: UsageChangeResult =
        serde_json::from_value(settled.result.expect("settled result"))
            .expect("decode settled batch result");
    assert_eq!(
        settled_result.item_results[1].status,
        UsageChangeItemStatus::Failed
    );
}

#[tokio::test]
async fn managed_repair_crash_after_identity_checkpoint_before_reconcile_is_recoverable() {
    let fixture = fixture().await;
    let (deployment_id, destination, _visible_tree) = seed_managed_link(&fixture);
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove old symlink");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove old junction");
    std::fs::create_dir_all(&destination).expect("replace link with a directory");
    std::fs::write(destination.join("user.txt"), "keep me").expect("replacement content");
    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "repair",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare managed repair");

    let database = Database::open(&fixture.database_path).expect("open database");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_repair_reconcile BEFORE UPDATE ON deployments
             WHEN OLD.id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected repair reconcile failure'); END;",
            deployment_id
        ))
        .expect("install deployment update fault");
    drop(database);
    let interrupted = app
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return a recoverable repair failure");
    assert_eq!(
        interrupted.item_results[0].status,
        UsageChangeItemStatus::RecoveryRequired
    );
    drop(app);

    let database = Database::open(&fixture.database_path).expect("open database after fault");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_repair_reconcile;")
        .expect("remove deployment update fault");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read interrupted operation")
        .expect("operation exists");
    let created_identity = record.recovery_data["plans"][0]["created_entry_identity"]
        .as_str()
        .expect("new link identity was persisted before reconciliation")
        .to_owned();
    assert_eq!(
        DeploymentFilesystem::new()
            .recovery_entry_identity(deploy_row(&fixture, deployment_id).mode, &destination)
            .expect("read installed link identity"),
        created_identity
    );
    let original_relation: skillhub_core::relationship::DeploymentRelationFact =
        serde_json::from_value(record.recovery_data["plans"][0]["original_relation"].clone())
            .expect("original relationship fact");
    database
        .relationship_repository()
        .upsert_deployment_relation(&original_relation)
        .expect("restore relationship facts from before reconciliation");
    record.recovery_data["completed"] = serde_json::json!([]);
    record.result = Some(record.recovery_data["prepared"].clone());
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = record.phase;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("simulate process exit after identity but before database receipt");
    drop(database);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list interrupted repair candidate")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("interrupted repair remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("finish reconciliation for the verified link");
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.first_version.id
    );
}

#[tokio::test]
async fn managed_restore_after_filesystem_write_can_resume_database_commit_after_restart() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "restore-recovery-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    std::fs::remove_dir_all(&destination).expect("remove target before restore");
    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "restore",
            &format!("managed:{deployment_id}"),
            None,
        ))
        .expect("prepare managed restore");

    let database = Database::open(&fixture.database_path).expect("open database for fault");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_restore_reconcile BEFORE UPDATE ON deployments
             WHEN OLD.id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected restore reconcile failure'); END;",
            deployment_id
        ))
        .expect("install deployment update fault");
    drop(database);

    let interrupted = app
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return a recoverable restore failure");
    assert_eq!(
        interrupted.item_results[0].status,
        UsageChangeItemStatus::RecoveryRequired
    );
    assert!(interrupted.recovery_required);
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored target"),
        "# First\n"
    );
    drop(app);

    let database = Database::open(&fixture.database_path).expect("open database after fault");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_restore_reconcile;")
        .expect("remove deployment update fault");
    drop(database);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list restore recovery candidates after restart")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("partially applied restore remains visible");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );

    std::fs::write(destination.join("SKILL.md"), "# User change\n")
        .expect("simulate target drift after candidate listing");
    let stale_completion = restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect_err("completion must recheck the restored target");
    assert_eq!(
        stale_completion.code,
        skillhub_core::ErrorCode::OperationConflict
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("preserved target change"),
        "# User change\n"
    );
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("recheck candidate after target drift")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("drifted restore remains visible")
        .actions
        .is_empty());

    std::fs::write(destination.join("SKILL.md"), "# First\n")
        .expect("restore exact target content");
    let database =
        Database::open(&fixture.database_path).expect("open database for settlement fault");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_restore_settlement BEFORE UPDATE ON operations
             WHEN OLD.operation_id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected restore settlement failure'); END;",
            prepared.operation_id
        ))
        .expect("install recovery journal fault");
    drop(database);

    let settlement_error = restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect_err("journal settlement fault leaves a resumable operation");
    assert_eq!(
        settlement_error.code,
        skillhub_core::ErrorCode::InternalError
    );
    let settled_facts = deploy_row(&fixture, deployment_id);
    assert_eq!(settled_facts.version_id, fixture.first_version.id);
    assert_eq!(
        settled_facts.observed_hash.as_deref(),
        Some(settled_facts.expected_hash.as_str())
    );

    let database =
        Database::open(&fixture.database_path).expect("open database after settlement fault");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_restore_settlement;")
        .expect("remove recovery journal fault");
    let still_pending = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read restore operation")
        .expect("restore operation remains");
    assert_eq!(
        still_pending.phase,
        skillhub_core::OperationPhase::NeedsRecovery
    );
    drop(database);
    drop(restarted);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list candidates after settlement restart")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("restore remains recoverable after restart")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("resume restore journal settlement");
    let settled = Database::open(&fixture.database_path)
        .expect("reopen settled database")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read recovered operation")
        .expect("operation remains recorded");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::Committed);
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("preserved restored target"),
        "# First\n"
    );
}

#[tokio::test]
async fn managed_link_restore_after_filesystem_write_can_resume_database_commit() {
    let fixture = fixture().await;
    let (deployment_id, destination, _visible_tree) = seed_managed_link(&fixture);
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove target link before restore");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove target junction before restore");
    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "restore",
            &format!("managed:{deployment_id}"),
            None,
        ))
        .expect("prepare managed link restore");

    let database = Database::open(&fixture.database_path).expect("open database for fault");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_link_restore_reconcile BEFORE UPDATE ON deployments
             WHEN OLD.id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected link restore reconcile failure'); END;",
            deployment_id
        ))
        .expect("install deployment update fault");
    drop(database);
    let interrupted = app
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return a recoverable link restore failure");
    assert_eq!(
        interrupted.item_results[0].status,
        UsageChangeItemStatus::RecoveryRequired
    );
    drop(app);

    let database = Database::open(&fixture.database_path).expect("open database after fault");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_link_restore_reconcile;")
        .expect("remove deployment update fault");
    drop(database);
    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list link restore recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("partially applied link restore remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("complete link restore after restart");
    let deployment = deploy_row(&fixture, deployment_id);
    let expected_mode = if cfg!(windows) {
        skillhub_core::DeploymentMode::DirectoryJunction
    } else {
        skillhub_core::DeploymentMode::SymbolicLink
    };
    assert_eq!(deployment.mode, expected_mode);
    assert!(DeploymentFilesystem::new()
        .recovery_entry_identity(expected_mode, &destination)
        .is_ok());
    assert_eq!(
        Database::open(&fixture.database_path)
            .expect("reopen recovered database")
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read recovered operation")
            .expect("operation remains recorded")
            .phase,
        skillhub_core::OperationPhase::Committed
    );
}

#[tokio::test]
async fn interrupted_managed_repair_during_target_removal_can_restore_verified_backup() {
    let fixture = fixture().await;
    let (deployment_id, destination, _visible_tree) = seed_managed_link(&fixture);
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove original symlink");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove original junction");
    std::fs::create_dir_all(&destination).expect("create damaged link replacement");
    std::fs::write(destination.join("keep.txt"), "keep me").expect("replacement content");
    std::fs::write(destination.join("removed.txt"), "restore me")
        .expect("content that recursive removal partially removes");

    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "repair",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare managed repair");

    let database = Database::open(&fixture.database_path).expect("open database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read prepared operation")
        .expect("operation exists");
    let backup = PathBuf::from(
        record.recovery_data["plans"][0]["backup_path"]
            .as_str()
            .expect("operation backup path"),
    );
    std::fs::create_dir_all(&backup).expect("create operation backup");
    std::fs::copy(destination.join("keep.txt"), backup.join("keep.txt"))
        .expect("back up surviving file");
    std::fs::copy(destination.join("removed.txt"), backup.join("removed.txt"))
        .expect("back up file removed before interruption");

    record.phase = skillhub_core::OperationPhase::Applying;
    record.progress.phase = record.phase;
    record.recovery_data["plans"][0]["backup_created"] = serde_json::json!(true);
    record.recovery_data["plans"][0]["repair_removal_started"] = serde_json::json!(true);
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist repair removal checkpoint");
    std::fs::remove_file(destination.join("removed.txt"))
        .expect("simulate a crash during recursive removal");
    drop(database);
    drop(app);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list candidates after restart")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("interrupted repair remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::RollbackOperation]
    );

    std::fs::write(destination.join("keep.txt"), "external change")
        .expect("simulate target drift after candidate listing");
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("recheck candidates after target drift")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("drifted repair remains visible")
        .actions
        .is_empty());
    assert_eq!(
        std::fs::read_to_string(destination.join("keep.txt")).expect("preserve drifted file"),
        "external change"
    );
    std::fs::write(destination.join("keep.txt"), "keep me")
        .expect("restore the known partial state");
    std::fs::write(destination.join("removed.txt"), "restore")
        .expect("simulate an interrupted partial backup copy");
    let database = Database::open(&fixture.database_path).expect("open recovery journal");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read recovery operation")
        .expect("operation remains recorded");
    record.recovery_data["plans"][0]["repair_restore_started"] = serde_json::json!(true);
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist recovery restore checkpoint");
    drop(database);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list candidates after interrupted restore")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("partially restored repair remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::RollbackOperation]
    );

    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::RollbackOperation,
        }))
        .await
        .expect("restore the original occupied directory");
    assert_eq!(
        std::fs::read_to_string(destination.join("keep.txt")).expect("surviving file"),
        "keep me"
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("removed.txt")).expect("restored file"),
        "restore me"
    );
    let settled = Database::open(&fixture.database_path)
        .expect("reopen database")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read settled operation")
        .expect("operation remains recorded");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::RolledBack);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list candidates after rollback")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .all(|candidate| candidate.operation_id != prepared.operation_id));
}

#[tokio::test]
async fn managed_repair_rollback_rejects_recovery_item_without_removal_checkpoint() {
    let fixture = fixture().await;
    let (deployment_id, destination, _visible_tree) = seed_managed_link(&fixture);
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove original symlink");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove original junction");
    std::fs::create_dir_all(&destination).expect("create damaged link replacement");
    std::fs::write(destination.join("keep.txt"), "keep me").expect("replacement content");

    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "repair",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare managed repair");

    let database = Database::open(&fixture.database_path).expect("open database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read prepared operation")
        .expect("operation exists");
    let original_plan = record.recovery_data["plans"][0].clone();
    let mut pending_plan = original_plan.clone();
    pending_plan["repair_removal_started"] = serde_json::json!(true);
    pending_plan["backup_created"] = serde_json::json!(true);
    let backup = PathBuf::from(
        pending_plan["backup_path"]
            .as_str()
            .expect("operation backup path"),
    );
    std::fs::create_dir_all(&backup).expect("create operation backup");
    std::fs::copy(destination.join("keep.txt"), backup.join("keep.txt"))
        .expect("back up target content");

    let evidence = record.recovery_data["prepared"]["entry_evidence"][0].clone();
    let impact: UsageChangeImpact =
        serde_json::from_value(record.recovery_data["prepared"]["impacts"][0].clone())
            .expect("decode prepared impact");
    let unrelated_recovery = UsageChangeItemResult {
        relation_ids: impact.relation_ids.clone(),
        skill_id: impact.skill_id,
        target: impact.target.clone(),
        action: impact.action,
        status: UsageChangeItemStatus::RecoveryRequired,
        reason: Some("failure_fact_not_recorded".to_owned()),
        recovery_point: None,
    };
    let mut updated_prepared = record.recovery_data["prepared"].clone();
    updated_prepared["entry_evidence"] = serde_json::json!([evidence.clone(), evidence]);
    updated_prepared["impacts"] = serde_json::json!([
        impact,
        serde_json::from_value::<UsageChangeImpact>(
            record.recovery_data["prepared"]["impacts"][0].clone()
        )
        .expect("decode second prepared impact")
    ]);
    record.recovery_data["prepared"] = updated_prepared.clone();
    record.recovery_data["plans"] = serde_json::json!([original_plan, pending_plan]);
    record.recovery_data["completed"] = serde_json::json!([unrelated_recovery]);
    record.result = Some(updated_prepared);
    record.phase = skillhub_core::OperationPhase::Applying;
    record.progress.phase = record.phase;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist mixed recovery state");
    drop(database);
    drop(app);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("mixed recovery remains visible")
        .actions
        .is_empty());
}

#[tokio::test]
async fn managed_repair_crash_after_reconcile_before_item_receipt_keeps_success_facts() {
    let fixture = fixture().await;
    let (deployment_id, destination, _visible_tree) = seed_managed_link(&fixture);
    let library = CentralLibrary::initialize(&fixture.library_root).expect("open library");
    VersionStore::from_library(&library)
        .set_current(fixture.skill.id(), &fixture.target_version.id)
        .expect("adopt target version in library");
    Database::open(&fixture.database_path)
        .expect("open database")
        .record_current_version(fixture.skill.id(), &fixture.target_version)
        .expect("adopt target version in database");
    library
        .materialize_current_skill(&fixture.skill, &fixture.target_version.id)
        .expect("materialize adopted target version");
    library
        .save_portable_skill(&fixture.skill, Some(&fixture.target_version.id))
        .expect("save adopted target version");
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove old symlink");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove old junction");
    std::fs::create_dir_all(&destination).expect("replace link with a directory");
    std::fs::write(destination.join("user.txt"), "keep me").expect("replacement content");

    let app = facade(&fixture);
    let result = prepare_and_commit(
        &app,
        usage_change(
            "repair",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ),
    );
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    let database = Database::open(&fixture.database_path).expect("open database");
    let mut record = database
        .operation_repository()
        .get_sync(result.operation_id)
        .expect("read completed operation")
        .expect("operation exists");
    assert!(record.recovery_data["plans"][0]["created_entry_identity"]
        .as_str()
        .is_some());
    record.recovery_data["completed"] = serde_json::json!([]);
    record.result = Some(record.recovery_data["prepared"].clone());
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = record.phase;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("simulate process exit after database reconciliation");
    drop(database);
    drop(app);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == result.operation_id)
            .expect("interrupted repair remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: result.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("settle the already reconciled repair without marking it failed");

    let settled_database = Database::open(&fixture.database_path).expect("reopen database");
    let settled = settled_database
        .operation_repository()
        .get_sync(result.operation_id)
        .expect("read settled operation")
        .expect("operation remains recorded");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::Committed);
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.target_version.id
    );
    let relation = settled_database
        .relationship_repository()
        .list_relations()
        .expect("read reconciled relationship")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relationship exists");
    assert_eq!(relation.health_reasons, Some(Vec::new()));
}

#[tokio::test]
async fn managed_repair_crash_after_link_install_before_identity_checkpoint_is_recoverable() {
    let fixture = fixture().await;
    let (deployment_id, destination, visible_tree) = seed_managed_link(&fixture);
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove old symlink");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove old junction");
    std::fs::create_dir_all(&destination).expect("replace link with a directory");
    std::fs::write(destination.join("user.txt"), "keep me").expect("replacement content");
    let app = facade(&fixture);
    let prepared = app
        .prepare_usage_change(usage_change(
            "repair",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare managed repair");

    let database = Database::open(&fixture.database_path).expect("open database for fault");
    database
        .connection_for_test()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_repair_reconcile BEFORE UPDATE ON deployments
             WHEN OLD.id = '{}'
             BEGIN SELECT RAISE(ABORT, 'injected repair reconcile failure'); END;",
            deployment_id
        ))
        .expect("install deployment update fault");
    drop(database);
    let interrupted = app
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return a recoverable repair failure");
    assert_eq!(
        interrupted.item_results[0].status,
        UsageChangeItemStatus::RecoveryRequired
    );
    let backup = interrupted.item_results[0]
        .recovery_point
        .as_ref()
        .expect("repair preserves a recovery copy")
        .path
        .clone();
    assert_eq!(
        std::fs::read_to_string(Path::new(&backup).join("user.txt"))
            .expect("original target remains backed up"),
        "keep me"
    );
    drop(app);

    let database = Database::open(&fixture.database_path).expect("open database after fault");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_repair_reconcile;")
        .expect("remove deployment update fault");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation before simulating process interruption")
        .expect("operation exists");
    let original_relation: skillhub_core::relationship::DeploymentRelationFact =
        serde_json::from_value(record.recovery_data["plans"][0]["original_relation"].clone())
            .expect("original relationship fact");
    database
        .relationship_repository()
        .upsert_deployment_relation(&original_relation)
        .expect("restore relationship state from before the process interruption");
    record.recovery_data["plans"][0]["created_entry_identity"] = serde_json::Value::Null;
    record.recovery_data["plans"][0]["repair_removal_started"] = serde_json::json!(true);
    record.recovery_data["completed"] = serde_json::json!([]);
    record.result = Some(record.recovery_data["prepared"].clone());
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = record.phase;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist the durable state left before the process interruption");
    drop(database);
    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list repair recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == prepared.operation_id)
            .expect("partially applied repair remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );

    let unrelated_source = fixture._root.path().join("same-content-unrelated-source");
    copy_test_tree(&visible_tree, &unrelated_source);
    assert_eq!(
        DeploymentFilesystem::hash_tree(&unrelated_source).expect("hash unrelated source"),
        DeploymentFilesystem::hash_tree(&visible_tree).expect("hash expected source"),
        "the safety check must distinguish source identity from content equality"
    );
    #[cfg(unix)]
    {
        std::fs::remove_file(&destination).expect("remove recovered link");
        std::os::unix::fs::symlink(&unrelated_source, &destination)
            .expect("install a different link with identical content");
    }
    #[cfg(windows)]
    {
        std::fs::remove_dir(&destination).expect("remove recovered junction");
        skillhub_adapters::deployment::create_junction(&unrelated_source, &destination)
            .expect("install a different junction with identical content");
    }
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("recheck candidates after replacing the link source")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("replaced repair remains visible")
        .actions
        .is_empty());
    #[cfg(unix)]
    {
        std::fs::remove_file(&destination).expect("remove unrelated symlink");
        std::os::unix::fs::symlink(&visible_tree, &destination)
            .expect("restore link to the expected version source");
    }
    #[cfg(windows)]
    {
        std::fs::remove_dir(&destination).expect("remove unrelated junction");
        skillhub_adapters::deployment::create_junction(&visible_tree, &destination)
            .expect("restore junction to the expected version source");
    }

    std::fs::write(Path::new(&backup).join("user.txt"), "backup changed")
        .expect("simulate recovery backup drift");
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("recheck repair candidate after backup drift")
    else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("drifted repair remains visible")
        .actions
        .is_empty());

    std::fs::write(Path::new(&backup).join("user.txt"), "keep me")
        .expect("restore exact recovery backup");
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("complete repair with verified backup");
    assert!(DeploymentFilesystem::new()
        .recovery_entry_identity(deploy_row(&fixture, deployment_id).mode, &destination)
        .is_ok());
    assert_eq!(
        std::fs::read_to_string(Path::new(&backup).join("user.txt"))
            .expect("verified recovery backup remains available"),
        "keep me"
    );
    let settled = Database::open(&fixture.database_path)
        .expect("reopen recovered database")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read recovered operation")
        .expect("operation remains recorded");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::Committed);
    assert!(settled.recovery_data["plans"][0]["created_entry_identity"]
        .as_str()
        .is_some());
    assert_eq!(
        settled.recovery_data["plans"][0]["repair_removal_started"],
        serde_json::json!(false)
    );
}

fn copy_test_tree(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).expect("create copied tree root");
    for entry in std::fs::read_dir(source).expect("read copied tree") {
        let entry = entry.expect("read copied tree entry");
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&source_path).expect("inspect copied entry");
        assert!(!metadata.file_type().is_symlink(), "source tree is plain");
        if metadata.is_dir() {
            copy_test_tree(&source_path, &destination_path);
        } else if metadata.is_file() {
            std::fs::copy(source_path, destination_path).expect("copy tree file");
        } else {
            panic!("unsupported test tree entry");
        }
    }
}

#[tokio::test]
async fn managed_change_crash_after_all_item_receipts_can_write_terminal_receipt() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "receipt-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    let library = CentralLibrary::initialize(&fixture.library_root).expect("open library");
    VersionStore::from_library(&library)
        .set_current(fixture.skill.id(), &fixture.target_version.id)
        .expect("adopt target version in library");
    Database::open(&fixture.database_path)
        .expect("open database")
        .record_current_version(fixture.skill.id(), &fixture.target_version)
        .expect("adopt target version in database");
    library
        .materialize_current_skill(&fixture.skill, &fixture.target_version.id)
        .expect("materialize adopted target version");
    library
        .save_portable_skill(&fixture.skill, Some(&fixture.target_version.id))
        .expect("save adopted target version");
    let app = facade(&fixture);
    let result = prepare_and_commit(
        &app,
        usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ),
    );
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("synced target"),
        "# Target\n"
    );
    let database = Database::open(&fixture.database_path).expect("open database");
    let mut record = database
        .operation_repository()
        .get_sync(result.operation_id)
        .expect("read completed operation")
        .expect("operation exists");
    record.result = Some(record.recovery_data["prepared"].clone());
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = record.phase;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("simulate process exit after item receipt but before terminal receipt");
    drop(database);
    drop(app);

    let restarted = facade(&fixture);
    let AppQueryResult::RecoveryCandidates(candidates) = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list terminal-receipt recovery candidate")
    else {
        panic!("expected recovery candidates");
    };
    assert_eq!(
        candidates
            .iter()
            .find(|candidate| candidate.operation_id == result.operation_id)
            .expect("receipt-only interruption remains visible")
            .actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation]
    );
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: result.operation_id,
            action: skillhub_core::RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("write terminal receipt without repeating item effects");
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("target remains synced"),
        "# Target\n"
    );
    let settled = Database::open(&fixture.database_path)
        .expect("reopen settled database")
        .operation_repository()
        .get_sync(result.operation_id)
        .expect("read settled operation")
        .expect("operation remains recorded");
    assert_eq!(settled.phase, skillhub_core::OperationPhase::Committed);
    let settled_result: UsageChangeResult =
        serde_json::from_value(settled.result.expect("terminal result"))
            .expect("decode terminal result");
    assert!(!settled_result.recovery_required);
    assert_eq!(
        settled_result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
}

#[tokio::test]
async fn unverified_restore_is_not_success() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "unverified-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    std::fs::remove_dir_all(&destination).expect("remove target");
    let database = Database::open(&fixture.database_path).expect("database for missing fact");
    let mut missing_relation = database
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relationship");
    missing_relation.health_reasons = Some(vec![
        skillhub_core::relationship::RelationHealthReason::TargetEntryMissing,
    ]);
    database
        .relationship_repository()
        .upsert_deployment_relation(&missing_relation)
        .expect("persist missing target fact");
    let version_manifest = version_manifest_path(&fixture, &fixture.first_version);
    std::fs::remove_file(version_manifest).expect("remove pinned source version manifest");
    let result = prepare_and_commit(
        &facade(&fixture),
        usage_change("restore", &format!("managed:{deployment_id}"), None),
    );
    assert_ne!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    assert!(!destination.exists());
    assert!(deploy_row(&fixture, deployment_id).managed);
    let after_failure = Database::open(&fixture.database_path).expect("database after failure");
    let failed_relation = after_failure
        .relationship_repository()
        .list_relations()
        .expect("relations after failed restore")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("failed relationship remains active");
    assert_eq!(
        failed_relation.health_reasons,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::TargetEntryMissing,
            skillhub_core::relationship::RelationHealthReason::OperationFailed,
        ])
    );
}
