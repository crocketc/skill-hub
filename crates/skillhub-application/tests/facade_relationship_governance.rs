//! Task 4 relationship-governance facade contract tests.
//!
//! These tests deliberately exercise the public `ApplicationFacade` seam.  In
//! particular, they prove that relationship governance is distinct from the
//! legacy original-file migration flow and that a prepare operation is
//! observationally read-only for the user's relationship path.

use serde_json::Value;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::DirectoryPrecedence;
use skillhub_core::api::{
    CreateSkill, GetRelationshipOverview, GetRelationshipRemovalImpact, ListSkills,
    PrepareRelationMigration, RelationshipMigrationBackupPolicy, RelationshipOverviewScope,
};
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, DeploymentRelationFact, DirectoryNodeFact, DirectoryRecognition, DirectoryRole,
    FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, IdentityDirection, OwnershipState,
    RelationshipType,
};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode,
    OperationPhase, RelationMigrationState, RelationMigrationTargetMode, SkillId,
};
use skillhub_storage::{CentralLibrary, Database};

const BODY: &str = "# Notes\n\nrelationship governance\n";

struct Fixture {
    _workspace: tempfile::TempDir,
    facade: LocalApplicationFacade,
    relation_id: String,
    skill_id: SkillId,
    source: std::path::PathBuf,
    central: std::path::PathBuf,
    library_root: std::path::PathBuf,
    db_path: std::path::PathBuf,
    database: std::sync::Arc<std::sync::Mutex<Database>>,
}

fn write_skill(path: &std::path::Path) {
    std::fs::create_dir_all(path).expect("skill directory");
    std::fs::write(path.join("SKILL.md"), BODY).expect("skill body");
}

fn mutate_relation_journal(
    fixture: &Fixture,
    operation_id: skillhub_core::OperationId,
    mutate: impl FnOnce(&mut Value),
) {
    let database = fixture.database.lock().expect("database lock");
    let raw: String = database
        .connection_for_test()
        .query_row(
            "SELECT progress_json FROM operations WHERE operation_id=?1",
            [operation_id.to_string()],
            |row| row.get(0),
        )
        .expect("journal progress");
    let mut progress: Value = serde_json::from_str(&raw).expect("journal json");
    mutate(&mut progress["recovery_data"]["journal"]["backup"]);
    let encoded = serde_json::to_string(&progress).expect("journal json encoding");
    database
        .connection_for_test()
        .execute(
            "UPDATE operations SET progress_json=?2 WHERE operation_id=?1",
            rusqlite::params![operation_id.to_string(), encoded],
        )
        .expect("tamper journal");
}

#[cfg(unix)]
fn create_dir_link_for_test(source: &std::path::Path, destination: &std::path::Path) {
    std::os::unix::fs::symlink(source, destination).expect("recreate managed link");
}

#[cfg(windows)]
fn create_dir_link_for_test(source: &std::path::Path, destination: &std::path::Path) {
    std::os::windows::fs::symlink_dir(source, destination).expect("recreate managed link");
}

