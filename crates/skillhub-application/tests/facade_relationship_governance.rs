//! Task 4 relationship-governance facade contract tests.
//!
//! These tests deliberately exercise the public `ApplicationFacade` seam.  In
//! particular, they prove that relationship governance is distinct from the
//! legacy original-file migration flow and that a prepare operation is
//! observationally read-only for the user's relationship path.

use std::collections::BTreeMap;

use serde_json::Value;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::DirectoryPrecedence;
use skillhub_core::api::{
    CreateSkill, GetRelationshipOverview, GetRelationshipRemovalImpact, ListSkills, PrepareImport,
    PrepareRelationMigration, RelationshipMigrationBackupPolicy, RelationshipOverviewScope,
};
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::import::{ImportGovernanceAction, ImportGovernanceDecision};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, DeploymentRelationFact, DirectoryNodeFact, DirectoryRecognition, DirectoryRole,
    FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, IdentityDirection, OwnershipState,
    RelationshipType, SourceRelationFact,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode,
    ImportCandidate, ImportDecision, OperationPhase, RelationMigrationState,
    RelationMigrationTargetMode, SkillId,
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
    /// Shared directory body when the seeded relation is a shared reference.
    shared_body: Option<std::path::PathBuf>,
    /// Second consumer's alias when the shared reference has other consumers.
    other_alias: Option<std::path::PathBuf>,
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
    mutate_relation_journal_record(fixture, operation_id, |journal| {
        mutate(&mut journal["backup"]);
    });
}

fn mutate_relation_journal_record(
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
    mutate(&mut progress["recovery_data"]["journal"]);
    let encoded = serde_json::to_string(&progress).expect("journal json encoding");
    database
        .connection_for_test()
        .execute(
            "UPDATE operations SET progress_json=?2 WHERE operation_id=?1",
            rusqlite::params![operation_id.to_string(), encoded],
        )
        .expect("tamper journal");
}

fn mark_relation_operation_applying(fixture: &Fixture, operation_id: skillhub_core::OperationId) {
    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute(
            "UPDATE operations SET state='running', phase='applying' WHERE operation_id=?1",
            [operation_id.to_string()],
        )
        .expect("mark operation applying");
}

#[cfg(unix)]
fn create_dir_link_for_test(source: &std::path::Path, destination: &std::path::Path) {
    std::os::unix::fs::symlink(source, destination).expect("recreate managed link");
}

#[cfg(windows)]
fn create_dir_link_for_test(source: &std::path::Path, destination: &std::path::Path) {
    std::os::windows::fs::symlink_dir(source, destination).expect("recreate managed link");
}

/// Which deployment relation the fixture should seed.  The default
/// `ObservedCopyEntry` shape is what the Task 4 tests rely on; the Task 6
/// conversion scenarios need managed copies and shared references.
enum RelationKind {
    ObservedCopyEntry,
    ManagedCopyEntry,
    SharedReference { other_consumers: usize },
}

async fn fixture() -> Fixture {
    fixture_with(RelationKind::ObservedCopyEntry).await
}

async fn fixture_with(kind: RelationKind) -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let db_path = workspace.path().join("db.sqlite");
    let database = Database::open(&db_path).expect("database");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    // The relationship entry lives in the agent's own directory.  Copy
    // entries are real directories; a shared reference is a link to the
    // shared directory body.
    let shared_body = workspace.path().join("shared/skills/notes");
    let source = workspace.path().join("agent/skills/notes");
    let import_source = match &kind {
        RelationKind::SharedReference { .. } => {
            write_skill(&shared_body);
            shared_body.clone()
        }
        _ => {
            write_skill(&source);
            source.clone()
        }
    };

    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: import_source.to_string_lossy().into_owned(),
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

    let mut shared_reference_fields: Option<(String, std::path::PathBuf)> = None;
    if matches!(kind, RelationKind::SharedReference { .. }) {
        std::fs::create_dir_all(source.parent().expect("alias parent")).expect("agent directory");
        create_dir_link_for_test(&shared_body, &source);
        shared_reference_fields = Some((
            skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&shared_body)
                .expect("shared body fingerprint"),
            shared_body.clone(),
        ));
    }
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

    let other_alias = if let RelationKind::SharedReference { other_consumers } = &kind {
        // The shared directory body is its own node with a second consumer.
        let shared_directory = workspace.path().join("shared/skills");
        database
            .directory_repository()
            .upsert_node(&DirectoryNodeFact {
                node_id: "directory:shared-skills".into(),
                path: shared_directory.to_string_lossy().into_owned(),
                path_key: String::new(),
                role: DirectoryRole::SharedDirectory,
                profile_id: None,
                agent_client_id: None,
                exists: true,
                observed_at: 1,
                scan_source: Some("test".into()),
            })
            .expect("shared directory node");
        for agent in ["agent.demo", "agent.other"] {
            database
                .relationship_repository()
                .upsert_capability(&AgentDirectoryCapabilityFact {
                    agent_client_id: agent.into(),
                    directory_node_id: "directory:shared-skills".into(),
                    recognition: DirectoryRecognition::Supported,
                    precedence: DirectoryPrecedence::MayCoexist,
                    evidence_reference: Some("fixture".into()),
                    researched_at: Some("2026-09-15".into()),
                    applicable_platforms: vec!["windows".into(), "macos".into()],
                })
                .expect("shared directory capability");
        }
        let other_alias = workspace.path().join("agent2/skills/notes");
        if *other_consumers > 0 {
            std::fs::create_dir_all(other_alias.parent().expect("other alias parent"))
                .expect("agent2 directory");
            create_dir_link_for_test(&shared_body, &other_alias);
            database
                .relationship_repository()
                .upsert_deployment_relation(&DeploymentRelationFact {
                    relation_id: "observed:agent.other:notes".into(),
                    skill_id: Some(skill_id),
                    agent_client_id: "agent.other".into(),
                    path: shared_body.to_string_lossy().into_owned(),
                    path_key: String::new(),
                    directory_node_id: Some("directory:shared-skills".into()),
                    relationship: RelationshipType::SharedDirectoryRead,
                    file_representation: FileRepresentation::Directory,
                    ownership: OwnershipState::ObservedUnmanaged,
                    link_target_path: None,
                    link_target_path_key: None,
                    link_target_directory_id: None,
                    content_fingerprint: fingerprint.clone(),
                    origin: ObservedOrigin::Scan,
                    match_state: ObservedMatchState::ContentVerified,
                    active: true,
                    observed_at: 1,
                    released_at: None,
                })
                .expect("other consumer relation");
        }
        Some(other_alias)
    } else {
        None
    };

    let (relationship, representation, ownership, link_target, link_target_directory_id) =
        match (&kind, &shared_reference_fields) {
            (RelationKind::SharedReference { .. }, Some((_, shared_body))) => (
                RelationshipType::SharedDirectoryReference,
                FileRepresentation::SymbolicLink,
                OwnershipState::ObservedUnmanaged,
                Some(shared_body.to_string_lossy().into_owned()),
                Some("directory:shared-skills".into()),
            ),
            (RelationKind::ManagedCopyEntry, _) => (
                RelationshipType::ManagedCopy,
                FileRepresentation::Copy,
                OwnershipState::SkillhubManaged,
                None,
                None,
            ),
            _ => (
                RelationshipType::ObservedCopy,
                FileRepresentation::Copy,
                OwnershipState::ObservedUnmanaged,
                None,
                None,
            ),
        };
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
            relationship,
            file_representation: representation,
            ownership,
            link_target_path: link_target,
            link_target_path_key: None,
            link_target_directory_id,
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
        shared_body: shared_reference_fields.map(|(_, body)| body),
        other_alias,
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
async fn import_requires_an_explicit_governance_confirmation_before_copying() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("library");
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path());
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: ImportCandidate::detected(
                SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
                source.path().to_string_lossy(),
                ".",
                "SKILL.md",
                "Notes",
            ),
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    assert_eq!(prepared.analysis.governance_groups.len(), 1);

    let error = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision: ImportGovernanceDecision {
                group_actions: BTreeMap::new(),
                item_overrides: BTreeMap::new(),
            },
        }))
        .await
        .expect_err("the suggested default is not a user confirmation");

    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(source.path().join("SKILL.md").is_file());
}

