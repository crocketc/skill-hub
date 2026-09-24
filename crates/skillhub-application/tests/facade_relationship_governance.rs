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
    CommitRelationGovernanceBatch, CreateSkill, GetConflictWorkspace, GetRelationshipOverview,
    GetRelationshipRemovalImpact, GetSkillRelationshipGraph, ListRelationGovernance,
    ListSkillRelationshipCandidates, ListSkills, PrepareImport, PrepareRelationGovernanceBatch,
    PrepareRelationMigration, RelationGovernanceBatchAction, RelationGovernanceBatchItemState,
    RelationGovernanceBatchOutcome, RelationGovernanceBatchState, RelationshipGraphFilters,
    RelationshipMigrationBackupPolicy, RelationshipOverviewScope, ResolveConflictCase,
    RollbackRelationGovernanceBatch,
};
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::duplicate::{
    build_conflict_analysis_input, AnalyzeConflictScope, ConflictAnalysisAction,
    ConflictAnalysisRecord, ConflictCaseAnalysis, DuplicateAnalysisSource,
};
use skillhub_core::import::{ImportGovernanceAction, ImportGovernanceDecision};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictDecision,
    ConflictEvidence, ConflictGovernanceIntent, ConflictKind, ConflictMemberFact,
    ConflictWorkspace, DeploymentRelationFact, DirectoryNodeFact, DirectoryRecognition,
    DirectoryRole, FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, IdentityDirection,
    OwnershipState, RelationGovernanceBlocker, RelationGovernanceBucket, RelationGovernanceFilters,
    RelationGovernanceReadiness, RelationshipType, SourceRelationFact,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode,
    ImportCandidate, ImportDecision, OperationPhase, RelationMigrationState,
    RelationMigrationTargetMode, SkillId,
};
use skillhub_storage::{CentralLibrary, Database};

const BODY: &str = "# Notes\n\nrelationship governance\n";

#[tokio::test]
async fn relationship_graph_and_candidates_use_only_queryable_relationship_facts() {
    let database = Database::open_in_memory().expect("database");
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    let center: SkillId = "00000000-0000-0000-0000-0000000000a1".parse().unwrap();
    let empty: SkillId = "00000000-0000-0000-0000-0000000000a2".parse().unwrap();
    {
        let database = facade.database_for_tests();
        let database = database.lock().expect("database");
        database
            .connection_for_test()
            .execute_batch(&format!(
                "INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES
                 ('{center}','Display Alias','main-name',1,1),
                 ('{empty}','No Relation','no-relation',1,1);
                 INSERT INTO tags(id,name) VALUES ('tag:graph','graph');
                 INSERT INTO skill_tags(skill_id,tag_id) VALUES ('{center}','tag:graph');"
            ))
            .expect("skills");
        database
            .relationship_repository()
            .upsert_source_relation(&SourceRelationFact {
                provenance_id: "provenance:graph".into(),
                skill_id: center,
                directory_node_id: None,
                agent_client_id: None,
                source_path: "C:/incoming/graph".into(),
                source_path_key: String::new(),
                relationship: RelationshipType::ImportCopy,
                file_representation: FileRepresentation::Directory,
                ownership: OwnershipState::ObservedUnmanaged,
                link_target_path: None,
                link_target_directory_id: None,
                content_fingerprint: "sha256:graph".into(),
                source: SourceDescriptor::new(
                    SourceKind::Local,
                    SourceLocator::local_path("C:/incoming/graph"),
                ),
                imported_at: 9,
            })
            .expect("source relation");
    }

    let candidates = facade
        .query(AppQuery::ListSkillRelationshipCandidates(
            ListSkillRelationshipCandidates {
                text: "main".into(),
                tags: vec!["graph".into()],
            },
        ))
        .await
        .expect("relationship candidates");
    let AppQueryResult::SkillRelationshipCandidates(candidates) = candidates else {
        panic!("expected relationship candidates");
    };
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].skill_id, center);
    assert_eq!(candidates[0].relationship_count, 1);
    assert!(candidates[0].matched_alias.is_some());
    assert!(!candidates[0].relationship_revision.is_empty());

    // 主名称命中不是别名命中：别名只在主名称不匹配时上报。
    let by_display_name = facade
        .query(AppQuery::ListSkillRelationshipCandidates(
            ListSkillRelationshipCandidates {
                text: "display".into(),
                tags: Vec::new(),
            },
        ))
        .await
        .expect("relationship candidates by display name");
    let AppQueryResult::SkillRelationshipCandidates(by_display_name) = by_display_name else {
        panic!("expected relationship candidates");
    };
    assert_eq!(by_display_name.len(), 1);
    assert_eq!(by_display_name[0].skill_id, center);
    assert_eq!(by_display_name[0].matched_alias, None);

    // 没有可展示关系事实的 Skill 不会因为搜索命中而变成候选节点。
    let relationless = facade
        .query(AppQuery::ListSkillRelationshipCandidates(
            ListSkillRelationshipCandidates {
                text: "no-relation".into(),
                tags: Vec::new(),
            },
        ))
        .await
        .expect("relationship candidates without relations");
    let AppQueryResult::SkillRelationshipCandidates(relationless) = relationless else {
        panic!("expected relationship candidates");
    };
    assert!(
        relationless.is_empty(),
        "a Skill without displayable relationship facts must not be fabricated as a candidate"
    );

    let graph = facade
        .query(AppQuery::GetSkillRelationshipGraph(
            GetSkillRelationshipGraph {
                skill_id: center,
                filters: RelationshipGraphFilters::default(),
            },
        ))
        .await
        .expect("relationship graph");
    let AppQueryResult::SkillRelationshipGraph(graph) = graph else {
        panic!("expected relationship graph");
    };
    assert_eq!(graph.center_skill_id, center);
    assert!(graph.has_node("source:provenance:graph"));
    assert_eq!(
        graph.relationship_revision,
        candidates[0].relationship_revision
    );
    assert!(graph.last_verified_at.is_some());

    let filtered = facade
        .query(AppQuery::GetSkillRelationshipGraph(
            GetSkillRelationshipGraph {
                skill_id: center,
                filters: RelationshipGraphFilters {
                    relationship_types: vec![RelationshipType::ManagedCopy],
                    statuses: Vec::new(),
                },
            },
        ))
        .await
        .expect("filtered relationship graph");
    let AppQueryResult::SkillRelationshipGraph(filtered) = filtered else {
        panic!("expected filtered relationship graph");
    };
    assert!(!filtered.has_node("source:provenance:graph"));
    let database = facade.database_for_tests();
    let database = database.lock().expect("database");
    assert_eq!(
        database
            .relationship_repository()
            .relationship_revision()
            .unwrap()
            .to_string(),
        graph.relationship_revision,
        "read-only graph queries do not mutate relationship facts"
    );
}

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

/// Records a capability-guarded skip and tells the caller to give up.
///
/// `available` is the probed fact and `requirement` names what the scenario
/// needed, so a skip always says which capability was missing instead of just
/// disappearing.  See [`missing_symlink_capability`] for the rationale.
fn skip_or_continue_for_missing_capability(
    available: bool,
    requirement: &str,
    location: &std::panic::Location<'_>,
) -> bool {
    if available {
        return false;
    }
    assert!(
        std::env::var("SKILLHUB_REQUIRE_SYMLINK_CAPABILITY").as_deref() != Ok("1"),
        "{}:{}: this host was required to provide {requirement} capability, but the guarded \
         scenario would be skipped instead of executed (RC-15)",
        location.file(),
        location.line()
    );
    // Deliberately not `eprintln!`: libtest captures that for passing tests,
    // and an invisible skip is the defect this helper exists to remove.
    let _ = std::io::Write::write_all(
        &mut std::io::stderr(),
        format!(
            "SKILLHUB-TEST-SKIP; {}:{}; this host cannot create {requirement}, so the guarded \
             scenario is skipped and its assertions never run (RC-15)\n",
            location.file(),
            location.line()
        )
        .as_bytes(),
    );
    true
}

/// Whether the negative control asked this run to behave like a host without
/// directory-link capability.
fn link_capability_forced_off() -> bool {
    std::env::var("SKILLHUB_TEST_FORCE_NO_LINK_CAPABILITY").is_ok_and(|value| value.trim() == "1")
}

/// Whether a scenario whose fixture itself creates a **symbolic link** has to
/// give up on this host.
///
/// libtest has no runtime skip and reports a guarded early `return` as a pass,
/// and it also captures the Rust-level stdout/stderr of a passing test.  Those
/// two behaviours together are exactly how a host-dependent skip can end up
/// invisible *and* counted as evidence (RC-15), so no guard returns silently
/// any more: every skip is written straight to the process' stderr file
/// descriptor, which bypasses the per-test capture, and can then be counted in
/// any plain `cargo test` log with
///
/// ```text
/// grep -c '^SKILLHUB-TEST-SKIP;' <cargo-test-log>
/// ```
///
/// Two environment switches make the accounting checkable instead of trusted:
///
/// - `SKILLHUB_REQUIRE_SYMLINK_CAPABILITY=1` turns any skip into a hard
///   failure.  A green run under that switch proves the guarded scenarios
///   really executed, which is what makes `passed` / `ignored` self-consistent;
/// - `SKILLHUB_TEST_FORCE_NO_LINK_CAPABILITY=1` is the negative control that
///   forces the skipped path, so the wiring stays verifiable on a link-capable
///   host without editing code.
#[track_caller]
fn missing_symlink_capability() -> bool {
    let available = !link_capability_forced_off()
        && skillhub_adapters::deployment::DeploymentFilesystem::new()
            .available_capabilities()
            .symlink;
    skip_or_continue_for_missing_capability(
        available,
        "a symbolic link",
        std::panic::Location::caller(),
    )
}

