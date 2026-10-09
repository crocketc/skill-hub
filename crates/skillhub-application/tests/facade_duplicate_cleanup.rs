use std::path::{Path, PathBuf};

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::{AppQueryResult, GetUsageEnvironmentProblems, PrepareUsageChange};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryNodeFact, DirectoryRecognition, DirectoryRole,
    EnvironmentProblemKind, UsageChangeAction, UsageEntryKey,
};
use skillhub_core::{
    AppCommand, AppQuery, ApplicationFacade, ErrorCode, OperationId, OperationPhase,
    RecoveryAction, ResolveRecovery,
};
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_ID: &str = "agent.duplicate-fixture";
const PROFILE_ID: &str = "duplicate-fixture";

struct Fixture {
    workspace: tempfile::TempDir,
    facade: LocalApplicationFacade,
    builtin_directory: PathBuf,
    user_directory: PathBuf,
}

fn fixture(with_builtin: bool) -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let database = Database::open(workspace.path().join("skillhub.sqlite")).expect("database");
    let builtin_directory = workspace.path().join("agent/builtin-skills");
    let user_directory = workspace.path().join("agent/user-skills");
    std::fs::create_dir_all(&builtin_directory).expect("builtin directory");
    std::fs::create_dir_all(&user_directory).expect("user directory");

    let logical_targets = if with_builtin {
        vec![LogicalTarget {
            id: "duplicate-fixture:builtin".into(),
            profile_id: PROFILE_ID.into(),
            client_id: CLIENT_ID.into(),
            scope: TargetScope::Global,
            path: builtin_directory.to_string_lossy().into_owned(),
            agent_root_id: "duplicate-fixture-root".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::MayCoexist,
            shared_reference: false,
            builtin: true,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id: skillhub_core::physical_id_for_path(&builtin_directory)
                .expect("builtin physical identity"),
            status: skillhub_core::agent::DirectoryObservationStatus::Existing,
            physical_identity_verified: true,
        }]
    } else {
        Vec::new()
    };
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-10-09T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: PROFILE_ID.into(),
                client_id: CLIENT_ID.into(),
                kind: ClientKind::Cli,
                display_name: "Duplicate Fixture Agent".into(),
                supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            agent_roots: Vec::new(),
            logical_targets,
            physical_targets: Vec::new(),
        })
        .expect("discovery snapshot");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    let fixture = Fixture {
        workspace,
        facade,
        builtin_directory,
        user_directory,
    };
    add_directory(&fixture, "builtin-dir", &fixture.builtin_directory);
    add_directory(&fixture, "user-dir", &fixture.user_directory);
    fixture
}

fn add_directory(fixture: &Fixture, id: &str, path: &Path) {
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    database
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: id.into(),
            path: path.to_string_lossy().into_owned(),
            path_key: String::new(),
            role: DirectoryRole::AgentNative,
            profile_id: Some(PROFILE_ID.into()),
            agent_client_id: Some(CLIENT_ID.into()),
            exists: true,
            observed_at: 1,
            scan_source: Some("duplicate-cleanup-fixture".into()),
        })
        .expect("directory node");
    database
        .relationship_repository()
        .upsert_capability(&AgentDirectoryCapabilityFact {
            agent_client_id: CLIENT_ID.into(),
            directory_node_id: id.into(),
            recognition: DirectoryRecognition::Supported,
            precedence: DirectoryPrecedence::Preferred,
            evidence_reference: Some("fixture".into()),
            researched_at: Some("2026-10-09".into()),
            applicable_platforms: vec!["macos".into(), "windows".into()],
        })
        .expect("directory capability");
}

fn write_skill(directory: &Path, relative: &str, body: &str) -> PathBuf {
    let path = directory.join(relative);
    std::fs::create_dir_all(&path).expect("skill directory");
    std::fs::write(
        path.join("SKILL.md"),
        format!("---\nname: formatter\n---\n{body}\n"),
    )
    .expect("skill file");
    path
}

async fn analysis(fixture: &Fixture) -> skillhub_core::relationship::EnvironmentProblemAnalysis {
    let result = fixture
        .facade
        .query(AppQuery::GetUsageEnvironmentProblems(
            GetUsageEnvironmentProblems,
        ))
        .await
        .expect("environment problem query");
    let AppQueryResult::UsageEnvironmentProblems(analysis) = result else {
        panic!("expected environment problem analysis");
    };
    analysis
}