#[tokio::test]
async fn import_item_override_creates_a_queryable_governance_task_without_removing_source() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("library");
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path());
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: ImportCandidate::detected(
                SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
                source.path().to_string_lossy(),
                ".",
                "SKILL.md",
                "Notes",
            ),
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let group = prepared.analysis.governance_groups.first().expect("group");
    let member = group.members.first().expect("member");

    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision: ImportGovernanceDecision {
                group_actions: BTreeMap::from([(
                    group.group_id.clone(),
                    ImportGovernanceAction::PreserveOriginal,
                )]),
                item_overrides: BTreeMap::from([(
                    member.member_id.clone(),
                    ImportGovernanceAction::CreateTodo,
                )]),
            },
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    let item = summary.items.first().expect("item result");
    assert_eq!(format!("{:?}", item.status), "Todo");
    let task = item
        .governance_tasks
        .first()
        .expect("created governance task");
    assert_eq!(task.kind, GovernanceTaskKind::UnknownDirectoryRecognition);
    assert!(!task.task_id.contains('#'));
    assert!(source.path().join("SKILL.md").is_file());

    let overview = facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::All,
        }))
        .await
        .expect("relationship overview");
    let AppQueryResult::RelationshipOverview(overview) = overview else {
        panic!("expected relationship overview");
    };
    assert!(overview
        .pending_governance_tasks
        .iter()
        .any(|pending| pending.task_id == task.task_id));
}

#[tokio::test]
async fn takeover_after_verify_copies_and_verifies_without_deleting_original() {
    let database = Database::open_in_memory().expect("database");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("library");
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path());
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    )
    .with_ownership(
        skillhub_core::import::CandidateOwnership::KnownAgentTarget,
        skillhub_core::ImportAction::Review,
        Some("agent.demo".into()),
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
    assert!(prepared
        .analysis
        .actions
        .contains(&ImportDecision::TakeOverAfterVerify));
    // 已知 Agent 目录来源关系明确：不生成治理组，接管无需治理确认。
    assert!(prepared.analysis.governance_groups.is_empty());

    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::TakeOverAfterVerify,
            governance_decision: ImportGovernanceDecision {
                group_actions: BTreeMap::new(),
                item_overrides: BTreeMap::new(),
            },
        }))
        .await
        .expect("takeover committed");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    assert_eq!(
        summary.items[0].status,
        skillhub_core::ImportItemStatus::Succeeded
    );
    assert!(summary.items[0].original_preserved);
    assert!(source.path().join("SKILL.md").is_file());
    assert_eq!(
        std::fs::read_dir(library_root.path().join("skills"))
            .expect("central skill directory")
            .count(),
        1
    );
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
    // The volume probe must not leave a temporary entry in the user's
    // directory either.
    let parent = fixture.source.parent().expect("relation parent");
    let leftovers = std::fs::read_dir(parent)
        .expect("parent listing")
        .filter(|entry| {
            entry
                .as_ref()
                .map(|entry| entry.file_name().to_string_lossy().starts_with('.'))
                .unwrap_or(false)
        })
        .count();
    assert_eq!(leftovers, 0, "prepare must not leave probe entries behind");
}

