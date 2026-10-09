use std::path::{Path, PathBuf};

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    AgentRootObservation, ClientInstance, ClientKind, ClientPresence, DirectoryObservationStatus,
    DirectoryPrecedence, DiscoverySnapshot, LogicalTarget, OperatingSystem, PhysicalTarget,
    TargetScope,
};
use skillhub_core::api::ResolveRecovery;
use skillhub_core::api::{
    AppQueryResult, CommitDeployment, CommitUsageChange, CreateSkill, GetUsageEnvironmentProblems,
    PrepareDeployment, PrepareUsageChange,
};
use skillhub_core::deployment::{RegisteredTargetIndex, TargetFact, TargetFactSource};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DeploymentRelationFact, DirectoryNodeFact, DirectoryRecognition,
    DirectoryRole, EnvironmentProblemKind, FileRepresentation, OwnershipState, RelationshipType,
    UsageChangeAction,
};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, ApplicationFacade, DeploymentCapability, OperationId,
    RecoveryAction, SkillId,
};
use skillhub_storage::{CentralLibrary, Database};

const AGENT_A: &str = "agent.shared-a";
const AGENT_B: &str = "agent.shared-b";
const SHARED_DIRECTORY_ID: &str = "directory.shared";
const TARGET_A_ID: &str = "target.shared-a";
const TARGET_B_ID: &str = "target.shared-b";

struct Fixture {
    workspace: tempfile::TempDir,
    database_path: PathBuf,
    library_root: PathBuf,
    facade: LocalApplicationFacade,
    skill_id: SkillId,
    shared_root: PathBuf,
    shared_skill: PathBuf,
    target_a: PathBuf,
    target_b: PathBuf,
    existing_a: PathBuf,
    other_shared_skill: PathBuf,
    problem_id: String,
}

