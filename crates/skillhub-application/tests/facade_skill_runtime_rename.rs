use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{AppCommand, AppCommandResult, AppQuery, AppQueryResult};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::{physical_id_for_path, ApplicationFacade};
use skillhub_storage::{CentralLibrary, Database, VersionStore};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

struct RenameFixture {
    _root: TempDir,
    facade: LocalApplicationFacade,
    database_path: PathBuf,
    library_root: PathBuf,
    skill_id: skillhub_core::SkillId,
    initial_version_id: skillhub_core::VersionId,
    old_runtime_name: String,
    target_paths: Vec<PathBuf>,
}

fn seed_managed_copy(
    database: &Database,
    root: &Path,
    skill_id: skillhub_core::SkillId,
    version: &skillhub_core::VersionRecord,
    runtime_name: &str,
    index: usize,
) -> PathBuf {
    let target_root = root.join(format!("agent-{index}")).join("skills");
    let destination = target_root.join(runtime_name);
    std::fs::create_dir_all(&destination).expect("create managed target");
    std::fs::write(
        destination.join("SKILL.md"),
        "---\nname: old-runtime\ndescription: Existing name\n---\n\n# Existing name\n",
    )
    .expect("write managed target content");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("target tree hash");
    let target_id = physical_id_for_path(&target_root).expect("target identity");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, ?2, 'global', ?3, 0)",
            rusqlite::params![
                target_id,
                format!("agent-{index}"),
                target_root.to_string_lossy().to_string(),
            ],
        )
        .expect("register target root");
    database
        .record_version(skill_id, version)
        .expect("register deployment version");
    database
        .deployment_repository()
        .insert_sync(&DeploymentRecord {
            id: skillhub_core::DeploymentId::new(),
            skill_id,
            version_id: version.id.clone(),
            target_id,
            state: DeploymentState::Deployed,
            mode: DeploymentMode::ManagedCopy,
            managed: true,
            runtime_name: runtime_name.to_owned(),
            expected_hash: expected_hash.clone(),
            observed_hash: Some(expected_hash),
        })
        .expect("record managed deployment");
    destination
}