fn key(directory_id: &str) -> UsageEntryKey {
    UsageEntryKey {
        directory_id: directory_id.into(),
        relative_entry_path: "formatter".into(),
    }
}

fn request(
    problem_id: String,
    retain: UsageEntryKey,
    selected: Vec<UsageEntryKey>,
    destination: Option<String>,
) -> PrepareUsageChange {
    PrepareUsageChange {
        operation_id: OperationId::new(),
        action: UsageChangeAction::ResolveDuplicate,
        relation_ids: Vec::new(),
        problem_id: Some(problem_id),
        skill_id: None,
        requested_form: None,
        copy_disposition: None,
        content_basis: None,
        retain_entry_key: Some(retain),
        selected_entry_keys: selected,
        runtime_name: None,
        base_version_id: None,
        non_recognized_destination: destination,
    }
}

#[tokio::test]
async fn same_content_builtin_is_retained_readonly() {
    let fixture = fixture(true);
    let builtin = write_skill(&fixture.builtin_directory, "formatter", "identical body");
    let user = write_skill(&fixture.user_directory, "formatter", "identical body");
    let found = analysis(&fixture).await;
    assert_eq!(found.problems.len(), 1);
    let problem = &found.problems[0];
    assert_eq!(problem.kind, EnvironmentProblemKind::SameSkill);
    let selected = vec![key("builtin-dir"), key("user-dir")];

    let prepared = fixture
        .facade
        .prepare_usage_change(request(
            problem.problem_id.clone(),
            key("builtin-dir"),
            selected,
            None,
        ))
        .expect("prepare duplicate cleanup");
    assert_eq!(prepared.action, UsageChangeAction::ResolveDuplicate);
    let result = fixture
        .facade
        .commit_usage_change(skillhub_core::api::CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("commit duplicate cleanup");

    assert!(result.item_results.is_empty());
    assert!(builtin.join("SKILL.md").is_file(), "builtin remains intact");
    assert!(
        !user.exists(),
        "redundant user copy is removed after backup"
    );
    assert!(analysis(&fixture).await.problems.is_empty());
}

#[tokio::test]
async fn different_builtin_content_is_name_conflict() {
    let fixture = fixture(true);
    let builtin = write_skill(&fixture.builtin_directory, "formatter", "builtin body");
    let user = write_skill(&fixture.user_directory, "formatter", "user body");
    let found = analysis(&fixture).await;
    assert_eq!(found.problems.len(), 1);
    assert_eq!(found.problems[0].kind, EnvironmentProblemKind::NameConflict);
    let result = fixture.facade.prepare_usage_change(request(
        found.problems[0].problem_id.clone(),
        key("builtin-dir"),
        vec![key("builtin-dir"), key("user-dir")],
        None,
    ));
    assert_eq!(
        result
            .expect_err("name conflict cannot use duplicate cleanup")
            .code,
        ErrorCode::OperationConflict
    );
    assert!(builtin.join("SKILL.md").is_file());
    assert!(user.join("SKILL.md").is_file());
}

#[tokio::test]
async fn unmanaged_cleanup_requires_explicit_intent() {
    let fixture = fixture(false);
    let first = write_skill(&fixture.user_directory, "formatter", "same body");
    let second_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&second_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &second_directory);
    let second = write_skill(&second_directory, "formatter", "same body");
    let result = fixture.facade.prepare_usage_change(PrepareUsageChange {
        operation_id: OperationId::new(),
        action: UsageChangeAction::Release,
        relation_ids: Vec::new(),
        problem_id: None,
        skill_id: None,
        requested_form: None,
        copy_disposition: None,
        content_basis: None,
        retain_entry_key: None,
        selected_entry_keys: Vec::new(),
        runtime_name: None,
        base_version_id: None,
        non_recognized_destination: None,
    });
    assert!(result.is_err());
    assert!(first.join("SKILL.md").is_file());
    assert!(second.join("SKILL.md").is_file());
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
}