async fn fixture() -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let database = Database::open(&database_path).expect("database");

    let shared_root = workspace.path().join("shared/skills");
    let target_a = workspace.path().join("agent-a/skills");
    let target_b = workspace.path().join("agent-b/skills");
    for path in [&shared_root, &target_a, &target_b] {
        std::fs::create_dir_all(path).expect("target directory");
    }

    let facade = LocalApplicationFacade::new_with_library_and_targets(
        database,
        &library_root,
        deployment_index(&target_a, &target_b),
    );
    let original = workspace.path().join("source/formatter");
    write_skill(&original, "formatter", "central formatter");
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "formatter".into(),
            source_path: original.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create subject");
    let AppQueryResult::SkillPage(page) = facade
        .query(AppQuery::ListSkills(skillhub_core::api::ListSkills {
            text: "formatter".into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list subject")
    else {
        panic!("expected skill page");
    };
    let skill_id = page.items[0].skill_id;
    let library = facade
        .library_runtime()
        .snapshot()
        .expect("library snapshot");
    let skill_source = library
        .central
        .visible_skill_path_for_runtime(skill_id, "formatter");
    let source_fingerprint = library
        .store
        .hash_tree_read_only(&skill_source)
        .expect("source fingerprint");

    let shared_skill = shared_root.join("formatter");
    copy_tree(&skill_source, &shared_skill);
    let existing_a = target_a.join("formatter");
    copy_tree(&skill_source, &existing_a);
    let other_shared_skill = shared_root.join("other");
    write_skill(&other_shared_skill, "other", "preserve other shared skill");

    let discovery = discovery_snapshot(workspace.path(), &shared_root, &target_a, &target_b);
    let database = facade.database_for_tests();
    {
        let database = database.lock().expect("database lock");
        database
            .agent_repository()
            .replace(&discovery)
            .expect("discovery snapshot");
        add_directory(
            &database,
            SHARED_DIRECTORY_ID,
            &shared_root,
            DirectoryRole::SharedDirectory,
            None,
        );
        add_directory(
            &database,
            "directory.a",
            &target_a,
            DirectoryRole::AgentNative,
            Some(AGENT_A),
        );
        add_directory(
            &database,
            "directory.b",
            &target_b,
            DirectoryRole::AgentNative,
            Some(AGENT_B),
        );
        add_capability(&database, SHARED_DIRECTORY_ID, AGENT_A);
        add_capability(&database, SHARED_DIRECTORY_ID, AGENT_B);
        add_capability(&database, "directory.a", AGENT_A);
        add_capability(&database, "directory.b", AGENT_B);
        add_relation(
            &database,
            "usage:shared:a",
            skill_id,
            AGENT_A,
            &shared_skill,
            SHARED_DIRECTORY_ID,
            &source_fingerprint,
        );
        add_relation(
            &database,
            "usage:shared:b",
            skill_id,
            AGENT_B,
            &shared_skill,
            SHARED_DIRECTORY_ID,
            &source_fingerprint,
        );
        add_relation(
            &database,
            "usage:direct:a",
            skill_id,
            AGENT_A,
            &existing_a,
            "directory.a",
            &source_fingerprint,
        );
    }

    let AppQueryResult::UsageEnvironmentProblems(analysis) = facade
        .query(AppQuery::GetUsageEnvironmentProblems(
            GetUsageEnvironmentProblems,
        ))
        .await
        .expect("query environment problems")
    else {
        panic!("expected usage environment problems");
    };
    let problem = analysis
        .problems
        .into_iter()
        .find(|problem| problem.kind == EnvironmentProblemKind::SameSkill)
        .expect("shared same-skill problem");

    Fixture {
        workspace,
        database_path,
        library_root,
        facade,
        skill_id,
        shared_root,
        shared_skill,
        target_a,
        target_b,
        existing_a,
        other_shared_skill,
        problem_id: problem.problem_id,
    }
}

fn deployment_index(target_a: &Path, target_b: &Path) -> RegisteredTargetIndex {
    let capability = DeploymentCapability {
        copy: true,
        symlink: false,
        junction: false,
        limitations: Vec::new(),
    };
    let facts = [(TARGET_A_ID, target_a), (TARGET_B_ID, target_b)]
        .into_iter()
        .map(|(id, path)| {
            TargetFact::registered(
                id,
                path,
                skillhub_core::physical_id_for_path(path).expect("target identity"),
                TargetFactSource::Discovery,
                capability.clone(),
            )
        });
    RegisteredTargetIndex::from_facts(
        facts,
        skillhub_core::PathPolicy::from_roots(
            [target_a, target_b]
                .into_iter()
                .map(|path| skillhub_core::AllowedRoot::new(path).expect("allowed target")),
        )
        .expect("target policy"),
    )
    .expect("target index")
}

fn discovery_snapshot(
    workspace: &Path,
    shared: &Path,
    target_a: &Path,
    target_b: &Path,
) -> DiscoverySnapshot {
    let profiles = [(AGENT_A, "profile.shared-a"), (AGENT_B, "profile.shared-b")];
    let instances = profiles
        .iter()
        .map(|(client_id, profile_id)| ClientInstance {
            profile_id: (*profile_id).into(),
            client_id: (*client_id).into(),
            kind: ClientKind::Cli,
            display_name: (*client_id).into(),
            supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
            client_presence: ClientPresence::Unknown,
        })
        .collect();
    let agent_roots = profiles
        .iter()
        .map(|(client_id, profile_id)| {
            let path = workspace.join(if *client_id == AGENT_A {
                "agent-a"
            } else {
                "agent-b"
            });
            std::fs::create_dir_all(&path).expect("Agent root");
            AgentRootObservation {
                id: format!("root:{client_id}"),
                profile_id: (*profile_id).into(),
                client_id: (*client_id).into(),
                scope: TargetScope::Global,
                path: path.to_string_lossy().into_owned(),
                status: DirectoryObservationStatus::Existing,
                exists: true,
                readable: true,
                writable: true,
                physical_id: skillhub_core::physical_id_for_path(&path),
                physical_identity_verified: true,
            }
        })
        .collect();
    let logical_targets = [
        (AGENT_A, "profile.shared-a", TARGET_A_ID, target_a, false),
        (AGENT_B, "profile.shared-b", TARGET_B_ID, target_b, false),
        (
            AGENT_A,
            "profile.shared-a",
            "target.shared-reference-a",
            shared,
            true,
        ),
        (
            AGENT_B,
            "profile.shared-b",
            "target.shared-reference-b",
            shared,
            true,
        ),
    ]
    .into_iter()
    .map(
        |(client_id, profile_id, id, path, shared_reference)| LogicalTarget {
            id: id.into(),
            profile_id: profile_id.into(),
            client_id: client_id.into(),
            scope: TargetScope::Global,
            path: path.to_string_lossy().into_owned(),
            agent_root_id: format!("root:{client_id}"),
            marker: "skills".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference,
            builtin: false,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id: skillhub_core::physical_id_for_path(path).expect("target identity"),
            status: DirectoryObservationStatus::Existing,
            physical_identity_verified: true,
        },
    )
    .collect::<Vec<_>>();
    let mut physical_targets = Vec::<PhysicalTarget>::new();
    for target in &logical_targets {
        if let Some(physical) = physical_targets
            .iter_mut()
            .find(|physical| physical.id == target.physical_id)
        {
            physical.logical_target_ids.push(target.id.clone());
        } else {
            physical_targets.push(PhysicalTarget {
                id: target.physical_id.clone(),
                path: target.path.clone(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "sensitive".into(),
                logical_target_ids: vec![target.id.clone()],
            });
        }
    }
    DiscoverySnapshot {
        generation: "shared-migration-fixture".into(),
        observed_at: "2026-10-09T00:00:00Z".into(),
        instances,
        agent_roots,
        logical_targets,
        physical_targets,
    }
}

fn add_directory(
    database: &Database,
    id: &str,
    path: &Path,
    role: DirectoryRole,
    agent_client_id: Option<&str>,
) {
    database
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: id.into(),
            path: path.to_string_lossy().into_owned(),
            path_key: String::new(),
            role,
            profile_id: agent_client_id.map(|_| format!("profile.{id}")),
            agent_client_id: agent_client_id.map(str::to_owned),
            exists: true,
            observed_at: 1,
            scan_source: Some("shared-usage-migration-test".into()),
        })
        .expect("directory node");
}

fn add_capability(database: &Database, directory_id: &str, client_id: &str) {
    database
        .relationship_repository()
        .upsert_capability(&AgentDirectoryCapabilityFact {
            agent_client_id: client_id.into(),
            directory_node_id: directory_id.into(),
            recognition: DirectoryRecognition::Supported,
            precedence: DirectoryPrecedence::Preferred,
            evidence_reference: Some("shared-usage-migration-test".into()),
            researched_at: Some("2026-10-09".into()),
            applicable_platforms: vec!["macos".into(), "windows".into()],
        })
        .expect("directory capability");
}

fn add_relation(
    database: &Database,
    relation_id: &str,
    skill_id: SkillId,
    client_id: &str,
    path: &Path,
    directory_id: &str,
    fingerprint: &str,
) {
    database
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: relation_id.into(),
            skill_id: Some(skill_id),
            agent_client_id: client_id.into(),
            path: path.to_string_lossy().into_owned(),
            path_key: String::new(),
            directory_node_id: Some(directory_id.into()),
            relationship: RelationshipType::ManagedCopy,
            file_representation: FileRepresentation::Copy,
            ownership: OwnershipState::SkillhubManaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: fingerprint.into(),
            origin: skillhub_core::deployment::ObservedOrigin::Scan,
            match_state: skillhub_core::deployment::ObservedMatchState::ContentVerified,
            health_reasons: Some(Vec::new()),
            active: true,
            observed_at: 1,
            released_at: None,
        })
        .expect("deployment relation");
}