#[cfg(unix)]
#[tokio::test]
async fn prepare_refuses_conversion_when_the_relation_volume_cannot_host_links() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture().await;
    let parent = fixture
        .source
        .parent()
        .expect("relation parent")
        .to_path_buf();
    let mut permissions = std::fs::metadata(&parent)
        .expect("parent metadata")
        .permissions();
    permissions.set_mode(0o555);
    std::fs::set_permissions(&parent, permissions.clone()).expect("read-only relation parent");

    // Fail honestly when the platform ignores the read-only bit (for example
    // a root test process) instead of reporting a fake pass.
    let control = parent.join(".skillhub-link-probe-control");
    let readonly_enforced = std::os::unix::fs::symlink(&fixture.central, &control).is_err();
    let _ = std::fs::remove_file(&control);
    if !readonly_enforced {
        let mut restore = std::fs::metadata(&parent)
            .expect("parent metadata")
            .permissions();
        restore.set_mode(0o755);
        std::fs::set_permissions(&parent, restore).expect("restore relation parent");
        eprintln!("skipping: this process can write read-only directories (root?)");
        return;
    }

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
        .expect_err("prepare must refuse when no link kind can be created");
    assert_eq!(error.code, ErrorCode::SymlinkNotSupported);

    // The original copy entry is untouched and no backup exists yet.
    assert!(fixture.source.is_dir());
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("source metadata")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("body"),
        BODY
    );
    assert!(!fixture
        .library_root
        .join(".skillhub")
        .join("relationship-migrations")
        .exists());

    // The refusal is recorded as a conversion governance todo, not silently
    // swallowed and not downgraded to a copy deployment.
    let tasks = fixture
        .database
        .lock()
        .expect("database lock")
        .governance_task_repository()
        .list_pending()
        .expect("pending tasks");
    assert!(
        tasks.iter().any(
            |task| task.kind == GovernanceTaskKind::ConvertCopyToManagedLink
                && task.subject_id == fixture.relation_id
        ),
        "expected a copy-to-link governance todo, got {tasks:?}"
    );

    let mut restore = std::fs::metadata(&parent)
        .expect("parent metadata")
        .permissions();
    restore.set_mode(0o755);
    std::fs::set_permissions(&parent, restore).expect("restore relation parent");
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
async fn commit_rejects_changed_relation_facts_even_when_content_is_unchanged() {
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
        panic!("expected prepared relation migration");
    };

    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute(
            "UPDATE deployment_relations
              SET skill_id=NULL, agent_client_id='agent.changed',
                 directory_node_id=NULL, relationship='managed_copy',
                 file_representation='directory', ownership='observed_unmanaged',
                 link_target_path='changed-target', origin='import'
             WHERE relation_id=?1",
            [&fixture.relation_id],
        )
        .expect("changed relation facts");

    let result = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("changed relation facts are reported as a result");
    let AppCommandResult::RelationMigrationResult(result) = result else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, RelationMigrationState::Failed);
    assert_eq!(result.error_code, Some(ErrorCode::TargetChanged));
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
async fn commit_rejects_a_replaced_relation_parent_before_any_filesystem_action() {
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
        panic!("expected prepared relation migration");
    };

    let original_parent = fixture
        .source
        .parent()
        .expect("relation parent")
        .to_path_buf();
    let preserved_parent = fixture._workspace.path().join("agent/skills-preserved");
    std::fs::rename(&original_parent, &preserved_parent).expect("move original parent");
    std::fs::create_dir_all(&original_parent).expect("replace parent");
    write_skill(&original_parent.join("notes"));

    let result = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("unsafe parent replacement is reported as a result");
    let AppCommandResult::RelationMigrationResult(result) = result else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, RelationMigrationState::Failed);
    assert_eq!(result.error_code, Some(ErrorCode::OwnershipMismatch));
    assert!(preserved_parent.join("notes/SKILL.md").is_file());
    assert!(fixture.source.join("SKILL.md").is_file());
    assert!(!std::path::Path::new(&prepared.backup_path).exists());
}

#[tokio::test]
async fn commit_rejects_a_replaced_central_target_parent_before_any_filesystem_action() {
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
        panic!("expected prepared relation migration");
    };

    let original_parent = fixture
        .central
        .parent()
        .expect("central parent")
        .to_path_buf();
    let preserved_parent = fixture._workspace.path().join("central-preserved");
    std::fs::rename(&original_parent, &preserved_parent).expect("move original central parent");
    std::fs::create_dir_all(&original_parent).expect("replace central parent");
    write_skill(&fixture.central);

    let result = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("unsafe central parent replacement is reported as a result");
    let AppCommandResult::RelationMigrationResult(result) = result else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, RelationMigrationState::Failed);
    assert_eq!(result.error_code, Some(ErrorCode::OwnershipMismatch));
    assert!(fixture.source.join("SKILL.md").is_file());
    assert!(preserved_parent.is_dir());
    assert!(!std::path::Path::new(&prepared.backup_path).exists());
}

#[tokio::test]
async fn commit_rejects_source_relation_changes_before_any_filesystem_action() {
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
        panic!("expected prepared relation migration");
    };
    fixture
        .database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .upsert_source_relation(&SourceRelationFact {
            provenance_id: "provenance:changed-after-prepare".into(),
            skill_id: fixture.skill_id,
            directory_node_id: None,
            agent_client_id: Some("agent.demo".into()),
            source_path: fixture.source.to_string_lossy().into_owned(),
            source_path_key: String::new(),
            relationship: RelationshipType::ImportCopy,
            file_representation: FileRepresentation::Directory,
            ownership: OwnershipState::ObservedUnmanaged,
            link_target_path: None,
            link_target_directory_id: None,
            content_fingerprint: prepared.current_content_fingerprint.clone(),
            source: SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::local_path(fixture.source.clone()),
            ),
            imported_at: 2,
        })
        .expect("source relation");

    let result = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("changed source relations are reported as a result");
    let AppCommandResult::RelationMigrationResult(result) = result else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, RelationMigrationState::Failed);
    assert_eq!(result.error_code, Some(ErrorCode::TargetChanged));
    assert!(fixture.source.join("SKILL.md").is_file());
    assert!(!std::path::Path::new(&prepared.backup_path).exists());
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
async fn managed_copy_conversion_replaces_the_copy_and_rollback_restores_the_managed_copy() {
    let fixture = fixture_with(RelationKind::ManagedCopyEntry).await;
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
    assert_eq!(
        prepared.relation.relationship,
        RelationshipType::ManagedCopy
    );

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

    // The copy entry was replaced in place by exactly one link entry; no
    // double entry and no staging leftovers remain in the agent directory.
    assert!(std::fs::symlink_metadata(&fixture.source)
        .expect("link metadata")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("body through link"),
        BODY
    );
    let parent = fixture.source.parent().expect("relation parent");
    let leftovers = std::fs::read_dir(parent)
        .expect("parent listing")
        .filter(|entry| {
            entry
                .as_ref()
                .map(|entry| entry.file_name().to_string_lossy().starts_with('.'))
                .unwrap_or(false)
        })
        .count();
    assert_eq!(leftovers, 0, "conversion must not leave staging entries");

    let record = fixture
        .database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == fixture.relation_id)
        .expect("relation record");
    assert_eq!(record.relationship, RelationshipType::ManagedLink);
    assert_eq!(record.ownership, OwnershipState::SkillhubManaged);
    assert_eq!(record.file_representation, FileRepresentation::SymbolicLink);
    assert_eq!(
        record.link_target_path.as_deref(),
        Some(fixture.central.to_string_lossy().as_ref())
    );

    // The recovery point keeps the original copy content.
    let backup = fixture
        .library_root
        .join(".skillhub")
        .join("relationship-migrations")
        .join(prepared.operation_id.to_string())
        .join("previous");
    assert_eq!(
        std::fs::read_to_string(backup.join("SKILL.md")).expect("backup body"),
        BODY
    );

    // Rolling back restores the managed copy, not a bare directory lookalike.
    let rolled_back = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("rollback");
    let AppCommandResult::RelationMigrationResult(rolled_back) = rolled_back else {
        panic!("expected rollback result");
    };
    assert_eq!(rolled_back.state, RelationMigrationState::RolledBack);
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("restored entry")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("restored body"),
        BODY
    );
    let record = fixture
        .database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == fixture.relation_id)
        .expect("relation record");
    assert_eq!(record.relationship, RelationshipType::ManagedCopy);
    assert_eq!(record.ownership, OwnershipState::SkillhubManaged);
    assert_eq!(record.file_representation, FileRepresentation::Copy);
    assert!(record.link_target_path.is_none());
}