#[tokio::test]
async fn keep_copy_in_recognized_directory_stays_pending() {
    let fixture = fixture(false);
    write_skill(&fixture.user_directory, "formatter", "same body");
    let other_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&other_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &other_directory);
    write_skill(&other_directory, "formatter", "same body");
    let found = analysis(&fixture).await;
    let problem = &found.problems[0];
    let incomplete = request(
        problem.problem_id.clone(),
        key("user-dir"),
        vec![key("user-dir")],
        None,
    );
    assert!(fixture.facade.prepare_usage_change(incomplete).is_err());
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
}

#[tokio::test]
async fn move_outside_environment_is_verified() {
    let fixture = fixture(false);
    let retained = write_skill(&fixture.user_directory, "formatter", "same body");
    let other_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&other_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &other_directory);
    let redundant = write_skill(&other_directory, "formatter", "same body");
    let destination = fixture.workspace.path().join("retained/formatter");
    std::fs::create_dir_all(destination.parent().expect("destination parent"))
        .expect("create unrecognized destination parent");
    let found = analysis(&fixture).await;
    let prepared = fixture
        .facade
        .prepare_usage_change(request(
            found.problems[0].problem_id.clone(),
            key("user-dir"),
            vec![key("user-dir"), key("other-dir")],
            Some(destination.to_string_lossy().into_owned()),
        ))
        .expect("prepare move out");
    fixture
        .facade
        .commit_usage_change(skillhub_core::api::CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("commit move out");

    assert!(!retained.exists());
    assert!(!redundant.exists());
    assert!(destination.join("SKILL.md").is_file());
    assert!(analysis(&fixture).await.problems.is_empty());
}

#[tokio::test]
async fn cancel_or_backup_conflict_stays_pending() {
    let fixture = fixture(false);
    let first = write_skill(&fixture.user_directory, "formatter", "same body");
    let second_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&second_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &second_directory);
    let second = write_skill(&second_directory, "formatter", "same body");
    let found = analysis(&fixture).await;
    let prepared = fixture
        .facade
        .prepare_usage_change(request(
            found.problems[0].problem_id.clone(),
            key("user-dir"),
            vec![key("user-dir"), key("other-dir")],
            None,
        ))
        .expect("prepare before cancel");
    let cancelled_operation_id = prepared.operation_id;
    drop(prepared); // User cancels before commit.
    assert!(first.join("SKILL.md").is_file());
    assert!(second.join("SKILL.md").is_file());
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
    let recovery = fixture
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates after cancelling preview");
    assert!(
        matches!(
            recovery,
            AppQueryResult::RecoveryCandidates(ref values)
                if values.iter().all(|candidate| candidate.operation_id != cancelled_operation_id)
        ),
        "a read-only cancelled preview must not appear as a recovery candidate"
    );

    let retry = fixture
        .facade
        .prepare_usage_change(request(
            analysis(&fixture).await.problems[0].problem_id.clone(),
            key("user-dir"),
            vec![key("user-dir"), key("other-dir")],
            None,
        ))
        .expect("prepare before blocked backup");
    let blocked_backup = fixture
        .workspace
        .path()
        .join("library/.skillhub/usage-duplicate-backups")
        .join(retry.operation_id.to_string())
        .join("0/entry");
    std::fs::create_dir_all(&blocked_backup).expect("occupy backup path");
    assert!(fixture
        .facade
        .commit_usage_change(skillhub_core::api::CommitUsageChange {
            operation_id: retry.operation_id,
            prepared_id: retry.prepared_id,
        })
        .is_err());
    assert!(first.join("SKILL.md").is_file());
    assert!(second.join("SKILL.md").is_file());
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn permission_denial_during_cleanup_keeps_all_copies_and_issue() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture(false);
    let first = write_skill(&fixture.user_directory, "formatter", "same body");
    let second_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&second_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &second_directory);
    let second = write_skill(&second_directory, "formatter", "same body");
    let problem = analysis(&fixture).await.problems.remove(0);
    let prepared = fixture
        .facade
        .prepare_usage_change(request(
            problem.problem_id,
            key("user-dir"),
            vec![key("user-dir"), key("other-dir")],
            None,
        ))
        .expect("prepare duplicate cleanup");

    let management = fixture.workspace.path().join("library/.skillhub");
    let original_mode = std::fs::metadata(&management)
        .expect("management directory metadata")
        .permissions()
        .mode();
    std::fs::set_permissions(&management, std::fs::Permissions::from_mode(0o500))
        .expect("remove management directory write permission");
    let probe = management.join("duplicate-cleanup-permission-probe");
    let permission_denied = std::fs::create_dir(&probe)
        .err()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied);
    if !permission_denied {
        let _ = std::fs::remove_dir(&probe);
        std::fs::set_permissions(&management, std::fs::Permissions::from_mode(original_mode))
            .expect("restore permissions after unavailable denial fixture");
        panic!("read-only management directory did not produce PermissionDenied");
    }

    let result = fixture
        .facade
        .commit_usage_change(skillhub_core::api::CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        });
    std::fs::set_permissions(&management, std::fs::Permissions::from_mode(original_mode))
        .expect("restore management directory permissions");

    assert!(result.is_err(), "permission failure must stop cleanup");
    assert!(first.join("SKILL.md").is_file());
    assert!(second.join("SKILL.md").is_file());
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
}