async fn fixture() -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let source = workspace.path().join("agent/skills/notes");
    write_skill(&source);
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let db_path = workspace.path().join("db.sqlite");
    let database = Database::open(&db_path).expect("database");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");
    let AppQueryResult::SkillPage(page) = facade
        .query(AppQuery::ListSkills(ListSkills {
            text: "Notes".into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list skill")
    else {
        panic!("expected skill page");
    };
    let skill_id = page.items[0].skill_id;
    let library = facade
        .library_runtime()
        .snapshot()
        .expect("library snapshot");
    let central = library
        .central
        .visible_skill_path_for_runtime(skill_id, "Notes");
    let fingerprint = skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&source)
        .expect("source fingerprint");

    let directory = workspace.path().join("agent/skills");
    let database_handle = facade.database_for_tests();
    let database = database_handle.lock().expect("database lock");
    database
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: "directory:agent-skills".into(),
            path: directory.to_string_lossy().into_owned(),
            path_key: String::new(),
            role: DirectoryRole::AgentNative,
            profile_id: Some("agent-profile".into()),
            agent_client_id: Some("agent.demo".into()),
            exists: true,
            observed_at: 1,
            scan_source: Some("test".into()),
        })
        .expect("directory node");
    database
        .relationship_repository()
        .upsert_capability(&AgentDirectoryCapabilityFact {
            agent_client_id: "agent.demo".into(),
            directory_node_id: "directory:agent-skills".into(),
            recognition: DirectoryRecognition::Supported,
            precedence: DirectoryPrecedence::Preferred,
            evidence_reference: Some("fixture".into()),
            researched_at: Some("2026-09-15".into()),
            applicable_platforms: vec!["windows".into(), "macos".into()],
        })
        .expect("directory capability");
    let relation_id = "observed:agent.demo:notes".to_owned();
    database
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: relation_id.clone(),
            skill_id: Some(skill_id),
            agent_client_id: "agent.demo".into(),
            path: source.to_string_lossy().into_owned(),
            path_key: String::new(),
            directory_node_id: Some("directory:agent-skills".into()),
            relationship: RelationshipType::ObservedCopy,
            file_representation: FileRepresentation::Copy,
            ownership: OwnershipState::ObservedUnmanaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: fingerprint,
            origin: ObservedOrigin::Scan,
            match_state: ObservedMatchState::ContentVerified,
            active: true,
            observed_at: 1,
            released_at: None,
        })
        .expect("relationship");
    database
        .conflict_repository()
        .create_case(&ConflictCaseFact {
            conflict_id: "conflict:notes".into(),
            kind: ConflictKind::SharedDirectoryDuplicate,
            classification: ConflictClassification::Uncertain,
            member_skill_ids: vec![skill_id],
            members: Vec::new(),
            evidence: ConflictEvidence {
                fingerprints_match: Some(true),
                names_match: Some(true),
                identity_direction: Some(IdentityDirection::SameSkill),
                sufficient_identity_evidence: true,
            },
            user_decision: None,
            decided_at: None,
        })
        .expect("conflict");
    database
        .governance_task_repository()
        .create(&GovernanceTaskFact {
            task_id: "task:notes".into(),
            kind: GovernanceTaskKind::ConfirmSharedDirectoryImpact,
            subject_id: relation_id.clone(),
            detail: "confirm relationship impact".into(),
            resolved: false,
            created_at: 1,
            resolved_at: None,
        })
        .expect("governance task");
    drop(database);

    Fixture {
        _workspace: workspace,
        facade,
        relation_id,
        skill_id,
        source,
        central,
        library_root,
        db_path,
        database: database_handle,
    }
}

#[tokio::test]
async fn relationship_overview_combines_facts_without_claiming_agent_execution() {
    let fixture = fixture().await;
    let result = fixture
        .facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::Skill {
                skill_id: fixture.skill_id,
            },
        }))
        .await
        .expect("relationship overview");
    let AppQueryResult::RelationshipOverview(overview) = result else {
        panic!("expected relationship overview");
    };
    assert_eq!(overview.deployment_relations.len(), 1);
    assert_eq!(overview.source_relations.len(), 0);
    assert_eq!(overview.directory_nodes.len(), 1);
    assert_eq!(overview.agent_directory_capabilities.len(), 1);
    assert_eq!(overview.conflict_cases.len(), 1);
    assert_eq!(overview.pending_governance_tasks.len(), 1);
    assert!(!overview.agent_execution_confirmed);
}

#[tokio::test]
async fn removal_impact_is_calculated_by_core_for_a_relation() {
    let fixture = fixture().await;
    let result = fixture
        .facade
        .query(AppQuery::GetRelationshipRemovalImpact(
            GetRelationshipRemovalImpact {
                relation_id: fixture.relation_id.clone(),
            },
        ))
        .await
        .expect("removal impact");
    let AppQueryResult::RelationshipRemovalImpact(impact) = result else {
        panic!("expected relationship removal impact");
    };
    assert_eq!(impact.relation_id, fixture.relation_id);
    assert_eq!(
        impact.relation.unwrap().relationship,
        RelationshipType::ObservedCopy
    );
    assert!(impact.backup.required);
    assert_eq!(
        impact.minimal_action,
        skillhub_core::relationship::MinimalImpactAction::ConvertCopyToManagedLink
    );
}

#[tokio::test]
async fn prepare_relation_migration_does_not_write_the_relationship_path() {
    let fixture = fixture().await;
    let before = std::fs::read(fixture.source.join("SKILL.md")).expect("before bytes");
    let metadata_before = std::fs::symlink_metadata(&fixture.source).expect("before metadata");
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id,
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare relation migration");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared relation migration");
    };
    assert_eq!(prepared.target_path, fixture.central.to_string_lossy());
    assert_eq!(
        std::fs::read(fixture.source.join("SKILL.md")).expect("after bytes"),
        before
    );
    assert_eq!(
        std::fs::symlink_metadata(&fixture.source)
            .expect("after metadata")
            .file_type(),
        metadata_before.file_type()
    );
}

