use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, CollectDeploymentChanges,
    IgnoreExternalChange,
};
use skillhub_core::catalog::Skill;
use skillhub_core::{
    ApplicationFacade, DeploymentMode, DeploymentRecord, DeploymentState, OperationPhase,
    OperationRecord, RecoveryAction, ResolveRecovery, SkillId, VersionRecord,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

fn collect_changes_fixture(
    workspace: &std::path::Path,
) -> (
    Database,
    std::path::PathBuf,
    DeploymentRecord,
    VersionRecord,
    VersionRecord,
) {
    let library_root = workspace.join("library");
    let central = CentralLibrary::initialize(&library_root).expect("central library");
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(SkillId::new(), "Collect changes recovery");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");

    let source = workspace.join("source");
    std::fs::create_dir_all(&source).expect("source directory");
    std::fs::write(source.join("SKILL.md"), "# approved version\n").expect("source content");
    let initial_version = VersionStore::from_library(&central)
        .capture(skill.id(), &source)
        .expect("capture initial version");
    database
        .record_version(skill.id(), &initial_version)
        .expect("record initial version");

    let target_root = workspace.join("agent/skills");
    std::fs::create_dir_all(&target_root).expect("target root");
    let destination = target_root.join(skill.runtime_name());
    std::fs::create_dir_all(&destination).expect("deployed target");
    std::fs::write(destination.join("SKILL.md"), "# externally changed\n")
        .expect("changed target content");
    let changed_version = VersionStore::from_library(&central)
        .capture(skill.id(), &destination)
        .expect("capture changed version fixture");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_root.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id: initial_version.id.clone(),
        target_id,
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: skill.runtime_name().to_owned(),
        expected_hash: initial_version.manifest.tree_hash.clone(),
        observed_hash: None,
    };
    database
        .deployment_repository()
        .insert_sync(&deployment)
        .expect("insert deployment");

    (
        database,
        library_root,
        deployment,
        initial_version,
        changed_version,
    )
}

#[tokio::test]
async fn collect_changes_registers_version_and_commits_facts_with_journal() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (database, library_root, deployment, initial_version, changed_version) =
        collect_changes_fixture(workspace.path());
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    let result = facade
        .execute(AppCommand::CollectDeploymentChanges(
            CollectDeploymentChanges {
                deployment_id: deployment.id,
            },
        ))
        .await
        .expect("collect changes");
    assert!(matches!(
        result,
        AppCommandResult::ReconcileResult(ref value)
            if value.version_id.as_ref() == Some(&changed_version.id)
    ));

    let database = facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let persisted = database
        .deployment_repository()
        .list_all()
        .expect("deployment rows")
        .into_iter()
        .find(|record| record.id == deployment.id)
        .expect("deployment row");
    assert_eq!(persisted.version_id, changed_version.id);
    assert_eq!(persisted.expected_hash, changed_version.manifest.tree_hash);
    assert_eq!(
        persisted.observed_hash.as_deref(),
        Some(changed_version.manifest.tree_hash.as_str())
    );
    assert_ne!(persisted.version_id, initial_version.id);
    let registered: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM versions WHERE id=?1",
            [changed_version.id.to_string()],
            |row| row.get(0),
        )
        .expect("registered version count");
    assert_eq!(registered, 1);
    let operation = database
        .operation_repository()
        .list_sync()
        .expect("operation rows")
        .into_iter()
        .find(|record| record.kind == "reconcile_collect_changes")
        .expect("collect changes operation");
    assert_eq!(operation.phase, OperationPhase::Committed);
    assert_eq!(
        operation
            .result
            .as_ref()
            .and_then(|value| value.get("version_id"))
            .and_then(serde_json::Value::as_str),
        Some(changed_version.id.as_str())
    );
}