/// Whether a scenario that only needs the conversion to be able to link *at
/// all* has to give up on this host.
///
/// The product refuses a conversion only when neither link kind is available
/// (`plan_relation_conversion` rejects the copy fallback), so a host that can
/// fall back to a junction — a Windows account without the symlink privilege —
/// still has to run these scenarios instead of skipping them.
#[track_caller]
fn missing_directory_link_capability() -> bool {
    let capabilities =
        skillhub_adapters::deployment::DeploymentFilesystem::new().available_capabilities();
    let available =
        !link_capability_forced_off() && (capabilities.symlink || capabilities.junction);
    skip_or_continue_for_missing_capability(
        available,
        "a symbolic link or a junction",
        std::panic::Location::caller(),
    )
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
    SharedReference {
        other_consumers: usize,
    },
    /// Task 12: orchestration-layer input only, NOT a product scenario.  The
    /// seeded fact claims `SharedDirectoryReference`, but the alias position
    /// is a plain directory copy (`FileRepresentation::Copy`) whose
    /// `link_target_path` still names the shared body.  Real shared
    /// references are symlink/junction entries; this shape exists solely so
    /// batch cases that only need the relationship FACTS can run on hosts
    /// without link privileges (RC-15) without staging a link themselves.
    /// The confirmation semantics behind such facts is anchored by the pure
    /// `plan_relation_conversion` tests in `skillhub-core`.
    SharedReferenceCopyAlias {
        other_consumers: usize,
    },
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
    // shared directory body.  The Task 12 orchestration shape imports the
    // shared body too, then stages a plain directory copy at the alias
    // position so no host link capability is needed to build the scenario.
    let shared_body = workspace.path().join("shared/skills/notes");
    let source = workspace.path().join("agent/skills/notes");
    let import_source = match &kind {
        RelationKind::SharedReference { .. } | RelationKind::SharedReferenceCopyAlias { .. } => {
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
    match &kind {
        RelationKind::SharedReference { .. } => {
            std::fs::create_dir_all(source.parent().expect("alias parent"))
                .expect("agent directory");
            create_dir_link_for_test(&shared_body, &source);
            shared_reference_fields = Some((
                skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&shared_body)
                    .expect("shared body fingerprint"),
                shared_body.clone(),
            ));
        }
        RelationKind::SharedReferenceCopyAlias { .. } => {
            // Task 12 orchestration shape: the alias position is a real
            // directory with the same body, so the seeded fact passes the
            // product's on-disk validations (`Copy` requires a non-symlink
            // directory whose tree hash matches) without ever creating a
            // link in the fixture.
            write_skill(&source);
        }
        _ => {}
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

    let other_alias = if let RelationKind::SharedReference { other_consumers }
    | RelationKind::SharedReferenceCopyAlias { other_consumers } = &kind
    {
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
            // The agent2 alias link is only materialized for scenarios that
            // assert on the real second alias; the confirmation trigger only
            // needs the active relation FACT below (Task 12).
            if matches!(&kind, RelationKind::SharedReference { .. }) {
                std::fs::create_dir_all(other_alias.parent().expect("other alias parent"))
                    .expect("agent2 directory");
                create_dir_link_for_test(&shared_body, &other_alias);
            }
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
            (RelationKind::SharedReferenceCopyAlias { .. }, _) => (
                // Task 12 orchestration-layer input, NOT a product scenario:
                // a `SharedDirectoryReference` fact whose alias position is a
                // real directory copy.  The product records symlink or
                // junction representations for shared references; this shape
                // only lets batch cases stage the relationship facts without
                // a host link, and the confirmation semantics stays anchored
                // by the pure planner tests in `skillhub-core`.
                RelationshipType::SharedDirectoryReference,
                FileRepresentation::Copy,
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
async fn import_copies_without_a_governance_confirmation_and_preserves_the_source() {
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

    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision: ImportGovernanceDecision {
                group_actions: BTreeMap::new(),
                item_overrides: BTreeMap::new(),
            },
            batch_id: None,
            candidate_key: None,
        }))
        .await
        .expect("an import does not govern the source during commit");

    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    assert!(summary.committed);
    assert_eq!(
        summary.items[0].status,
        skillhub_core::ImportItemStatus::Succeeded
    );
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
            batch_id: None,
            candidate_key: None,
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
            batch_id: None,
            candidate_key: None,
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    // 环境前提（Task 12，非缺陷）：本用例的主题就是“重指真实别名链接并保留
    // 共享主体”，夹具因此自行创建别名符号链接（create_dir_link_for_test），
    // 不经过产品的能力探测与回退。守卫下方显式声明这一前提：在无链接权限的
    // 宿主上按守卫跳过并输出原因（取证记入 RC-15），不影响其他用例；真实的
    // 共享引用产品路径仍由本用例在具备链接能力的主机上完整执行。
    if missing_symlink_capability() {
        return;
    }
    let fixture = fixture_with(RelationKind::SharedReference { other_consumers: 1 }).await;
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    if missing_symlink_capability() {
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
    // Since v19, `source_relations` is a read-only view over the immutable
    // `import_provenance_events_v19` table, so the race write targets the
    // event table (with its required batch row) directly.
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
                 INSERT OR IGNORE INTO import_batches (batch_id, status, started_at, finished_at)
                 VALUES ('legacy:provenance:concurrent', 'completed', 2, 2);
                 INSERT INTO import_provenance_events_v19 (
                     provenance_id, skill_id, directory_node_id, agent_client_id,
                     source_path, source_path_key, relationship, file_representation,
                     ownership, link_target_path, link_target_directory_id,
                     content_fingerprint, source_kind, source_locator, imported_at,
                     batch_id, source_class, local_source_path
                 )
                 SELECT 'provenance:concurrent', skill_id, NULL, agent_client_id,
                        path, path, 'import_copy', 'directory', 'observed_unmanaged',
                        NULL, NULL, content_fingerprint, 'local', path, 2,
                        'legacy:provenance:concurrent', 'legacy_unclassified', path
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
    if missing_symlink_capability() {
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
    // Compare path components instead of a literal string: a hardcoded "/"
    // would make this assertion a platform test rather than a contract test.
    assert!(std::path::Path::new(&member.source_path)
        .ends_with(std::path::Path::new("shared-skills").join("notes")));
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
            batch_id: None,
            candidate_key: None,
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
            batch_id: None,
            candidate_key: None,
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
            batch_id: None,
            candidate_key: None,
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

// ---------------------------------------------------------------------------
// Task 2 conflict resolution: workspace, explicit decisions, governance
// handoff and the operation journal behind each ending.
// ---------------------------------------------------------------------------

fn conflict_member(path: &str, fingerprint: &str) -> ConflictMemberFact {
    ConflictMemberFact {
        skill_id: None,
        version_id: None,
        provenance_id: None,
        directory_node_id: None,
        path: Some(path.to_owned()),
        fingerprint: Some(fingerprint.to_owned()),
    }
}

fn conflict_case(
    conflict_id: &str,
    classification: ConflictClassification,
    fingerprint: &str,
) -> ConflictCaseFact {
    ConflictCaseFact {
        conflict_id: conflict_id.to_owned(),
        kind: ConflictKind::SameNameDifferentContent,
        classification,
        member_skill_ids: Vec::new(),
        members: vec![
            conflict_member(&format!("/library/{conflict_id}"), fingerprint),
            conflict_member(
                &format!("/agents/{conflict_id}"),
                &format!("{fingerprint}-other"),
            ),
        ],
        evidence: ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: Some(IdentityDirection::Unknown),
            sufficient_identity_evidence: false,
        },
        user_decision: None,
        decided_at: None,
    }
}

fn analysis_record(
    conflict_id: &str,
    fingerprint: &str,
    action: ConflictAnalysisAction,
    analyzed_at: i64,
) -> ConflictAnalysisRecord {
    ConflictAnalysisRecord {
        record_id: format!("analysis:{conflict_id}:{analyzed_at}"),
        conflict_id: conflict_id.to_owned(),
        scope: AnalyzeConflictScope::Case {
            conflict_id: conflict_id.to_owned(),
        },
        input_fingerprint: fingerprint.to_owned(),
        baseline_classification: ConflictClassification::Uncertain,
        conclusion: Some(ConflictCaseAnalysis {
            conflict_id: conflict_id.to_owned(),
            baseline_classification: ConflictClassification::Uncertain,
            summary: "成员指纹不同，无法确认同一 Skill。".to_owned(),
            recommended_action: action,
            recommended_keep_member: None,
            key_evidence: vec!["fingerprints differ".to_owned()],
            uncertainties: Vec::new(),
            confidence: 30,
        }),
        source: DuplicateAnalysisSource::Llm,
        analyzed_at,
        failure_code: None,
        adopted_by_user: false,
    }
}

async fn conflict_workspace_of(facade: &LocalApplicationFacade) -> ConflictWorkspace {
    match facade
        .query(AppQuery::GetConflictWorkspace(GetConflictWorkspace))
        .await
        .expect("conflict workspace")
    {
        AppQueryResult::ConflictWorkspace(workspace) => workspace,
        other => panic!("expected conflict workspace, got {other:?}"),
    }
}

fn open_conflict_facade() -> (LocalApplicationFacade, tempfile::TempDir) {
    let database = Database::open_in_memory().expect("database");
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    (
        LocalApplicationFacade::new_with_library(database, &library_root),
        workspace,
    )
}

fn relationship_revision(facade: &LocalApplicationFacade) -> i64 {
    facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .relationship_repository()
        .relationship_revision()
        .expect("relationship revision")
}

/// Raw journal rows for one operation kind: `(phase, error_code)`.
fn conflict_resolution_journal(facade: &LocalApplicationFacade) -> Vec<(String, Option<String>)> {
    let handle = facade.database_for_tests();
    let database = handle.lock().expect("database lock");
    let mut statement = database
        .connection_for_test()
        .prepare(
            "SELECT phase, error_code FROM operations WHERE kind='conflict_resolution'
             ORDER BY created_at, operation_id",
        )
        .expect("prepare journal query");
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .expect("journal rows");
    rows.map(|row| row.expect("journal row")).collect()
}

#[tokio::test]
async fn conflict_workspace_lists_only_pending_cases_and_marks_stale_analysis() {
    let (facade, _workspace) = open_conflict_facade();
    let pending = conflict_case(
        "conflict:pending",
        ConflictClassification::Uncertain,
        "fp-a",
    );
    let scope = AnalyzeConflictScope::Case {
        conflict_id: "conflict:pending".to_owned(),
    };
    let fingerprint = build_conflict_analysis_input(&scope, std::slice::from_ref(&pending))
        .expect("analysis input")
        .fingerprint;
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&pending)
            .expect("pending case");
        let mut handled = conflict_case(
            "conflict:handled",
            ConflictClassification::Uncertain,
            "fp-h",
        );
        handled.user_decision = Some(ConflictClassification::DistinctSkill);
        handled.decided_at = Some(30);
        database
            .conflict_repository()
            .create_case(&handled)
            .expect("handled case");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:deterministic",
                ConflictClassification::DistinctSkill,
                "fp-d",
            ))
            .expect("deterministic case");
        database
            .conflict_analysis_repository()
            .insert_record(&analysis_record(
                "conflict:pending",
                &fingerprint,
                ConflictAnalysisAction::DistinctSkill,
                100,
            ))
            .expect("analysis record");
    }

    let revision_before = relationship_revision(&facade);
    let workspace = conflict_workspace_of(&facade).await;
    // 只读查询：不推进关系版本。
    assert_eq!(relationship_revision(&facade), revision_before);

    assert_eq!(workspace.cases.len(), 1);
    assert_eq!(workspace.cases[0].case.conflict_id, "conflict:pending");
    assert!(!workspace.cases[0].analysis_stale);
    assert_eq!(
        workspace.cases[0].recommended_decision,
        Some(ConflictDecision::KeepDistinct),
        "指纹未变时 AI 建议映射成明确动作"
    );
    assert_eq!(workspace.handled_count, 1);
    assert_eq!(workspace.handled[0].conflict_id, "conflict:handled");
    assert_eq!(
        workspace.handled[0].decision,
        ConflictDecision::KeepDistinct
    );
    assert_eq!(workspace.relationship_revision, revision_before.to_string());

    // 关系事实变化后，旧分析因输入指纹改变而过期。
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:pending",
                ConflictClassification::Uncertain,
                "fp-moved",
            ))
            .expect("updated pending case");
    }
    let stale = conflict_workspace_of(&facade).await;
    assert!(stale.cases[0].analysis_stale);
    assert_eq!(stale.cases[0].recommended_decision, None);
    assert!(stale.cases[0].latest_analysis.is_some());
}

#[tokio::test]
async fn manual_conflict_decision_needs_no_llm_and_is_auditable() {
    // 未配置 LLM / 未开启任何 LLM 能力：人工决定仍然可用。
    let (facade, _workspace) = open_conflict_facade();
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:pending",
                ConflictClassification::Uncertain,
                "fp-a",
            ))
            .expect("pending case");
        database
            .conflict_analysis_repository()
            .insert_record(&analysis_record(
                "conflict:pending",
                "sha256:whatever",
                ConflictAnalysisAction::DistinctSkill,
                100,
            ))
            .expect("analysis record");
    }

    let workspace = conflict_workspace_of(&facade).await;
    let revision_before = relationship_revision(&facade);
    let resolved = facade
        .execute(AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:pending".to_owned(),
            decision: ConflictDecision::KeepDistinct,
            expected_relationship_revision: workspace.relationship_revision.clone(),
        }))
        .await
        .expect("manual decision");
    let AppCommandResult::ConflictResolved(outcome) = resolved else {
        panic!("expected a conflict resolution outcome");
    };
    assert_eq!(outcome.conflict_id, "conflict:pending");
    assert_eq!(outcome.decision, ConflictDecision::KeepDistinct);
    assert_eq!(
        outcome.conclusion,
        Some(ConflictClassification::DistinctSkill)
    );
    assert!(outcome.decided_at.is_some());
    assert!(outcome.governance.is_none());
    assert!(outcome.relationship_revision.parse::<i64>().unwrap() > revision_before);

    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        let cases = database.conflict_repository().list_cases().expect("cases");
        assert_eq!(
            cases[0].user_decision,
            Some(ConflictClassification::DistinctSkill)
        );
        assert_eq!(cases[0].decided_at, outcome.decided_at);
        // 具体动作完成后才把分析记录标为已采纳：审计关联，而不是独立采纳状态。
        let records = database
            .conflict_analysis_repository()
            .list_records(Some("conflict:pending"))
            .expect("records");
        assert!(records.iter().all(|record| record.adopted_by_user));
    }

    // 决定后：待确认队列清空，冲突进入已处理历史。
    let after = conflict_workspace_of(&facade).await;
    assert!(after.cases.is_empty());
    assert_eq!(after.handled_count, 1);
    assert_eq!(after.handled[0].conflict_id, "conflict:pending");

    // 决定是一次可追溯的操作记录。
    assert_eq!(
        conflict_resolution_journal(&facade),
        vec![("committed".to_owned(), None)],
        "a completed decision is journaled as committed"
    );
}

#[tokio::test]
async fn a_decision_taken_on_stale_facts_is_refused_with_a_journaled_failure() {
    let (facade, _workspace) = open_conflict_facade();
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:pending",
                ConflictClassification::Uncertain,
                "fp-a",
            ))
            .expect("pending case");
    }
    let stale_revision = conflict_workspace_of(&facade)
        .await
        .relationship_revision
        .clone();

    // 关系事实在用户阅读工作台之后发生了变化。
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:other",
                ConflictClassification::Uncertain,
                "fp-b",
            ))
            .expect("another case moves the revision");
    }

    let error = facade
        .execute(AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:pending".to_owned(),
            decision: ConflictDecision::ConfirmSameSkill,
            expected_relationship_revision: stale_revision,
        }))
        .await
        .expect_err("a stale workspace revision must refuse the decision");
    assert_eq!(error.code, ErrorCode::OperationConflict);

    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        let cases = database.conflict_repository().list_cases().expect("cases");
        assert!(
            cases.iter().all(|case| case.user_decision.is_none()),
            "过期事实上的决定不写任何裁决"
        );
    }
    assert_eq!(
        conflict_resolution_journal(&facade),
        vec![(
            "rolled_back".to_owned(),
            Some("operation.conflict".to_owned())
        )],
        "a refused decision still leaves a traceable failure record"
    );

    // 重新读取工作台后即可在最新事实上决定。
    let fresh = conflict_workspace_of(&facade).await;
    let resolved = facade
        .execute(AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:pending".to_owned(),
            decision: ConflictDecision::ConfirmSameSkill,
            expected_relationship_revision: fresh.relationship_revision.clone(),
        }))
        .await
        .expect("decision on fresh facts");
    let AppCommandResult::ConflictResolved(outcome) = resolved else {
        panic!("expected a conflict resolution outcome");
    };
    assert_eq!(
        outcome.conclusion,
        Some(ConflictClassification::SameSkillVersion)
    );
}

#[tokio::test]
async fn repeating_the_same_decision_is_idempotent_and_a_conflicting_one_is_refused() {
    let (facade, _workspace) = open_conflict_facade();
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:pending",
                ConflictClassification::Uncertain,
                "fp-a",
            ))
            .expect("pending case");
    }
    let revision = conflict_workspace_of(&facade)
        .await
        .relationship_revision
        .clone();
    let request = |decision: ConflictDecision| {
        AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:pending".to_owned(),
            decision,
            expected_relationship_revision: revision.clone(),
        })
    };

    let first = facade
        .execute(request(ConflictDecision::KeepDistinct))
        .await;
    let AppCommandResult::ConflictResolved(first) = first.expect("first decision") else {
        panic!("expected a conflict resolution outcome");
    };
    let revision_after_first = relationship_revision(&facade);

    // 同一决定的并发/重复提交按幂等处理：不写第二条事实，也不推进版本。
    let replay = facade
        .execute(request(ConflictDecision::KeepDistinct))
        .await
        .expect("idempotent replay");
    let AppCommandResult::ConflictResolved(replay) = replay else {
        panic!("expected a conflict resolution outcome");
    };
    assert_eq!(replay.decided_at, first.decided_at);
    assert_eq!(replay.conclusion, first.conclusion);
    assert_eq!(
        relationship_revision(&facade),
        revision_after_first,
        "an idempotent replay writes no new relationship fact"
    );

    // 用另一个决定覆盖已有裁决被拒绝。
    let error = facade
        .execute(request(ConflictDecision::ConfirmSameSkill))
        .await
        .expect_err("a conflicting decision must be refused");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    // 三次提交各自留下记录：两次完成、一次被拒绝（同一秒内顺序不保证）。
    let mut phases: Vec<String> = conflict_resolution_journal(&facade)
        .into_iter()
        .map(|(phase, _)| phase)
        .collect();
    phases.sort();
    assert_eq!(
        phases,
        vec![
            "committed".to_owned(),
            "committed".to_owned(),
            "rolled_back".to_owned()
        ]
    );
}