#[tokio::test]
async fn cancelling_a_conversion_keeps_the_copy_entry_and_its_recorded_relationship() {
    let fixture = fixture_with(RelationKind::ManagedCopyEntry).await;
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

    // Keeping the copy is the explicit cancel path: nothing on disk or in
    // the relationship record may change.
    let cancelled = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("cancel");
    let AppCommandResult::RelationMigrationResult(cancelled) = cancelled else {
        panic!("expected cancel result");
    };
    assert_eq!(cancelled.state, RelationMigrationState::Cancelled);

    assert!(fixture.source.is_dir());
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("entry metadata")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("body"),
        BODY
    );
    let record = fixture
        .database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == fixture.relation_id)
        .expect("relation record");
    assert_eq!(record.relationship, RelationshipType::ManagedCopy);
    assert_eq!(record.ownership, OwnershipState::SkillhubManaged);
    assert_eq!(record.file_representation, FileRepresentation::Copy);
    assert!(!fixture
        .library_root
        .join(".skillhub")
        .join("relationship-migrations")
        .exists());
}

#[tokio::test]
async fn shared_reference_conversion_repoints_one_alias_and_keeps_the_shared_body() {
    let fixture = fixture_with(RelationKind::SharedReference { other_consumers: 1 }).await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    let shared_body = fixture
        .shared_body
        .clone()
        .expect("shared body fixture path");
    let other_alias = fixture.other_alias.clone().expect("other consumer alias");
    let shared_fingerprint_before =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&shared_body)
            .expect("shared body fingerprint");

    // Without the explicit shared-impact confirmation the conversion stops
    // before any filesystem change.
    let unconfirmed = fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture.relation_id.clone(),
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: None,
            },
        ))
        .await
        .expect("unconfirmed prepare is recorded");
    let AppCommandResult::PreparedRelationMigration(unconfirmed) = unconfirmed else {
        panic!("expected prepared");
    };
    assert!(unconfirmed
        .governance_tasks
        .iter()
        .any(|task| { task.kind == GovernanceTaskKind::ConfirmSharedDirectoryImpact }));
    let refused = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: unconfirmed.operation_id,
            },
        ))
        .await
        .expect("refused commit is reported");
    let AppCommandResult::RelationMigrationResult(refused) = refused else {
        panic!("expected refused result");
    };
    assert_eq!(refused.state, RelationMigrationState::Failed);
    assert!(std::fs::symlink_metadata(&fixture.source)
        .expect("alias metadata")
        .file_type()
        .is_symlink());

    // The confirmed conversion replaces the shared-directory alias with a
    // managed link to the central library.
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
    assert!(
        prepared.governance_tasks.is_empty(),
        "unexpected tasks: {:?}",
        prepared.governance_tasks
    );

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
    assert_eq!(
        committed.state,
        RelationMigrationState::Committed,
        "unexpected: {:?}",
        committed
    );

    // The agent's own alias now points at the central library only.
    assert_eq!(
        std::fs::read_link(&fixture.source).expect("alias target"),
        fixture.central
    );
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("body through new link"),
        BODY
    );

    // The shared body itself is untouched and still serves the other consumer.
    assert!(std::fs::symlink_metadata(&shared_body)
        .expect("shared body metadata")
        .is_dir());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&shared_body)
            .expect("shared body fingerprint after conversion"),
        shared_fingerprint_before
    );
    assert_eq!(
        std::fs::read_to_string(shared_body.join("SKILL.md")).expect("shared body content"),
        BODY
    );
    assert!(std::fs::symlink_metadata(&other_alias)
        .expect("other alias")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_link(&other_alias).expect("other alias target"),
        shared_body
    );
    assert_eq!(
        std::fs::read_to_string(other_alias.join("SKILL.md")).expect("other consumer body"),
        BODY
    );

    let relations = fixture
        .database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_relations()
        .expect("relations");
    let converted = relations
        .iter()
        .find(|relation| relation.relation_id == fixture.relation_id)
        .expect("converted relation");
    assert_eq!(converted.relationship, RelationshipType::ManagedLink);
    assert_eq!(converted.ownership, OwnershipState::SkillhubManaged);
    let other = relations
        .iter()
        .find(|relation| relation.relation_id == "observed:agent.other:notes")
        .expect("other consumer relation");
    assert_eq!(other.relationship, RelationshipType::SharedDirectoryRead);
    assert!(other.active);
    let shared_node = fixture
        .database
        .lock()
        .expect("database lock")
        .directory_repository()
        .list_nodes()
        .expect("directory nodes")
        .into_iter()
        .any(|node| node.node_id == "directory:shared-skills" && node.exists);
    assert!(shared_node, "shared directory node must survive");

    // Rolling back removes the managed link and restores the alias that
    // points at the shared body.
    let rolled_back = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("rollback");
    let AppCommandResult::RelationMigrationResult(rolled_back) = rolled_back else {
        panic!("expected rollback result");
    };
    assert_eq!(rolled_back.state, RelationMigrationState::RolledBack);
    assert_eq!(
        std::fs::read_link(&fixture.source).expect("restored alias target"),
        shared_body
    );
    let restored = fixture
        .database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == fixture.relation_id)
        .expect("restored relation");
    assert_eq!(
        restored.relationship,
        RelationshipType::SharedDirectoryReference
    );
    assert_eq!(
        restored.link_target_path.as_deref(),
        Some(shared_body.to_string_lossy().as_ref())
    );
    assert_eq!(
        std::fs::read_link(&other_alias).expect("other alias target after rollback"),
        shared_body
    );
}