#[tokio::test]
async fn collect_changes_keeps_deployment_facts_and_journal_atomic_on_commit_failure() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (database, library_root, deployment, initial_version, changed_version) =
        collect_changes_fixture(workspace.path());

    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    let database = facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER reject_collect_changes_journal_commit
             BEFORE UPDATE ON operations
             WHEN NEW.kind = 'reconcile_collect_changes' AND NEW.phase = 'committed'
             BEGIN SELECT RAISE(ABORT, 'injected reconcile journal failure'); END;",
        )
        .expect("install journal failure trigger");

    let result = facade
        .execute(AppCommand::CollectDeploymentChanges(
            CollectDeploymentChanges {
                deployment_id: deployment.id,
            },
        ))
        .await;
    assert!(
        result.is_err(),
        "the command must not report success when its durable journal commit fails"
    );

    let operation_id = {
        let database = database.lock().expect("database lock");
        let persisted = database
            .deployment_repository()
            .list_all()
            .expect("deployment rows")
            .into_iter()
            .find(|record| record.id == deployment.id)
            .expect("deployment row");
        assert_eq!(persisted.version_id, initial_version.id);
        assert_eq!(persisted.expected_hash, initial_version.manifest.tree_hash);
        assert_eq!(persisted.observed_hash, None);
        let registered: i64 = database
            .connection_for_test()
            .query_row(
                "SELECT COUNT(*) FROM versions WHERE id=?1",
                [changed_version.id.to_string()],
                |row| row.get(0),
            )
            .expect("registered version count");
        assert_eq!(
            registered, 0,
            "failed journal commit must roll back version registration"
        );
        let operation = database
            .operation_repository()
            .list_sync()
            .expect("operation rows")
            .into_iter()
            .find(|record| record.kind == "reconcile_collect_changes")
            .expect("collect changes operation");
        assert_eq!(operation.phase, OperationPhase::RolledBack);
        operation.operation_id
    };
    let candidates = facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates");
    assert!(matches!(
        candidates,
        AppQueryResult::RecoveryCandidates(ref values)
            if !values.iter().any(|candidate| candidate.operation_id == operation_id)
    ));
}

#[tokio::test]
async fn ignore_external_change_commits_observation_and_journal_together() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (database, library_root, deployment, initial_version, _changed_version) =
        collect_changes_fixture(workspace.path());
    let observed_hash = DeploymentFilesystem::hash_tree(
        workspace
            .path()
            .join("agent/skills")
            .join(deployment.runtime_name.as_str()),
    )
    .expect("observed target hash");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    let result = facade
        .execute(AppCommand::IgnoreExternalChange(IgnoreExternalChange {
            deployment_id: deployment.id,
        }))
        .await
        .expect("ignore external change");
    assert!(matches!(
        result,
        AppCommandResult::ReconcileResult(ref value)
            if value.action == skillhub_core::deployment::ReconcileAction::Ignore
    ));

    let database = facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let persisted = database
        .deployment_repository()
        .list_all()
        .expect("deployment rows")
        .into_iter()
        .find(|record| record.id == deployment.id)
        .expect("deployment row");
    assert_eq!(persisted.version_id, initial_version.id);
    assert_eq!(persisted.expected_hash, initial_version.manifest.tree_hash);
    assert_eq!(
        persisted.observed_hash.as_deref(),
        Some(observed_hash.as_str())
    );
    let operation = database
        .operation_repository()
        .list_sync()
        .expect("operation rows")
        .into_iter()
        .find(|record| record.kind == "reconcile_ignore_external_change")
        .expect("ignore operation");
    assert_eq!(operation.phase, OperationPhase::Committed);
    assert_eq!(
        operation
            .result
            .as_ref()
            .and_then(|value| value.get("observed_hash"))
            .and_then(serde_json::Value::as_str),
        Some(observed_hash.as_str())
    );
}

#[tokio::test]
async fn ignore_missing_external_target_commits_without_changing_deployment_facts() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (database, library_root, deployment, initial_version, _changed_version) =
        collect_changes_fixture(workspace.path());
    std::fs::remove_dir_all(
        workspace
            .path()
            .join("agent/skills")
            .join(deployment.runtime_name.as_str()),
    )
    .expect("remove deployed target");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    facade
        .execute(AppCommand::IgnoreExternalChange(IgnoreExternalChange {
            deployment_id: deployment.id,
        }))
        .await
        .expect("ignore missing external target");

    let database = facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let persisted = database
        .deployment_repository()
        .list_all()
        .expect("deployment rows")
        .into_iter()
        .find(|record| record.id == deployment.id)
        .expect("deployment row");
    assert_eq!(persisted.version_id, initial_version.id);
    assert_eq!(persisted.expected_hash, initial_version.manifest.tree_hash);
    assert_eq!(persisted.observed_hash, None);
    let operation = database
        .operation_repository()
        .list_sync()
        .expect("operation rows")
        .into_iter()
        .find(|record| record.kind == "reconcile_ignore_external_change")
        .expect("ignore operation");
    assert_eq!(operation.phase, OperationPhase::Committed);
    assert_eq!(
        operation
            .result
            .as_ref()
            .and_then(|value| value.get("observed_hash")),
        Some(&serde_json::Value::Null)
    );
}