fn write_skill(path: &Path, name: &str, body: &str) {
    std::fs::create_dir_all(path).expect("skill directory");
    std::fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\n---\n\n{body}\n"),
    )
    .expect("skill markdown");
}

fn copy_tree(source: &Path, destination: &Path) {
    std::fs::create_dir_all(destination).expect("copy destination");
    for entry in std::fs::read_dir(source).expect("source entries") {
        let entry = entry.expect("source entry");
        let destination = destination.join(entry.file_name());
        let kind = entry.file_type().expect("source type");
        if kind.is_dir() {
            copy_tree(&entry.path(), &destination);
        } else if kind.is_file() {
            std::fs::copy(entry.path(), destination).expect("copy source file");
        }
    }
}

fn migration_request(problem_id: &str) -> PrepareUsageChange {
    PrepareUsageChange {
        operation_id: OperationId::new(),
        action: UsageChangeAction::MigrateSharedUsage,
        relation_ids: Vec::new(),
        problem_id: Some(problem_id.into()),
        skill_id: None,
        requested_form: None,
        copy_disposition: None,
        content_basis: None,
        retain_entry_key: None,
        selected_entry_keys: Vec::new(),
        runtime_name: None,
        base_version_id: None,
        non_recognized_destination: None,
        selected_relation_ids: vec![],
        confirmed_shared_relation_ids: vec![],
    }
}