#[tokio::test]
async fn centralize_management_hands_the_relation_to_governance_without_touching_a_file() {
    let (facade, _workspace) = open_conflict_facade();
    let relation_path = "/agents/conflict:pending";
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:pending",
                ConflictClassification::Uncertain,
                "fp-a",
            ))
            .expect("pending case");
        database
            .relationship_repository()
            .upsert_deployment_relation(&DeploymentRelationFact {
                relation_id: "relation:managed-copy".to_owned(),
                skill_id: None,
                agent_client_id: "trae.code".to_owned(),
                path: relation_path.to_owned(),
                path_key: String::new(),
                directory_node_id: None,
                relationship: RelationshipType::ManagedCopy,
                file_representation: FileRepresentation::Copy,
                ownership: OwnershipState::SkillhubManaged,
                link_target_path: None,
                link_target_path_key: None,
                link_target_directory_id: None,
                content_fingerprint: "sha256:copy".to_owned(),
                origin: ObservedOrigin::Scan,
                match_state: ObservedMatchState::ContentVerified,
                active: true,
                observed_at: 5,
                released_at: None,
            })
            .expect("deployment relation");
    }

    let workspace = conflict_workspace_of(&facade).await;
    let revision_before = relationship_revision(&facade);
    let resolved = facade
        .execute(AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:pending".to_owned(),
            decision: ConflictDecision::CentralizeManagement,
            expected_relationship_revision: workspace.relationship_revision.clone(),
        }))
        .await
        .expect("governance handoff");
    let AppCommandResult::ConflictResolved(outcome) = resolved else {
        panic!("expected a conflict resolution outcome");
    };

    let handoff = outcome.governance.expect("governance handoff");
    assert_eq!(handoff.conflict_id, "conflict:pending");
    assert_eq!(
        handoff.relation_id.as_deref(),
        Some("relation:managed-copy")
    );
    assert_eq!(
        handoff.intent,
        ConflictGovernanceIntent::CentralizeManagement
    );
    // 只写结论的动作才写结论：文件类动作不写裁决、不动关系事实。
    assert_eq!(outcome.conclusion, None);
    assert_eq!(outcome.decided_at, None);
    assert!(!std::path::Path::new(relation_path).exists());
    assert_eq!(relationship_revision(&facade), revision_before);

    let after = conflict_workspace_of(&facade).await;
    assert_eq!(after.cases.len(), 1, "冲突在治理执行前仍然待确认");
    assert!(after.handled.is_empty());
    assert_eq!(after.handled_count, 0, "纳入集中库管理不计入累计处理数");
    assert_eq!(
        conflict_resolution_journal(&facade),
        vec![("committed".to_owned(), None)]
    );
}

#[tokio::test]
async fn centralize_management_reports_no_relation_instead_of_inventing_one() {
    let (facade, _workspace) = open_conflict_facade();
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        database
            .conflict_repository()
            .create_case(&conflict_case(
                "conflict:pending",
                ConflictClassification::Uncertain,
                "fp-a",
            ))
            .expect("pending case");
    }
    let workspace = conflict_workspace_of(&facade).await;
    let resolved = facade
        .execute(AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:pending".to_owned(),
            decision: ConflictDecision::CentralizeManagement,
            expected_relationship_revision: workspace.relationship_revision.clone(),
        }))
        .await
        .expect("governance handoff");
    let AppCommandResult::ConflictResolved(outcome) = resolved else {
        panic!("expected a conflict resolution outcome");
    };
    let handoff = outcome.governance.expect("governance handoff");
    assert_eq!(handoff.relation_id, None);
}

#[tokio::test]
async fn deciding_an_unknown_conflict_fails_with_a_journaled_failure() {
    let (facade, _workspace) = open_conflict_facade();
    let error = facade
        .execute(AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:missing".to_owned(),
            decision: ConflictDecision::KeepDistinct,
            expected_relationship_revision: "0".to_owned(),
        }))
        .await
        .expect_err("an unknown conflict cannot be decided");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
    assert_eq!(
        conflict_resolution_journal(&facade),
        vec![(
            "rolled_back".to_owned(),
            Some("object.not_found".to_owned())
        )]
    );
}

// ---------------------------------------------------------------------------
// Task 3: relationship governance ledger + batch orchestration
// ---------------------------------------------------------------------------

struct BatchFixture {
    _workspace: tempfile::TempDir,
    facade: LocalApplicationFacade,
    /// `(relation_id, agent entry path)`, in insertion order.
    entries: Vec<(String, std::path::PathBuf)>,
}

/// Several agents each holding their own content-verified copy of one Skill.
/// Every copy matches the central-library body, so each edge is independently
/// convertible.
async fn batch_fixture(agents: &[&str]) -> BatchFixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let database = Database::open(workspace.path().join("db.sqlite")).expect("database");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    let first_entry = workspace.path().join(format!("{}/skills/notes", agents[0]));
    write_skill(&first_entry);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: first_entry.to_string_lossy().into_owned(),
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

    let database_handle = facade.database_for_tests();
    let mut entries = Vec::new();
    for agent in agents {
        let directory = workspace.path().join(format!("{agent}/skills"));
        let entry = directory.join("notes");
        if !entry.exists() {
            write_skill(&entry);
        }
        let fingerprint = skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&entry)
            .expect("entry fingerprint");
        let database = database_handle.lock().expect("database lock");
        database
            .directory_repository()
            .upsert_node(&DirectoryNodeFact {
                node_id: format!("directory:{agent}"),
                path: directory.to_string_lossy().into_owned(),
                path_key: String::new(),
                role: DirectoryRole::AgentNative,
                profile_id: None,
                agent_client_id: Some((*agent).to_owned()),
                exists: true,
                observed_at: 1,
                scan_source: Some("test".into()),
            })
            .expect("directory node");
        database
            .relationship_repository()
            .upsert_capability(&AgentDirectoryCapabilityFact {
                agent_client_id: (*agent).to_owned(),
                directory_node_id: format!("directory:{agent}"),
                recognition: DirectoryRecognition::Supported,
                precedence: DirectoryPrecedence::Preferred,
                evidence_reference: Some("fixture".into()),
                researched_at: Some("2026-09-16".into()),
                applicable_platforms: vec!["windows".into(), "macos".into()],
            })
            .expect("directory capability");
        let relation_id = format!("observed:{agent}:notes");
        database
            .relationship_repository()
            .upsert_deployment_relation(&DeploymentRelationFact {
                relation_id: relation_id.clone(),
                skill_id: Some(skill_id),
                agent_client_id: (*agent).to_owned(),
                path: entry.to_string_lossy().into_owned(),
                path_key: String::new(),
                directory_node_id: Some(format!("directory:{agent}")),
                relationship: RelationshipType::ManagedCopy,
                file_representation: FileRepresentation::Copy,
                ownership: OwnershipState::SkillhubManaged,
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
        drop(database);
        entries.push((relation_id, entry));
    }

    BatchFixture {
        _workspace: workspace,
        facade,
        entries,
    }
}

impl BatchFixture {
    fn relation_id(&self, index: usize) -> String {
        self.entries[index].0.clone()
    }

    fn entry(&self, index: usize) -> &std::path::Path {
        &self.entries[index].1
    }

    fn set_match_state(&self, relation_id: &str, state: ObservedMatchState) {
        let handle = self.facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        let repository = database.relationship_repository();
        let mut relation = repository
            .list_relations()
            .expect("relations")
            .into_iter()
            .find(|relation| relation.relation_id == relation_id)
            .expect("seeded relation");
        relation.match_state = state;
        repository
            .upsert_deployment_relation(&relation)
            .expect("update relation");
    }

    fn entry_is_symlink(&self, index: usize) -> bool {
        std::fs::symlink_metadata(self.entry(index))
            .expect("agent entry")
            .file_type()
            .is_symlink()
    }
}

async fn governance_ledger(
    facade: &LocalApplicationFacade,
    filters: RelationGovernanceFilters,
) -> skillhub_core::relationship::RelationGovernanceLedger {
    let result = facade
        .query(AppQuery::ListRelationGovernance(ListRelationGovernance {
            filters,
        }))
        .await
        .expect("governance ledger");
    let AppQueryResult::RelationGovernanceLedger(ledger) = result else {
        panic!("expected governance ledger");
    };
    ledger
}

fn batch_outcome(result: AppCommandResult) -> RelationGovernanceBatchOutcome {
    let AppCommandResult::RelationGovernanceBatch(outcome) = result else {
        panic!("expected a governance batch outcome");
    };
    outcome
}

fn batch_item<'a>(
    outcome: &'a RelationGovernanceBatchOutcome,
    relation_id: &str,
) -> &'a skillhub_core::api::RelationGovernanceBatchItem {
    outcome
        .items
        .iter()
        .find(|item| item.relation_id == relation_id)
        .unwrap_or_else(|| panic!("batch item for {relation_id}"))
}