#[tokio::test]
async fn ignore_external_change_keeps_facts_atomic_with_journal_commit_failure() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (database, library_root, deployment, initial_version, _changed_version) =
        collect_changes_fixture(workspace.path());

    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    let database = facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER reject_ignore_change_journal_commit
             BEFORE UPDATE ON operations
             WHEN NEW.kind = 'reconcile_ignore_external_change' AND NEW.phase = 'committed'
             BEGIN SELECT RAISE(ABORT, 'injected ignore journal failure'); END;",
        )
        .expect("install journal failure trigger");

    let result = facade
        .execute(AppCommand::IgnoreExternalChange(IgnoreExternalChange {
            deployment_id: deployment.id,
        }))
        .await;
    assert!(
        result.is_err(),
        "the command must not report success when its durable journal commit fails"
    );

    let operation_id = {
        let database = database.lock().expect("database lock");
        let persisted = database
            .deployment_repository()
            .list_all()
            .expect("deployment rows")
            .into_iter()
            .find(|record| record.id == deployment.id)
            .expect("deployment row");
        assert_eq!(persisted.version_id, initial_version.id);
        assert_eq!(persisted.expected_hash, initial_version.manifest.tree_hash);
        assert_eq!(persisted.observed_hash, None);
        let operation = database
            .operation_repository()
            .list_sync()
            .expect("operation rows")
            .into_iter()
            .find(|record| record.kind == "reconcile_ignore_external_change")
            .expect("ignore operation");
        assert_eq!(operation.phase, OperationPhase::RolledBack);
        operation.operation_id
    };
    let candidates = facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates");
    assert!(matches!(
        candidates,
        AppQueryResult::RecoveryCandidates(ref values)
            if !values.iter().any(|candidate| candidate.operation_id == operation_id)
    ));
}

#[tokio::test]
async fn reconcile_restore_resumes_after_original_target_was_moved_to_backup() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    let target_root = workspace.path().join("agent/skills");
    std::fs::create_dir_all(&target_root).expect("target root");
    let central = CentralLibrary::initialize(&library_root).expect("central library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(SkillId::new(), "Restore recovery");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");

    let source = workspace.path().join("source");
    std::fs::create_dir_all(&source).expect("source directory");
    std::fs::write(source.join("SKILL.md"), "# central version\n").expect("source content");
    let version = VersionStore::from_library(&central)
        .capture(skill.id(), &source)
        .expect("capture source version");
    database
        .record_version(skill.id(), &version)
        .expect("record version");

    let destination = target_root.join(skill.runtime_name());
    std::fs::create_dir_all(&destination).expect("deployed target");
    std::fs::write(destination.join("SKILL.md"), "# user's changed version\n")
        .expect("changed target content");
    let original_hash = DeploymentFilesystem::hash_tree(&destination).expect("original hash");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_root.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id: version.id.clone(),
        target_id: target_id.clone(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: skill.runtime_name().to_owned(),
        expected_hash: DeploymentFilesystem::hash_tree(&source).expect("source tree hash"),
        observed_hash: Some(original_hash.clone()),
    };
    database
        .deployment_repository()
        .insert_sync(&deployment)
        .expect("insert deployment");

    let operation_id = skillhub_core::OperationId::new();
    let backup_path = target_root.join(format!(
        ".{}.skillhub-restore-{operation_id}",
        deployment.runtime_name
    ));
    let filesystem = DeploymentFilesystem::new();
    let original_entry_identity = filesystem
        .recovery_entry_identity(DeploymentMode::ManagedCopy, &destination)
        .expect("original entry identity");
    std::fs::rename(&destination, &backup_path).expect("simulate interrupted target replacement");

    let mut journal = OperationRecord::planned(
        operation_id,
        "reconcile_restore_deployment",
        "restore fixture",
    );
    journal.phase = OperationPhase::NeedsRecovery;
    journal.progress.phase = OperationPhase::NeedsRecovery;
    journal.recovery_data = serde_json::json!({
        "deployment": deployment,
        "target_root": target_root.to_string_lossy(),
        "target_root_identity": target_id,
        "destination_path": destination.to_string_lossy(),
        "backup_path": backup_path.to_string_lossy(),
        "original_entry_identity": original_entry_identity,
        "original_observed_hash": original_hash,
    });
    database
        .operation_repository()
        .insert_sync(&journal)
        .expect("insert interrupted operation");
    drop(database);

    let facade = LocalApplicationFacade::open_with_library(&database_path, &library_root)
        .expect("restart facade");
    let candidates = facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates");
    let AppQueryResult::RecoveryCandidates(candidates) = candidates else {
        panic!("expected recovery candidates");
    };
    assert!(candidates.iter().any(|candidate| {
        candidate.operation_id == operation_id
            && candidate.actions == [RecoveryAction::CompleteOperation]
    }));

    let result = facade
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::ResolveRecovery {
                operation_id,
                action: RecoveryAction::CompleteOperation,
            },
        ))
        .await
        .expect("continue restore");
    assert!(matches!(result, AppCommandResult::OperationSummary(_)));
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored deployment"),
        "# central version\n"
    );
    assert!(!backup_path.exists(), "verified original backup is retired");
    let database = facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let restored = database
        .deployment_repository()
        .list_all()
        .expect("deployment rows")
        .into_iter()
        .find(|record| record.id == deployment.id)
        .expect("deployment row");
    assert_eq!(
        restored.observed_hash.as_deref(),
        Some(deployment.expected_hash.as_str())
    );
    let record = database
        .operation_repository()
        .get_sync(operation_id)
        .expect("read operation")
        .expect("operation record");
    assert_eq!(record.phase, OperationPhase::Committed);
}