async fn fixture_with_two_managed_targets() -> RenameFixture {
    let root = tempfile::tempdir().expect("fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "old-runtime");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let library = CentralLibrary::initialize(&library_root).expect("central library");
    let store = VersionStore::from_library(&library);
    let source = tempfile::tempdir().expect("version source");
    std::fs::write(
        source.path().join("SKILL.md"),
        "---\nname: old-runtime\ndescription: Existing name\n---\n\n# Existing name\n",
    )
    .expect("write skill version");
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture initial version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set initial version");
    database
        .record_current_version(skill.id(), &version)
        .expect("record current version");
    library
        .materialize_current_skill(&skill, &version.id)
        .expect("materialize central skill");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("record portable skill");

    let target_paths = (1..=2)
        .map(|index| {
            seed_managed_copy(
                &database,
                root.path(),
                skill.id(),
                &version,
                skill.runtime_name(),
                index,
            )
        })
        .collect();

    RenameFixture {
        _root: root,
        facade: LocalApplicationFacade::new_with_library(database, &library_root),
        database_path,
        library_root,
        skill_id: skill.id(),
        initial_version_id: version.id,
        old_runtime_name: skill.runtime_name().to_owned(),
        target_paths,
    }
}

async fn prepare_subject_rename(
    fixture: &RenameFixture,
    runtime_name: &str,
) -> skillhub_core::relationship::PreparedUsageChange {
    let operation_id = skillhub_core::OperationId::new();
    let command: AppCommand = serde_json::from_value(serde_json::json!({
        "type": "prepare_usage_change",
        "payload": {
            "operation_id": operation_id.to_string(),
            "action": "rename_subject",
            "relation_ids": [],
            "problem_id": null,
            "skill_id": fixture.skill_id.to_string(),
            "requested_form": null,
            "copy_disposition": null,
            "content_basis": null,
            "retain_entry_key": null,
            "selected_entry_keys": [],
            "runtime_name": runtime_name,
            "base_version_id": null,
            "non_recognized_destination": null
        }
    }))
    .expect("rename action is part of the generated command contract");
    match fixture
        .facade
        .execute(command)
        .await
        .expect("prepare rename")
    {
        AppCommandResult::PreparedUsageChange(prepared) => *prepared,
        other => panic!("expected prepared usage change, got {other:?}"),
    }
}

async fn commit_subject_rename(
    fixture: &RenameFixture,
    prepared: &skillhub_core::relationship::PreparedUsageChange,
) -> skillhub_core::AppResult<AppCommandResult> {
    let command: AppCommand = serde_json::from_value(serde_json::json!({
        "type": "commit_usage_change",
        "payload": {
            "operation_id": prepared.operation_id.to_string(),
            "prepared_id": prepared.prepared_id.to_string()
        }
    }))
    .expect("commit command");
    fixture.facade.execute(command).await
}

#[tokio::test]
async fn rename_preview_lists_every_managed_target() {
    let fixture = fixture_with_two_managed_targets().await;
    let command: AppCommand = serde_json::from_value(serde_json::json!({
        "type": "prepare_usage_change",
        "payload": {
            "operation_id": skillhub_core::OperationId::new().to_string(),
            "action": "rename_subject",
            "relation_ids": [],
            "problem_id": null,
            "skill_id": fixture.skill_id.to_string(),
            "requested_form": null,
            "copy_disposition": null,
            "content_basis": null,
            "retain_entry_key": null,
            "selected_entry_keys": [],
            "runtime_name": "new-runtime",
            "base_version_id": null,
            "non_recognized_destination": null
        }
    }))
    .expect("rename action is part of the generated command contract");
    let prepared = match fixture
        .facade
        .execute(command)
        .await
        .expect("prepare rename")
    {
        AppCommandResult::PreparedUsageChange(prepared) => *prepared,
        other => panic!("expected prepared usage change, got {other:?}"),
    };
    let prepared = serde_json::to_value(prepared).expect("serialize preview contract");
    let preview = prepared
        .get("subject_rename")
        .and_then(serde_json::Value::as_object)
        .expect("subject rename preview");

    assert_eq!(preview["previous_runtime_name"], fixture.old_runtime_name);
    assert_eq!(preview["runtime_name"], "new-runtime");
    let targets = preview["targets"].as_array().expect("target list");
    assert_eq!(targets.len(), 2);
    for (target, old_path) in targets.iter().zip(&fixture.target_paths) {
        assert_eq!(
            PathBuf::from(target["previous_path"].as_str().unwrap()),
            *old_path
        );
        assert_eq!(
            PathBuf::from(target["path"].as_str().unwrap()),
            old_path.parent().expect("target root").join("new-runtime")
        );
    }
}

#[tokio::test]
async fn rename_commit_updates_markdown_version_and_every_target() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    commit_subject_rename(&fixture, &prepared)
        .await
        .expect("commit rename");

    let database = Database::open(&fixture.database_path).expect("reopen database");
    let (display_name, runtime_name): (String, String) = database
        .connection_for_test()
        .query_row(
            "SELECT display_name, runtime_name FROM skills WHERE id=?1",
            [fixture.skill_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("catalog runtime metadata");
    assert_eq!(display_name, fixture.old_runtime_name);
    assert_eq!(runtime_name, "new-runtime");

    let central = CentralLibrary::initialize(&fixture.library_root).expect("open library");
    let source = central.visible_skill_path_for_runtime(fixture.skill_id, "new-runtime");
    assert!(!central
        .visible_skill_path_for_runtime(fixture.skill_id, &fixture.old_runtime_name)
        .exists());
    let markdown = std::fs::read_to_string(source.join("SKILL.md")).expect("renamed source");
    assert!(
        markdown.contains("name: new-runtime"),
        "renamed central markdown: {markdown:?}"
    );

    let mut deployment_statement = database
        .connection_for_test()
        .prepare("SELECT runtime_name, version_id FROM deployments WHERE skill_id=?1 AND state='deployed'")
        .expect("deployment query");
    let deployments = deployment_statement
        .query_map([fixture.skill_id.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("deployment rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("deployment values");
    assert_eq!(deployments.len(), 2);
    assert!(deployments.iter().all(|(name, version)| {
        name == "new-runtime" && version != fixture.initial_version_id.as_str()
    }));
    for old_path in &fixture.target_paths {
        let renamed_path = old_path.parent().expect("target root").join("new-runtime");
        assert!(!old_path.exists());
        let target_markdown =
            std::fs::read_to_string(renamed_path.join("SKILL.md")).expect("renamed target");
        assert!(target_markdown.contains("name: new-runtime"));
    }
}

#[tokio::test]
async fn rename_commit_rejects_target_changed_after_preview() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    std::fs::write(
        fixture.target_paths[0].join("SKILL.md"),
        "---\nname: changed-outside-preview\n---\n",
    )
    .expect("change target after preview");

    let error = commit_subject_rename(&fixture, &prepared)
        .await
        .expect_err("stale preview must not write any target");
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("usage_change_preview_stale")
    );
    assert!(fixture.target_paths[0].exists());
    assert!(!fixture.target_paths[0]
        .parent()
        .expect("target root")
        .join("new-runtime")
        .exists());
}

#[tokio::test]
async fn rename_preview_rejects_existing_target_name() {
    let fixture = fixture_with_two_managed_targets().await;
    let collision = fixture.target_paths[0]
        .parent()
        .expect("target root")
        .join("new-runtime");
    std::fs::create_dir_all(&collision).expect("create conflicting target name");

    let error = fixture
        .facade
        .prepare_usage_change(
            serde_json::from_value(serde_json::json!({
                "operation_id": skillhub_core::OperationId::new().to_string(),
                "action": "rename_subject",
                "relation_ids": [],
                "problem_id": null,
                "skill_id": fixture.skill_id.to_string(),
                "requested_form": null,
                "copy_disposition": null,
                "content_basis": null,
                "retain_entry_key": null,
                "selected_entry_keys": [],
                "runtime_name": "new-runtime",
                "base_version_id": null,
                "non_recognized_destination": null
            }))
            .expect("prepare request"),
        )
        .expect_err("existing runtime path must be surfaced before commit");
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("subject_rename_target_name_conflict")
    );
    assert!(fixture.target_paths[0].exists());
    assert!(collision.exists());
}

#[tokio::test]
async fn rename_preview_rejects_a_managed_deployment_reclassified_as_unmanaged() {
    let fixture = fixture_with_two_managed_targets().await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployment_relations SET ownership='observed_unmanaged' WHERE path=?1",
            [fixture.target_paths[0].to_string_lossy().to_string()],
        )
        .expect("reclassify relation as unmanaged");

    let error = fixture
        .facade
        .prepare_usage_change(
            serde_json::from_value(serde_json::json!({
                "operation_id": skillhub_core::OperationId::new().to_string(),
                "action": "rename_subject",
                "relation_ids": [],
                "problem_id": null,
                "skill_id": fixture.skill_id.to_string(),
                "requested_form": null,
                "copy_disposition": null,
                "content_basis": null,
                "retain_entry_key": null,
                "selected_entry_keys": [],
                "runtime_name": "new-runtime",
                "base_version_id": null,
                "non_recognized_destination": null
            }))
            .expect("prepare request"),
        )
        .expect_err("runtime rename must not claim an unmanaged relation");

    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("subject_rename_usage_scope_unverified")
    );
    assert!(fixture.target_paths.iter().all(|path| path.exists()));
    assert!(fixture.target_paths.iter().all(|path| {
        !path
            .parent()
            .expect("target root")
            .join("new-runtime")
            .exists()
    }));
}