/// Reads the durable parent operation row: `(kind, phase, progress json)`.
fn governance_batch_operation_row(
    facade: &LocalApplicationFacade,
    batch_id: skillhub_core::OperationId,
) -> (String, String, Value) {
    let handle = facade.database_for_tests();
    let database = handle.lock().expect("database lock");
    let (kind, phase, progress): (String, String, String) = database
        .connection_for_test()
        .query_row(
            "SELECT kind, phase, progress_json FROM operations WHERE operation_id=?1",
            [batch_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("governance batch operation row");
    (
        kind,
        phase,
        serde_json::from_str(&progress).expect("batch progress json"),
    )
}

fn operation_kind(
    facade: &LocalApplicationFacade,
    operation_id: skillhub_core::OperationId,
) -> Option<String> {
    let handle = facade.database_for_tests();
    let database = handle.lock().expect("database lock");
    database
        .connection_for_test()
        .query_row(
            "SELECT kind FROM operations WHERE operation_id=?1",
            [operation_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

async fn prepare_batch(
    facade: &LocalApplicationFacade,
    relation_ids: Vec<String>,
    confirmations: Vec<(String, String)>,
) -> RelationGovernanceBatchOutcome {
    batch_outcome(
        facade
            .execute(AppCommand::PrepareRelationGovernanceBatch(
                PrepareRelationGovernanceBatch {
                    action: RelationGovernanceBatchAction::CentralizeManagement,
                    relation_ids,
                    confirmations: confirmations.into_iter().collect(),
                },
            ))
            .await
            .expect("prepare governance batch"),
    )
}

#[tokio::test]
async fn governance_ledger_query_is_read_only_and_groups_edges_by_relationship() {
    let fixture = batch_fixture(&["agent.demo", "agent.other"]).await;
    let revision_before = relationship_revision(&fixture.facade);

    let all = governance_ledger(&fixture.facade, RelationGovernanceFilters::default()).await;
    assert_eq!(all.rows.len(), 2, "one row per relationship edge");
    assert_eq!(all.counts.all, 2);
    assert_eq!(all.counts.eligible_to_centralize, 2);
    assert_eq!(all.counts.blocked, 0);
    assert!(all
        .rows
        .iter()
        .all(|row| row.readiness == RelationGovernanceReadiness::EligibleToCentralize));
    assert!(all.rows.iter().all(|row| row.blockers.is_empty()));
    assert_eq!(all.rows[0].skill_display_name.as_deref(), Some("Notes"));
    assert_eq!(all.rows[0].path(), fixture.entry(0).to_string_lossy());
    assert_eq!(
        all.rows[0].relationship(),
        Some(RelationshipType::ManagedCopy)
    );

    // 四个筛选是同一份清单的快捷筛选：计数始终描述整份清单。
    let blocked = governance_ledger(
        &fixture.facade,
        RelationGovernanceFilters {
            bucket: RelationGovernanceBucket::Blocked,
            ..Default::default()
        },
    )
    .await;
    assert!(blocked.rows.is_empty());
    assert_eq!(blocked.counts.all, 2);

    // 按关系边筛选，而不是复制一份 Skill 列表。
    let by_agent = governance_ledger(
        &fixture.facade,
        RelationGovernanceFilters {
            agent_client_id: Some("agent.other".into()),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(by_agent.rows.len(), 1);
    assert_eq!(by_agent.rows[0].relation_id(), fixture.relation_id(1));

    assert_eq!(
        relationship_revision(&fixture.facade),
        revision_before,
        "reading the governance ledger never writes a relationship fact"
    );
}

#[tokio::test]
async fn governance_batch_blocks_unverified_rows_and_keeps_the_executable_ones() {
    let fixture = batch_fixture(&["agent.demo", "agent.other"]).await;
    let stale = fixture.relation_id(1);
    fixture.set_match_state(&stale, ObservedMatchState::NameOnly);

    let outcome = prepare_batch(
        &fixture.facade,
        vec![fixture.relation_id(0), stale.clone()],
        Vec::new(),
    )
    .await;

    assert_eq!(outcome.state, RelationGovernanceBatchState::Prepared);
    assert_eq!(outcome.prepared_count, 1);
    assert_eq!(outcome.blocked_count, 1);
    assert_eq!(
        batch_item(&outcome, &fixture.relation_id(0)).state,
        RelationGovernanceBatchItemState::Prepared
    );
    let blocked = batch_item(&outcome, &stale);
    assert_eq!(blocked.state, RelationGovernanceBatchItemState::Blocked);
    assert_eq!(
        blocked.blockers,
        vec![RelationGovernanceBlocker::VerificationNotCurrent]
    );
    assert_eq!(blocked.error_code, Some(ErrorCode::OperationConflict));
    assert!(
        !blocked.retryable,
        "a fact-level block is not retryable as-is"
    );
    assert_eq!(blocked.operation_id, None);
    assert!(
        !fixture.entry_is_symlink(1),
        "a blocked row never touches the filesystem"
    );
}

#[tokio::test]
async fn governance_batch_cancelling_one_row_leaves_the_others_untouched() {
    if missing_symlink_capability() {
        return;
    }
    let fixture = batch_fixture(&["agent.demo", "agent.other"]).await;
    let kept = fixture.relation_id(0);
    let cancelled = fixture.relation_id(1);
    let prepared = prepare_batch(
        &fixture.facade,
        vec![kept.clone(), cancelled.clone()],
        Vec::new(),
    )
    .await;
    assert_eq!(prepared.prepared_count, 2);

    let committed = batch_outcome(
        fixture
            .facade
            .execute(AppCommand::CommitRelationGovernanceBatch(
                CommitRelationGovernanceBatch {
                    batch_id: prepared.batch_id,
                    relation_ids: vec![kept.clone()],
                },
            ))
            .await
            .expect("commit governance batch"),
    );

    assert_eq!(committed.state, RelationGovernanceBatchState::Committed);
    assert_eq!(committed.committed_count, 1);
    assert_eq!(committed.cancelled_count, 1);
    assert_eq!(
        batch_item(&committed, &kept).state,
        RelationGovernanceBatchItemState::Committed
    );
    assert_eq!(
        batch_item(&committed, &cancelled).state,
        RelationGovernanceBatchItemState::Cancelled
    );
    assert!(fixture.entry_is_symlink(0), "the kept row was centralized");
    assert!(
        !fixture.entry_is_symlink(1),
        "cancelling a row does not convert it"
    );
}

#[tokio::test]
async fn governance_batch_partial_failure_keeps_successes_with_per_item_retry_info() {
    if missing_symlink_capability() {
        return;
    }
    let fixture = batch_fixture(&["agent.demo", "agent.other"]).await;
    let kept = fixture.relation_id(0);
    let drifting = fixture.relation_id(1);
    let prepared = prepare_batch(
        &fixture.facade,
        vec![kept.clone(), drifting.clone()],
        Vec::new(),
    )
    .await;
    assert_eq!(prepared.prepared_count, 2);

    // The second edge's content moves after the plan was made.  The batch must
    // re-check it per row instead of trusting the earlier plan.
    std::fs::write(fixture.entry(1).join("SKILL.md"), "# Notes\n\nchanged\n").expect("drift");

    let committed = batch_outcome(
        fixture
            .facade
            .execute(AppCommand::CommitRelationGovernanceBatch(
                CommitRelationGovernanceBatch {
                    batch_id: prepared.batch_id,
                    relation_ids: vec![kept.clone(), drifting.clone()],
                },
            ))
            .await
            .expect("commit governance batch"),
    );

    assert_eq!(
        committed.state,
        RelationGovernanceBatchState::PartiallyCommitted,
        "a partial failure is never summarised as success"
    );
    assert_eq!(committed.committed_count, 1);
    assert_eq!(committed.failed_count, 1);
    assert_eq!(
        batch_item(&committed, &kept).state,
        RelationGovernanceBatchItemState::Committed
    );
    assert!(fixture.entry_is_symlink(0), "the successful row is kept");

    let failed = batch_item(&committed, &drifting);
    assert_eq!(failed.state, RelationGovernanceBatchItemState::Failed);
    assert_eq!(failed.error_code, Some(ErrorCode::TargetChanged));
    assert!(
        failed.retryable,
        "the failing row can be retried on its own"
    );
    assert!(
        !fixture.entry_is_symlink(1),
        "the drifting row keeps its original entry"
    );

    // 逐项回退信息：成功项仍可单独回退。
    let rolled_back = batch_outcome(
        fixture
            .facade
            .execute(AppCommand::RollbackRelationGovernanceBatch(
                RollbackRelationGovernanceBatch {
                    batch_id: prepared.batch_id,
                    relation_ids: vec![kept.clone()],
                },
            ))
            .await
            .expect("rollback governance batch"),
    );
    assert_eq!(
        batch_item(&rolled_back, &kept).state,
        RelationGovernanceBatchItemState::RolledBack
    );
    assert!(
        !fixture.entry_is_symlink(0),
        "the rolled-back row is restored to its original entry"
    );
}

#[tokio::test]
async fn governance_batch_requires_the_shared_impact_confirmation_per_row() {
    // Task 12: this case proves batch orchestration cannot bypass the
    // shared-impact confirmation.  That rule is decided purely by the
    // relationship facts (`SharedDirectoryReference` with other shared
    // consumers > 0 — anchored by the pure `plan_relation_conversion` tests
    // in skillhub-core), so the scenario needs no real alias link on disk.
    // The fixture shape below is an orchestration-layer input, not a product
    // scenario: the alias position is a real directory copy whose fact still
    // names the shared body as its link target.  Real linked shared
    // references stay covered by
    // `shared_reference_conversion_repoints_one_alias_and_keeps_the_shared_body`.
    // Note the confirmed row reaching `Prepared` also proves on-disk honesty:
    // prepare's `validate_relation_entity` for `Copy` rejects symlink alias
    // positions, so the assertion below can only hold when the fixture staged
    // a real directory and never created a link.
    //
    // RC-16: the confirmed row is asserted to reach `Prepared` again.  The
    // link-free fixture removes the alias-creation premise, but a conversion
    // still has to link at the relation's own volume, so a host that can
    // create neither link kind is an explicit, counted skip rather than a
    // quietly weaker assertion.
    if missing_directory_link_capability() {
        return;
    }
    let fixture = fixture_with(RelationKind::SharedReferenceCopyAlias { other_consumers: 1 }).await;
    let relation_id = fixture.relation_id.clone();

    // The staged scenario must be link-free by construction: `symlink_metadata`
    // does not follow links, so `is_dir` proves a real directory at the alias
    // position, and no second-alias entry may exist at all.  This keeps the
    // green result independent of host link capability on every platform.
    let alias_metadata = std::fs::symlink_metadata(&fixture.source).expect("alias metadata");
    assert!(
        alias_metadata.is_dir(),
        "the orchestration fixture must stage a real directory at the alias position, not a link"
    );
    assert!(
        !fixture._workspace.path().join("agent2").exists(),
        "the link-free shape must not stage a second alias entry"
    );

    let unconfirmed = prepare_batch(&fixture.facade, vec![relation_id.clone()], Vec::new()).await;
    assert_eq!(unconfirmed.prepared_count, 0);
    assert_eq!(unconfirmed.blocked_count, 1);
    let blocked = batch_item(&unconfirmed, &relation_id);
    assert_eq!(blocked.state, RelationGovernanceBatchItemState::Blocked);
    assert_eq!(
        blocked.blockers,
        vec![RelationGovernanceBlocker::SharedImpactConfirmationRequired]
    );

    // 提供该行的确认令牌后，确认阻塞必须消失，且该行必须真的走到 `Prepared`
    // ——这是 RC-16 恢复的原始断言。夹具按构造不创建链接（别名位置是真实目录，
    // 校验用 `symlink_metadata` 判定），因此只有「父目录所在卷确实无法创建
    // 链接」才会让该行落到 Failed；那种宿主必须显式跳过，不能把「没进入
    // `Prepared`」当作通过。
    let confirmed = prepare_batch(
        &fixture.facade,
        vec![relation_id.clone()],
        vec![(relation_id.clone(), "confirmed".into())],
    )
    .await;
    assert_eq!(confirmed.blocked_count, 0);
    assert_eq!(
        confirmed.prepared_count, 1,
        "the confirmed row must be executed, not merely unblocked: {confirmed:?}"
    );
    assert_eq!(
        batch_item(&confirmed, &relation_id).state,
        RelationGovernanceBatchItemState::Prepared
    );
    assert!(
        !batch_item(&confirmed, &relation_id)
            .blockers
            .contains(&RelationGovernanceBlocker::SharedImpactConfirmationRequired),
        "a supplied confirmation token must remove the confirmation blocker"
    );
}

#[tokio::test]
async fn governance_batch_log_links_the_parent_to_each_child_operation() {
    let fixture = batch_fixture(&["agent.demo", "agent.other"]).await;
    let first = fixture.relation_id(0);
    let second = fixture.relation_id(1);
    let prepared = prepare_batch(
        &fixture.facade,
        vec![first.clone(), second.clone()],
        Vec::new(),
    )
    .await;

    let (kind, phase, progress) =
        governance_batch_operation_row(&fixture.facade, prepared.batch_id);
    assert_eq!(kind, "relation_governance_batch");
    assert_eq!(phase, "prepared");

    let children = progress["recovery_data"]["children"]
        .as_array()
        .expect("recovery children");
    assert_eq!(children.len(), 2);
    let mut child_operation_ids = Vec::new();
    for relation_id in [&first, &second] {
        let child = children
            .iter()
            .find(|child| child["relation_id"] == Value::String(relation_id.clone()))
            .unwrap_or_else(|| panic!("child for {relation_id}"));
        let operation_id: skillhub_core::OperationId = child["operation_id"]
            .as_str()
            .expect("child operation id")
            .parse()
            .expect("operation id");
        child_operation_ids.push(operation_id);
    }

    let object_results = progress["object_results"]
        .as_array()
        .expect("object results");
    assert_eq!(object_results.len(), 2);
    for relation_id in [&first, &second] {
        assert!(
            object_results
                .iter()
                .any(|result| result["object_id"] == Value::String(relation_id.clone())),
            "the batch log names every item it orchestrates"
        );
    }
    for operation_id in child_operation_ids {
        assert_eq!(
            operation_kind(&fixture.facade, operation_id).as_deref(),
            Some("migrate_relation"),
            "each child is the same single-relation operation the page uses"
        );
    }
}

#[tokio::test]
async fn concurrent_governance_batch_commits_do_not_bypass_the_relation_lock() {
    if missing_symlink_capability() {
        return;
    }
    let fixture = batch_fixture(&["agent.demo"]).await;
    let relation_id = fixture.relation_id(0);
    let prepared = prepare_batch(&fixture.facade, vec![relation_id.clone()], Vec::new()).await;
    let batch_id = prepared.batch_id;
    let facade = &fixture.facade;
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("first runtime");
            runtime.block_on(facade.execute(AppCommand::CommitRelationGovernanceBatch(
                CommitRelationGovernanceBatch {
                    batch_id,
                    relation_ids: vec![relation_id.clone()],
                },
            )))
        });
        let second = scope.spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("second runtime");
            runtime.block_on(facade.execute(AppCommand::CommitRelationGovernanceBatch(
                CommitRelationGovernanceBatch {
                    batch_id,
                    relation_ids: vec![relation_id.clone()],
                },
            )))
        });
        (
            first.join().expect("first batch thread"),
            second.join().expect("second batch thread"),
        )
    });

    let first = batch_outcome(first.expect("first batch commit"));
    let second = batch_outcome(second.expect("second batch commit"));
    assert_eq!(first.committed_count, 1);
    assert_eq!(second.committed_count, 1);
    assert_eq!(
        batch_item(&first, &relation_id).operation_id,
        batch_item(&second, &relation_id).operation_id,
        "the same child operation is serialized, not executed twice"
    );
    assert!(fixture.entry_is_symlink(0));
    assert_eq!(
        std::fs::read_to_string(fixture.entry(0).join("SKILL.md")).expect("centralized body"),
        BODY
    );
}

#[tokio::test]
async fn governance_batch_rejects_an_empty_selection() {
    let fixture = batch_fixture(&["agent.demo"]).await;
    let error = fixture
        .facade
        .execute(AppCommand::PrepareRelationGovernanceBatch(
            PrepareRelationGovernanceBatch {
                action: RelationGovernanceBatchAction::CentralizeManagement,
                relation_ids: Vec::new(),
                confirmations: Default::default(),
            },
        ))
        .await
        .expect_err("a batch needs at least one relationship edge");
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

mod unified_and_history {
    //! Task 7 集成验收：统一清单同表呈现来源副本与部署边（7.2/7.8），
    //! batch_id 过滤只命中 import_batch_items 映射关系（7.3），批次约束在
    //! prepare 前整体拒绝（7.5），治理历史是独立分页查询且只读写入时固化
    //! 的显示快照（7.10）。

    use skillhub_core::api::{ListGovernanceHistory, PrepareRelationGovernanceBatch};
    use skillhub_core::import::{ImportCandidate, ImportDecision};
    use skillhub_core::relationship::GovernableRelationStatus;
    use skillhub_core::{AppCommandResult, AppQueryResult};

    use super::*;

    pub(super) async fn import_source_copy(
        facade: &LocalApplicationFacade,
        root: &std::path::Path,
        name: &str,
    ) -> String {
        let candidate = ImportCandidate::detected(
            SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root)),
            root.to_string_lossy(),
            ".",
            "SKILL.md",
            name,
        );
        let prepared = facade
            .execute(AppCommand::PrepareImport(skillhub_core::PrepareImport {
                candidate,
                tree_hash: None,
            }))
            .await
            .expect("prepared import");
        let AppCommandResult::PreparedImport(prepared) = prepared else {
            panic!("expected prepared import");
        };
        let committed = facade
            .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
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
        // 关系 id：来源副本清单行以 import 产生的活动关系为准。
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        let relations = database
            .relationship_repository()
            .list_source_copy_relations(true)
            .expect("source copy relations");
        relations
            .iter()
            .find(|relation| relation.source_path == root.to_string_lossy())
            .unwrap_or_else(|| panic!("relation for {}", root.display()))
            .relation_id
            .clone()
    }

    #[tokio::test]
    async fn unified_ledger_lists_imported_source_copies_beside_deployments() {
        let fixture = fixture().await;
        let sources = tempfile::tempdir().expect("sources");
        let source = sources.path().join("imported-src");
        write_skill(&source);
        let copy_relation_id = import_source_copy(&fixture.facade, &source, "Imported").await;

        let ledger = governance_ledger(&fixture.facade, RelationGovernanceFilters::default()).await;
        let ids = ledger
            .rows
            .iter()
            .map(|row| row.relation_id().to_owned())
            .collect::<Vec<_>>();
        assert!(
            ids.contains(&copy_relation_id),
            "source copy rows join the unified ledger: {ids:?}"
        );
        assert_eq!(ledger.counts.source_copies, 1);
        assert_eq!(ledger.counts.deployments, 1);
        assert!(ledger.counts.all >= 2);

        // 五状态计数与行状态一致：来源副本导入后为 Normal。
        assert!(ledger.counts.status_normal >= 1);
        let copy_row = ledger
            .rows
            .iter()
            .find(|row| row.relation_id() == copy_relation_id)
            .expect("copy row");
        assert_eq!(copy_row.status, GovernableRelationStatus::Normal);

        // 状态过滤只命中对应行。
        let filters = RelationGovernanceFilters {
            statuses: vec![GovernableRelationStatus::Normal],
            ..RelationGovernanceFilters::default()
        };
        let filtered = governance_ledger(&fixture.facade, filters).await;
        assert!(filtered
            .rows
            .iter()
            .all(|row| row.status == GovernableRelationStatus::Normal));
    }

    #[tokio::test]
    async fn batch_id_filter_only_hits_relations_mapped_by_the_import_batch() {
        let fixture = fixture().await;
        let sources = tempfile::tempdir().expect("sources");
        let source = sources.path().join("batched-src");
        write_skill(&source);
        let copy_relation_id = import_source_copy(&fixture.facade, &source, "Batched").await;

        // 另一个 import 产生第二个批次与关系。
        let other = sources.path().join("other-src");
        write_skill(&other);
        let other_relation_id = import_source_copy(&fixture.facade, &other, "Other").await;

        let database = fixture.facade.database_for_tests().clone();
        let first_batch = {
            let database = database.lock().expect("database lock");
            let mut statement = database
                .connection_for_test()
                .prepare(
                    "SELECT DISTINCT batch_id FROM import_batch_items WHERE source_relation_id = ?1",
                )
                .expect("batch lookup");
            let found: String = statement
                .query_row([&copy_relation_id], |row| row.get(0))
                .expect("batch for the first import");
            found
        };

        let filters = RelationGovernanceFilters {
            batch_id: Some(first_batch),
            ..RelationGovernanceFilters::default()
        };
        let ledger = governance_ledger(&fixture.facade, filters).await;
        let ids = ledger
            .rows
            .iter()
            .map(|row| row.relation_id().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec![copy_relation_id]);
        assert!(!ids.contains(&other_relation_id));
    }

    #[tokio::test]
    async fn governance_batch_rejects_duplicate_relation_ids_before_prepare() {
        let fixture = fixture().await;
        let relation_id = fixture.relation_id.clone();
        let error = fixture
            .facade
            .execute(AppCommand::PrepareRelationGovernanceBatch(
                PrepareRelationGovernanceBatch {
                    action: RelationGovernanceBatchAction::CentralizeManagement,
                    relation_ids: vec![relation_id.clone(), relation_id],
                    confirmations: BTreeMap::new(),
                },
            ))
            .await
            .expect_err("duplicate ids are rejected");
        assert_eq!(
            error.code.as_str(),
            skillhub_core::ErrorCode::InvalidInput.as_str()
        );
    }

    #[tokio::test]
    async fn governance_history_is_a_paged_display_snapshot_query() {
        let fixture = fixture().await;
        let now = 1_700_000_000i64;
        let relation_id = fixture.relation_id.clone();
        let seed = |event_id: &str, result: &str, occurred_at: i64| {
            let database = fixture.facade.database_for_tests().clone();
            let database = database.lock().expect("database lock");
            skillhub_storage::GovernanceHistoryRepository::append(
                &database.governance_history_repository(),
                &skillhub_storage::GovernanceHistoryEvent {
                    event_id: event_id.to_owned(),
                    relation_id: relation_id.clone(),
                    skill_id: Some(fixture.skill_id.to_string()),
                    skill_display_name: "Notes".to_owned(),
                    agent_presentation: serde_json::json!({"client_id": "codebuddy.code"}),
                    path: "/agent/skills/notes".to_owned(),
                    scope: "deployment".to_owned(),
                    project_id: Some("project-9".to_owned()),
                    action: "validate".to_owned(),
                    result: result.to_owned(),
                    reason: None,
                    operation_id: Some("op-1".to_owned()),
                    occurred_at,
                },
            )
            .expect("seed history");
        };
        seed("hist-old", "checked", now);
        seed("hist-new", "archived", now + 5);

        let page = match fixture
            .facade
            .query(AppQuery::ListGovernanceHistory(ListGovernanceHistory {
                page: 1,
                page_size: 1,
                relation_id: None,
                skill_id: None,
                agent_client_id: None,
                project_id: None,
                result: None,
            }))
            .await
            .expect("history page")
        {
            AppQueryResult::GovernanceHistoryPage(page) => page,
            other => panic!("expected history page, got {other:?}"),
        };
        assert_eq!(page.total, 2);
        assert_eq!(page.items.len(), 1, "page size is honored");
        assert_eq!(page.items[0].result, "archived", "newest first");
        assert_eq!(page.items[0].skill_display_name, "Notes");
        assert_eq!(
            page.items[0].agent.client_id.as_deref(),
            Some("codebuddy.code")
        );

        // result 过滤与分页可组合。
        let filtered = match fixture
            .facade
            .query(AppQuery::ListGovernanceHistory(ListGovernanceHistory {
                page: 1,
                page_size: 10,
                relation_id: None,
                skill_id: None,
                agent_client_id: None,
                project_id: None,
                result: Some("checked".to_owned()),
            }))
            .await
            .expect("filtered history")
        {
            AppQueryResult::GovernanceHistoryPage(page) => page,
            other => panic!("expected history page, got {other:?}"),
        };
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items[0].result, "checked");

        // skill 过滤同样可用。
        let by_skill = match fixture
            .facade
            .query(AppQuery::ListGovernanceHistory(ListGovernanceHistory {
                page: 1,
                page_size: 10,
                relation_id: None,
                skill_id: Some(fixture.skill_id),
                agent_client_id: None,
                project_id: None,
                result: None,
            }))
            .await
            .expect("skill-filtered history")
        {
            AppQueryResult::GovernanceHistoryPage(page) => page,
            other => panic!("expected history page, got {other:?}"),
        };
        assert_eq!(by_skill.total, 2);
    }
}