#[test]
fn shared_usage_migration_is_a_supported_usage_change_action() {
    let action: UsageChangeAction =
        serde_json::from_str("\"migrate_shared_usage\"").expect("shared usage migration action");

    assert_eq!(format!("{action:?}"), "MigrateSharedUsage");
}

#[tokio::test]
async fn all_replacements_verified_before_shared_delete() {
    let fixture = fixture().await;
    let prepared = fixture
        .facade
        .prepare_usage_change(migration_request(&fixture.problem_id))
        .expect("prepare full shared usage migration");

    let preview = prepared
        .shared_usage_migration
        .as_ref()
        .expect("backend-owned migration preview");
    assert_eq!(preview.problem.problem_id, fixture.problem_id);
    assert_eq!(preview.replacements.len(), 2);
    assert!(preview.replacements.iter().any(|replacement| {
        replacement.environment.agent_client_id == AGENT_A
            && replacement.reused_existing
            && replacement.target_ids.is_empty()
    }));
    assert!(preview.replacements.iter().any(|replacement| {
        replacement.environment.agent_client_id == AGENT_B
            && !replacement.reused_existing
            && replacement.target_ids == [TARGET_B_ID]
            && replacement.form.is_some()
    }));
    assert!(fixture.shared_skill.join("SKILL.md").is_file());
    assert!(fixture.existing_a.join("SKILL.md").is_file());
    assert!(fixture.other_shared_skill.join("SKILL.md").is_file());
    assert!(fixture.workspace.path().exists());

    let result = commit_migration(&fixture.facade, &prepared).await;
    assert!(!result.recovery_required, "migration result: {result:#?}");
    assert!(!fixture.shared_skill.exists());
    assert!(fixture.shared_root.is_dir());
    assert!(fixture.other_shared_skill.join("SKILL.md").is_file());
    assert!(fixture.existing_a.join("SKILL.md").is_file());
    assert!(fixture.target_b.join("formatter/SKILL.md").is_file());
}

#[tokio::test]
async fn existing_direct_usage_is_reused() {
    let fixture = fixture().await;
    let prepared = fixture
        .facade
        .prepare_usage_change(migration_request(&fixture.problem_id))
        .expect("prepare shared usage migration");

    let preview = prepared
        .shared_usage_migration
        .as_ref()
        .expect("migration preview");
    let existing = preview
        .replacements
        .iter()
        .find(|replacement| replacement.environment.agent_client_id == AGENT_A)
        .expect("Agent A replacement");
    assert!(existing.reused_existing);
    assert!(existing.target_ids.is_empty());
    assert!(fixture.existing_a.join("SKILL.md").is_file());
}

