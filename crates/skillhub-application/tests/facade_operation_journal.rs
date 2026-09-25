//! Persistent operation journal: public mutation flows must leave durable
//! records in the `operations` table so the operations page and the recovery
//! entry keep working across restarts. Every assertion is driven through the
//! public [`ApplicationFacade`] commands and the `GetBootstrapSnapshot` query;
//! no journal row is ever fabricated by hand.

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CommitDeployment, CreateIgnoreRule, CreateSkill,
    PrepareDeployment, PrepareImport, RemoveIgnoreRule, SaveSkillContent,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::{DeploymentMode, DeploymentPlan, TargetChange, TargetPlan};
use skillhub_core::import::ImportCandidate;
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{
    AppCommand, AppQuery, ApplicationFacade, CommitImport, ErrorCode, ImportDecision,
    OperationPhase, RecentOperationSummary, StartupRecoveryState,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

/// Registers one Agent target through the public discovery repository so
/// commit-time revalidation sees the same registered facts the plan used.
fn seed_registered_target(database: &Database, path: &std::path::Path, logical_id: &str) -> String {
    let physical_id = skillhub_core::physical_id_for_path(path).expect("target identity");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-09-24T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: "fixture".into(),
                client_id: logical_id.into(),
                kind: ClientKind::Cli,
                display_name: "Fixture".into(),
                supported_os: vec![OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: vec![LogicalTarget {
                id: logical_id.into(),
                profile_id: "fixture".into(),
                client_id: logical_id.into(),
                scope: TargetScope::Global,
                path: path.to_string_lossy().into_owned(),
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
            physical_targets: Vec::new(),
        })
        .expect("seed registered target");
    physical_id
}

async fn recent_operations(facade: &LocalApplicationFacade) -> Vec<RecentOperationSummary> {
    let result = facade
        .query(AppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap snapshot");
    match result {
        AppQueryResult::BootstrapSnapshot(snapshot) => snapshot.recent_operations,
        other => panic!("unexpected result: {other:?}"),
    }
}

async fn recovery_state(facade: &LocalApplicationFacade) -> StartupRecoveryState {
    let result = facade
        .query(AppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap snapshot");
    match result {
        AppQueryResult::BootstrapSnapshot(snapshot) => snapshot.recovery_state,
        other => panic!("unexpected result: {other:?}"),
    }
}

fn import_candidate(source: &tempfile::TempDir) -> ImportCandidate {
    ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    )
}

fn facade_with_library() -> (LocalApplicationFacade, tempfile::TempDir) {
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("central library");
    let facade = LocalApplicationFacade::new_with_library(
        Database::open_in_memory().expect("database"),
        library_root.path(),
    );
    (facade, library_root)
}

#[tokio::test]
async fn create_skill_is_journalled_as_a_committed_record_linked_to_its_summary() {
    let (facade, _library_root) = facade_with_library();
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write skill");

    let created = facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");
    let AppCommandResult::OperationSummary(summary) = created else {
        panic!("expected operation summary");
    };

    let operations = recent_operations(&facade).await;
    let record = operations
        .iter()
        .find(|record| record.operation_id == summary.operation_id)
        .expect("create_skill must be journalled with the returned operation id");
    assert_eq!(record.kind, "create_skill");
    assert_eq!(record.state, "completed");
    assert_eq!(record.phase, OperationPhase::Committed);
    assert_eq!(record.error_code, None);
}

#[tokio::test]
async fn save_skill_content_is_journalled_as_a_committed_record() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Editable skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(root.path()).expect("central library");
    let store = VersionStore::from_library(&library);
    let initial = tempfile::tempdir().expect("initial source");
    std::fs::write(initial.path().join("SKILL.md"), "# Initial\n").expect("write initial");
    let first = store
        .capture(skill.id(), initial.path())
        .expect("capture initial");
    store
        .set_current(skill.id(), &first.id)
        .expect("set initial current");
    let updated = tempfile::tempdir().expect("updated source");
    std::fs::write(updated.path().join("SKILL.md"), "# Updated\n").expect("write updated");
    let facade = LocalApplicationFacade::new_with_library(database, root.path());

    let saved = facade
        .execute(AppCommand::SaveSkillContent(SaveSkillContent {
            skill_id: skill.id(),
            source_path: updated.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("save skill content");
    let AppCommandResult::OperationSummary(summary) = saved else {
        panic!("expected operation summary");
    };

    let operations = recent_operations(&facade).await;
    let record = operations
        .iter()
        .find(|record| record.operation_id == summary.operation_id)
        .expect("save_skill_content must be journalled with the returned operation id");
    assert_eq!(record.kind, "save_skill_content");
    assert_eq!(record.state, "completed");
    assert_eq!(record.phase, OperationPhase::Committed);
}

#[tokio::test]
async fn journalled_records_survive_a_restart_and_reach_the_new_facade() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("app.sqlite");
    let library_root = workspace.path().join("library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write skill");

    let created = {
        let facade = LocalApplicationFacade::open_with_library(&database_path, &library_root)
            .expect("facade before restart");
        facade
            .execute(AppCommand::CreateSkill(CreateSkill {
                name: "Notes".into(),
                source_path: source.path().to_string_lossy().into_owned(),
            }))
            .await
            .expect("create skill")
    };
    let AppCommandResult::OperationSummary(summary) = created else {
        panic!("expected operation summary");
    };

    let facade = LocalApplicationFacade::open_with_library(&database_path, &library_root)
        .expect("facade after restart");
    let operations = recent_operations(&facade).await;
    let record = operations
        .iter()
        .find(|record| record.operation_id == summary.operation_id)
        .expect("journalled record must survive the restart");
    assert_eq!(record.kind, "create_skill");
    assert_eq!(record.state, "completed");
    assert_eq!(record.phase, OperationPhase::Committed);
}

#[tokio::test]
async fn import_prepare_commit_and_cancel_write_the_full_lifecycle() {
    let (facade, _library_root) = facade_with_library();
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write skill");

    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: import_candidate(&source),
            tree_hash: None,
        }))
        .await
        .expect("prepare import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let operations = recent_operations(&facade).await;
    let prepared_record = operations
        .iter()
        .find(|record| record.operation_id == prepared.id)
        .expect("prepare_import must journal a started record");
    assert_eq!(prepared_record.kind, "import_skill");
    assert_eq!(prepared_record.state, "running");
    assert_eq!(prepared_record.phase, OperationPhase::Prepared);
    assert_eq!(prepared_record.error_code, None);

    let committed = facade
        .execute(AppCommand::CommitImport(CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision: skillhub_core::ImportGovernanceDecision {
                group_actions: prepared
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
        .expect("commit import");
    let AppCommandResult::ImportSummary(_) = committed else {
        panic!("expected import summary");
    };
    let operations = recent_operations(&facade).await;
    let committed_record = operations
        .iter()
        .find(|record| record.operation_id == prepared.id)
        .expect("commit must update the prepared record");
    assert_eq!(committed_record.kind, "import_skill");
    assert_eq!(committed_record.state, "completed");
    assert_eq!(committed_record.phase, OperationPhase::Committed);

    let cancelled_source = tempfile::tempdir().expect("cancelled source");
    std::fs::write(cancelled_source.path().join("SKILL.md"), "# Other\n").expect("write skill");
    let second = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: import_candidate(&cancelled_source),
            tree_hash: None,
        }))
        .await
        .expect("prepare second import");
    let AppCommandResult::PreparedImport(second) = second else {
        panic!("expected second prepared import");
    };
    facade
        .execute(AppCommand::CancelImport {
            prepared_import_id: second.id,
        })
        .await
        .expect("cancel import");
    let operations = recent_operations(&facade).await;
    let cancelled_record = operations
        .iter()
        .find(|record| record.operation_id == second.id)
        .expect("cancel must roll the prepared record back");
    assert_eq!(cancelled_record.kind, "import_skill");
    assert_eq!(cancelled_record.state, "rolled_back");
    assert_eq!(cancelled_record.phase, OperationPhase::RolledBack);
}

#[tokio::test]
async fn a_failed_create_skill_is_a_terminal_rolled_back_record_without_recovery() {
    let (facade, _library_root) = facade_with_library();
    let empty_source = tempfile::tempdir().expect("empty source");

    let error = facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Broken".into(),
            source_path: empty_source.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect_err("missing SKILL.md must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let operations = recent_operations(&facade).await;
    assert_eq!(
        operations.len(),
        1,
        "exactly the failed attempt is journalled"
    );
    let record = &operations[0];
    assert_eq!(record.kind, "create_skill");
    assert_eq!(record.state, "rolled_back");
    assert_eq!(record.phase, OperationPhase::RolledBack);
    assert_eq!(
        record.error_code.as_deref(),
        Some(ErrorCode::InvalidInput.as_str())
    );
    assert_eq!(
        recovery_state(&facade).await,
        StartupRecoveryState::Clean,
        "single-step validation failures must not pollute the recovery page"
    );
}

/// A commit that fails *before* anything reaches the target directory must settle
/// as `rolled_back`, not `needs_recovery`.
///
/// This used to assert `needs_recovery` for every failure that was not
/// `ObjectNotFound`, which meant a plain rejected add gated the next launch
/// (see R-10 in 人工验收清单-2026-09-18).  `needs_recovery` is now reserved for
/// residue the app could not clean up on its own — here the backend never wrote
/// a byte, so there is nothing for the user to decide.  The retry contract on
/// the same prepared record is unchanged and is asserted below.
#[tokio::test]
async fn a_failed_deployment_commit_rolls_back_cleanly_and_retry_reuses_the_record() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Retryable");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Retryable\n").expect("write source");
    let target = tempfile::tempdir().expect("target");
    let library_root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let version_id = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version")
        .id;
    let target_id = seed_registered_target(&database, target.path(), "agent-codex");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version fixture");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-codex', 'global', ?2, 0)",
            rusqlite::params![target_id, target.path().to_string_lossy().into_owned()],
        )
        .expect("insert target fixture");
    let destination = target.path().join("retryable");
    let plan = DeploymentPlan {
        skill_id: skill.id(),
        version_id: version_id.clone(),
        runtime_name: "retryable".into(),
        mode: DeploymentMode::ManagedCopy,
        warnings: Vec::new(),
        conflicts: Vec::new(),
        targets: vec![TargetPlan {
            physical_target_id: target_id,
            logical_target_ids: vec!["agent-codex".into()],
            target_path: target.path().to_string_lossy().into_owned(),
            destination_path: destination.to_string_lossy().into_owned(),
            source_path: source.path().to_string_lossy().into_owned(),
            runtime_name: "retryable".into(),
            skill_id: skill.id(),
            version_id: version_id.clone(),
            mode: DeploymentMode::ManagedCopy,
            change: TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        }],
    };
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let prepared = facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare deployment");
    let AppCommandResult::PreparedDeployment(prepared) = prepared else {
        panic!("expected prepared deployment");
    };
    // A plain file at the destination stops the copy but leaves every planning
    // fact intact once removed, so the retry reuses the same prepared record.
    std::fs::write(&destination, "occupied").expect("plant destination obstruction");
    let operations = recent_operations(&facade).await;
    let prepared_record = operations
        .iter()
        .find(|record| record.operation_id == prepared.id)
        .expect("prepare_deployment must journal a started record");
    assert_eq!(prepared_record.kind, "deploy_skill");
    assert_eq!(prepared_record.state, "running");
    assert_eq!(prepared_record.phase, OperationPhase::Prepared);

    let failed = facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("failed commit returns a summary");
    let AppCommandResult::DeploymentSummary(failed) = failed else {
        panic!("expected deployment summary");
    };
    assert!(!failed.committed);
    let operations = recent_operations(&facade).await;
    let failed_record = operations
        .iter()
        .find(|record| record.operation_id == prepared.id)
        .expect("failed commit must settle the prepared record");
    assert_eq!(failed_record.state, "rolled_back");
    assert_eq!(failed_record.phase, OperationPhase::RolledBack);
    assert!(
        failed_record.error_code.is_some(),
        "failures must carry an error code even when they roll back cleanly"
    );
    assert_eq!(
        recovery_state(&facade).await,
        StartupRecoveryState::Clean,
        "a failure that left no residue must not gate the next launch"
    );

    std::fs::remove_file(&destination).expect("clear destination obstruction");
    let retried = facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("retry commit");
    let AppCommandResult::DeploymentSummary(retried) = retried else {
        panic!("expected retry deployment summary");
    };
    assert!(retried.committed);
    let operations = recent_operations(&facade).await;
    let retried_record = operations
        .iter()
        .find(|record| record.operation_id == prepared.id)
        .expect("successful retry must complete the same record");
    assert_eq!(retried_record.state, "completed");
    assert_eq!(retried_record.phase, OperationPhase::Committed);
    assert_eq!(recovery_state(&facade).await, StartupRecoveryState::Clean);
}

#[tokio::test]
async fn remove_ignore_rule_is_journalled_as_a_committed_record() {
    let (facade, _library_root) = facade_with_library();

    let created = facade
        .execute(AppCommand::CreateIgnoreRule(CreateIgnoreRule {
            subject: skillhub_core::IgnoreSubject::ExactSkill(skillhub_core::SkillId::new()),
            reason: "not relevant".into(),
            defer_until: None,
        }))
        .await
        .expect("create ignore rule");
    let AppCommandResult::IgnoreRule(rule) = created else {
        panic!("expected ignore rule");
    };

    facade
        .execute(AppCommand::RemoveIgnoreRule(RemoveIgnoreRule {
            rule_id: rule.id,
        }))
        .await
        .expect("remove ignore rule");

    let operations = recent_operations(&facade).await;
    let record = operations
        .iter()
        .find(|record| record.kind == "remove_ignore_rule")
        .expect("remove_ignore_rule must be journalled");
    assert_eq!(record.state, "completed");
    assert_eq!(record.phase, OperationPhase::Committed);
    assert_eq!(record.error_code, None);
}