// ===================== 8A：保留来源副本与来源关系维度的清理准备 =====================

mod retain_and_cleanup_prepare {
    //! 8A 验收：RetainSourceCopy 只改决策并记历史、绝不触碰来源目录；
    //! PrepareOriginalMigration 以 source_relation_id 为对象，计划携带
    //! 关系身份、Agent 呈现与逻辑目标上下文；Full 校验把关阻断冲突；
    //! 同一 Skill 的多条来源互不影响（8.1/8.2/8.6/8.11/8.12）。

    use skillhub_core::agent::{
        ClientInstance, ClientKind, ClientPresence, DiscoverySnapshot, LogicalTarget,
        OperatingSystem, TargetScope,
    };
    use skillhub_core::api::{ListGovernanceHistory, PrepareImport};
    use skillhub_core::import::{ImportCandidate, ImportDecision};
    use skillhub_core::physical_id_for_path;
    use skillhub_core::relationship::{
        SourceCopyDecision, SourceCopyHealth, SourceCopyRelationFact,
    };
    use skillhub_core::{AppCommand, AppCommandResult, AppQueryResult, ImportGovernanceDecision};

    use super::*;

    pub(super) const CLIENT_ID: &str = "agent.demo";

    fn register_agent_target(database: &Database, root: &std::path::Path) {
        database
            .agent_repository()
            .replace(&DiscoverySnapshot {
                generation: "1".into(),
                observed_at: "2026-09-15T00:00:00Z".into(),
                instances: vec![ClientInstance {
                    profile_id: "demo".into(),
                    client_id: CLIENT_ID.into(),
                    kind: ClientKind::IdeExtension,
                    display_name: "Demo IDE".into(),
                    supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                    client_presence: ClientPresence::Unknown,
                }],
                logical_targets: vec![LogicalTarget {
                    id: "target-1".into(),
                    profile_id: "demo".into(),
                    client_id: CLIENT_ID.into(),
                    scope: TargetScope::Global,
                    path: root.to_string_lossy().into_owned(),
                    marker: "SKILL.md".into(),
                    precedence: DirectoryPrecedence::Preferred,
                    shared_reference: false,
                    exists: true,
                    readable: true,
                    writable: true,
                    available: true,
                    physical_id: physical_id_for_path(root).expect("physical id"),
                }],
                physical_targets: Vec::new(),
            })
            .expect("agent snapshot");
    }

    /// Agent 目录 + 集中库 + 门面；返回 (facade, agent_skills_root)。
    pub(super) fn agent_facade(
        workspace: &std::path::Path,
    ) -> (LocalApplicationFacade, std::path::PathBuf) {
        let agent_root = workspace.join("agents/demo/skills");
        std::fs::create_dir_all(&agent_root).expect("agent root");
        let database = Database::open(workspace.join("db.sqlite")).expect("database");
        register_agent_target(&database, &agent_root);
        let library_root = workspace.join("library");
        CentralLibrary::initialize(&library_root).expect("library");
        let facade = LocalApplicationFacade::new_with_library(database, &library_root);
        (facade, agent_root)
    }

    /// 导入一个来源副本并返回其来源关系 id（Task 5B 提交后即完成首轮
    /// Full 校验，因此关系处于 Normal）。
    pub(super) async fn import_source_copy(
        facade: &LocalApplicationFacade,
        root: &std::path::Path,
        name: &str,
    ) -> String {
        let candidate = ImportCandidate::detected(
            SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root)),
            root.to_string_lossy(),
            ".",
            "SKILL.md",
            name,
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
        facade
            .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
                prepared_import_id: prepared.id,
                decision: ImportDecision::CopyIntoLibrary,
                governance_decision: ImportGovernanceDecision {
                    group_actions: BTreeMap::new(),
                    item_overrides: BTreeMap::new(),
                },
                batch_id: None,
                candidate_key: None,
            }))
            .await
            .expect("commit import");
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        database
            .relationship_repository()
            .list_source_copy_relations(true)
            .expect("source copy relations")
            .into_iter()
            .find(|relation| relation.source_path == root.to_string_lossy())
            .unwrap_or_else(|| panic!("relation for {}", root.display()))
            .relation_id
    }

    pub(super) async fn relation_fact(
        facade: &LocalApplicationFacade,
        relation_id: &str,
    ) -> SourceCopyRelationFact {
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        database
            .relationship_repository()
            .list_source_copy_relations(false)
            .expect("relations")
            .into_iter()
            .find(|relation| relation.relation_id == relation_id)
            .unwrap_or_else(|| panic!("relation {relation_id}"))
    }

    async fn retain_history_count(facade: &LocalApplicationFacade, relation_id: &str) -> usize {
        let AppQueryResult::GovernanceHistoryPage(page) = facade
            .query(AppQuery::ListGovernanceHistory(ListGovernanceHistory {
                page: 1,
                page_size: 50,
                relation_id: Some(relation_id.to_owned()),
                skill_id: None,
                agent_client_id: None,
                project_id: None,
                result: None,
            }))
            .await
            .expect("governance history")
        else {
            panic!("expected governance history page");
        };
        page.items
            .iter()
            .filter(|entry| entry.action == "retain" && entry.result == "retained")
            .count()
    }

    // 8.6：保留只改决策并记录历史，绝不读写来源目录。
    #[tokio::test]
    async fn retain_source_copy_updates_decision_records_history_and_keeps_files() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;

        let retained = facade
            .execute(AppCommand::RetainSourceCopy(
                skillhub_core::api::RetainSourceCopy {
                    source_relation_id: relation_id.clone(),
                },
            ))
            .await
            .expect("retain source copy");
        let AppCommandResult::SourceCopyRelationUpdated(fact) = retained else {
            panic!("expected updated relation");
        };
        assert_eq!(fact.relation_id, relation_id);
        assert_eq!(fact.decision, SourceCopyDecision::Retained);
        assert_eq!(fact.health, SourceCopyHealth::Normal);
        assert!(fact.active);

        let reloaded = relation_fact(&facade, &relation_id).await;
        assert_eq!(reloaded.decision, SourceCopyDecision::Retained);
        assert!(
            source.join("SKILL.md").is_file(),
            "retain never touches disk"
        );

        // 历史固定写时快照：动作、展示名、路径、Agent 呈现。
        let AppQueryResult::GovernanceHistoryPage(page) = facade
            .query(AppQuery::ListGovernanceHistory(ListGovernanceHistory {
                page: 1,
                page_size: 50,
                relation_id: Some(relation_id.clone()),
                skill_id: None,
                agent_client_id: None,
                project_id: None,
                result: None,
            }))
            .await
            .expect("governance history")
        else {
            panic!("expected governance history page");
        };
        let event = page
            .items
            .iter()
            .find(|entry| entry.action == "retain")
            .expect("retain history event");
        assert_eq!(event.result, "retained");
        assert_eq!(event.skill_display_name, "Notes");
        assert_eq!(event.path, source.to_string_lossy());
        assert_eq!(event.agent.client_id.as_deref(), Some(CLIENT_ID));
    }

    // 8.6：保留幂等——重复保留不重复写历史。
    #[tokio::test]
    async fn retain_is_idempotent_without_duplicate_history() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;

        for _ in 0..2 {
            let retained = facade
                .execute(AppCommand::RetainSourceCopy(
                    skillhub_core::api::RetainSourceCopy {
                        source_relation_id: relation_id.clone(),
                    },
                ))
                .await
                .expect("retain source copy");
            let AppCommandResult::SourceCopyRelationUpdated(fact) = retained else {
                panic!("expected updated relation");
            };
            assert_eq!(fact.decision, SourceCopyDecision::Retained);
        }
        assert_eq!(retain_history_count(&facade, &relation_id).await, 1);
    }

    // 8.6/8.11：保留后清理准备直接可用；决策保持 Retained（不伪造
    // Pending 过渡）；计划携带关系身份与 Agent 呈现/目标上下文。
    #[tokio::test]
    async fn retained_relation_enters_cleanup_prepare_without_pending_rewrite() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        facade
            .execute(AppCommand::RetainSourceCopy(
                skillhub_core::api::RetainSourceCopy {
                    source_relation_id: relation_id.clone(),
                },
            ))
            .await
            .expect("retain source copy");

        let planned = facade
            .execute(AppCommand::PrepareOriginalMigration(
                skillhub_core::api::PrepareOriginalMigration {
                    source_relation_id: relation_id.clone(),
                },
            ))
            .await
            .expect("prepare cleanup");
        let AppCommandResult::OriginalMigrationPlan(plan) = planned else {
            panic!("expected migration plan");
        };
        assert_eq!(plan.relation_id, relation_id);
        assert_eq!(plan.original_path, source.to_string_lossy());
        assert!(plan.conflicts.is_empty(), "clean copy prepares freely");
        assert_eq!(plan.agent.client_id.as_deref(), Some(CLIENT_ID));
        assert_eq!(
            plan.target_context.agent_client_id.as_deref(),
            Some(CLIENT_ID)
        );
        assert_eq!(plan.target_context.shared_directory_node_id, None);

        let reloaded = relation_fact(&facade, &relation_id).await;
        assert_eq!(
            reloaded.decision,
            SourceCopyDecision::Retained,
            "prepare must not rewrite the decision back to pending"
        );
    }

    // 8.1/8.2/8.12：清理准备按关系隔离；Full 校验把关内容分叉；一条
    // 来源分叉不波及同 Skill 另一条来源。
    #[tokio::test]
    async fn cleanup_prepare_is_scoped_per_relation_and_gated_by_full_check() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let first = agent_root.join("notes-one");
        let second = agent_root.join("notes-two");
        write_skill(&first);
        write_skill(&second);
        let first_relation = import_source_copy(&facade, &first, "NotesOne").await;
        let second_relation = import_source_copy(&facade, &second, "NotesTwo").await;

        // 第一条来源内容分叉。
        std::fs::write(first.join("SKILL.md"), "# Notes\n\ndiverged\n").expect("diverge");

        let diverged = facade
            .execute(AppCommand::PrepareOriginalMigration(
                skillhub_core::api::PrepareOriginalMigration {
                    source_relation_id: first_relation.clone(),
                },
            ))
            .await
            .expect("prepare cleanup");
        let AppCommandResult::OriginalMigrationPlan(diverged) = diverged else {
            panic!("expected migration plan");
        };
        assert_eq!(diverged.relation_id, first_relation);
        assert_eq!(diverged.conflicts.len(), 1);
        assert_eq!(
            diverged.conflicts[0].reason,
            skillhub_core::import::OriginalMigrationConflictReason::ContentDiverged
        );

        let clean = facade
            .execute(AppCommand::PrepareOriginalMigration(
                skillhub_core::api::PrepareOriginalMigration {
                    source_relation_id: second_relation.clone(),
                },
            ))
            .await
            .expect("prepare cleanup");
        let AppCommandResult::OriginalMigrationPlan(clean) = clean else {
            panic!("expected migration plan");
        };
        assert_eq!(clean.relation_id, second_relation);
        assert!(clean.conflicts.is_empty(), "other source stays unaffected");

        let second_fact = relation_fact(&facade, &second_relation).await;
        assert_eq!(second_fact.health, SourceCopyHealth::Normal);
        let first_fact = relation_fact(&facade, &first_relation).await;
        assert_eq!(first_fact.health, SourceCopyHealth::ContentChanged);
    }

    // 8.12：准备只接受活动来源关系；未知 id 与已归档关系一律拒绝。
    #[tokio::test]
    async fn cleanup_prepare_requires_an_active_source_relation() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;

        let unknown = facade
            .execute(AppCommand::PrepareOriginalMigration(
                skillhub_core::api::PrepareOriginalMigration {
                    source_relation_id: "rel-unknown".into(),
                },
            ))
            .await;
        assert_eq!(
            unknown.expect_err("unknown relation").code,
            ErrorCode::ObjectNotFound
        );

        // 归档后拒绝：清理准备不复活历史关系。
        {
            let database = facade.database_for_tests().clone();
            let database = database.lock().expect("database lock");
            database
                .relationship_repository()
                .archive_source_copy_relation(
                    &relation_id,
                    skillhub_core::relationship::SourceCopyArchiveReason::ExternalRemoved,
                    123,
                )
                .expect("archive relation");
        }
        let archived = facade
            .execute(AppCommand::PrepareOriginalMigration(
                skillhub_core::api::PrepareOriginalMigration {
                    source_relation_id: relation_id.clone(),
                },
            ))
            .await;
        assert_eq!(
            archived.expect_err("archived relation").code,
            ErrorCode::OperationConflict
        );
    }

    // 8.11/8.17：共享目录来源的准备返回 shared-directory 节点与关联
    // Agent，不压扁成单一 agent 目标。
    #[tokio::test]
    async fn cleanup_prepare_reports_shared_directory_target_context() {
        let workspace = tempfile::tempdir().expect("workspace");
        let library_root = workspace.path().join("library");
        CentralLibrary::initialize(&library_root).expect("library");
        let database = Database::open(workspace.path().join("db.sqlite")).expect("database");
        let facade = LocalApplicationFacade::new_with_library(database, &library_root);

        let shared_root = workspace.path().join("shared/skills");
        std::fs::create_dir_all(&shared_root).expect("shared root");
        let source = shared_root.join("notes");
        write_skill(&source);
        {
            let database = facade.database_for_tests().clone();
            let database = database.lock().expect("database lock");
            database
                .directory_repository()
                .upsert_node(&DirectoryNodeFact {
                    node_id: "directory:shared-skills".into(),
                    path: shared_root.to_string_lossy().into_owned(),
                    path_key: String::new(),
                    role: DirectoryRole::SharedDirectory,
                    profile_id: None,
                    agent_client_id: None,
                    exists: true,
                    observed_at: 1,
                    scan_source: Some("test".into()),
                })
                .expect("shared node");
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
                        applicable_platforms: vec![],
                    })
                    .expect("capability");
            }
        }

        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        let planned = facade
            .execute(AppCommand::PrepareOriginalMigration(
                skillhub_core::api::PrepareOriginalMigration {
                    source_relation_id: relation_id,
                },
            ))
            .await
            .expect("prepare cleanup");
        let AppCommandResult::OriginalMigrationPlan(plan) = planned else {
            panic!("expected migration plan");
        };
        assert_eq!(
            plan.agent.client_id, None,
            "shared directory has no single agent"
        );
        let context = plan.target_context;
        assert_eq!(
            context.shared_directory_node_id.as_deref(),
            Some("directory:shared-skills")
        );
        assert_eq!(context.agent_client_id, None);
        let mut associated = context.associated_agent_client_ids;
        associated.sort();
        assert_eq!(associated, vec!["agent.demo", "agent.other"]);
    }
}