#[tokio::test]
async fn builtin_consumer_needs_no_new_dispatch() {
    let fixture = fixture().await;
    let builtin = fixture.target_b.join("formatter");
    copy_tree(&fixture.shared_skill, &builtin);
    {
        let database = fixture.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let mut snapshot = database
            .agent_repository()
            .load()
            .expect("load discovery")
            .expect("discovery snapshot");
        snapshot
            .logical_targets
            .iter_mut()
            .find(|target| target.id == TARGET_B_ID)
            .expect("Agent B target")
            .builtin = true;
        database
            .agent_repository()
            .replace(&snapshot)
            .expect("mark builtin target");
    }
    let problem_id = current_same_skill_problem_id(&fixture.facade).await;
    let prepared = fixture
        .facade
        .prepare_usage_change(migration_request(&problem_id))
        .expect("prepare builtin migration");
    let preview = prepared
        .shared_usage_migration
        .as_ref()
        .expect("migration preview");
    let builtin_replacement = preview
        .replacements
        .iter()
        .find(|replacement| replacement.environment.agent_client_id == AGENT_B)
        .expect("builtin consumer");
    assert!(builtin_replacement.reused_existing);
    assert!(builtin_replacement.target_ids.is_empty());

    let result = commit_migration(&fixture.facade, &prepared).await;
    assert!(!result.recovery_required, "migration result: {result:#?}");
    let database = fixture.facade.database_for_tests();
    let deployments = database
        .lock()
        .expect("database lock")
        .deployment_repository()
        .list_all()
        .expect("deployment records");
    assert!(deployments.is_empty());
    assert!(builtin.join("SKILL.md").is_file());
    assert!(!fixture.shared_skill.exists());
}

#[tokio::test]
async fn unknown_consumer_or_name_conflict_blocks_cleanup() {
    let unknown_fixture = fixture().await;
    let fingerprint = skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(
        &unknown_fixture.shared_skill,
    )
    .expect("shared fingerprint");
    {
        let database = unknown_fixture.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        add_capability(&database, SHARED_DIRECTORY_ID, "agent.not-discovered");
        add_relation(
            &database,
            "usage:shared:unknown",
            unknown_fixture.skill_id,
            "agent.not-discovered",
            &unknown_fixture.shared_skill,
            SHARED_DIRECTORY_ID,
            &fingerprint,
        );
    }
    let problem_id = current_same_skill_problem_id(&unknown_fixture.facade).await;
    assert!(unknown_fixture
        .facade
        .prepare_usage_change(migration_request(&problem_id))
        .is_err());
    assert!(unknown_fixture.shared_skill.join("SKILL.md").is_file());

    let conflict_fixture = fixture().await;
    write_skill(
        &conflict_fixture.target_b.join("formatter"),
        "formatter",
        "different content",
    );
    let problem_id = current_same_skill_problem_id(&conflict_fixture.facade).await;
    assert!(conflict_fixture
        .facade
        .prepare_usage_change(migration_request(&problem_id))
        .is_err());
    assert!(conflict_fixture.shared_skill.join("SKILL.md").is_file());
}

#[tokio::test]
async fn one_target_failure_keeps_shared_source() {
    let fixture = fixture().await;
    let prepared = fixture
        .facade
        .prepare_usage_change(migration_request(&fixture.problem_id))
        .expect("prepare shared usage migration");
    let late_conflict = fixture.target_b.join("formatter");
    write_skill(&late_conflict, "formatter", "arrived after preview");

    let error = fixture
        .facade
        .execute(AppCommand::CommitUsageChange(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        }))
        .await
        .expect_err("stale preview must not dispatch over a new conflict");
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("shared_usage_migration_name_conflict")
    );
    assert!(fixture.shared_skill.join("SKILL.md").is_file());
    assert!(fixture.other_shared_skill.join("SKILL.md").is_file());
    assert!(late_conflict.join("SKILL.md").is_file());
    let database = fixture.facade.database_for_tests();
    let record = database
        .lock()
        .expect("database lock")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("read untouched preview")
        .expect("preview remains available for retry");
    assert_eq!(record.phase, skillhub_core::OperationPhase::Prepared);

    std::fs::remove_dir_all(&late_conflict).expect("resolve temporary conflict");
    let retried = commit_migration(&fixture.facade, &prepared).await;
    assert!(!retried.recovery_required);
    assert!(!fixture.shared_skill.exists());
}