#[tokio::test]
async fn rollback_rejects_a_replaced_relation_parent_before_removing_the_managed_link() {
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
        panic!("expected prepared relation migration");
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

    let original_parent = fixture
        .source
        .parent()
        .expect("relation parent")
        .to_path_buf();
    let preserved_parent = fixture._workspace.path().join("agent/skills-preserved");
    std::fs::rename(&original_parent, &preserved_parent).expect("move original parent");
    std::fs::create_dir_all(&original_parent).expect("replace parent");
    create_dir_link_for_test(&fixture.central, &fixture.source);

    let result = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: committed.operation_id,
            },
        ))
        .await
        .expect("unsafe parent replacement is reported as a result");
    let AppCommandResult::RelationMigrationResult(result) = result else {
        panic!("expected rollback result");
    };
    assert_eq!(result.state, RelationMigrationState::Failed);
    assert_eq!(result.error_code, Some(ErrorCode::OwnershipMismatch));
    assert!(std::fs::symlink_metadata(&fixture.source)
        .expect("replacement link")
        .file_type()
        .is_symlink());
    assert!(preserved_parent.join("notes").is_symlink());
}

#[tokio::test]
async fn prepare_rejects_directory_junction_and_records_governance_task() {
    let fixture = fixture().await;
    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute(
            "UPDATE deployment_relations
             SET file_representation='directory_junction'
             WHERE relation_id=?1",
            [&fixture.relation_id],
        )
        .expect("mark junction relation");

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
        .expect_err("junction migration must fail closed");
    assert_eq!(error.code, ErrorCode::JunctionNotSupported);
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
                && task.kind == GovernanceTaskKind::OperationFailureRecovery
        }));
}

#[tokio::test]
async fn prepare_rejects_externally_modified_targets_before_any_conversion() {
    // A centrally modified target must be refused before any conversion.
    let central_fixture = fixture().await;
    std::fs::write(
        central_fixture.central.join("SKILL.md"),
        "externally changed",
    )
    .expect("mutate central target");
    let error = central_fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: central_fixture.relation_id,
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect_err("prepare must refuse a modified central target");
    assert_eq!(error.code, ErrorCode::TargetChanged);

    // A locally edited copy entry is refused the same way, and stays intact.
    let copy_fixture = fixture().await;
    std::fs::write(copy_fixture.source.join("SKILL.md"), "locally edited")
        .expect("mutate copy entry");
    let error = copy_fixture
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: copy_fixture.relation_id,
                target_mode: RelationMigrationTargetMode::ManagedLink,
                backup_policy: RelationshipMigrationBackupPolicy::Required,
                confirmation_token: Some("confirmed".into()),
            },
        ))
        .await
        .expect_err("prepare must refuse a modified copy entry");
    assert_eq!(error.code, ErrorCode::TargetChanged);
    assert!(copy_fixture.source.is_dir());
    assert_eq!(
        std::fs::read_to_string(copy_fixture.source.join("SKILL.md")).expect("entry body"),
        "locally edited"
    );
}

#[tokio::test]
async fn commit_creates_and_verifies_the_staged_link_before_removing_the_original_entry() {
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

    // A foreign entry exactly at the migration's staging location makes
    // creating the staged managed link impossible.  The conversion order is
    // "create new link -> verify -> remove original entry", so the original
    // copy must survive untouched.
    let staging = fixture
        .source
        .parent()
        .expect("relation parent")
        .join(format!(".skillhub-relation-link-{}", prepared.operation_id));
    std::fs::create_dir(&staging).expect("plant foreign staging entry");
    let original_identity_before =
        skillhub_core::physical_id_for_path(&fixture.source).expect("original identity");

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
    assert_eq!(result.error_code, Some(ErrorCode::OwnershipMismatch));

    // The original entry was never removed: same physical identity, same
    // body, still a plain directory.
    assert_eq!(
        skillhub_core::physical_id_for_path(&fixture.source),
        Some(original_identity_before)
    );
    assert!(fixture.source.is_dir());
    assert!(!std::fs::symlink_metadata(&fixture.source)
        .expect("source metadata")
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read_to_string(fixture.source.join("SKILL.md")).expect("body"),
        BODY
    );
    // The foreign staging entry is not ours to delete either.
    assert!(staging.is_dir());
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
        .execute_batch(
            "CREATE TRIGGER fail_relation_commit_checkpoint
             BEFORE UPDATE OF phase ON operations
             WHEN NEW.phase = 'committed'
             BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END;",
        )
        .expect("break only the journal checkpoint");

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
async fn rollback_retries_relation_writeback_after_filesystem_restore_failure() {
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
        panic!("expected prepared relation migration");
    };
    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_commit_checkpoint_after_filesystem
             BEFORE UPDATE OF phase ON operations
             WHEN NEW.phase = 'committed'
             BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END;
             CREATE TRIGGER fail_relation_writeback
             BEFORE UPDATE OF relationship ON deployment_relations
             WHEN NEW.relationship = 'observed_copy'
             BEGIN SELECT RAISE(ABORT, 'relation writeback unavailable'); END;",
        )
        .expect("install failure triggers");

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
    assert_eq!(first.error_code, Some(ErrorCode::InternalError));
    assert!(fixture.source.is_dir());

    let record = fixture
        .database
        .lock()
        .expect("database lock")
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("journal read")
        .expect("journal record");
    let stage = record.recovery_data["journal"]["stage"]
        .as_str()
        .expect("pending stage");
    assert_eq!(stage, "filesystem_restored_relation_persistence_pending");

    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "DROP TRIGGER fail_commit_checkpoint_after_filesystem;
             DROP TRIGGER fail_relation_writeback;",
        )
        .expect("remove failure triggers");
    let retried = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("rollback retry");
    let AppCommandResult::RelationMigrationResult(retried) = retried else {
        panic!("expected rollback result");
    };
    assert_eq!(retried.state, RelationMigrationState::RolledBack);
    assert!(fixture.source.is_dir());
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
async fn rollback_rejects_a_corrupt_backup_metadata_record_without_fabricating_metadata() {
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
        panic!("expected prepared relation migration");
    };
    write_skill(std::path::Path::new(&prepared.backup_path));
    mark_relation_operation_applying(&fixture, prepared.operation_id);

    mutate_relation_journal_record(&fixture, prepared.operation_id, |journal| {
        journal["backup"]
            .as_object_mut()
            .expect("backup object")
            .remove("original_representation");
    });
    let error = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect_err("corrupt metadata must be rejected before a result is fabricated");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("detail").and_then(|value| value.as_str()),
        Some("relationship backup metadata is corrupt")
    );
    assert!(fixture.source.is_dir());
}