#[cfg(unix)]
#[tokio::test]
async fn rename_commit_recreates_managed_directory_links_to_the_renamed_central_skill() {
    use std::os::unix::fs::symlink;

    let fixture = fixture_with_two_managed_targets().await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let target_root = fixture.target_paths[0].parent().expect("target root");
    let target_id = physical_id_for_path(target_root).expect("target identity");
    let deployment_id: String = database
        .connection_for_test()
        .query_row(
            "SELECT id FROM deployments WHERE target_id=?1",
            [target_id],
            |row| row.get(0),
        )
        .expect("managed deployment id");
    let relation_id = format!("managed:{deployment_id}");
    let library = CentralLibrary::initialize(&fixture.library_root).expect("open library");
    let old_central =
        library.visible_skill_path_for_runtime(fixture.skill_id, &fixture.old_runtime_name);
    std::fs::remove_dir_all(&fixture.target_paths[0]).expect("remove copy target");
    symlink(&old_central, &fixture.target_paths[0]).expect("create managed directory link");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployments SET method='symbolic_link' WHERE id=?1",
            [&deployment_id],
        )
        .expect("record symbolic-link deployment mode");
    database
        .connection_for_test()
        .execute(
            "UPDATE deployment_relations SET relationship='managed_link', file_representation='symbolic_link' WHERE relation_id=?1",
            [&relation_id],
        )
        .expect("record symbolic-link relationship representation");

    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    commit_subject_rename(&fixture, &prepared)
        .await
        .expect("commit runtime rename");

    let renamed_link = target_root.join("new-runtime");
    let new_central = library.visible_skill_path_for_runtime(fixture.skill_id, "new-runtime");
    assert!(std::fs::symlink_metadata(&renamed_link)
        .expect("renamed target link")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::canonicalize(&renamed_link).expect("resolve renamed link"),
        std::fs::canonicalize(&new_central).expect("resolve renamed central skill")
    );
    assert!(!fixture.target_paths[0].exists());
}