// ===================== 8B：清理提交状态机、崩溃恢复与回滚 =====================

mod cleanup_commit_recovery {
    //! 8B 验收：提交按"备份→checkpoint→删除→原子归档"推进（8.4）；
    //! 删除失败不删审计、现场保留、关系标 OperationFailed（8.5）；
    //! checkpoint 后崩溃由启动恢复按三方事实推进（8.3/8.14）；回滚恢复
    //! 文件、Full 校验、新建关系并显式关联新旧关系（8.7）。

    use skillhub_core::import::original_migration_backup_key;
    use skillhub_core::relationship::{
        SourceCopyArchiveReason, SourceCopyDecision, SourceCopyHealth,
    };
    use skillhub_core::{
        AppCommand, AppCommandResult, ErrorCode, OperationId, OriginalMigrationState,
    };

    use super::retain_and_cleanup_prepare::{agent_facade, import_source_copy, relation_fact};
    use super::*;

    async fn prepare_cleanup(
        facade: &LocalApplicationFacade,
        relation_id: &str,
    ) -> skillhub_core::OriginalMigrationPlan {
        let planned = facade
            .execute(AppCommand::PrepareOriginalMigration(
                skillhub_core::api::PrepareOriginalMigration {
                    source_relation_id: relation_id.to_owned(),
                },
            ))
            .await
            .expect("prepare cleanup");
        let AppCommandResult::OriginalMigrationPlan(plan) = planned else {
            panic!("expected migration plan");
        };
        assert!(plan.conflicts.is_empty());
        plan
    }

    async fn committed_record(
        facade: &LocalApplicationFacade,
        migration_id: OperationId,
    ) -> skillhub_core::OriginalMigrationResult {
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        database
            .provenance_repository()
            .original_migration(migration_id)
            .expect("migration lookup")
            .expect("migration record")
    }

    async fn history_with(
        facade: &LocalApplicationFacade,
        relation_id: &str,
        action: &str,
        result: &str,
    ) -> usize {
        let AppQueryResult::GovernanceHistoryPage(page) = facade
            .query(AppQuery::ListGovernanceHistory(
                skillhub_core::api::ListGovernanceHistory {
                    page: 1,
                    page_size: 50,
                    relation_id: Some(relation_id.to_owned()),
                    skill_id: None,
                    agent_client_id: None,
                    project_id: None,
                    result: None,
                },
            ))
            .await
            .expect("governance history")
        else {
            panic!("expected governance history page");
        };
        page.items
            .iter()
            .filter(|entry| entry.action == action && entry.result == result)
            .count()
    }

    /// 直接落一条迁移 checkpoint（模拟"写 checkpoint 后崩溃"）。以
    /// operation id 为备份目录名；`create_backup=false` 模拟备份缺失。
    async fn seed_checkpoint(
        facade: &LocalApplicationFacade,
        relation_id: &str,
        source_path: &std::path::Path,
        backup_base: &std::path::Path,
        create_backup: bool,
        state: OriginalMigrationState,
    ) -> OperationId {
        let operation_id = OperationId::new();
        let backup = backup_base.join(operation_id.to_string());
        if create_backup {
            std::fs::create_dir_all(&backup).expect("backup dir");
            std::fs::write(backup.join("SKILL.md"), BODY).expect("backup body");
        }
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        let relation = database
            .relationship_repository()
            .list_source_copy_relations(false)
            .expect("relations")
            .into_iter()
            .find(|relation| relation.relation_id == relation_id)
            .expect("relation");
        database
            .provenance_repository()
            .insert_original_migration(&skillhub_core::OriginalMigrationResult {
                migration_id: operation_id,
                skill_id: relation.skill_id,
                relation_id: relation_id.to_owned(),
                agent: Default::default(),
                target_context: Default::default(),
                relationship_revision: 0,
                original_path: source_path.to_string_lossy().into_owned(),
                backup_path: backup.to_string_lossy().into_owned(),
                content_fingerprint: relation.expected_fingerprint.clone(),
                state,
                confirmed_at: 1,
                rolled_back_at: None,
                restored_relation_id: None,
            })
            .expect("seed migration record");
        operation_id
    }

    fn backup_base(workspace: &std::path::Path, relation_id: &str) -> std::path::PathBuf {
        workspace
            .join("library")
            .join(".skillhub")
            .join("original-migrations")
            .join(original_migration_backup_key(relation_id))
    }

    // 8.4/8.13/8.17：提交 = 备份 → checkpoint → 删除 → 单事务原子归档
    // （关系 Cleaned + 历史 migrated + 记录 Migrated）；结果带逻辑目标
    // 上下文；备份在 safe-key 目录下。
    #[tokio::test]
    async fn cleanup_commit_archives_relation_and_records_history_atomically() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        let plan = prepare_cleanup(&facade, &relation_id).await;

        let committed = facade
            .execute(AppCommand::CommitOriginalMigration(
                skillhub_core::api::CommitOriginalMigration {
                    prepared_migration_id: plan.operation_id,
                    ownership_confirmed: true,
                },
            ))
            .await
            .expect("confirmed cleanup");
        let AppCommandResult::OriginalMigrationResult(result) = committed else {
            panic!("expected migration result");
        };
        assert_eq!(result.state, OriginalMigrationState::Migrated);
        assert_eq!(result.relation_id, relation_id);
        assert_eq!(
            result.target_context.agent_client_id.as_deref(),
            Some("agent.demo")
        );
        assert!(!source.exists(), "cleanup removes the original directory");

        // 备份目录：safe-key + operation id，不在用户目录里。
        let backup = std::path::PathBuf::from(&result.backup_path);
        let expected_root = backup_base(workspace.path(), &relation_id);
        assert!(backup.starts_with(&expected_root), "backup at {backup:?}");
        assert!(backup.join("SKILL.md").is_file(), "backup holds the copy");