#[tokio::test]
async fn rollback_rejects_a_backup_directory_replaced_by_a_symlink() {
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
        panic!("expected prepared relation migration");
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

    let backup = std::path::PathBuf::from(committed.backup_path.expect("backup path"));
    std::fs::remove_dir_all(&backup).expect("remove original backup directory");
    create_dir_link_for_test(&fixture.central, &backup);

    let rollback = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: committed.operation_id,
            },
        ))
        .await
        .expect("unsafe backup is reported as a result");
    let AppCommandResult::RelationMigrationResult(rollback) = rollback else {
        panic!("expected rollback result");
    };
    assert_eq!(rollback.state, RelationMigrationState::Failed);
    assert_eq!(rollback.error_code, Some(ErrorCode::OperationConflict));
    assert!(std::fs::symlink_metadata(&fixture.source)
        .expect("managed link remains")
        .file_type()
        .is_symlink());
}

#[tokio::test]
async fn rollback_rejects_backup_metadata_rebound_outside_the_library_root() {
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
        panic!("expected prepared relation migration");
    };
    mark_relation_operation_applying(&fixture, prepared.operation_id);

    let outside_backup_path = fixture._workspace.path().join("outside-backup");
    write_skill(&outside_backup_path);
    let outside_backup = outside_backup_path.to_string_lossy().into_owned();
    mutate_relation_journal_record(&fixture, prepared.operation_id, |journal| {
        journal["prepared"]["backup_path"] = Value::String(outside_backup.clone());
        journal["backup"]["path"] = Value::String(outside_backup.clone());
    });

    let rollback = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("outside backup is reported as a result");
    let AppCommandResult::RelationMigrationResult(rollback) = rollback else {
        panic!("expected rollback result");
    };
    assert_eq!(rollback.state, RelationMigrationState::Failed);
    assert_eq!(
        rollback.error_code,
        Some(ErrorCode::PathOutsideAllowedRoots)
    );
    assert!(fixture.source.is_dir());
    assert_eq!(
        std::fs::read_to_string(outside_backup_path.join("SKILL.md"))
            .expect("outside backup remains untouched"),
        BODY
    );
}

#[tokio::test]
async fn rollback_rejects_an_original_symlink_backup_with_a_changed_target() {
    let fixture = fixture().await;
    if !skillhub_adapters::deployment::DeploymentFilesystem::new()
        .available_capabilities()
        .symlink
    {
        return;
    }
    std::fs::remove_dir_all(&fixture.source).expect("remove original copy");
    create_dir_link_for_test(&fixture.central, &fixture.source);
    {
        let database = fixture.database.lock().expect("database lock");
        let mut relation = database
            .relationship_repository()
            .list_relations()
            .expect("relations")
            .into_iter()
            .find(|relation| relation.relation_id == fixture.relation_id)
            .expect("relation");
        relation.relationship = RelationshipType::ObservedLink;
        relation.file_representation = FileRepresentation::SymbolicLink;
        relation.link_target_path = Some(fixture.central.to_string_lossy().into_owned());
        database
            .relationship_repository()
            .upsert_deployment_relation(&relation)
            .expect("symlink relation");
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
        panic!("expected prepared relation migration");
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

    let wrong_target = fixture.library_root.join("wrong-target");
    write_skill(&wrong_target);
    let backup = std::path::PathBuf::from(committed.backup_path.expect("backup path"));
    std::fs::remove_file(&backup).expect("remove original backup link");
    create_dir_link_for_test(&wrong_target, &backup);

    let rollback = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: committed.operation_id,
            },
        ))
        .await
        .expect("wrong backup target is reported as a result");
    let AppCommandResult::RelationMigrationResult(rollback) = rollback else {
        panic!("expected rollback result");
    };
    assert_eq!(rollback.state, RelationMigrationState::Failed);
    assert_eq!(rollback.error_code, Some(ErrorCode::OperationConflict));
    assert_eq!(
        std::fs::read_link(&fixture.source).expect("managed source link"),
        fixture.central
    );
}

#[tokio::test]
async fn rollback_wraps_final_checkpoint_failure_and_can_retry_after_filesystem_restore() {
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
        panic!("expected prepared relation migration");
    };
    write_skill(std::path::Path::new(&prepared.backup_path));
    mark_relation_operation_applying(&fixture, prepared.operation_id);

    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_relation_rollback_checkpoint
             BEFORE UPDATE OF phase ON operations
             WHEN NEW.phase = 'rolled_back'
             BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END;",
        )
        .expect("install checkpoint failure");

    let first = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect_err("final checkpoint failure must be visible");
    assert_eq!(first.code, ErrorCode::InternalError);
    assert_eq!(
        first.params.get("audit").and_then(|value| value.as_str()),
        Some("filesystem_restored_after_journal_failure")
    );
    assert!(fixture.source.is_dir());

    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_relation_rollback_checkpoint")
        .expect("restore checkpoint");
    let retried = fixture
        .facade
        .execute(AppCommand::RollbackRelationMigration(
            skillhub_core::api::RollbackRelationMigration {
                operation_id: prepared.operation_id,
            },
        ))
        .await
        .expect("rollback retry");
    let AppCommandResult::RelationMigrationResult(retried) = retried else {
        panic!("expected rollback result");
    };
    assert_eq!(retried.state, RelationMigrationState::RolledBack);
    assert!(fixture.source.is_dir());
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