#[tokio::test]
async fn commit_rejects_a_changed_fingerprint_and_leaves_a_recovery_task() {
    let fixture = fixture().await;
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    std::fs::write(fixture.source.join("SKILL.md"), "changed").expect("change source");

    let result = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("failed commit is reported as a result");
    let AppCommandResult::RelationMigrationResult(result) = result else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, RelationMigrationState::Failed);
    assert_eq!(result.error_code, Some(ErrorCode::TargetChanged));
    assert!(fixture.source.is_dir());
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("source metadata")
        .file_type()
        .is_symlink());
    assert!(fixture
        .database
        .lock()
        .expect("database lock")
        .governance_task_repository()
        .list_pending()
        .expect("pending tasks")
        .iter()
        .any(|task| task.kind == GovernanceTaskKind::OperationFailureRecovery));
}

#[tokio::test]
async fn prepared_relation_can_be_cancelled_without_touching_original_migration() {
    let fixture = fixture().await;
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id,
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    let rolled_back = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("cancel prepared operation");
    let AppCommandResult::RelationMigrationResult(result) = rolled_back else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, RelationMigrationState::Cancelled);
    assert!(fixture.source.is_dir());
    assert!(fixture.central.is_dir());

    // A relationship rollback must not create, remove, or mark an
    // `original_migration` row.  That legacy flow has its own explicit API.
    let original_migrations: i64 = fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM original_migrations", [], |row| {
            row.get(0)
        })
        .expect("original migration count");
    assert_eq!(original_migrations, 0);
}

#[tokio::test]
async fn committed_relation_is_rollbackable_when_link_capability_exists() {
    let fixture = fixture().await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    let committed = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("commit");
    let AppCommandResult::RelationMigrationResult(committed) = committed else {
        panic!("expected commit result");
    };
    assert_eq!(committed.state, RelationMigrationState::Committed);
    assert!(std::fs::symlink_metadata(&fixture.source)
        .expect("link metadata")
        .file_type()
        .is_symlink());

    let rolled_back = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: committed.operation_id,
            },
        ))
        .await
        .expect("rollback");
    let AppCommandResult::RelationMigrationResult(rolled_back) = rolled_back else {
        panic!("expected rollback result");
    };
    assert_eq!(rolled_back.state, RelationMigrationState::RolledBack);
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("restored metadata")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("restored body"),
        BODY
    );
}

#[tokio::test]
async fn commit_failure_removes_new_link_before_restoring_and_preserves_central_fingerprint() {
    let fixture = fixture().await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    let central_before =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.central)
            .expect("central fingerprint");

    // Force the post-filesystem journal checkpoint to fail. The commit must
    // still remove the newly-created link with symlink_metadata semantics
    // before copying the backup back to the original path.
    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute(
            "ALTER TABLE operations RENAME TO operations_unavailable",
            [],
        )
        .expect("break only the journal table");

    let error = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect_err("journal failure must be reported");
    assert_eq!(error.code, ErrorCode::InternalError);
    assert_eq!(
        error.params.get("audit").and_then(|value| value.as_str()),
        Some("filesystem_restored_after_journal_failure")
    );
    assert_eq!(
        error
            .params
            .get("journal_error")
            .and_then(|value| value.as_str()),
        Some("internal.error")
    );
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("restored source metadata")
        .file_type()
        .is_symlink());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.central)
            .expect("central fingerprint after recovery"),
        central_before
    );
}

#[tokio::test]
async fn rollback_rejects_backup_metadata_tampering_without_restoring_or_writing_old_relation() {
    let fixture = fixture().await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    let committed = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("commit");
    let AppCommandResult::RelationMigrationResult(committed) = committed else {
        panic!("expected committed result");
    };

    mutate_relation_journal(&fixture, committed.operation_id, |backup| {
        backup["original_fingerprint"] = Value::String("sha256:tampered".into());
    });
    let rollback = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: committed.operation_id,
            },
        ))
        .await
        .expect("tampered rollback is reported");
    let AppCommandResult::RelationMigrationResult(rollback) = rollback else {
        panic!("expected rollback result");
    };
    assert_eq!(rollback.state, RelationMigrationState::Failed);
    assert_eq!(rollback.error_code, Some(ErrorCode::OperationConflict));
    assert!(std::fs::symlink_metadata(&fixture.source)
        .expect("managed link remains")
        .file_type()
        .is_symlink());
    let relation = fixture
        .database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == fixture.relation_id)
        .expect("relation");
    assert_eq!(relation.relationship, RelationshipType::ManagedLink);
    assert_eq!(relation.ownership, OwnershipState::SkillhubManaged);
}