#[tokio::test]
async fn declared_destination_inside_recognized_directory_is_rejected() {
    let fixture = fixture(false);
    let retained = write_skill(&fixture.user_directory, "formatter", "same body");
    let other_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&other_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &other_directory);
    let redundant = write_skill(&other_directory, "formatter", "same body");
    let found = analysis(&fixture).await;
    let destination = fixture.user_directory.join("retained-formatter");
    let prepared = fixture.facade.prepare_usage_change(request(
        found.problems[0].problem_id.clone(),
        key("user-dir"),
        vec![key("user-dir"), key("other-dir")],
        Some(destination.to_string_lossy().into_owned()),
    ));
    assert!(prepared.is_err());
    assert!(retained.join("SKILL.md").is_file());
    assert!(redundant.join("SKILL.md").is_file());
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
}

#[tokio::test]
async fn interrupted_duplicate_cleanup_can_be_rolled_back_from_recovery_center() {
    let fixture = fixture(false);
    let retained = write_skill(&fixture.user_directory, "formatter", "same body");
    let second_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&second_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &second_directory);
    let removed = write_skill(&second_directory, "formatter", "same body");
    let problem = analysis(&fixture).await.problems.remove(0);
    let prepared = fixture
        .facade
        .prepare_usage_change(request(
            problem.problem_id,
            key("user-dir"),
            vec![key("other-dir"), key("user-dir")],
            None,
        ))
        .expect("prepare duplicate cleanup");

    // 模拟文件系统删除完成后进程中断：备份与写前恢复日志已持久化，
    // 但恢复中心尚未收到提交结果。
    let database = fixture.facade.database_for_tests();
    {
        let database = database.lock().expect("database lock");
        let mut record = database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read operation")
            .expect("operation exists");
        let plans = record.recovery_data["plans"]
            .as_array_mut()
            .expect("duplicate cleanup plans");
        let plan = plans
            .iter_mut()
            .find(|plan| plan["entry_key"]["directory_id"] == "other-dir")
            .expect("removed entry plan");
        let backup = PathBuf::from(plan["backup_path"].as_str().expect("backup path"));
        std::fs::create_dir_all(backup.parent().expect("backup parent"))
            .expect("create backup parent");
        std::fs::create_dir(&backup).expect("create backup");
        std::fs::copy(removed.join("SKILL.md"), backup.join("SKILL.md"))
            .expect("copy backup content");
        std::fs::remove_dir_all(&removed).expect("interrupted remove");
        plan["backup_created"] = serde_json::Value::Bool(true);
        plan["removal_started"] = serde_json::Value::Bool(true);
        // The source is gone, but the write-ahead `removal_started` marker is
        // the only durable evidence because the process stopped before the
        // post-delete journal update.
        plan["removed"] = serde_json::Value::Bool(false);
        record.phase = OperationPhase::Applying;
        record.progress.phase = OperationPhase::Applying;
        record.progress.message_code = "operation.usage_duplicate_cleanup.needs_recovery".into();
        database
            .operation_repository()
            .update_sync(&record)
            .expect("persist interrupted operation");
    }

    let candidates = fixture
        .facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list duplicate cleanup recovery candidate");
    assert!(matches!(
        candidates,
        AppQueryResult::RecoveryCandidates(ref values)
            if values.len() == 1
                && values[0].operation_id == prepared.operation_id
                && values[0].actions == vec![RecoveryAction::RollbackOperation]
    ));

    fixture
        .facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: RecoveryAction::RollbackOperation,
        }))
        .await
        .expect("restore interrupted duplicate cleanup");

    assert!(retained.join("SKILL.md").is_file(), "retained copy remains");
    assert!(
        removed.join("SKILL.md").is_file(),
        "removed copy is restored"
    );
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read recovered operation")
            .expect("operation exists")
            .phase,
        OperationPhase::RolledBack,
    );
}