#[tokio::test]
async fn reconcile_restore_checkpoints_then_replaces_and_settles_target() {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    let central = CentralLibrary::initialize(&library_root).expect("central library");
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(SkillId::new(), "Restore normal path");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");
    let source = workspace.path().join("source");
    std::fs::create_dir_all(&source).expect("source directory");
    std::fs::write(source.join("SKILL.md"), "# approved version\n").expect("source content");
    let version = VersionStore::from_library(&central)
        .capture(skill.id(), &source)
        .expect("capture source version");
    database
        .record_version(skill.id(), &version)
        .expect("record version");

    let target_root = workspace.path().join("agent/skills");
    std::fs::create_dir_all(&target_root).expect("target root");
    let destination = target_root.join(skill.runtime_name());
    std::fs::create_dir_all(&destination).expect("deployed target");
    std::fs::write(destination.join("SKILL.md"), "# externally changed\n")
        .expect("changed target content");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_root.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    let expected_hash = DeploymentFilesystem::hash_tree(&source).expect("source tree hash");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id: version.id.clone(),
        target_id,
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: skill.runtime_name().to_owned(),
        expected_hash: expected_hash.clone(),
        observed_hash: Some(expected_hash),
    };
    database
        .deployment_repository()
        .insert_sync(&deployment)
        .expect("insert deployment");

    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    let result = facade
        .execute(AppCommand::RestoreDeployment(
            skillhub_core::RestoreDeployment {
                deployment_id: deployment.id,
            },
        ))
        .await
        .expect("restore changed target");
    assert!(matches!(result, AppCommandResult::ReconcileResult(_)));
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored target"),
        "# approved version\n"
    );
    let operation_id = {
        let database = facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let operation = database
            .operation_repository()
            .list_sync()
            .expect("read operation journal")
            .into_iter()
            .find(|record| record.kind == "reconcile_restore_deployment")
            .expect("operation record");
        assert_eq!(operation.phase, OperationPhase::Committed);
        operation.operation_id
    };
    assert!(!target_root
        .join(format!(
            ".{}.skillhub-restore-{operation_id}",
            deployment.runtime_name
        ))
        .exists());
    VersionStore::from_library(&central)
        .discard_sync(&version)
        .expect("remove source manifest to exercise preflight error");

    let blocked_destination = target_root.join("missing-source");
    std::fs::create_dir_all(&blocked_destination).expect("blocked target");
    std::fs::write(
        blocked_destination.join("SKILL.md"),
        "# preserve after error\n",
    )
    .expect("blocked target content");
    let blocked_deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id: deployment.version_id.clone(),
        target_id: deployment.target_id.clone(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "missing-source".to_owned(),
        expected_hash: deployment.expected_hash.clone(),
        observed_hash: Some(deployment.expected_hash.clone()),
    };
    facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .deployment_repository()
        .insert_sync(&blocked_deployment)
        .expect("insert target with unavailable source version");
    facade
        .execute(AppCommand::RestoreDeployment(
            skillhub_core::RestoreDeployment {
                deployment_id: blocked_deployment.id,
            },
        ))
        .await
        .expect_err("unavailable source must fail in preflight");
    assert_eq!(
        std::fs::read_to_string(blocked_destination.join("SKILL.md"))
            .expect("original target survives preflight failure"),
        "# preserve after error\n"
    );
    let database = facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let failed_operation = database
        .operation_repository()
        .list_sync()
        .expect("operation journal")
        .into_iter()
        .find(|record| record.kind == "reconcile_restore_deployment" && record.error_code.is_some())
        .expect("failed operation row");
    assert_eq!(failed_operation.phase, OperationPhase::RolledBack);
}