#[tokio::test]
async fn restart_recovers_partial_migration() {
    let fixture = fixture().await;
    let prepared = fixture
        .facade
        .prepare_usage_change(migration_request(&fixture.problem_id))
        .expect("prepare shared usage migration");
    let child_plan = {
        let database = fixture.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let record = database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read migration operation")
            .expect("migration operation exists");
        record.recovery_data["replacements"]
            .as_array()
            .expect("replacement plans")
            .iter()
            .find(|replacement| replacement["preview"]["environment"]["agent_client_id"] == AGENT_B)
            .expect("Agent B replacement")["deployment_plan"]
            .clone()
    };
    let child_plan = serde_json::from_value(child_plan).expect("saved deployment plan");
    let AppCommandResult::PreparedDeployment(child) = fixture
        .facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment {
            plan: child_plan,
        }))
        .await
        .expect("prepare replacement dispatch")
    else {
        panic!("expected prepared deployment");
    };
    let AppCommandResult::DeploymentSummary(summary) = fixture
        .facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: child.id,
        }))
        .await
        .expect("commit replacement before simulated interruption")
    else {
        panic!("expected deployment summary");
    };
    assert!(summary.committed);

    {
        let database = fixture.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let mut record = database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("read interrupted migration")
            .expect("migration operation exists");
        let replacement = record.recovery_data["replacements"]
            .as_array_mut()
            .expect("replacement plans")
            .iter_mut()
            .find(|replacement| replacement["preview"]["environment"]["agent_client_id"] == AGENT_B)
            .expect("Agent B replacement");
        replacement["child_operation_id"] = serde_json::to_value(child.id).unwrap();
        record.phase = skillhub_core::OperationPhase::Applying;
        record.progress.phase = skillhub_core::OperationPhase::Applying;
        database
            .operation_repository()
            .update_sync(&record)
            .expect("persist interrupted migration");
    }
    assert!(fixture.shared_skill.join("SKILL.md").is_file());

    let reopened = LocalApplicationFacade::new_with_library_and_targets(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
        deployment_index(&fixture.target_a, &fixture.target_b),
    );
    let AppCommandResult::OperationSummary(summary) = reopened
        .execute(AppCommand::ResolveRecovery(ResolveRecovery {
            operation_id: prepared.operation_id,
            action: RecoveryAction::CompleteOperation,
        }))
        .await
        .expect("resume migration from recovery center")
    else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.phase, skillhub_core::OperationPhase::Committed);
    assert!(!fixture.shared_skill.exists());
    assert!(fixture.shared_root.is_dir());
    assert!(fixture.other_shared_skill.join("SKILL.md").is_file());
    assert!(fixture.target_b.join("formatter/SKILL.md").is_file());
}

async fn current_same_skill_problem_id(facade: &LocalApplicationFacade) -> String {
    let AppQueryResult::UsageEnvironmentProblems(analysis) = facade
        .query(AppQuery::GetUsageEnvironmentProblems(
            GetUsageEnvironmentProblems,
        ))
        .await
        .expect("query environment problems")
    else {
        panic!("expected usage environment problems");
    };
    analysis
        .problems
        .into_iter()
        .find(|problem| problem.kind == EnvironmentProblemKind::SameSkill)
        .expect("same skill problem")
        .problem_id
}

async fn commit_migration(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::relationship::PreparedUsageChange,
) -> skillhub_core::relationship::UsageChangeResult {
    let AppCommandResult::UsageChangeResult(result) = facade
        .execute(AppCommand::CommitUsageChange(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        }))
        .await
        .expect("commit migration")
    else {
        panic!("expected migration result");
    };
    result
}