#[tokio::test]
async fn interrupted_retained_copy_move_can_be_rolled_back() {
    let fixture = fixture(false);
    let retained = write_skill(&fixture.user_directory, "formatter", "same body");
    let second_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&second_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &second_directory);
    let redundant = write_skill(&second_directory, "formatter", "same body");
    let destination = fixture.workspace.path().join("retained/formatter");
    std::fs::create_dir_all(destination.parent().expect("destination parent"))
        .expect("create destination parent");
    let problem = analysis(&fixture).await.problems.remove(0);
    let prepared = fixture
        .facade
        .prepare_usage_change(request(
            problem.problem_id,
            key("user-dir"),
            vec![key("other-dir"), key("user-dir")],
            Some(destination.to_string_lossy().into_owned()),
        ))
        .expect("prepare retained copy move");

    let database = fixture.facade.database_for_tests();
    {
        let database = database.lock().expect("database lock");
        let mut record = database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read operation")
            .expect("operation exists");
        let plans = record.recovery_data["plans"]
            .as_array_mut()
            .expect("duplicate cleanup plans");
        let plan = plans
            .iter_mut()
            .find(|plan| plan["entry_key"]["directory_id"] == "user-dir")
            .expect("retained entry plan");
        let backup = PathBuf::from(plan["backup_path"].as_str().expect("backup path"));
        std::fs::create_dir_all(backup.parent().expect("backup parent"))
            .expect("create backup parent");
        std::fs::create_dir(&backup).expect("create backup");
        std::fs::copy(retained.join("SKILL.md"), backup.join("SKILL.md"))
            .expect("copy backup content");
        std::fs::create_dir(&destination).expect("create interrupted destination");
        std::fs::copy(retained.join("SKILL.md"), destination.join("SKILL.md"))
            .expect("copy retained content");
        plan["backup_created"] = serde_json::Value::Bool(true);
        // This is the write-ahead state before destination creation; recovery
        // must inspect and remove the exact verified destination if present.
        plan["destination_started"] = serde_json::Value::Bool(true);
        plan["destination_created"] = serde_json::Value::Bool(false);
        record.phase = OperationPhase::Applying;
        record.progress.phase = OperationPhase::Applying;
        database
            .operation_repository()
            .update_sync(&record)
            .expect("persist interrupted move");
    }

    fixture
        .facade
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: RecoveryAction::RollbackOperation,
        }))
        .await
        .expect("roll back interrupted move");

    assert!(retained.join("SKILL.md").is_file());
    assert!(redundant.join("SKILL.md").is_file());
    assert!(!destination.exists());
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
}

#[tokio::test]
async fn close_only_after_rescan() {
    let fixture = fixture(false);
    write_skill(&fixture.user_directory, "formatter", "same body");
    let second_directory = fixture.workspace.path().join("agent/other-skills");
    std::fs::create_dir_all(&second_directory).expect("second directory");
    add_directory(&fixture, "other-dir", &second_directory);
    write_skill(&second_directory, "formatter", "same body");
    let found = analysis(&fixture).await;
    let prepared = fixture
        .facade
        .prepare_usage_change(request(
            found.problems[0].problem_id.clone(),
            key("user-dir"),
            vec![key("user-dir"), key("other-dir")],
            None,
        ))
        .expect("prepare cleanup");
    assert_eq!(analysis(&fixture).await.problems.len(), 1);
    fixture
        .facade
        .commit_usage_change(skillhub_core::api::CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("commit cleanup");
    assert!(analysis(&fixture).await.problems.is_empty());
}