#[tokio::test]
async fn rename_commit_rolls_back_files_when_relationship_commit_fails() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER reject_subject_rename_relationship
             BEFORE UPDATE OF path ON deployment_relations
             WHEN OLD.relation_id LIKE 'managed:%'
             BEGIN SELECT RAISE(ABORT, 'injected relationship write failure'); END;",
        )
        .expect("install relationship failure trigger");

    let error = commit_subject_rename(&fixture, &prepared)
        .await
        .expect_err("database failure must abort runtime rename");
    assert_eq!(error.code, skillhub_core::ErrorCode::InternalError);

    let database = Database::open(&fixture.database_path).expect("reopen rolled-back database");
    let runtime_name: String = database
        .connection_for_test()
        .query_row(
            "SELECT runtime_name FROM skills WHERE id=?1",
            [fixture.skill_id.to_string()],
            |row| row.get(0),
        )
        .expect("runtime metadata after rollback");
    assert_eq!(runtime_name, fixture.old_runtime_name);
    assert!(fixture.target_paths.iter().all(|path| path.exists()));
    assert!(fixture.target_paths.iter().all(|path| {
        !path
            .parent()
            .expect("target root")
            .join("new-runtime")
            .exists()
    }));
    let library = CentralLibrary::initialize(&fixture.library_root).expect("open library");
    assert!(library
        .visible_skill_path_for_runtime(fixture.skill_id, &fixture.old_runtime_name)
        .exists());
    assert!(!library
        .visible_skill_path_for_runtime(fixture.skill_id, "new-runtime")
        .exists());
}