        // 关系以 Cleaned 归档；历史与记录一致。
        let archived = relation_fact(&facade, &relation_id).await;
        assert!(!archived.active);
        assert_eq!(
            archived.archive_reason,
            Some(SourceCopyArchiveReason::Cleaned)
        );
        assert_eq!(
            history_with(&facade, &relation_id, "migrate", "migrated").await,
            1
        );
        let record = committed_record(&facade, plan.operation_id).await;
        assert_eq!(record.state, OriginalMigrationState::Migrated);
    }

    // 8.5：删除失败（可确认原目录仍在）→ 记录 Failed、关系
    // OperationFailed、历史 failed；审计与备份绝不删除。
    #[tokio::test]
    async fn delete_failure_marks_operation_failed_and_preserves_scene() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        let plan = prepare_cleanup(&facade, &relation_id).await;
        facade.set_original_migration_deletion_for_tests(std::sync::Arc::new(
            failing_deletion::FailingDeletion,
        ));

        let denied = facade
            .execute(AppCommand::CommitOriginalMigration(
                skillhub_core::api::CommitOriginalMigration {
                    prepared_migration_id: plan.operation_id,
                    ownership_confirmed: true,
                },
            ))
            .await;
        assert_eq!(
            denied.expect_err("delete failure must abort").code,
            ErrorCode::OperationConflict
        );
        assert!(source.join("SKILL.md").is_file(), "scene preserved");

        let record = committed_record(&facade, plan.operation_id).await;
        assert_eq!(record.state, OriginalMigrationState::Failed);
        assert!(std::path::PathBuf::from(&record.backup_path)
            .join("SKILL.md")
            .is_file());
        let relation = relation_fact(&facade, &relation_id).await;
        assert_eq!(relation.health, SourceCopyHealth::OperationFailed);
        assert!(relation.active, "failed cleanup does not archive");
        assert_eq!(
            history_with(&facade, &relation_id, "migrate", "failed").await,
            1
        );
    }

    // 8.3/8.14：checkpoint 后、删除后崩溃（原目录不在、备份在）→ 启动
    // 恢复前滚为 Migrated，补归档与历史。
    #[tokio::test]
    async fn crash_after_delete_rolls_forward_to_migrated() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        let operation_id = seed_checkpoint(
            &facade,
            &relation_id,
            &source,
            &backup_base(workspace.path(), &relation_id),
            true,
            OriginalMigrationState::Deleting,
        )
        .await;
        std::fs::remove_dir_all(&source).expect("simulate the delete happened");

        let _ = facade.recover_original_migrations();

        let record = committed_record(&facade, operation_id).await;
        assert_eq!(record.state, OriginalMigrationState::Migrated);
        let archived = relation_fact(&facade, &relation_id).await;
        assert!(!archived.active);
        assert_eq!(
            archived.archive_reason,
            Some(SourceCopyArchiveReason::Cleaned)
        );
        assert_eq!(
            history_with(&facade, &relation_id, "migrate", "migrated").await,
            1
        );
        assert!(!source.exists());
    }

    // 8.3/8.14/8.5：checkpoint 后、删除前崩溃（原目录仍在）→ 恢复为
    // Failed，现场保留，关系 OperationFailed。
    #[tokio::test]
    async fn crash_before_delete_recovers_as_failed_preserving_scene() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        seed_checkpoint(
            &facade,
            &relation_id,
            &source,
            &backup_base(workspace.path(), &relation_id),
            true,
            OriginalMigrationState::BackedUp,
        )
        .await;

        let _ = facade.recover_original_migrations();

        let relation = relation_fact(&facade, &relation_id).await;
        assert!(relation.active, "nothing was deleted");
        assert_eq!(relation.health, SourceCopyHealth::OperationFailed);
        assert_eq!(
            history_with(&facade, &relation_id, "migrate", "failed").await,
            1
        );
        assert!(source.join("SKILL.md").is_file(), "scene preserved");
    }

    // 8.14：备份缺失 → NeedsRecovery（不归档、不假装任何一侧完好）。
    #[tokio::test]
    async fn crash_without_backup_lands_in_needs_recovery() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        seed_checkpoint(
            &facade,
            &relation_id,
            &source,
            &backup_base(workspace.path(), &relation_id),
            false,
            OriginalMigrationState::Deleting,
        )
        .await;
        std::fs::remove_dir_all(&source).expect("simulate the delete happened");

        let _ = facade.recover_original_migrations();

        let relation = relation_fact(&facade, &relation_id).await;
        assert!(relation.active, "must not archive without a backup");
        assert_eq!(
            history_with(&facade, &relation_id, "migrate", "needs_recovery").await,
            1
        );
    }

    // 8.7：回滚恢复原目录、旧关系保持归档、新建活动关系并 Full 校验，
    // 记录显式关联新旧关系，历史追加 rolled_back；重复回滚拒绝。
    #[tokio::test]
    async fn rollback_restores_files_and_creates_a_new_active_relation() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        facade
            .execute(AppCommand::RetainSourceCopy(
                skillhub_core::api::RetainSourceCopy {
                    source_relation_id: relation_id.clone(),
                },
            ))
            .await
            .expect("retain");
        let plan = prepare_cleanup(&facade, &relation_id).await;
        let committed = facade
            .execute(AppCommand::CommitOriginalMigration(
                skillhub_core::api::CommitOriginalMigration {
                    prepared_migration_id: plan.operation_id,
                    ownership_confirmed: true,
                },
            ))
            .await
            .expect("commit");
        let AppCommandResult::OriginalMigrationResult(record) = committed else {
            panic!("expected migration result");
        };

        let rolled_back = facade
            .execute(AppCommand::RollbackOriginalMigration(
                skillhub_core::api::RollbackOriginalMigration {
                    migration_id: record.migration_id,
                },
            ))
            .await
            .expect("rollback");
        let AppCommandResult::OriginalMigrationResult(rolled_back) = rolled_back else {
            panic!("expected rollback result");
        };
        assert_eq!(rolled_back.state, OriginalMigrationState::RolledBack);
        assert!(source.join("SKILL.md").is_file(), "files restored");

        // 旧关系保持归档；新关系活动、同路径、Full 校验后 Normal、决策
        // 沿用保留（Retained）。
        let old_relation = relation_fact(&facade, &relation_id).await;
        assert!(!old_relation.active);
        assert_eq!(
            old_relation.archive_reason,
            Some(SourceCopyArchiveReason::Cleaned)
        );
        let new_relations = {
            let database = facade.database_for_tests().clone();
            let database = database.lock().expect("database lock");
            database
                .relationship_repository()
                .list_source_copy_relations(true)
                .expect("active relations")
        };
        let new_relation = new_relations
            .iter()
            .find(|relation| relation.source_path == source.to_string_lossy())
            .expect("new active relation at the restored path");
        assert_ne!(new_relation.relation_id, relation_id);
        assert_eq!(new_relation.decision, SourceCopyDecision::Retained);
        assert_eq!(new_relation.health, SourceCopyHealth::Normal);
        assert_eq!(
            history_with(&facade, &relation_id, "rollback", "rolled_back").await,
            1
        );

        // 记录显式关联新旧关系。
        let stored = committed_record(&facade, record.migration_id).await;
        assert_eq!(stored.state, OriginalMigrationState::RolledBack);
        assert_eq!(stored.relation_id, relation_id);
        assert_eq!(
            stored.restored_relation_id.as_deref(),
            Some(new_relation.relation_id.as_str())
        );

        // 已回滚的迁移不能再次回滚。
        let again = facade
            .execute(AppCommand::RollbackOriginalMigration(
                skillhub_core::api::RollbackOriginalMigration {
                    migration_id: record.migration_id,
                },
            ))
            .await;
        assert_eq!(
            again.expect_err("double rollback").code,
            ErrorCode::OperationConflict
        );
    }

    // 8.7：原路径已存在时拒绝回滚，绝不覆盖用户文件。
    #[tokio::test]
    async fn rollback_refuses_to_overwrite_an_existing_path() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, agent_root) = agent_facade(workspace.path());
        let source = agent_root.join("notes");
        write_skill(&source);
        let relation_id = import_source_copy(&facade, &source, "Notes").await;
        let plan = prepare_cleanup(&facade, &relation_id).await;
        let committed = facade
            .execute(AppCommand::CommitOriginalMigration(
                skillhub_core::api::CommitOriginalMigration {
                    prepared_migration_id: plan.operation_id,
                    ownership_confirmed: true,
                },
            ))
            .await
            .expect("commit");
        let AppCommandResult::OriginalMigrationResult(record) = committed else {
            panic!("expected migration result");
        };

        // 原路径被用户重建（有新内容）→ 回滚必须拒绝。
        std::fs::create_dir_all(&source).expect("user recreates the path");
        std::fs::write(source.join("SKILL.md"), "# user data\n").expect("user content");

        let refused = facade
            .execute(AppCommand::RollbackOriginalMigration(
                skillhub_core::api::RollbackOriginalMigration {
                    migration_id: record.migration_id,
                },
            ))
            .await;
        assert_eq!(
            refused.expect_err("existing path must refuse").code,
            ErrorCode::OperationConflict
        );
        assert_eq!(
            std::fs::read_to_string(source.join("SKILL.md")).expect("user file"),
            "# user data\n",
            "user files are never overwritten"
        );
    }
}

// ===================== 8C：来源副本批处理（batch retain/clean） =====================

mod source_copy_batches {
    //! 8C 验收：来源副本批次必须同为 source_copy 且动作一致，部署边混入
    //! 在拆分子操作前整体拒绝（8.9）；清理逐行显式确认，未确认的行在
    //! prepare 阶段就受阻；预览后取消的行不触碰文件系统；一行删除失败
    //! 只影响该行，其余行照常提交；子操作走 retain/cleanup 自己的
    //! operation kind，不借用部署转换的链路（8.16）。

    use skillhub_core::relationship::{SourceCopyArchiveReason, SourceCopyDecision};
    use skillhub_core::{AppCommand, AppCommandResult, ErrorCode, OperationId};

    use super::failing_deletion::SelectiveDeletion;
    use super::retain_and_cleanup_prepare::{agent_facade, import_source_copy, relation_fact};
    use super::*;

    fn confirmation(relation_id: &str) -> (String, String) {
        (relation_id.to_owned(), format!("confirm:{relation_id}"))
    }

    async fn prepare_batch(
        facade: &LocalApplicationFacade,
        action: RelationGovernanceBatchAction,
        relation_ids: Vec<String>,
        confirmations: BTreeMap<String, String>,
    ) -> RelationGovernanceBatchOutcome {
        let prepared = facade
            .execute(AppCommand::PrepareRelationGovernanceBatch(
                PrepareRelationGovernanceBatch {
                    action,
                    relation_ids,
                    confirmations,
                },
            ))
            .await
            .expect("prepare batch");
        let AppCommandResult::RelationGovernanceBatch(outcome) = prepared else {
            panic!("expected batch outcome");
        };
        outcome
    }

    async fn commit_batch(
        facade: &LocalApplicationFacade,
        batch_id: OperationId,
        relation_ids: Vec<String>,
    ) -> RelationGovernanceBatchOutcome {
        let committed = facade
            .execute(AppCommand::CommitRelationGovernanceBatch(
                CommitRelationGovernanceBatch {
                    batch_id,
                    relation_ids,
                },
            ))
            .await
            .expect("commit batch");
        let AppCommandResult::RelationGovernanceBatch(outcome) = committed else {
            panic!("expected batch outcome");
        };
        outcome
    }

    pub(super) async fn history_count(
        facade: &LocalApplicationFacade,
        relation_id: &str,
        action: &str,
        result: &str,
    ) -> usize {
        let AppQueryResult::GovernanceHistoryPage(page) = facade
            .query(AppQuery::ListGovernanceHistory(
                skillhub_core::api::ListGovernanceHistory {
                    page: 1,
                    page_size: 50,
                    relation_id: Some(relation_id.to_owned()),
                    skill_id: None,
                    agent_client_id: None,
                    project_id: None,
                    result: None,
                },
            ))
            .await
            .expect("governance history")
        else {
            panic!("expected governance history page");
        };
        page.items
            .iter()
            .filter(|entry| entry.action == action && entry.result == result)
            .count()
    }

    fn child_operation_kind(facade: &LocalApplicationFacade, operation_id: OperationId) -> String {
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        database
            .operation_repository()
            .get_sync(operation_id)
            .expect("operation lookup")
            .expect("child operation record")
            .kind
    }