#[tokio::test]
async fn reconcile_restore_recovers_after_filesystem_replace_and_database_failure() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    let central = CentralLibrary::initialize(&library_root).expect("central library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(SkillId::new(), "Restore failure recovery");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");
    let source = workspace.path().join("source");
    std::fs::create_dir_all(&source).expect("source directory");
    std::fs::write(source.join("SKILL.md"), "# central version\n").expect("source content");
    let version = VersionStore::from_library(&central)
        .capture(skill.id(), &source)
        .expect("capture source version");
    database
        .record_version(skill.id(), &version)
        .expect("record version");

    let target_root = workspace.path().join("agent/skills");
    std::fs::create_dir_all(&target_root).expect("target root");
    let destination = target_root.join(skill.runtime_name());
    std::fs::create_dir_all(&destination).expect("deployed target");
    std::fs::write(destination.join("SKILL.md"), "# external edit\n")
        .expect("changed target content");
    let target_id = skillhub_core::physical_id_for_path(&target_root).expect("target identity");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_root.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    let expected_hash = DeploymentFilesystem::hash_tree(&source).expect("source tree hash");
    let deployment = DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id: version.id.clone(),
        target_id,
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: skill.runtime_name().to_owned(),
        expected_hash: expected_hash.clone(),
        observed_hash: Some(expected_hash.clone()),
    };
    database
        .deployment_repository()
        .insert_sync(&deployment)
        .expect("insert deployment");
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER block_reconcile_restore_checkpoint
             BEFORE UPDATE OF observed_hash ON deployments
             WHEN NEW.observed_hash = NEW.expected_hash
             BEGIN SELECT RAISE(ABORT, 'injected reconcile facts failure'); END;",
        )
        .expect("inject reconcile checkpoint failure");

    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    facade
        .execute(AppCommand::RestoreDeployment(
            skillhub_core::RestoreDeployment {
                deployment_id: deployment.id,
            },
        ))
        .await
        .expect_err("database failure follows the physical replacement");
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored target"),
        "# central version\n"
    );
    let operation_id = {
        let database = facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let operation = database
            .operation_repository()
            .list_sync()
            .expect("operation records")
            .into_iter()
            .find(|record| record.kind == "reconcile_restore_deployment")
            .expect("reconcile operation");
        assert_eq!(operation.phase, OperationPhase::NeedsRecovery);
        operation.operation_id
    };
    let backup_path = target_root.join(format!(
        ".{}.skillhub-restore-{operation_id}",
        deployment.runtime_name
    ));
    assert!(backup_path.exists(), "original target remains recoverable");
    let candidates = facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates");
    let AppQueryResult::RecoveryCandidates(candidates) = candidates else {
        panic!("expected recovery candidates");
    };
    assert!(candidates.iter().any(|candidate| {
        candidate.operation_id == operation_id
            && candidate.actions == [RecoveryAction::CompleteOperation]
    }));

    facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch("DROP TRIGGER block_reconcile_restore_checkpoint")
        .expect("remove injected checkpoint failure");
    drop(facade);

    let restarted = LocalApplicationFacade::open_with_library(&database_path, &library_root)
        .expect("restart facade");
    restarted
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id,
            action: RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("resume reconcile restore");
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored target"),
        "# central version\n"
    );
    assert!(
        !backup_path.exists(),
        "verified backup is retired after commit"
    );
    let database = restarted.database_for_tests();
    let database = database.lock().expect("database lock");
    let restored = database
        .deployment_repository()
        .list_all()
        .expect("deployment rows")
        .into_iter()
        .find(|record| record.id == deployment.id)
        .expect("deployment row");
    assert_eq!(
        restored.observed_hash.as_deref(),
        Some(expected_hash.as_str())
    );
    assert_eq!(
        database
            .operation_repository()
            .get_sync(operation_id)
            .expect("read operation")
            .expect("operation record")
            .phase,
        OperationPhase::Committed
    );
}