#[tokio::test]
async fn rollback_refuses_to_remove_a_path_that_no_longer_matches_the_prepared_link() {
    let fixture = fixture().await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    let committed = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("commit");
    let AppCommandResult::RelationMigrationResult(committed) = committed else {
        panic!("expected committed result");
    };

    std::fs::remove_file(&fixture.source).expect("remove managed link");
    write_skill(&fixture.source);
    let rollback = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: committed.operation_id,
            },
        ))
        .await
        .expect("rollback result");
    let AppCommandResult::RelationMigrationResult(rollback) = rollback else {
        panic!("expected rollback result");
    };
    assert_eq!(rollback.state, RelationMigrationState::Failed);
    assert_eq!(rollback.error_code, Some(ErrorCode::OwnershipMismatch));
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("attacker content"),
        BODY
    );

    std::fs::remove_dir_all(&fixture.source).expect("remove attacker content");
    create_dir_link_for_test(&fixture.central, &fixture.source);
    let retried = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: committed.operation_id,
            },
        ))
        .await
        .expect("retry rollback result");
    let AppCommandResult::RelationMigrationResult(retried) = retried else {
        panic!("expected retry result");
    };
    assert_eq!(retried.state, RelationMigrationState::RolledBack);
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("restored body"),
        BODY
    );
}

#[tokio::test]
async fn relation_migration_can_resume_from_a_new_facade_using_the_durable_journal() {
    let fixture = fixture().await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };

    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.db_path).expect("reopen database"),
        &fixture.library_root,
    );
    let committed = restarted
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("commit after restart");
    let AppCommandResult::RelationMigrationResult(committed) = committed else {
        panic!("expected committed result");
    };
    assert_eq!(committed.state, RelationMigrationState::Committed);

    let restarted_again = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.db_path).expect("reopen database for rollback"),
        &fixture.library_root,
    );
    let rolled_back = restarted_again
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("rollback after restart");
    let AppCommandResult::RelationMigrationResult(rolled_back) = rolled_back else {
        panic!("expected rollback result");
    };
    assert_eq!(rolled_back.state, RelationMigrationState::RolledBack);
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("restored source")
        .file_type()
        .is_symlink());
}

#[tokio::test]
async fn failed_relation_commit_re_reads_facts_on_retry_instead_of_returning_stale_failure() {
    let fixture = fixture().await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    std::fs::write(fixture.central.join("SKILL.md"), "temporarily changed")
        .expect("change central target");
    let first = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("failed commit result");
    let AppCommandResult::RelationMigrationResult(first) = first else {
        panic!("expected failed result");
    };
    assert_eq!(first.state, RelationMigrationState::Failed);
    std::fs::write(fixture.central.join("SKILL.md"), BODY).expect("restore central target");

    let second = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("retry commit result");
    let AppCommandResult::RelationMigrationResult(second) = second else {
        panic!("expected retry result");
    };
    assert_eq!(second.state, RelationMigrationState::Committed);
}

#[tokio::test]
async fn unknown_registered_root_is_rejected_and_creates_a_governance_task() {
    let fixture = fixture().await;
    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute("DELETE FROM directory_nodes", [])
        .expect("remove registered root");
    let error = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect_err("unknown root must be rejected");
    assert_eq!(error.code, ErrorCode::PathOutsideAllowedRoots);
    assert!(fixture
        .database
        .lock()
        .expect("database lock")
        .governance_task_repository()
        .list_pending()
        .expect("governance tasks")
        .iter()
        .any(|task| {
            task.subject_id == fixture.relation_id
                && task.kind == GovernanceTaskKind::UnknownDirectoryRecognition
        }));
}