    // 8.9：retain 批次逐行复用单条保留语义；每行一条治理历史，子操作
    // 记录在自己的 operation kind 下。
    #[tokio::test]
    async fn retain_batch_commits_each_row_and_records_history() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, _agent_root) = agent_facade(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let first = sources.path().join("batch-retain-a");
        let second = sources.path().join("batch-retain-b");
        write_skill(&first);
        write_skill(&second);
        let first_id = import_source_copy(&facade, &first, "RetainA").await;
        let second_id = import_source_copy(&facade, &second, "RetainB").await;

        let outcome = prepare_batch(
            &facade,
            RelationGovernanceBatchAction::RetainSourceCopy,
            vec![first_id.clone(), second_id.clone()],
            BTreeMap::new(),
        )
        .await;
        assert_eq!(outcome.state, RelationGovernanceBatchState::Prepared);
        assert_eq!(outcome.prepared_count, 2);
        assert!(outcome
            .items
            .iter()
            .all(|item| item.state == RelationGovernanceBatchItemState::Prepared));
        let child_ops: Vec<OperationId> = outcome
            .items
            .iter()
            .filter_map(|item| item.operation_id)
            .collect();
        assert_eq!(child_ops.len(), 2);

        let outcome = commit_batch(
            &facade,
            outcome.batch_id,
            vec![first_id.clone(), second_id.clone()],
        )
        .await;
        assert_eq!(outcome.state, RelationGovernanceBatchState::Committed);
        assert_eq!(outcome.committed_count, 2);
        assert!(outcome
            .items
            .iter()
            .all(|item| item.state == RelationGovernanceBatchItemState::Committed));

        for relation_id in [&first_id, &second_id] {
            let fact = relation_fact(&facade, relation_id).await;
            assert_eq!(fact.decision, SourceCopyDecision::Retained);
            assert_eq!(
                history_count(&facade, relation_id, "retain", "retained").await,
                1,
                "one retained history event per relation"
            );
            assert!(
                first.exists() && second.exists(),
                "retain never touches the source directories"
            );
        }
        for operation_id in child_ops {
            assert_eq!(
                child_operation_kind(&facade, operation_id),
                "retain_source_copy",
                "retain children run under their own operation kind"
            );
        }
    }

    // 8.9：来源动作只接受同为 source_copy 的批次；部署边混入在拆分
    // 子操作前整体拒绝。
    #[tokio::test]
    async fn source_actions_refuse_batches_containing_deployment_edges() {
        let fixture = fixture().await;
        let sources = tempfile::tempdir().expect("sources");
        let source = sources.path().join("mixed-src");
        write_skill(&source);
        let copy_id =
            super::unified_and_history::import_source_copy(&fixture.facade, &source, "Mixed").await;

        for action in [
            RelationGovernanceBatchAction::RetainSourceCopy,
            RelationGovernanceBatchAction::CleanSourceCopy,
        ] {
            let error = fixture
                .facade
                .execute(AppCommand::PrepareRelationGovernanceBatch(
                    PrepareRelationGovernanceBatch {
                        action,
                        relation_ids: vec![fixture.relation_id.clone(), copy_id.clone()],
                        confirmations: BTreeMap::new(),
                    },
                ))
                .await
                .expect_err("deployment edges are refused in source batches");
            assert_eq!(
                error.code.as_str(),
                ErrorCode::InvalidInput.as_str(),
                "action {action:?} rejects mixed kinds"
            );
        }
    }

    // 7.5：纳入管理的批次同样拒绝来源副本与部署边混批——批次行改用统一
    // 清单投影后，该约束才真正有来源副本事实可判。
    #[tokio::test]
    async fn centralize_management_refuses_mixed_kinds() {
        let fixture = fixture().await;
        let sources = tempfile::tempdir().expect("sources");
        let source = sources.path().join("mixed-central-src");
        write_skill(&source);
        let copy_id =
            super::unified_and_history::import_source_copy(&fixture.facade, &source, "MixedC")
                .await;
        let error = fixture
            .facade
            .execute(AppCommand::PrepareRelationGovernanceBatch(
                PrepareRelationGovernanceBatch {
                    action: RelationGovernanceBatchAction::CentralizeManagement,
                    relation_ids: vec![fixture.relation_id.clone(), copy_id],
                    confirmations: BTreeMap::new(),
                },
            ))
            .await
            .expect_err("mixed kinds are refused before child operations");
        assert_eq!(error.code.as_str(), ErrorCode::InvalidInput.as_str());
    }

    // 8.9：清理逐行显式确认是硬门槛；预览后未提交的行按取消处理且
    // 不触碰文件；回滚逐行恢复。
    #[tokio::test]
    async fn clean_batch_confirms_rows_cancels_deselected_and_rolls_back() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, _agent_root) = agent_facade(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let first = sources.path().join("batch-clean-a");
        let second = sources.path().join("batch-clean-b");
        write_skill(&first);
        write_skill(&second);
        let first_id = import_source_copy(&facade, &first, "CleanA").await;
        let second_id = import_source_copy(&facade, &second, "CleanB").await;
        let first_original = first.to_string_lossy().into_owned();

        // 未确认：全部受阻，不产生子操作。
        let outcome = prepare_batch(
            &facade,
            RelationGovernanceBatchAction::CleanSourceCopy,
            vec![first_id.clone(), second_id.clone()],
            BTreeMap::new(),
        )
        .await;
        assert_eq!(outcome.state, RelationGovernanceBatchState::Failed);
        assert_eq!(outcome.blocked_count, 2);
        assert!(outcome
            .items
            .iter()
            .all(|item| item.state == RelationGovernanceBatchItemState::Blocked));

        // 逐行确认后进入准备，预览携带将被删除的原路径。
        let outcome = prepare_batch(
            &facade,
            RelationGovernanceBatchAction::CleanSourceCopy,
            vec![first_id.clone(), second_id.clone()],
            BTreeMap::from([confirmation(&first_id), confirmation(&second_id)]),
        )
        .await;
        assert_eq!(outcome.state, RelationGovernanceBatchState::Prepared);
        assert_eq!(outcome.prepared_count, 2);
        for item in &outcome.items {
            assert_eq!(item.state, RelationGovernanceBatchItemState::Prepared);
            assert!(!item.rollback_available);
            assert_eq!(
                item.affected_paths,
                vec![if item.relation_id == first_id {
                    first_original.clone()
                } else {
                    second.to_string_lossy().into_owned()
                }]
            );
        }

        // 预览后只保留第一行：第二行取消且毫发无损。
        let outcome = commit_batch(&facade, outcome.batch_id, vec![first_id.clone()]).await;
        assert_eq!(outcome.state, RelationGovernanceBatchState::Committed);
        let first_item = outcome
            .items
            .iter()
            .find(|item| item.relation_id == first_id)
            .expect("first item");
        assert_eq!(
            first_item.state,
            RelationGovernanceBatchItemState::Committed
        );
        assert!(first_item.rollback_available);
        let second_item = outcome
            .items
            .iter()
            .find(|item| item.relation_id == second_id)
            .expect("second item");
        assert_eq!(
            second_item.state,
            RelationGovernanceBatchItemState::Cancelled
        );
        assert!(!first.exists(), "committed cleanup removed the source");
        assert!(second.exists(), "cancelled cleanup left the source alone");
        let second_fact = relation_fact(&facade, &second_id).await;
        assert_eq!(second_fact.decision, SourceCopyDecision::Pending);
        let first_fact = relation_fact(&facade, &first_id).await;
        assert!(!first_fact.active, "committed row is archived");
        assert_eq!(
            first_fact.archive_reason,
            Some(SourceCopyArchiveReason::Cleaned)
        );
        let first_operation_id = first_item.operation_id.expect("child operation");
        assert_eq!(
            child_operation_kind(&facade, first_operation_id),
            "migrate_original",
            "cleanup children run under the original-migration operation kind"
        );

        // 批次回退：仅选中的行用备份恢复。
        let rolled = facade
            .execute(AppCommand::RollbackRelationGovernanceBatch(
                RollbackRelationGovernanceBatch {
                    batch_id: outcome.batch_id,
                    relation_ids: vec![first_id.clone()],
                },
            ))
            .await
            .expect("rollback batch");
        let AppCommandResult::RelationGovernanceBatch(rolled) = rolled else {
            panic!("expected batch outcome");
        };
        assert_eq!(
            rolled.items[0].state,
            RelationGovernanceBatchItemState::RolledBack
        );
        assert!(first.exists(), "rollback restored the original directory");
    }

    // 8.9：一行删除失败只影响该行，其余行照常提交（部分成功）。
    #[tokio::test]
    async fn clean_batch_delete_failure_keeps_the_other_rows_committed() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, _agent_root) = agent_facade(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let good = sources.path().join("batch-clean-good");
        let bad = sources.path().join("batch-clean-bad");
        write_skill(&good);
        write_skill(&bad);
        let good_id = import_source_copy(&facade, &good, "CleanGood").await;
        let bad_id = import_source_copy(&facade, &bad, "CleanBad").await;
        facade.set_original_migration_deletion_for_tests(std::sync::Arc::new(SelectiveDeletion {
            fail_when_contains: "batch-clean-bad".into(),
        }));

        let outcome = prepare_batch(
            &facade,
            RelationGovernanceBatchAction::CleanSourceCopy,
            vec![bad_id.clone(), good_id.clone()],
            BTreeMap::from([confirmation(&bad_id), confirmation(&good_id)]),
        )
        .await;
        assert_eq!(outcome.prepared_count, 2);

        let outcome = commit_batch(
            &facade,
            outcome.batch_id,
            vec![bad_id.clone(), good_id.clone()],
        )
        .await;
        assert_eq!(
            outcome.state,
            RelationGovernanceBatchState::PartiallyCommitted
        );
        let bad_item = outcome
            .items
            .iter()
            .find(|item| item.relation_id == bad_id)
            .expect("bad item");
        assert_eq!(bad_item.state, RelationGovernanceBatchItemState::Failed);
        assert!(bad.exists(), "failed row keeps the user's files");
        let bad_fact = relation_fact(&facade, &bad_id).await;
        assert!(bad_fact.active);
        assert_eq!(
            bad_fact.health,
            skillhub_core::relationship::SourceCopyHealth::OperationFailed
        );
        let good_item = outcome
            .items
            .iter()
            .find(|item| item.relation_id == good_id)
            .expect("good item");
        assert_eq!(good_item.state, RelationGovernanceBatchItemState::Committed);
        assert!(!good.exists(), "unrelated row committed as usual");
    }
}

// ===================== 8D：重关联（relink）与历史恢复 =====================

mod relink_history_restore {
    //! 8D 验收：ExternalRemoved 关系由用户选择新目录后，只有完整校验——
    //! 新目录 SKILL.md 声明名与集中库 runtime_name 一致（绝不按目录名
    //! 猜测身份）、新物理身份可建立且不与活动关系冲突——才建立新活动
    //! 关系；始终创建新关系与新历史事件，旧关系与旧 provenance event
    //! 原样保留（8.8/8.15）。

    use skillhub_core::relationship::{SourceCopyArchiveReason, SourceCopyDecision};
    use skillhub_core::{AppCommand, AppCommandResult, ErrorCode};

    use super::retain_and_cleanup_prepare::{agent_facade, import_source_copy, relation_fact};
    use super::*;

    fn write_named_skill(path: &std::path::Path, name: &str) {
        std::fs::create_dir_all(path).expect("skill directory");
        std::fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: relink fixture\n---\n\n# Notes\n"),
        )
        .expect("skill body");
    }

    async fn archive_external_removed(facade: &LocalApplicationFacade, relation_id: &str) {
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        database
            .relationship_repository()
            .archive_source_copy_relation(
                relation_id,
                SourceCopyArchiveReason::ExternalRemoved,
                123,
            )
            .expect("archive relation");
    }

    async fn active_relations(facade: &LocalApplicationFacade) -> usize {
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database lock");
        database
            .relationship_repository()
            .list_source_copy_relations(true)
            .expect("active relations")
            .len()
    }

    async fn relink(
        facade: &LocalApplicationFacade,
        relation_id: &str,
        new_source_path: &std::path::Path,
    ) -> Result<skillhub_core::relationship::SourceCopyRelationFact, skillhub_core::AppError> {
        match facade
            .execute(AppCommand::RelinkSourceCopy(
                skillhub_core::api::RelinkSourceCopy {
                    source_relation_id: relation_id.to_owned(),
                    new_source_path: new_source_path.to_string_lossy().into_owned(),
                },
            ))
            .await
        {
            Ok(AppCommandResult::SourceCopyRelationUpdated(fact)) => Ok(fact),
            Ok(other) => panic!("expected source copy relation, got {other:?}"),
            Err(error) => Err(error),
        }
    }

    // 8.8：身份与内容完整校验通过后新建活动关系；旧关系保持归档且
    // 原样保留，历史追加在新事件里，不改写旧记录。
    #[tokio::test]
    async fn relink_builds_a_new_active_relation_from_the_chosen_directory() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, _agent_root) = agent_facade(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let original = sources.path().join("relink-src");
        write_named_skill(&original, "relink-src");
        let old_relation = import_source_copy(&facade, &original, "relink-src").await;
        archive_external_removed(&facade, &old_relation).await;

        let restored = sources.path().join("relink-restored");
        write_named_skill(&restored, "relink-src");
        let fact = relink(&facade, &old_relation, &restored)
            .await
            .expect("relink succeeds");

        assert_ne!(fact.relation_id, old_relation, "always a new relation");
        assert!(fact.active);
        assert_eq!(fact.decision, SourceCopyDecision::Pending);
        assert_eq!(
            fact.health,
            skillhub_core::relationship::SourceCopyHealth::Normal,
            "identical content passes the follow-up full check"
        );
        assert!(
            fact.source_path.ends_with("relink-restored"),
            "source path points at the chosen directory: {}",
            fact.source_path
        );

        // 旧关系原样归档；来源动作只新增事实。
        let old_fact = relation_fact(&facade, &old_relation).await;
        assert!(!old_fact.active);
        assert_eq!(
            old_fact.archive_reason,
            Some(SourceCopyArchiveReason::ExternalRemoved)
        );
        assert_eq!(
            old_fact.source_path,
            original.to_string_lossy().into_owned()
        );
        assert_eq!(
            super::source_copy_batches::history_count(&facade, &old_relation, "relink", "relinked")
                .await,
            1,
            "one relinked history event anchored to the old relation"
        );
    }

    // 8.8：声明名不一致时拒绝——绝不按目录名猜测身份，也不产生新关系。
    #[tokio::test]
    async fn relink_refuses_directories_whose_declared_name_is_not_the_skill() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, _agent_root) = agent_facade(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let original = sources.path().join("relink-src");
        write_named_skill(&original, "relink-src");
        let old_relation = import_source_copy(&facade, &original, "relink-src").await;
        archive_external_removed(&facade, &old_relation).await;

        let impostor = sources.path().join("impostor");
        write_named_skill(&impostor, "totally-other");
        let error = relink(&facade, &old_relation, &impostor)
            .await
            .expect_err("name mismatch is refused");
        assert_eq!(error.code.as_str(), ErrorCode::InvalidInput.as_str());
        assert_eq!(active_relations(&facade).await, 0, "no new relation");
        assert_eq!(
            super::source_copy_batches::history_count(&facade, &old_relation, "relink", "relinked")
                .await,
            0
        );
    }

    // 8.8：新物理身份与活动关系冲突时拒绝（槽位被另一条活动关系占用）。
    #[tokio::test]
    async fn relink_refuses_slots_occupied_by_another_active_relation() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, _agent_root) = agent_facade(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let original = sources.path().join("relink-src");
        write_named_skill(&original, "relink-src");
        let old_relation = import_source_copy(&facade, &original, "relink-src").await;
        archive_external_removed(&facade, &old_relation).await;

        // 另一条活动关系已经占据新目录的物理槽位。
        let occupied = sources.path().join("relink-restored");
        write_named_skill(&occupied, "relink-src");
        import_source_copy(&facade, &occupied, "relink-src").await;

        let error = relink(&facade, &old_relation, &occupied)
            .await
            .expect_err("occupied slot is refused");
        assert_eq!(error.code.as_str(), ErrorCode::OperationConflict.as_str());
        let old_fact = relation_fact(&facade, &old_relation).await;
        assert!(!old_fact.active, "old relation stays archived");
        assert_eq!(active_relations(&facade).await, 1, "no new relation");
    }

    // 8.8/8.15：只有 ExternalRemoved 关系可重关联；未知关系、活动关系、
    // 不存在的新目录与集中库内部路径一律拒绝。
    #[tokio::test]
    async fn relink_only_applies_to_externally_removed_relations_with_real_directories() {
        let workspace = tempfile::tempdir().expect("workspace");
        let (facade, _agent_root) = agent_facade(workspace.path());
        let sources = tempfile::tempdir().expect("sources");
        let original = sources.path().join("relink-src");
        write_named_skill(&original, "relink-src");
        let active_relation = import_source_copy(&facade, &original, "relink-src").await;

        let restored = sources.path().join("relink-restored");
        write_named_skill(&restored, "relink-src");

        let still_active = relink(&facade, &active_relation, &restored)
            .await
            .expect_err("active relations are not relinkable");
        assert_eq!(
            still_active.code.as_str(),
            ErrorCode::OperationConflict.as_str()
        );

        let unknown = relink(&facade, "rel-unknown", &restored)
            .await
            .expect_err("unknown relation");
        assert_eq!(unknown.code.as_str(), ErrorCode::ObjectNotFound.as_str());

        archive_external_removed(&facade, &active_relation).await;
        let missing = relink(&facade, &active_relation, &sources.path().join("nope"))
            .await
            .expect_err("missing directory");
        assert_eq!(missing.code.as_str(), ErrorCode::InvalidInput.as_str());

        let under_library = workspace.path().join("library/inside");
        write_named_skill(&under_library, "relink-src");
        let managed = relink(&facade, &active_relation, &under_library)
            .await
            .expect_err("library-internal paths are not sources");
        assert_eq!(managed.code.as_str(), ErrorCode::InvalidInput.as_str());
    }
}

/// 8.5 测试注入：删除永远失败的文件系统假象（模拟权限墙/占用）。
pub mod failing_deletion {
    pub struct FailingDeletion;

    impl skillhub_application::OriginalMigrationDeletion for FailingDeletion {
        fn delete_dir_all(&self, _path: &std::path::Path) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected deletion failure",
            ))
        }
    }

    /// 8.9 测试注入：只对命中片段的路径注入删除失败，其余照常删除，
    /// 用于验证批处理中单行失败不影响其余行。
    pub struct SelectiveDeletion {
        pub fail_when_contains: String,
    }

    impl skillhub_application::OriginalMigrationDeletion for SelectiveDeletion {
        fn delete_dir_all(&self, path: &std::path::Path) -> std::io::Result<()> {
            if path.to_string_lossy().contains(&self.fail_when_contains) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected selective deletion failure",
                ));
            }
            std::fs::remove_dir_all(path)
        }
    }
}