#[tokio::test]
async fn rename_commit_records_recovery_when_backup_cleanup_checkpoint_fails() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    database
        .connection_for_test()
        .execute(
            &format!(
                "CREATE TRIGGER reject_backup_cleanup_checkpoint
             BEFORE UPDATE ON operations
             WHEN NEW.operation_id='{}'
               AND NEW.phase='applying'
               AND json_extract(NEW.progress_json, '$.recovery_data.plans[0].backup_finalized')=1
             BEGIN SELECT RAISE(ABORT, 'injected cleanup checkpoint failure'); END;",
                prepared.operation_id
            ),
            [],
        )
        .expect("install cleanup checkpoint failure trigger");

    let error = commit_subject_rename(&fixture, &prepared)
        .await
        .expect_err("cleanup checkpoint error must be returned");
    assert_eq!(error.code, skillhub_core::ErrorCode::InternalError);

    let database = Database::open(&fixture.database_path).expect("reopen recovery database");
    let record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation")
        .expect("rename operation");
    assert_eq!(record.phase, skillhub_core::OperationPhase::NeedsRecovery);

    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER reject_backup_cleanup_checkpoint")
        .expect("remove injected failure");
    let AppQueryResult::RecoveryCandidates(candidates) = fixture
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("retain valid cleanup recovery candidate");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::CompleteOperation],
        "a valid committed rename journal keeps its supported completion action"
    );
    let recovery: AppCommand = serde_json::from_value(serde_json::json!({
        "type": "resolve_recovery",
        "payload": {
            "operation_id": prepared.operation_id.to_string(),
            "action": "complete_operation"
        }
    }))
    .expect("recovery command");
    fixture
        .facade
        .execute(recovery)
        .await
        .expect("complete runtime rename after recovery");
    let database = Database::open(&fixture.database_path).expect("reopen recovered database");
    let record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read recovered operation")
        .expect("rename operation");
    assert_eq!(record.phase, skillhub_core::OperationPhase::Committed);
}

#[tokio::test]
async fn malformed_subject_rename_journal_keeps_candidate_without_recovery_actions() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation")
        .expect("rename operation");
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.recovery_data = serde_json::json!({"metadata_committed": false});
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist malformed recovery journal");

    let AppQueryResult::RecoveryCandidates(candidates) = fixture
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("retain malformed operation for inspection");
    assert!(
        candidate.actions.is_empty(),
        "a malformed subject rename journal must not advertise a rollback that cannot be parsed"
    );
}

#[tokio::test]
async fn subject_rename_candidate_hides_actions_when_journal_operation_id_mismatches() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation")
        .expect("rename operation");
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.recovery_data["request"]["operation_id"] =
        serde_json::to_value(skillhub_core::OperationId::new())
            .expect("serialize mismatched operation id");
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist mismatched recovery journal");

    let AppQueryResult::RecoveryCandidates(candidates) = fixture
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("retain operation for inspection");
    assert!(
        candidate.actions.is_empty(),
        "a subject rename journal whose operation id differs from its row must not advertise actions"
    );
}

#[tokio::test]
async fn subject_rename_candidate_rejects_committed_flag_without_commit_checkpoints() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation")
        .expect("rename operation");
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.recovery_data["metadata_committed"] = serde_json::json!(true);
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist inconsistent committed checkpoint");

    let AppQueryResult::RecoveryCandidates(candidates) = fixture
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("retain inconsistent operation for inspection");
    assert!(
        candidate.actions.is_empty(),
        "the committed checkpoint flag alone must not advertise completion"
    );
}