#[tokio::test]
async fn commit_rechecks_source_relations_after_the_applying_checkpoint() {
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

    // The trigger is a deterministic stand-in for another writer committing
    // after the initial source snapshot but before filesystem mutation.
    fixture
        .database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER add_source_relation_after_applying
             AFTER UPDATE OF phase ON operations
             WHEN NEW.phase = 'applying'
             BEGIN
                 INSERT INTO source_relations (
                     provenance_id, skill_id, directory_node_id, agent_client_id,
                     source_path, source_path_key, relationship, file_representation,
                     ownership, link_target_path, link_target_directory_id,
                     content_fingerprint, source_kind, source_locator, imported_at
                 )
                 SELECT 'provenance:concurrent', skill_id, NULL, agent_client_id,
                        path, path, 'import_copy', 'directory', 'observed_unmanaged',
                        NULL, NULL, content_fingerprint, 'local', path, 2
                 FROM deployment_relations
                 WHERE relation_id = 'observed:agent.demo:notes';
             END;",
        )
        .expect("install source relation race trigger");

    let result = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect("source relation race is reported as a result");
    let AppCommandResult::RelationMigrationResult(result) = result else {
        panic!("expected migration result");
    };
    assert_eq!(result.state, RelationMigrationState::Failed);
    assert_eq!(result.error_code, Some(ErrorCode::TargetChanged));
    assert!(fixture.source.is_dir());
    assert!(!std::path::Path::new(&prepared.backup_path).exists());
}

#[tokio::test]
async fn commit_rejects_a_missing_required_journal_field_without_recomputing_it() {
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
    mutate_relation_journal_record(&fixture, prepared.operation_id, |journal| {
        journal
            .as_object_mut()
            .expect("journal object")
            .remove("expected_target_fingerprint");
    });

    let error = fixture
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect_err("missing journal field must fail closed");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("detail").and_then(|value| value.as_str()),
        Some("relationship journal target fingerprint is missing")
    );
    assert!(fixture.source.is_dir());
}

#[tokio::test]
async fn commit_rejects_a_corrupt_journal_result_and_optional_field() {
    let fixture_first = fixture().await;
    let prepared = fixture_first
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture_first.relation_id.clone(),
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
    mutate_relation_journal_record(&fixture_first, prepared.operation_id, |journal| {
        journal["backup"]["original_link_target"] = Value::Bool(true);
    });
    let error = fixture_first
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect_err("corrupt optional field must fail closed");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("detail").and_then(|value| value.as_str()),
        Some("relationship backup metadata is corrupt")
    );
    assert!(fixture_first.source.is_dir());

    // A malformed persisted result must be rejected too, rather than being
    // treated as an absent result and allowing a retry to fabricate state.
    let fixture2 = fixture().await;
    let prepared = fixture2
        .facade
        .execute(AppCommand::PrepareRelationMigration(
            PrepareRelationMigration {
                relation_id: fixture2.relation_id.clone(),
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
    let raw: String = {
        let database = fixture2.database.lock().expect("database lock");
        database
            .connection_for_test()
            .query_row(
                "SELECT progress_json FROM operations WHERE operation_id=?1",
                [prepared.operation_id.to_string()],
                |row| row.get(0),
            )
            .expect("journal progress")
    };
    let mut progress: Value = serde_json::from_str(&raw).expect("journal json");
    progress["result"] = Value::String("not-a-relation-result".into());
    let encoded = serde_json::to_string(&progress).expect("journal json encoding");
    {
        let database = fixture2.database.lock().expect("database lock");
        database
            .connection_for_test()
            .execute(
                "UPDATE operations SET progress_json=?2 WHERE operation_id=?1",
                rusqlite::params![prepared.operation_id.to_string(), encoded],
            )
            .expect("tamper result");
    }

    let error = fixture2
        .facade
        .execute(AppCommand::CommitRelationMigration(
            skillhub_core::api::CommitRelationMigration {
                prepared_relation_migration_id: prepared.operation_id,
            },
        ))
        .await
        .expect_err("corrupt result must fail closed");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("detail").and_then(|value| value.as_str()),
        Some("relationship journal result is corrupt")
    );
    assert!(fixture2.source.is_dir());
}

#[tokio::test]
async fn concurrent_commits_of_one_prepared_relation_are_serialized() {
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
    let operation_id = prepared.operation_id;
    let facade = &fixture.facade;
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("first runtime");
            runtime.block_on(facade.execute(AppCommand::CommitRelationMigration(
                skillhub_core::api::CommitRelationMigration {
                    prepared_relation_migration_id: operation_id,
                },
            )))
        });
        let second = scope.spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("second runtime");
            runtime.block_on(facade.execute(AppCommand::CommitRelationMigration(
                skillhub_core::api::CommitRelationMigration {
                    prepared_relation_migration_id: operation_id,
                },
            )))
        });
        (
            first.join().expect("first commit thread"),
            second.join().expect("second commit thread"),
        )
    });
    let first = first.expect("first commit");
    let second = second.expect("second commit");
    let AppCommandResult::RelationMigrationResult(first) = first else {
        panic!("expected first migration result");
    };
    let AppCommandResult::RelationMigrationResult(second) = second else {
        panic!("expected second migration result");
    };
    assert_eq!(first.state, RelationMigrationState::Committed);
    assert_eq!(second.state, RelationMigrationState::Committed);
    assert_eq!(first.operation_id, second.operation_id);
    assert!(std::fs::symlink_metadata(&fixture.source)
        .expect("managed relation")
        .file_type()
        .is_symlink());
}