#[tokio::test]
async fn removal_impact_surfaces_shared_inactive_and_permission_governance_tasks() {
    let fixture = fixture().await;
    let relation = {
        let db = fixture.database.lock().expect("database lock");
        db.connection_for_test()
            .execute("DELETE FROM governance_tasks", [])
            .expect("clear fixture tasks");
        let mut relation = db
            .relationship_repository()
            .list_relations()
            .expect("relation")
            .into_iter()
            .next()
            .expect("fixture relation");
        relation.relationship = RelationshipType::SharedDirectoryRead;
        relation.file_representation = FileRepresentation::Directory;
        relation.active = true;
        db.relationship_repository()
            .upsert_deployment_relation(&relation)
            .expect("shared relation");
        relation
    };

    let other_path = fixture
        .source
        .parent()
        .expect("source parent")
        .join("other-notes");
    {
        let db = fixture.database.lock().expect("database lock");
        let other = DeploymentRelationFact {
            relation_id: "observed:other:notes".into(),
            skill_id: Some(fixture.skill_id),
            agent_client_id: "agent.other".into(),
            path: other_path.to_string_lossy().into_owned(),
            path_key: String::new(),
            directory_node_id: relation.directory_node_id.clone(),
            relationship: RelationshipType::SharedDirectoryRead,
            file_representation: FileRepresentation::Directory,
            ownership: OwnershipState::ObservedUnmanaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: relation.content_fingerprint.clone(),
            origin: ObservedOrigin::Scan,
            match_state: ObservedMatchState::ContentVerified,
            active: true,
            observed_at: 1,
            released_at: None,
        };
        db.relationship_repository()
            .upsert_deployment_relation(&other)
            .expect("other consumer");
    }

    let result = fixture
        .facade
        .query(AppQuery::GetRelationshipRemovalImpact(
            GetRelationshipRemovalImpact {
                relation_id: fixture.relation_id.clone(),
            },
        ))
        .await
        .expect("shared impact");
    let AppQueryResult::RelationshipRemovalImpact(impact) = result else {
        panic!("expected impact");
    };
    assert!(impact
        .governance_tasks
        .iter()
        .any(|task| task.kind == GovernanceTaskKind::ConfirmSharedDirectoryImpact));
    assert_eq!(
        impact.minimal_action,
        skillhub_core::relationship::MinimalImpactAction::CreateGovernanceTask
    );

    {
        let db = fixture.database.lock().expect("database lock");
        db.connection_for_test()
            .execute(
                "DELETE FROM deployment_relations WHERE relation_id=?1",
                [&fixture.relation_id],
            )
            .expect("remove selected relation");
        db.relationship_repository()
            .upsert_deployment_relation(&DeploymentRelationFact {
                relation_id: fixture.relation_id.clone(),
                path: fixture
                    .source
                    .join("does-not-exist")
                    .to_string_lossy()
                    .into_owned(),
                active: false,
                ..relation
            })
            .expect("inactive relation");
    }
    let result = fixture
        .facade
        .query(AppQuery::GetRelationshipRemovalImpact(
            GetRelationshipRemovalImpact {
                relation_id: fixture.relation_id.clone(),
            },
        ))
        .await
        .expect("inactive impact");
    let AppQueryResult::RelationshipRemovalImpact(impact) = result else {
        panic!("expected inactive impact");
    };
    assert!(impact
        .governance_tasks
        .iter()
        .any(|task| task.detail.contains("inactive")));
    assert!(impact.permission_limited);
}

#[tokio::test]
async fn relationship_journal_keeps_prepared_facts_and_recovery_phase() {
    let fixture = fixture().await;
    let prepared = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id,
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedRelationMigration(prepared) = prepared else {
        panic!("expected prepared");
    };
    let record = fixture
        .database
        .lock()
        .expect("database lock")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("journal read")
        .expect("journal record");
    assert_eq!(record.phase, OperationPhase::Prepared);
    let prepared_json = &record.recovery_data["prepared"];
    assert_eq!(prepared_json["target_path"], prepared.target_path);
    assert_eq!(prepared_json["backup_path"], prepared.backup_path);
    let backup = &record.recovery_data["journal"]["backup"];
    assert_eq!(backup["operation_id"], prepared.operation_id.to_string());
    assert_eq!(backup["path"], prepared.backup_path);
    assert_eq!(backup["original_path"], prepared.relation.path);
    assert_eq!(
        backup["original_fingerprint"],
        prepared.current_content_fingerprint
    );
    assert_eq!(backup["original_relationship"], "observed_copy");
    assert_eq!(backup["original_ownership"], "observed_unmanaged");
    assert!(record.inverse.is_some());
}