#[tokio::test]
async fn valid_unstarted_subject_rename_recovery_keeps_rollback_action() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read operation")
        .expect("rename operation");
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = skillhub_core::OperationPhase::NeedsRecovery;
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist valid recovery candidate");

    let AppQueryResult::RecoveryCandidates(candidates) = fixture
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates")
    else {
        panic!("expected recovery candidates");
    };
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.operation_id == prepared.operation_id)
        .expect("retain valid recovery candidate");
    assert_eq!(
        candidate.actions,
        vec![skillhub_core::RecoveryAction::RollbackOperation],
        "a valid unstarted rename journal keeps its supported rollback action"
    );

    let recovery: AppCommand = serde_json::from_value(serde_json::json!({
        "type": "resolve_recovery",
        "payload": {
            "operation_id": prepared.operation_id.to_string(),
            "action": "rollback_operation"
        }
    }))
    .expect("rollback recovery command");
    fixture
        .facade
        .execute(recovery)
        .await
        .expect("roll back the valid unstarted rename");
    let database = Database::open(&fixture.database_path).expect("reopen rolled-back database");
    let record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read rolled-back operation")
        .expect("rename operation");
    assert_eq!(record.phase, skillhub_core::OperationPhase::RolledBack);
}

#[tokio::test]
async fn rollback_rejects_same_content_replacement_of_created_target() {
    let fixture = fixture_with_two_managed_targets().await;
    let prepared = prepare_subject_rename(&fixture, "new-runtime").await;
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let mut record = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read prepared operation")
        .expect("rename operation");
    let plan = record.recovery_data["plans"][1].clone();
    let target_root = fixture.target_paths[1].parent().expect("target root");
    let backup = PathBuf::from(plan["backup_path"].as_str().expect("backup path"));
    std::fs::rename(&fixture.target_paths[1], &backup).expect("simulate moved original entry");

    let operation_entry = target_root.join(".operation-created-target");
    std::fs::create_dir(&operation_entry).expect("create operation target fixture");
    std::fs::write(operation_entry.join("SKILL.md"), "# same content\n")
        .expect("write operation target fixture");
    let expected_hash = DeploymentFilesystem::hash_tree(&operation_entry).expect("target hash");
    let expected_identity = physical_id_for_path(&operation_entry).expect("target identity");
    let moved_operation_entry = target_root.join(".operation-created-target-moved");
    std::fs::rename(&operation_entry, &moved_operation_entry)
        .expect("move original operation target aside");

    let replacement = target_root.join("new-runtime");
    std::fs::create_dir(&replacement).expect("create replacement target");
    std::fs::write(replacement.join("SKILL.md"), "# same content\n")
        .expect("write replacement content");
    assert_eq!(
        DeploymentFilesystem::hash_tree(&replacement).expect("replacement hash"),
        expected_hash
    );
    assert_ne!(
        physical_id_for_path(&replacement).as_deref(),
        Some(expected_identity.as_str()),
        "replacement must be a different physical entry"
    );

    record.recovery_data["new_target_hash"] = serde_json::json!(expected_hash);
    record.recovery_data["plans"][1]["created_new_entry"] = serde_json::json!(true);
    record.recovery_data["plans"][1]["created_entry_identity"] =
        serde_json::json!(expected_identity);
    record.recovery_data["plans"][1]["moved_previous_entry"] = serde_json::json!(true);
    record.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.phase = skillhub_core::OperationPhase::NeedsRecovery;
    record.progress.message_code = "operation.needs_recovery".to_owned();
    database
        .operation_repository()
        .update_sync(&record)
        .expect("persist interrupted rename fixture");

    let recovery: AppCommand = serde_json::from_value(serde_json::json!({
        "type": "resolve_recovery",
        "payload": {
            "operation_id": prepared.operation_id.to_string(),
            "action": "rollback_operation"
        }
    }))
    .expect("recovery command");
    let error = fixture
        .facade
        .execute(recovery)
        .await
        .expect_err("same-content replacement must not be deleted");

    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("subject_rename_target_identity_changed")
    );
    assert_eq!(
        std::fs::read_to_string(replacement.join("SKILL.md")).expect("replacement survives"),
        "# same content\n"
    );
    assert_eq!(
        Database::open(&fixture.database_path)
            .expect("reopen database")
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read recovery state")
            .expect("rename operation")
            .phase,
        skillhub_core::OperationPhase::NeedsRecovery
    );
}