#[tokio::test]
async fn import_from_shared_directory_groups_members_with_affected_agents() {
    let database = Database::open_in_memory().expect("database");
    let workspace = tempfile::tempdir().expect("workspace");
    let shared = workspace.path().join("shared-skills");
    std::fs::create_dir_all(&shared).expect("shared dir");
    let source = shared.join("notes");
    write_skill(&source);
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .directory_repository()
            .upsert_node(&DirectoryNodeFact {
                node_id: "directory:shared".into(),
                path: shared.to_string_lossy().into_owned(),
                path_key: String::new(),
                role: DirectoryRole::SharedDirectory,
                profile_id: Some("agent-skills".into()),
                agent_client_id: None,
                exists: true,
                observed_at: 1,
                scan_source: Some("test".into()),
            })
            .expect("directory node");
        for client in ["zcode.shared", "trae.code"] {
            database
                .relationship_repository()
                .upsert_capability(&AgentDirectoryCapabilityFact {
                    agent_client_id: client.into(),
                    directory_node_id: "directory:shared".into(),
                    recognition: DirectoryRecognition::Supported,
                    precedence: DirectoryPrecedence::Preferred,
                    evidence_reference: None,
                    researched_at: None,
                    applicable_platforms: vec![],
                })
                .expect("capability");
        }
    }

    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: ImportCandidate::detected(
                SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(&source)),
                source.to_string_lossy(),
                ".",
                "SKILL.md",
                "Notes",
            ),
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    assert_eq!(prepared.analysis.governance_groups.len(), 1);
    let group = prepared
        .analysis
        .governance_groups
        .first()
        .expect("governance group");
    assert_eq!(
        group.classification,
        skillhub_core::ImportGovernanceClassification::SharedDirectoryRead
    );
    let member = group.members.first().expect("member");
    assert!(member.source_path.ends_with("shared-skills/notes"));
    // 受影响 Agent 来自已登记目录能力，排序去重后供界面展示。
    assert_eq!(member.affected_agents, ["trae.code", "zcode.shared"]);

    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision: ImportGovernanceDecision {
                group_actions: BTreeMap::from([(
                    group.group_id.clone(),
                    ImportGovernanceAction::CreateTodo,
                )]),
                item_overrides: BTreeMap::new(),
            },
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    let task = summary
        .items
        .first()
        .expect("item")
        .governance_tasks
        .first()
        .expect("task")
        .clone();
    assert_eq!(task.kind, GovernanceTaskKind::ConfirmSharedDirectoryImpact);
    // detail 是稳定键，不是散文；客户端负责翻译。
    assert_eq!(
        task.detail,
        "import.governance.task.confirm_shared_directory_impact"
    );
    assert!(source.join("SKILL.md").is_file());
}

#[tokio::test]
async fn same_name_conflict_todo_maps_to_classify_same_name_skill() {
    let database = Database::open_in_memory().expect("database");
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let existing_source = workspace.path().join("existing/notes");
    std::fs::create_dir_all(&existing_source).expect("existing dir");
    std::fs::write(existing_source.join("SKILL.md"), "# Notes A").expect("existing skill");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: existing_source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");

    let incoming = workspace.path().join("incoming/notes");
    std::fs::create_dir_all(&incoming).expect("incoming dir");
    std::fs::write(incoming.join("SKILL.md"), "# Notes B").expect("incoming skill");
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: ImportCandidate::detected(
                SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(&incoming)),
                incoming.to_string_lossy(),
                ".",
                "SKILL.md",
                "Notes",
            ),
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let group = prepared
        .analysis
        .governance_groups
        .first()
        .expect("governance group");
    assert_eq!(
        group.classification,
        skillhub_core::ImportGovernanceClassification::SameNameDifferentContent
    );
    assert_eq!(
        group.default_action,
        ImportGovernanceAction::CreateTodo,
        "同名不同内容默认进入待判断待办"
    );

    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::KeepIndependent,
            governance_decision: ImportGovernanceDecision {
                group_actions: BTreeMap::from([(
                    group.group_id.clone(),
                    ImportGovernanceAction::CreateTodo,
                )]),
                item_overrides: BTreeMap::new(),
            },
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    let task = summary
        .items
        .first()
        .expect("item")
        .governance_tasks
        .first()
        .expect("task");
    assert_eq!(task.kind, GovernanceTaskKind::ClassifySameNameSkill);
    assert_eq!(
        task.detail,
        "import.governance.task.classify_same_name_skill"
    );
    assert!(incoming.join("SKILL.md").is_file());
}

#[tokio::test]
async fn exact_duplicate_todo_maps_to_select_authoritative_version() {
    let database = Database::open_in_memory().expect("database");
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let source = workspace.path().join("source/notes");
    write_skill(&source);
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");

    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: ImportCandidate::detected(
                SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(&source)),
                source.to_string_lossy(),
                ".",
                "SKILL.md",
                "Notes",
            ),
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let group = prepared
        .analysis
        .governance_groups
        .first()
        .expect("governance group");
    assert_eq!(
        group.classification,
        skillhub_core::ImportGovernanceClassification::ExactDuplicate
    );

    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision: ImportGovernanceDecision {
                group_actions: BTreeMap::from([(
                    group.group_id.clone(),
                    ImportGovernanceAction::CreateTodo,
                )]),
                item_overrides: BTreeMap::new(),
            },
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    let task = summary
        .items
        .first()
        .expect("item")
        .governance_tasks
        .first()
        .expect("task");
    assert_eq!(task.kind, GovernanceTaskKind::SelectAuthoritativeVersion);
    assert_eq!(
        task.detail,
        "import.governance.task.select_authoritative_version"
    );
}

#[tokio::test]
async fn verified_observed_copy_import_is_grouped_as_content_identical_copy() {
    let database = Database::open_in_memory().expect("database");
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let managed_source = workspace.path().join("origin/notes");
    write_skill(&managed_source);
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: managed_source.to_string_lossy().into_owned(),
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
        .expect("list skills")
    else {
        panic!("expected skill page");
    };
    let skill_id = page.items[0].skill_id;

    // 同一内容的第二个目录：扫描建立"内容已验证"的观察副本事实。
    let copy = workspace.path().join("elsewhere/notes");
    write_skill(&copy);
    let fingerprint = skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&copy)
        .expect("copy fingerprint");
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .provenance_repository()
            .apply_observed_row_action(
                "trae.code",
                &copy.to_string_lossy(),
                &skillhub_core::deployment::ObservedRowAction::EstablishVerified {
                    skill_id,
                    fingerprint,
                },
                skillhub_core::deployment::ObservedOrigin::Scan,
                1,
            )
            .expect("observed copy");
    }

    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate: ImportCandidate::detected(
                SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(&copy)),
                copy.to_string_lossy(),
                ".",
                "SKILL.md",
                "Notes",
            ),
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let group = prepared
        .analysis
        .governance_groups
        .first()
        .expect("governance group");
    assert_eq!(
        group.classification,
        skillhub_core::ImportGovernanceClassification::ContentIdenticalCopy
    );
    let member = group.members.first().expect("member");
    assert_eq!(
        member.affected_agents,
        ["trae.code"],
        "观察副本的归属 Agent 进入影响事实"
    );
}
