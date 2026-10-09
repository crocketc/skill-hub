//! Unified usage-release contract tests.
//!
//! These tests use a real SQLite database and real directory entries. The
//! preview is read-only; a release is only committed through the prepared
//! snapshot returned by the application facade.

use std::panic::Location;
use std::path::{Path, PathBuf};

use serde_json::Value;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    AgentDirectoryRole, AgentRootObservation, ClientInstance, ClientKind, ClientPresence,
    DirectoryObservationStatus, DirectoryPrecedence, DiscoverySnapshot, LogicalTarget,
    OperatingSystem, PhysicalTarget, TargetScope,
};
use skillhub_core::api::{
    CommitUsageChange, CreateSkill, GetRelationshipOverview, ListSkills, PrepareUsageChange,
    RelationshipOverviewScope,
};
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DeploymentRelationFact, DirectoryNodeFact, DirectoryRecognition,
    DirectoryRole, FileRepresentation, OwnershipState, RelationHealthReason, RelationshipType,
    UsageChangeAction, UsageChangeImpactAction, UsageCopyDisposition, UsageDecision, UsageEntryKey,
};
use skillhub_core::{
    AppCommand, AppQuery, AppQueryResult, ApplicationFacade, OperationId, SkillId,
};
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_ID: &str = "agent.release-fixture";
const DIRECTORY_ID: &str = "directory:agent-release-skills";
const RELATION_ID: &str = "usage:agent-release-fixture:notes";
const SECOND_RELATION_ID: &str = "usage:second-consumer:notes";
const SECOND_TARGET_RELATION_ID: &str = "usage:z-second-target:notes";
const PROFILE_ID: &str = "release-fixture";
const AGENT_ROOT_ID: &str = "agent-root-release-fixture";
const SKILL_BODY: &str = "---\nname: notes\n---\n\nrelease fixture\n";

struct Fixture {
    _workspace: tempfile::TempDir,
    database_path: PathBuf,
    library_root: PathBuf,
    facade: LocalApplicationFacade,
    skill_id: SkillId,
    original_path: PathBuf,
    subject_path: PathBuf,
    entry_path: PathBuf,
    expected_fingerprint: String,
}

#[derive(Clone, Copy)]
enum EntryKind {
    Link,
    FullCopy,
}

#[derive(Clone, Copy)]
enum DirectoryKind {
    AgentUser,
    Builtin,
    Shared,
    Unknown,
}

#[track_caller]
fn skip_if_link_creation_unavailable() -> bool {
    let workspace = tempfile::tempdir().expect("link capability workspace");
    let source = workspace.path().join("source");
    let destination = workspace.path().join("destination");
    std::fs::create_dir(&source).expect("link capability source");
    if create_dir_link(&source, &destination).is_ok()
        && std::fs::symlink_metadata(&destination)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return false;
    }
    assert_ne!(
        std::env::var("SKILLHUB_REQUIRE_SYMLINK_CAPABILITY").as_deref(),
        Ok("1"),
        "{}: host was required to provide symbolic-link capability",
        Location::caller().line()
    );
    let _ = std::io::Write::write_all(
        &mut std::io::stderr(),
        format!(
            "SKILLHUB-TEST-SKIP; facade_usage_release; line {}; host cannot create symbolic links; guarded assertions did not run\n",
            Location::caller().line()
        )
        .as_bytes(),
    );
    true
}

fn write_skill(path: &Path) {
    std::fs::create_dir_all(path).expect("create skill directory");
    std::fs::write(path.join("SKILL.md"), SKILL_BODY).expect("write skill body");
}

#[cfg(unix)]
fn create_dir_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
}

#[cfg(windows)]
fn create_dir_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(source, destination)
}

async fn fixture(kind: EntryKind, managed: bool) -> Fixture {
    fixture_with_directory(kind, managed, DirectoryKind::AgentUser).await
}

async fn fixture_with_directory(
    kind: EntryKind,
    managed: bool,
    directory_kind: DirectoryKind,
) -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    let database = Database::open(&database_path).expect("database");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    let original_path = workspace.path().join("source/notes");
    write_skill(&original_path);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: original_path.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create subject");
    let listed = facade
        .query(AppQuery::ListSkills(ListSkills {
            text: "Notes".into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list subject");
    let AppQueryResult::SkillPage(page) = listed else {
        panic!("expected skill page");
    };
    let skill_id = page.items[0].skill_id;
    let library = facade
        .library_runtime()
        .snapshot()
        .expect("library snapshot");
    let subject_path = library
        .central
        .visible_skill_path_for_runtime(skill_id, "Notes");

    let entry_directory = workspace.path().join("agent/skills");
    std::fs::create_dir_all(&entry_directory).expect("create Agent directory");
    let entry_path = entry_directory.join("notes");
    match kind {
        EntryKind::Link => {
            create_dir_link(&subject_path, &entry_path).expect("create directory link")
        }
        EntryKind::FullCopy => std::fs::create_dir_all(&entry_path).expect("copy entry dir"),
    }
    if matches!(kind, EntryKind::FullCopy) {
        std::fs::copy(subject_path.join("SKILL.md"), entry_path.join("SKILL.md"))
            .expect("copy subject body");
    }
    let expected_fingerprint =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&entry_path)
            .expect("entry fingerprint");

    let database = facade.database_for_tests();
    let database_guard = database.lock().expect("database lock");
    database_guard
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: DIRECTORY_ID.into(),
            path: entry_directory.to_string_lossy().into_owned(),
            path_key: String::new(),
            role: DirectoryRole::AgentNative,
            profile_id: Some("release-profile".into()),
            agent_client_id: Some(CLIENT_ID.into()),
            exists: true,
            observed_at: 1,
            scan_source: Some("usage-release-test".into()),
        })
        .expect("directory node");
    database_guard
        .relationship_repository()
        .upsert_capability(&AgentDirectoryCapabilityFact {
            agent_client_id: CLIENT_ID.into(),
            directory_node_id: DIRECTORY_ID.into(),
            recognition: DirectoryRecognition::Supported,
            precedence: DirectoryPrecedence::Preferred,
            evidence_reference: Some("usage-release-test".into()),
            researched_at: Some("2026-10-09".into()),
            applicable_platforms: vec!["macos".into(), "windows".into()],
        })
        .expect("Agent directory capability");
    if !matches!(directory_kind, DirectoryKind::Unknown) {
        let agent_root = workspace.path().join("agent");
        let agent_root_physical_id =
            skillhub_core::physical_id_for_path(&agent_root).expect("Agent root physical identity");
        let physical_id = skillhub_core::physical_id_for_path(&entry_directory)
            .expect("Agent target physical identity");
        let builtin = matches!(directory_kind, DirectoryKind::Builtin);
        database_guard
            .agent_repository()
            .replace(&DiscoverySnapshot {
                generation: "1".into(),
                observed_at: "2026-10-09T00:00:00Z".into(),
                instances: vec![ClientInstance {
                    profile_id: PROFILE_ID.into(),
                    client_id: CLIENT_ID.into(),
                    kind: ClientKind::Cli,
                    display_name: "Release Fixture Agent".into(),
                    supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                    client_presence: ClientPresence::Unknown,
                }],
                agent_roots: vec![AgentRootObservation {
                    id: AGENT_ROOT_ID.into(),
                    profile_id: PROFILE_ID.into(),
                    client_id: CLIENT_ID.into(),
                    scope: TargetScope::Global,
                    path: agent_root.to_string_lossy().into_owned(),
                    status: DirectoryObservationStatus::Existing,
                    exists: true,
                    readable: true,
                    writable: true,
                    physical_id: Some(agent_root_physical_id),
                    physical_identity_verified: true,
                }],
                logical_targets: vec![LogicalTarget {
                    id: "target-release-fixture".into(),
                    profile_id: PROFILE_ID.into(),
                    client_id: CLIENT_ID.into(),
                    scope: TargetScope::Global,
                    path: entry_directory.to_string_lossy().into_owned(),
                    agent_root_id: AGENT_ROOT_ID.into(),
                    marker: "skills".into(),
                    precedence: DirectoryPrecedence::Preferred,
                    shared_reference: matches!(directory_kind, DirectoryKind::Shared),
                    builtin,
                    exists: true,
                    readable: true,
                    writable: !builtin,
                    available: true,
                    physical_id: physical_id.clone(),
                    status: DirectoryObservationStatus::Existing,
                    physical_identity_verified: true,
                }],
                physical_targets: vec![PhysicalTarget {
                    id: physical_id,
                    path: entry_directory.to_string_lossy().into_owned(),
                    exists: true,
                    readable: true,
                    writable: !builtin,
                    case_behavior: "sensitive".into(),
                    logical_target_ids: vec!["target-release-fixture".into()],
                }],
            })
            .expect("registered Agent directory projection");
    }
    database_guard
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: RELATION_ID.into(),
            skill_id: Some(skill_id),
            agent_client_id: CLIENT_ID.into(),
            path: entry_path.to_string_lossy().into_owned(),
            path_key: String::new(),
            directory_node_id: Some(DIRECTORY_ID.into()),
            relationship: match kind {
                EntryKind::Link => RelationshipType::ManagedLink,
                EntryKind::FullCopy => RelationshipType::ManagedCopy,
            },
            file_representation: match kind {
                EntryKind::Link => FileRepresentation::SymbolicLink,
                EntryKind::FullCopy => FileRepresentation::Copy,
            },
            ownership: if managed {
                OwnershipState::SkillhubManaged
            } else {
                OwnershipState::ObservedUnmanaged
            },
            link_target_path: matches!(kind, EntryKind::Link)
                .then(|| subject_path.to_string_lossy().into_owned()),
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: expected_fingerprint.clone(),
            origin: ObservedOrigin::Scan,
            match_state: ObservedMatchState::ContentVerified,
            health_reasons: Some(Vec::new()),
            active: true,
            observed_at: 1,
            released_at: None,
        })
        .expect("deployment relation");
    drop(database_guard);

    Fixture {
        _workspace: workspace,
        database_path,
        library_root,
        facade,
        skill_id,
        original_path,
        subject_path,
        entry_path,
        expected_fingerprint,
    }
}

fn prepare_release(
    facade: &LocalApplicationFacade,
    relation_id: &str,
    copy_disposition: Option<UsageCopyDisposition>,
) -> skillhub_core::relationship::PreparedUsageChange {
    facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![relation_id.to_owned()],
            problem_id: None,
            skill_id: None,
            requested_form: None,
            copy_disposition,
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: Vec::new(),
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect("prepare release")
}

#[tokio::test]
async fn release_skill_and_entry_selection_matches_relation_selection() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let by_relation = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::KeepIndependent),
    );
    let by_entry = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: Vec::new(),
            problem_id: None,
            skill_id: Some(fixture.skill_id),
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: vec![usage_entry_key()],
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect("prepare by skill and selected entry key");

    assert_eq!(by_entry.action, by_relation.action);
    assert_eq!(
        by_entry.relationship_revision,
        by_relation.relationship_revision
    );
    assert_eq!(by_entry.affected_skill_ids, by_relation.affected_skill_ids);
    assert_eq!(by_entry.subject_versions, by_relation.subject_versions);
    assert_eq!(by_entry.entry_evidence, by_relation.entry_evidence);
    assert_eq!(by_entry.consumers, by_relation.consumers);
    assert_eq!(by_entry.impacts, by_relation.impacts);
    assert_eq!(by_entry.limitations, by_relation.limitations);
}

#[tokio::test]
async fn release_relation_representative_expands_to_all_entry_evidence() {
    let fixture = fixture_with_directory(EntryKind::FullCopy, true, DirectoryKind::Shared).await;
    let second_client = "agent.release-shared-evidence";
    register_shared_directory_capability(&fixture, second_client);
    add_shared_directory_member(&fixture, second_client);
    {
        let database = fixture.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let mut second = database
            .relationship_repository()
            .list_relations()
            .expect("deployment relations")
            .into_iter()
            .find(|relation| relation.relation_id == RELATION_ID)
            .expect("first deployment relation");
        second.relation_id = SECOND_RELATION_ID.into();
        second.agent_client_id = second_client.into();
        second.observed_at += 1;
        database
            .relationship_repository()
            .upsert_deployment_relation(&second)
            .expect("second Agent evidence for same shared entry");
    }
    let AppQueryResult::RelationshipOverview(overview) = fixture
        .facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::All,
        }))
        .await
        .expect("relationship overview")
    else {
        panic!("expected relationship overview");
    };
    let view = overview
        .usage_relations
        .iter()
        .find(|view| view.evidence_relation_ids.len() == 2)
        .unwrap_or_else(|| panic!("unified usage views: {:#?}", overview.usage_relations));
    let mut expected_ids = vec![RELATION_ID.to_owned(), SECOND_RELATION_ID.to_owned()];
    expected_ids.sort();
    assert_eq!(view.evidence_relation_ids, expected_ids);

    let prepared = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![view.relation_id.clone()],
            problem_id: None,
            skill_id: None,
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: Vec::new(),
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect("representative relation ID expands through the unified view");
    assert_eq!(prepared.entry_evidence.len(), 1);
    assert_eq!(prepared.entry_evidence[0].relation_ids, expected_ids);
    let result = commit_release(&fixture.facade, &prepared).expect("commit expanded usage");
    assert_eq!(result.item_results.len(), 1);
    assert!(fixture.entry_path.join("SKILL.md").is_file());

    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let history = database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("usage decision history");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].relation_ids, expected_ids);
    assert!(!database
        .relationship_repository()
        .list_relations()
        .expect("deployment relations")
        .iter()
        .any(|relation| {
            [RELATION_ID, SECOND_RELATION_ID].contains(&relation.relation_id.as_str())
                && relation.active
        }));
}

#[tokio::test]
async fn release_relation_id_mapping_rejects_ambiguous_usage_views() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let other_source = fixture._workspace.path().join("other-source/notes");
    write_skill(&other_source);
    fixture
        .facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Other Notes".into(),
            source_path: other_source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create second subject");
    let AppQueryResult::SkillPage(page) = fixture
        .facade
        .query(AppQuery::ListSkills(ListSkills {
            text: "Other Notes".into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list second subject")
    else {
        panic!("expected skill page");
    };
    let other_skill_id = page.items[0].skill_id;
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let provenance_id = "provenance:ambiguous-release-evidence";
    let batch_id = "batch:ambiguous-release-evidence";
    database
        .provenance_repository()
        .begin_import_batch(batch_id, 1)
        .expect("begin provenance batch");
    database
        .provenance_repository()
        .append_provenance_event(&skillhub_core::import::ImportProvenanceEvent {
            provenance_id: provenance_id.into(),
            batch_id: batch_id.into(),
            skill_id: other_skill_id,
            source_class: skillhub_core::import::ImportSourceClass::AgentLocal,
            source: skillhub_core::source::SourceDescriptor::new(
                skillhub_core::source::SourceKind::Local,
                skillhub_core::source::SourceLocator::local_path(fixture.entry_path.clone()),
            ),
            local_source_path: Some(fixture.entry_path.to_string_lossy().into_owned()),
            source_container_id: Some(DIRECTORY_ID.into()),
            physical_source_id: Some(
                skillhub_core::physical_id_for_path(&fixture.entry_path)
                    .expect("entry physical id"),
            ),
            agent_client_id: Some(CLIENT_ID.into()),
            content_fingerprint: fixture.expected_fingerprint.clone(),
            imported_at: 1,
        })
        .expect("append valid provenance event");
    database
        .relationship_repository()
        .upsert_source_copy_relation(
            &skillhub_core::relationship::SourceCopyRelationFact {
                relation_id: RELATION_ID.into(),
                skill_id: other_skill_id,
                latest_provenance_id: provenance_id.into(),
                source_class: skillhub_core::import::ImportSourceClass::AgentLocal,
                source_path: fixture.entry_path.to_string_lossy().into_owned(),
                source_path_key: String::new(),
                physical_source_id: skillhub_core::physical_id_for_path(&fixture.entry_path)
                    .expect("entry physical id"),
                source_container_id: Some(DIRECTORY_ID.into()),
                directory_node_id: Some(DIRECTORY_ID.into()),
                agent_client_id: Some(CLIENT_ID.into()),
                expected_fingerprint: fixture.expected_fingerprint.clone(),
                current_fingerprint: Some(fixture.expected_fingerprint.clone()),
                decision: skillhub_core::relationship::SourceCopyDecision::Retained,
                health: skillhub_core::relationship::SourceCopyHealth::NeedsValidation,
                health_reasons: None,
                active: true,
                last_verified_at: None,
                archived_at: None,
                archive_reason: None,
            },
            "usage-release-ambiguous-test",
            1,
        )
        .expect("insert cross-table ambiguous evidence");
    drop(database);

    let error = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![RELATION_ID.into()],
            problem_id: None,
            skill_id: None,
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: Vec::new(),
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect_err("one relation id must not ambiguously select two unified views");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_change_evidence_ambiguous"),
    );
    assert!(fixture.entry_path.join("SKILL.md").is_file());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no release decision")
        .is_empty());
}

#[tokio::test]
async fn release_selection_rejects_empty_mixed_and_out_of_skill_scopes() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let request = |operation_id, relation_ids, skill_id, selected_entry_keys| PrepareUsageChange {
        operation_id,
        action: UsageChangeAction::Release,
        relation_ids,
        problem_id: None,
        skill_id,
        requested_form: None,
        copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
        content_basis: None,
        retain_entry_key: None,
        selected_entry_keys,
        runtime_name: None,
        base_version_id: None,
        non_recognized_destination: None,
    };

    assert!(fixture
        .facade
        .prepare_usage_change(request(OperationId::new(), Vec::new(), None, Vec::new()))
        .is_err());
    assert!(fixture
        .facade
        .prepare_usage_change(request(
            OperationId::new(),
            vec![RELATION_ID.into()],
            Some(fixture.skill_id),
            vec![usage_entry_key()],
        ))
        .is_err());
    assert!(fixture
        .facade
        .prepare_usage_change(request(
            OperationId::new(),
            Vec::new(),
            Some(SkillId::new()),
            vec![usage_entry_key()],
        ))
        .is_err());
}

#[tokio::test]
async fn release_mixed_link_and_copy_uses_one_preview_and_per_entry_actions() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let link_path = add_managed_link_entry(&fixture, "notes-link", "usage:agent:notes-link");
    let prepared = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: Vec::new(),
            problem_id: None,
            skill_id: Some(fixture.skill_id),
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: vec![usage_entry_key(), usage_entry_key_for("notes-link")],
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect("prepare mixed link and copy selection together");

    assert_eq!(prepared.impacts.len(), 2);
    assert!(prepared.impacts.iter().any(|impact| {
        impact.relation_ids == [RELATION_ID]
            && impact.action == UsageChangeImpactAction::KeepIndependentCopy
    }));
    assert!(prepared.impacts.iter().any(|impact| {
        impact.relation_ids == ["usage:agent:notes-link"]
            && impact.action == UsageChangeImpactAction::RemoveLink
    }));

    let result = commit_release(&fixture.facade, &prepared).expect("commit mixed release");
    assert_eq!(result.item_results.len(), 2);
    assert!(is_absent(&link_path));
    assert!(fixture.entry_path.join("SKILL.md").is_file());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let copy_history = database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("copy decision history");
    let link_history = database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key_for("notes-link"))
        .expect("link decision history");
    assert_eq!(copy_history.len(), 1);
    assert_eq!(
        copy_history[0].decision,
        UsageDecision::RetainedIndependentCopy
    );
    assert_eq!(link_history.len(), 1);
    assert_eq!(link_history[0].decision, UsageDecision::Released);
}

#[tokio::test]
async fn release_rejects_copy_disposition_when_selection_has_no_copy() {
    let fixture = fixture(EntryKind::Link, true).await;
    let error = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![RELATION_ID.into()],
            problem_id: None,
            skill_id: None,
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: Vec::new(),
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect_err("copy choice is inapplicable when selection only contains links");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("copy_disposition_not_applicable"),
    );
}

fn set_health_reason(fixture: &Fixture, reason: RelationHealthReason) {
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let mut relation = database
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == RELATION_ID)
        .expect("deployment relation");
    relation.health_reasons = Some(vec![reason]);
    relation.match_state = ObservedMatchState::Diverged;
    database
        .relationship_repository()
        .upsert_deployment_relation(&relation)
        .expect("set abnormal relation health");
}

fn register_shared_directory_capability(fixture: &Fixture, client_id: &str) {
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    database
        .relationship_repository()
        .upsert_capability(&AgentDirectoryCapabilityFact {
            agent_client_id: client_id.into(),
            directory_node_id: DIRECTORY_ID.into(),
            recognition: DirectoryRecognition::Supported,
            precedence: DirectoryPrecedence::Preferred,
            evidence_reference: Some("usage-release-shared-consumer-test".into()),
            researched_at: Some("2026-10-09".into()),
            applicable_platforms: vec!["macos".into(), "windows".into()],
        })
        .expect("register second Agent shared-directory capability");
}

fn add_shared_directory_member(fixture: &Fixture, client_id: &str) {
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let mut snapshot = database
        .agent_repository()
        .load()
        .expect("load discovery snapshot")
        .expect("discovery snapshot exists");
    let shared_directory = fixture.entry_path.parent().expect("shared directory path");
    let shared_physical_id =
        skillhub_core::physical_id_for_path(shared_directory).expect("shared physical identity");
    let other_root = fixture._workspace.path().join("other-agent");
    std::fs::create_dir_all(&other_root).expect("create other Agent root");
    let other_root_physical_id =
        skillhub_core::physical_id_for_path(&other_root).expect("other Agent root identity");
    let other_profile_id = format!("profile:{client_id}");
    let other_root_id = format!("root:{client_id}");
    let other_target_id = format!("target:{client_id}");
    snapshot.instances.push(ClientInstance {
        profile_id: other_profile_id.clone(),
        client_id: client_id.into(),
        kind: ClientKind::Cli,
        display_name: "Shared Consumer Agent".into(),
        supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
        client_presence: ClientPresence::Unknown,
    });
    snapshot.agent_roots.push(AgentRootObservation {
        id: other_root_id.clone(),
        profile_id: other_profile_id.clone(),
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: other_root.to_string_lossy().into_owned(),
        status: DirectoryObservationStatus::Existing,
        exists: true,
        readable: true,
        writable: true,
        physical_id: Some(other_root_physical_id),
        physical_identity_verified: true,
    });
    snapshot.logical_targets.push(LogicalTarget {
        id: other_target_id.clone(),
        profile_id: other_profile_id,
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: shared_directory.to_string_lossy().into_owned(),
        agent_root_id: other_root_id,
        marker: "shared-skills".into(),
        precedence: DirectoryPrecedence::Preferred,
        shared_reference: true,
        builtin: false,
        exists: true,
        readable: true,
        writable: true,
        available: true,
        physical_id: shared_physical_id.clone(),
        status: DirectoryObservationStatus::Existing,
        physical_identity_verified: true,
    });
    let physical_target = snapshot
        .physical_targets
        .iter_mut()
        .find(|target| target.id == shared_physical_id)
        .expect("shared physical target");
    physical_target.logical_target_ids.push(other_target_id);
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("add shared directory member without a deployment relation");
}

fn commit_release(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::relationship::PreparedUsageChange,
) -> skillhub_core::AppResult<skillhub_core::relationship::UsageChangeResult> {
    facade.commit_usage_change(CommitUsageChange {
        operation_id: prepared.operation_id,
        prepared_id: prepared.prepared_id,
    })
}

fn usage_entry_key() -> UsageEntryKey {
    usage_entry_key_for("notes")
}

fn usage_entry_key_for(entry: &str) -> UsageEntryKey {
    UsageEntryKey {
        directory_id: DIRECTORY_ID.into(),
        relative_entry_path: entry.into(),
    }
}

fn add_managed_link_entry(fixture: &Fixture, name: &str, relation_id: &str) -> PathBuf {
    let link_path = fixture
        .entry_path
        .parent()
        .expect("Agent directory")
        .join(name);
    create_dir_link(&fixture.subject_path, &link_path).expect("create managed link entry");
    let fingerprint = skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&link_path)
        .expect("link target fingerprint");
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    database
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: relation_id.into(),
            skill_id: Some(fixture.skill_id),
            agent_client_id: CLIENT_ID.into(),
            path: link_path.to_string_lossy().into_owned(),
            path_key: String::new(),
            directory_node_id: Some(DIRECTORY_ID.into()),
            relationship: RelationshipType::ManagedLink,
            file_representation: FileRepresentation::SymbolicLink,
            ownership: OwnershipState::SkillhubManaged,
            link_target_path: Some(fixture.subject_path.to_string_lossy().into_owned()),
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: fingerprint,
            origin: ObservedOrigin::Scan,
            match_state: ObservedMatchState::ContentVerified,
            health_reasons: Some(Vec::new()),
            active: true,
            observed_at: 2,
            released_at: None,
        })
        .expect("managed link relation");
    link_path
}

fn add_second_managed_copy_entry(fixture: &Fixture) -> PathBuf {
    let second_entry = fixture
        .entry_path
        .parent()
        .expect("Agent directory")
        .join("notes-second");
    std::fs::create_dir_all(&second_entry).expect("create second copy entry");
    std::fs::copy(
        fixture.subject_path.join("SKILL.md"),
        second_entry.join("SKILL.md"),
    )
    .expect("copy subject to second entry");
    let fingerprint = skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&second_entry)
        .expect("second copy fingerprint");
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let mut relation = database
        .relationship_repository()
        .list_relations()
        .expect("deployment relations")
        .into_iter()
        .find(|relation| relation.relation_id == RELATION_ID)
        .expect("first deployment relation");
    relation.relation_id = SECOND_TARGET_RELATION_ID.into();
    relation.path = second_entry.to_string_lossy().into_owned();
    relation.content_fingerprint = fingerprint;
    relation.observed_at += 1;
    database
        .relationship_repository()
        .upsert_deployment_relation(&relation)
        .expect("second deployment relation");
    second_entry
}

fn add_shared_client_usage_entry(
    fixture: &Fixture,
    client_id: &str,
    entry_name: &str,
    relation_id: &str,
) -> PathBuf {
    let entry = fixture
        .entry_path
        .parent()
        .expect("shared directory")
        .join(entry_name);
    std::fs::create_dir_all(&entry).expect("create unrelated usage entry");
    std::fs::copy(
        fixture.subject_path.join("SKILL.md"),
        entry.join("SKILL.md"),
    )
    .expect("copy skill to unrelated usage entry");
    let fingerprint = skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&entry)
        .expect("unrelated usage fingerprint");
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let mut relation = database
        .relationship_repository()
        .list_relations()
        .expect("deployment relations")
        .into_iter()
        .find(|relation| relation.relation_id == RELATION_ID)
        .expect("primary relation");
    relation.relation_id = relation_id.to_owned();
    relation.agent_client_id = client_id.to_owned();
    relation.path = entry.to_string_lossy().into_owned();
    relation.content_fingerprint = fingerprint;
    relation.observed_at += 2;
    database
        .relationship_repository()
        .upsert_deployment_relation(&relation)
        .expect("add unrelated path usage");
    entry
}

fn is_absent(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_err()
}

#[tokio::test]
async fn release_link_removes_only_link() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::Link, true).await;
    assert!(std::fs::symlink_metadata(&fixture.entry_path)
        .expect("link entry")
        .file_type()
        .is_symlink());
    let before =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.subject_path)
            .expect("subject hash before");

    let prepared = prepare_release(&fixture.facade, RELATION_ID, None);
    assert!(
        !is_absent(&fixture.entry_path),
        "prepare is read-only; entry remains"
    );
    let result = commit_release(&fixture.facade, &prepared).expect("commit release");

    assert!(
        is_absent(&fixture.entry_path),
        "only the link entry is removed"
    );
    assert!(
        fixture.original_path.exists(),
        "the user's source stays intact"
    );
    assert!(
        fixture.subject_path.exists(),
        "the Skill subject stays intact"
    );
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.subject_path)
            .expect("subject hash after"),
        before,
    );
    assert!(!result.recovery_required);
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let history = database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("usage decision history");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].decision, UsageDecision::Released);
    assert_eq!(history[0].relation_ids, vec![RELATION_ID]);
}

#[tokio::test]
async fn release_copy_keep_preserves_files_and_archives() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::KeepIndependent),
    );
    let result = commit_release(&fixture.facade, &prepared).expect("commit keep decision");

    assert!(fixture.entry_path.join("SKILL.md").exists());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("copy remains intact"),
        fixture.expected_fingerprint,
    );
    assert!(!result.recovery_required);
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let history = database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("usage decision history");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].decision, UsageDecision::RetainedIndependentCopy);
    assert!(!database
        .relationship_repository()
        .list_relations()
        .expect("deployment facts")
        .iter()
        .any(|relation| relation.relation_id == RELATION_ID && relation.active));
}

#[tokio::test]
async fn full_copy_fact_rejects_root_link_replacement_before_keep_prepare() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let target_fingerprint =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.subject_path)
            .expect("subject fingerprint before replacement");
    std::fs::remove_dir_all(&fixture.entry_path).expect("remove prepared copy fixture");
    create_dir_link(&fixture.subject_path, &fixture.entry_path)
        .expect("replace managed copy with a root directory link");
    assert!(
        std::fs::symlink_metadata(&fixture.entry_path)
            .expect("replacement entry metadata")
            .file_type()
            .is_symlink(),
        "the fixture must be a root link, not a copied directory"
    );

    let error = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![RELATION_ID.into()],
            problem_id: None,
            skill_id: None,
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: Vec::new(),
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect_err("a copied fact must not authorize keeping an actual root link");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_entry_representation_changed"),
    );
    assert!(std::fs::symlink_metadata(&fixture.entry_path)
        .expect("replaced entry remains")
        .file_type()
        .is_symlink());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.subject_path)
            .expect("subject unchanged after rejected prepare"),
        target_fingerprint,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no decision for mismatched physical form")
        .is_empty());
    assert!(database
        .relationship_repository()
        .list_relations()
        .expect("active relation remains")
        .iter()
        .any(|relation| relation.relation_id == RELATION_ID && relation.active));
}

#[cfg(unix)]
#[tokio::test]
async fn inaccessible_entry_is_not_treated_as_missing_release() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture(EntryKind::FullCopy, true).await;
    let parent = fixture.entry_path.parent().expect("entry parent");
    let original_mode = std::fs::metadata(parent)
        .expect("entry parent metadata")
        .permissions()
        .mode();
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o000))
        .expect("remove parent search permission");
    let access_error_kind = std::fs::symlink_metadata(&fixture.entry_path)
        .err()
        .map(|error| error.kind());
    if access_error_kind != Some(std::io::ErrorKind::PermissionDenied) {
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(original_mode))
            .expect("restore parent permissions after unavailable denial fixture");
        panic!("unsearchable parent did not produce PermissionDenied: {access_error_kind:?}");
    }

    let result = fixture.facade.prepare_usage_change(PrepareUsageChange {
        operation_id: OperationId::new(),
        action: UsageChangeAction::Release,
        relation_ids: vec![RELATION_ID.into()],
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
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(original_mode))
        .expect("restore parent permissions");

    let error = result.expect_err("access failure must not be interpreted as a missing entry");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_entry_access_unverified"),
    );
    assert!(fixture.entry_path.join("SKILL.md").is_file());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("entry remains unchanged"),
        fixture.expected_fingerprint,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("access failure has no release decision")
        .is_empty());
    assert!(database
        .relationship_repository()
        .list_relations()
        .expect("deployment facts")
        .iter()
        .any(|relation| relation.relation_id == RELATION_ID && relation.active));
}

#[tokio::test]
async fn release_copy_keep_records_decision_time_fingerprint() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    std::fs::write(
        fixture.entry_path.join("SKILL.md"),
        "---\nname: notes\n---\n\nchanged before release\n",
    )
    .expect("change copied entry before release");
    set_health_reason(&fixture, RelationHealthReason::ContentChanged);
    let actual_fingerprint =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("hash decision-time copy");
    assert_ne!(actual_fingerprint, fixture.expected_fingerprint);

    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::KeepIndependent),
    );
    assert_eq!(
        prepared.impacts[0].action,
        UsageChangeImpactAction::KeepIndependentCopy,
    );
    commit_release(&fixture.facade, &prepared).expect("archive changed copy as independent");
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("kept copy fingerprint"),
        actual_fingerprint,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
            .expect("released-copy decision history")[0]
            .content_fingerprint
            .as_deref(),
        Some(actual_fingerprint.as_str()),
    );
}

#[tokio::test]
async fn release_copy_remove_has_verified_recovery() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let original_fingerprint =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.original_path)
            .expect("original source fingerprint before release");
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let result = commit_release(&fixture.facade, &prepared).expect("commit removal");

    assert!(is_absent(&fixture.entry_path));
    assert!(fixture.subject_path.join("SKILL.md").exists());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.original_path)
            .expect("original source remains unchanged"),
        original_fingerprint,
    );
    assert!(!result.recovery_required);
    let backup = result.item_results[0]
        .recovery_point
        .as_ref()
        .expect("verified backup recovery point");
    assert_eq!(
        backup.fingerprint,
        Some(fixture.expected_fingerprint.clone())
    );
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(Path::new(&backup.path))
            .expect("backup fingerprint"),
        fixture.expected_fingerprint,
    );
}

#[tokio::test]
async fn release_unmanaged_is_record_only() {
    let fixture = fixture(EntryKind::FullCopy, false).await;
    let prepared = prepare_release(&fixture.facade, RELATION_ID, None);
    let result = commit_release(&fixture.facade, &prepared).expect("commit record-only release");

    assert!(fixture.entry_path.join("SKILL.md").exists());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("unmanaged entry stays intact"),
        fixture.expected_fingerprint,
    );
    assert!(!result.recovery_required);
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
            .expect("usage decision history")[0]
            .decision,
        UsageDecision::Released,
    );
}

#[tokio::test]
async fn cancel_or_stale_preview_does_not_mutate() {
    // Abandoning a preview leaves both the entry and the decision ledger alone.
    let abandoned = fixture(EntryKind::FullCopy, true).await;
    let _abandoned_preview = prepare_release(
        &abandoned.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&abandoned.entry_path)
            .expect("abandoned preview leaves file intact"),
        abandoned.expected_fingerprint,
    );

    // A library version change invalidates the exact prepared snapshot.
    let version_changed = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &version_changed.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let replacement_version = skillhub_core::VersionId::parse(
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    )
    .expect("replacement version id");
    skillhub_storage::CentralLibrary::open_existing(&version_changed.library_root)
        .expect("open library")
        .set_portable_current_version(version_changed.skill_id, Some(&replacement_version))
        .expect("change subject version");
    assert!(commit_release(&version_changed.facade, &prepared).is_err());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&version_changed.entry_path)
            .expect("version change leaves target intact"),
        version_changed.expected_fingerprint,
    );

    // Replacing the physical entry with identical bytes still invalidates its identity.
    let replaced = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &replaced.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    std::fs::remove_dir_all(&replaced.entry_path).expect("remove original entry");
    write_skill(&replaced.entry_path);
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&replaced.entry_path)
            .expect("replacement contents match"),
        replaced.expected_fingerprint,
    );
    assert!(commit_release(&replaced.facade, &prepared).is_err());
    assert!(replaced.entry_path.join("SKILL.md").exists());

    // A new active consumer at the same canonical entry also invalidates the preview.
    let consumer_changed = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &consumer_changed.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    {
        let database = consumer_changed.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let mut second = database
            .relationship_repository()
            .list_relations()
            .expect("relations")
            .into_iter()
            .find(|relation| relation.relation_id == RELATION_ID)
            .expect("selected relation");
        second.relation_id = SECOND_RELATION_ID.into();
        second.agent_client_id = "agent.release-second-consumer".into();
        second.observed_at += 1;
        database
            .relationship_repository()
            .upsert_deployment_relation(&second)
            .expect("add second active consumer");
    }
    assert!(commit_release(&consumer_changed.facade, &prepared).is_err());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(
            &consumer_changed.entry_path
        )
        .expect("consumer change leaves entry intact"),
        consumer_changed.expected_fingerprint,
    );

    // An old preview whose current relation revision changes must also fail.
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    // A preview the user abandons is observational only.
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("preview left entry intact"),
        fixture.expected_fingerprint,
    );

    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let mut relation = database
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == RELATION_ID)
        .expect("relation fact");
    relation.observed_at += 1;
    database
        .relationship_repository()
        .upsert_deployment_relation(&relation)
        .expect("change relationship snapshot");
    drop(database);

    assert!(commit_release(&fixture.facade, &prepared).is_err());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("stale preview left entry intact"),
        fixture.expected_fingerprint,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no decision on stale preview")
        .is_empty());
}

#[tokio::test]
async fn release_link_replaced_with_directory_is_rejected_without_history() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::Link, true).await;
    let prepared = prepare_release(&fixture.facade, RELATION_ID, None);

    std::fs::remove_file(&fixture.entry_path).expect("remove prepared link");
    write_skill(&fixture.entry_path);
    std::fs::write(
        fixture.entry_path.join("SKILL.md"),
        "---\nname: notes\n---\n\nreplacement directory\n",
    )
    .expect("different replacement contents");
    let replacement_fingerprint =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("replacement directory fingerprint");
    assert_ne!(replacement_fingerprint, fixture.expected_fingerprint);

    let error = commit_release(&fixture.facade, &prepared)
        .expect_err("a directory cannot replace the prepared link target");
    assert!(error.params.get("reason").and_then(Value::as_str).is_some());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("replacement directory remains intact"),
        replacement_fingerprint,
    );
    assert!(fixture.subject_path.join("SKILL.md").is_file());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("release history")
        .is_empty());
}

#[tokio::test]
async fn release_link_replaced_with_different_link_is_rejected_without_history() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::Link, true).await;
    let replacement_target = fixture._workspace.path().join("replacement-target");
    write_skill(&replacement_target);
    let prepared = prepare_release(&fixture.facade, RELATION_ID, None);

    std::fs::remove_file(&fixture.entry_path).expect("remove prepared link");
    create_dir_link(&replacement_target, &fixture.entry_path).expect("create replacement link");
    assert!(std::fs::symlink_metadata(&fixture.entry_path)
        .expect("replacement link metadata")
        .file_type()
        .is_symlink());

    let error = commit_release(&fixture.facade, &prepared)
        .expect_err("a different link target cannot reuse the prepared action");
    assert!(error.params.get("reason").and_then(Value::as_str).is_some());
    assert_eq!(
        std::fs::canonicalize(&fixture.entry_path).expect("replacement link target"),
        std::fs::canonicalize(&replacement_target).expect("replacement target path"),
        "replacement link remains directed to its new target",
    );
    assert!(replacement_target.join("SKILL.md").is_file());
    assert!(fixture.subject_path.join("SKILL.md").is_file());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("release history")
        .is_empty());
}

#[tokio::test]
async fn release_parent_directory_replaced_is_rejected_without_history() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let parent = fixture
        .entry_path
        .parent()
        .expect("entry parent")
        .to_path_buf();
    let entry_identity_before =
        skillhub_core::physical_id_for_path(&fixture.entry_path).expect("entry identity");
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );

    let moved_parent = fixture._workspace.path().join("agent/skills-replaced");
    std::fs::rename(&parent, &moved_parent).expect("move original parent directory");
    std::fs::create_dir(&parent).expect("create replacement parent directory");
    std::fs::create_dir(parent.join("notes")).expect("create replacement entry");
    std::fs::copy(
        fixture.subject_path.join("SKILL.md"),
        parent.join("notes/SKILL.md"),
    )
    .expect("copy entry into replacement parent");
    let replacement_entry = parent.join("notes");
    let replacement_identity =
        skillhub_core::physical_id_for_path(&replacement_entry).expect("replacement identity");
    assert_ne!(replacement_identity, entry_identity_before);

    let error = commit_release(&fixture.facade, &prepared)
        .expect_err("a new parent directory identity invalidates the prepared scope");
    assert!(error.params.get("reason").and_then(Value::as_str).is_some());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&replacement_entry)
            .expect("replacement entry remains intact"),
        fixture.expected_fingerprint,
    );
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(moved_parent.join("notes"))
            .expect("moved original entry remains intact"),
        fixture.expected_fingerprint,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("release history")
        .is_empty());
}

#[tokio::test]
async fn release_copy_modified_in_place_is_rejected_without_history() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let entry_identity_before =
        skillhub_core::physical_id_for_path(&fixture.entry_path).expect("entry identity");
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );

    std::fs::write(
        fixture.entry_path.join("SKILL.md"),
        "---\nname: notes\n---\n\nmodified after preview\n",
    )
    .expect("modify entry contents in place");
    let entry_identity_after =
        skillhub_core::physical_id_for_path(&fixture.entry_path).expect("same entry identity");
    assert_eq!(entry_identity_after, entry_identity_before);
    let modified_contents =
        std::fs::read(fixture.entry_path.join("SKILL.md")).expect("modified contents");

    let error = commit_release(&fixture.facade, &prepared)
        .expect_err("changed content invalidates the prepared removal");
    assert!(error.params.get("reason").and_then(Value::as_str).is_some());
    assert_eq!(
        std::fs::read(fixture.entry_path.join("SKILL.md")).expect("entry content remains"),
        modified_contents,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("release history")
        .is_empty());
}

#[tokio::test]
async fn shared_recognition_consumer_without_relation_invalidates_preview() {
    let fixture = fixture_with_directory(EntryKind::FullCopy, true, DirectoryKind::Shared).await;
    let second_client = "agent.release-shared-second";
    register_shared_directory_capability(&fixture, second_client);
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::KeepIndependent),
    );
    assert_eq!(
        prepared
            .consumers
            .iter()
            .filter_map(|consumer| consumer.target.agent_client_id.as_deref())
            .filter(|client_id| *client_id == second_client)
            .count(),
        0,
        "a capability alone is not an active consumer before directory projection membership",
    );
    let before_count = fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_relations()
        .expect("relations before adding recognized consumer")
        .len();

    // The second Agent appears in the exact shared directory and has a
    // confirmed capability, but no deployment row is created. This changes
    // the real impact set without changing the relationship revision.
    add_shared_directory_member(&fixture, second_client);
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .relationship_repository()
            .list_relations()
            .expect("no synthetic deployment relation")
            .len(),
        before_count,
    );
    drop(database);

    let error = commit_release(&fixture.facade, &prepared)
        .expect_err("new recognized shared consumer invalidates frozen impact scope");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_change_preview_stale"),
    );
    assert!(fixture.entry_path.join("SKILL.md").exists());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no release decision on stale scope")
        .is_empty());
}

#[tokio::test]
async fn shared_preview_keeps_other_path_consumer_for_each_selected_entry() {
    let fixture = fixture_with_directory(EntryKind::FullCopy, true, DirectoryKind::Shared).await;
    let second_client = "agent.release-shared-multi-entry";
    register_shared_directory_capability(&fixture, second_client);
    add_shared_directory_member(&fixture, second_client);
    let second_selected_path = add_second_managed_copy_entry(&fixture);
    let unrelated_path = add_shared_client_usage_entry(
        &fixture,
        second_client,
        "notes-third",
        "usage:shared-multi-entry:notes-third",
    );

    let prepared = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: Vec::new(),
            problem_id: None,
            skill_id: Some(fixture.skill_id),
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::KeepIndependent),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: vec![usage_entry_key(), usage_entry_key_for("notes-second")],
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect("prepare both shared entries");

    let mut consumers = prepared
        .consumers
        .iter()
        .filter(|consumer| consumer.target.agent_client_id.as_deref() == Some(second_client))
        .collect::<Vec<_>>();
    consumers.sort_by(|left, right| left.entry_key.cmp(&right.entry_key));
    assert_eq!(consumers.len(), 2, "one consumer record per selected entry");
    assert_eq!(
        consumers
            .iter()
            .map(|consumer| consumer.entry_key.clone())
            .collect::<Vec<_>>(),
        vec![
            Some(usage_entry_key()),
            Some(usage_entry_key_for("notes-second")),
        ],
    );
    assert!(consumers.iter().all(|consumer| {
        consumer.relation_ids.is_empty()
            && consumer.target.directory_id.as_deref() == Some(DIRECTORY_ID)
            && consumer.path.as_deref().is_some_and(|path| {
                Path::new(path) != unrelated_path
                    && (Path::new(path) == fixture.entry_path
                        || Path::new(path) == second_selected_path)
            })
    }));
}

#[tokio::test]
async fn repeat_commit_returns_same_receipt() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let first = commit_release(&fixture.facade, &prepared).expect("first commit");
    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    let second = commit_release(&restarted, &prepared).expect("replayed commit");
    assert_eq!(second, first);
    assert!(
        is_absent(&fixture.entry_path),
        "replay must not touch the entry again"
    );
    let database = restarted.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
            .expect("single decision after replay")
            .len(),
        1,
    );
}

#[tokio::test]
async fn committed_operation_rejects_wrong_prepared_id() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::KeepIndependent),
    );
    commit_release(&fixture.facade, &prepared).expect("first commit");
    let before =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("kept entry hash");

    let error = fixture
        .facade
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: OperationId::new(),
        })
        .expect_err("committed receipt is bound to the prepared snapshot");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_change_preview_mismatch"),
    );
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("wrong prepared id did not change files"),
        before,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
            .expect("history unchanged")
            .len(),
        1,
    );
}

#[tokio::test]
async fn backup_parent_symlink_replacement_does_not_write_outside_or_remove_target() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let backup_root = fixture.library_root.join(".skillhub/usage-release-backups");
    let external = tempfile::tempdir().expect("external backup destination");
    std::fs::write(
        external.path().join("sentinel.txt"),
        "preserve external data",
    )
    .expect("external sentinel");
    create_dir_link(external.path(), &backup_root).expect("replace backup parent with symlink");

    let error = commit_release(&fixture.facade, &prepared)
        .expect_err("a replaced backup parent must block removal");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_backup_parent_identity_changed"),
    );
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("entry remains intact"),
        fixture.expected_fingerprint,
    );
    assert_eq!(
        std::fs::read_to_string(external.path().join("sentinel.txt"))
            .expect("external sentinel remains"),
        "preserve external data",
    );
    assert!(
        !external
            .path()
            .join(prepared.operation_id.to_string())
            .exists(),
        "no backup directory may be created outside the library"
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no release decision")
        .is_empty());
}

#[tokio::test]
async fn decision_write_failure_restores_active_entry() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let database = fixture.facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER reject_usage_release BEFORE INSERT ON usage_decisions
             BEGIN SELECT RAISE(ABORT, 'injected usage decision failure'); END;",
        )
        .expect("install decision failure trigger");

    assert!(commit_release(&fixture.facade, &prepared).is_err());
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("entry restored after failed decision write"),
        fixture.expected_fingerprint,
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("decision transaction rolled back")
        .is_empty());
    assert!(database
        .relationship_repository()
        .list_relations()
        .expect("relation facts")
        .iter()
        .any(|relation| relation.relation_id == RELATION_ID && relation.active));
}

#[tokio::test]
async fn restore_failure_stays_recoverable() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let entry_path = fixture.entry_path.clone();
    let database = fixture.facade.database_for_tests();
    {
        let connection = database.lock().expect("database lock");
        connection
            .connection_for_test()
            .create_scalar_function(
                "occupy_release_path",
                0,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    std::fs::create_dir(&entry_path)
                        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
                    Ok(1_i64)
                },
            )
            .expect("install restore failure callback");
        connection
            .connection_for_test()
            .execute_batch(
                "CREATE TRIGGER block_release_restore BEFORE INSERT ON usage_decisions
                 BEGIN SELECT occupy_release_path();
                       SELECT RAISE(ABORT, 'injected decision failure'); END;",
            )
            .expect("install decision failure trigger");
    }

    assert!(commit_release(&fixture.facade, &prepared).is_err());
    assert!(
        fixture.entry_path.is_dir(),
        "the blocking entry prevents restore"
    );
    assert!(!fixture.entry_path.join("SKILL.md").exists());
    let external_marker = fixture.entry_path.join("EXTERNAL.txt");
    std::fs::write(&external_marker, "keep external replacement\n")
        .expect("mark replacement as user data");
    let backup_dir = fixture
        .library_root
        .join(".skillhub/usage-release-backups")
        .join(prepared.operation_id.to_string());
    assert!(backup_dir.exists(), "recovery backup remains on disk");

    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    let candidates = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list release recovery candidate");
    let AppQueryResult::RecoveryCandidates(candidates) = candidates else {
        panic!("expected recovery candidates");
    };
    assert!(
        candidates
            .iter()
            .any(|candidate| candidate.operation_id == prepared.operation_id),
        "release NeedsRecovery is visible after restart"
    );
    let rejected = restarted
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::api::ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::RollbackOperation,
            },
        ))
        .await
        .expect_err("recovery must not replace a different physical directory");
    assert_eq!(
        rejected.params.get("reason").and_then(Value::as_str),
        Some("usage_restore_destination_occupied"),
    );
    assert_eq!(
        std::fs::read_to_string(&external_marker).expect("external marker survives"),
        "keep external replacement\n",
    );
    std::fs::remove_dir_all(&fixture.entry_path).expect("remove test blocker");
    restarted
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::api::ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::RollbackOperation,
            },
        ))
        .await
        .expect("restore from durable release backup");
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("restored entry fingerprint"),
        fixture.expected_fingerprint,
    );
    let database = restarted.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("failed commit leaves no decision")
        .is_empty());
}

#[tokio::test]
async fn recovery_rejects_backup_reached_through_replaced_ancestor() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let entry_path = fixture.entry_path.clone();
    let database = fixture.facade.database_for_tests();
    {
        let connection = database.lock().expect("database lock");
        connection
            .connection_for_test()
            .create_scalar_function(
                "occupy_release_path",
                0,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    std::fs::create_dir(&entry_path)
                        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
                    Ok(1_i64)
                },
            )
            .expect("install restore failure callback");
        connection
            .connection_for_test()
            .execute_batch(
                "CREATE TRIGGER block_release_restore BEFORE INSERT ON usage_decisions
                 BEGIN SELECT occupy_release_path();
                       SELECT RAISE(ABORT, 'injected decision failure'); END;",
            )
            .expect("install decision failure trigger");
    }

    assert!(commit_release(&fixture.facade, &prepared).is_err());
    assert!(fixture.entry_path.is_dir());
    std::fs::remove_dir(&fixture.entry_path).expect("remove empty compensation blocker");

    let library_backup_root = fixture.library_root.join(".skillhub/usage-release-backups");
    let external = tempfile::tempdir().expect("external recovery directory");
    let external_backup_root = external.path().join("usage-release-backups");
    let backup_path = library_backup_root
        .join(prepared.operation_id.to_string())
        .join("0/entry");
    let backup_identity =
        skillhub_core::physical_id_for_path(&backup_path).expect("original backup identity");
    std::fs::rename(&library_backup_root, &external_backup_root)
        .expect("move real recovery materials outside library");
    create_dir_link(&external_backup_root, &library_backup_root)
        .expect("redirect backup ancestor outside library");
    assert_eq!(
        skillhub_core::physical_id_for_path(&backup_path).as_deref(),
        Some(backup_identity.as_str()),
        "the backup leaf identity alone still matches through the replacement link"
    );
    std::fs::write(
        external.path().join("sentinel.txt"),
        "preserve external data",
    )
    .expect("write external sentinel");

    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    let error = restarted
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::api::ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::RollbackOperation,
            },
        ))
        .await
        .expect_err("recovery must not trust a backup through a replaced parent");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_backup_parent_identity_changed"),
    );
    assert!(
        is_absent(&fixture.entry_path),
        "recovery did not copy the external tree"
    );
    assert_eq!(
        std::fs::read_to_string(external.path().join("sentinel.txt"))
            .expect("external sentinel remains"),
        "preserve external data",
    );
}

#[tokio::test]
async fn crash_after_remove_before_journal_update_recovers_from_removal_intent() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let database = fixture.facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER crash_after_release_remove BEFORE UPDATE OF progress_json ON operations
             WHEN json_extract(NEW.progress_json, '$.recovery_data.plans[0].target_removed') = 1
             BEGIN SELECT RAISE(ABORT, 'injected crash after target removal'); END;",
        )
        .expect("install crash-window trigger");

    assert!(commit_release(&fixture.facade, &prepared).is_err());
    assert!(
        is_absent(&fixture.entry_path),
        "remove completed before journal write failed"
    );
    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database after simulated crash"),
        &fixture.library_root,
    );
    let candidates = restarted
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list crash-window recovery candidate");
    let AppQueryResult::RecoveryCandidates(candidates) = candidates else {
        panic!("expected recovery candidates");
    };
    assert!(candidates
        .iter()
        .any(|candidate| candidate.operation_id == prepared.operation_id));

    restarted
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::api::ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::RollbackOperation,
            },
        ))
        .await
        .expect("rollback uses persisted removal intent");
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("entry restored after crash window"),
        fixture.expected_fingerprint,
    );
    let database = restarted.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no decision after crash rollback")
        .is_empty());
}

#[tokio::test]
async fn restart_after_restore_before_journal_settle_is_idempotent() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let backup_path = {
        let database = fixture.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let mut record = database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("operation query")
            .expect("prepared operation");
        let backup_path = PathBuf::from(
            record.recovery_data["plans"][0]["backup_path"]
                .as_str()
                .expect("persisted backup path"),
        );
        std::fs::create_dir_all(backup_path.parent().expect("backup parent"))
            .expect("create backup parent");
        std::fs::create_dir_all(&backup_path).expect("create backup");
        std::fs::copy(
            fixture.entry_path.join("SKILL.md"),
            backup_path.join("SKILL.md"),
        )
        .expect("copy entry to recovery backup");
        let backup_identity =
            skillhub_core::physical_id_for_path(&backup_path).expect("backup physical identity");
        let backup_parent_chain = backup_path
            .parent()
            .expect("backup parent")
            .ancestors()
            .map(|ancestor| {
                let canonical = std::fs::canonicalize(ancestor).expect("canonical backup ancestor");
                serde_json::json!({
                    "path": canonical.to_string_lossy(),
                    "physical_id": skillhub_core::physical_id_for_path(&canonical)
                        .expect("backup ancestor identity"),
                })
            })
            .collect::<Vec<_>>();
        record.recovery_data["plans"][0]["backup_created"] = serde_json::json!(true);
        record.recovery_data["plans"][0]["backup_identity"] = serde_json::json!(backup_identity);
        record.recovery_data["plans"][0]["backup_parent_chain"] =
            serde_json::json!({"nodes": backup_parent_chain});
        record.recovery_data["plans"][0]["removal_started"] = serde_json::json!(true);
        record.recovery_data["plans"][0]["restore_started"] = serde_json::json!(true);
        record.phase = skillhub_core::OperationPhase::NeedsRecovery;
        record.progress.phase = skillhub_core::OperationPhase::NeedsRecovery;
        database
            .operation_repository()
            .update_sync(&record)
            .expect("persist restoration intent before simulated crash");
        backup_path
    };

    std::fs::remove_dir_all(&fixture.entry_path).expect("remove pre-crash entry");
    std::fs::create_dir_all(&fixture.entry_path).expect("restore entry directory");
    std::fs::copy(
        backup_path.join("SKILL.md"),
        fixture.entry_path.join("SKILL.md"),
    )
    .expect("restore files before simulated journal crash");
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&fixture.entry_path)
            .expect("restored tree fingerprint"),
        fixture.expected_fingerprint,
    );
    let restored_identity =
        skillhub_core::physical_id_for_path(&fixture.entry_path).expect("restored target identity");

    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    restarted
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::api::ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::RollbackOperation,
            },
        ))
        .await
        .expect("recognize verified restored tree and settle rollback");
    assert_eq!(
        skillhub_core::physical_id_for_path(&fixture.entry_path),
        Some(restored_identity),
        "recovery must accept the verified restored tree without replacing it",
    );
    let database = restarted.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("operation query")
            .expect("operation")
            .phase,
        skillhub_core::OperationPhase::RolledBack,
    );
}

#[tokio::test]
async fn complete_recovery_finishes_file_and_decision_after_restart() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::RemoveWithBackup),
    );
    let entry_path = fixture.entry_path.clone();
    let database = fixture.facade.database_for_tests();
    {
        let connection = database.lock().expect("database lock");
        connection
            .connection_for_test()
            .create_scalar_function(
                "occupy_release_path",
                0,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    std::fs::create_dir(&entry_path)
                        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
                    Ok(1_i64)
                },
            )
            .expect("install restore failure callback");
        connection
            .connection_for_test()
            .execute_batch(
                "CREATE TRIGGER block_release_restore BEFORE INSERT ON usage_decisions
                 BEGIN SELECT occupy_release_path();
                       SELECT RAISE(ABORT, 'injected decision failure'); END;",
            )
            .expect("install decision failure trigger");
    }

    assert!(commit_release(&fixture.facade, &prepared).is_err());
    assert!(!fixture.entry_path.join("SKILL.md").exists());
    std::fs::remove_dir_all(&fixture.entry_path).expect("remove compensation blocker");
    fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch("DROP TRIGGER block_release_restore")
        .expect("remove injected decision failure");

    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    restarted
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::api::ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::CompleteOperation,
            },
        ))
        .await
        .expect("complete file and decision through usage recovery");
    assert!(is_absent(&fixture.entry_path));
    let database = restarted.database_for_tests();
    let database = database.lock().expect("database lock");
    let decisions = database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("completed recovery decision");
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].decision, UsageDecision::Released);
    assert_eq!(
        database
            .operation_repository()
            .get_sync(prepared.operation_id)
            .expect("operation query")
            .expect("operation record")
            .phase,
        skillhub_core::OperationPhase::Committed,
    );
}

#[tokio::test]
async fn rollback_recovery_preserves_committed_target_and_restores_failed_target() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let second_entry = add_second_managed_copy_entry(&fixture);
    let second_fingerprint =
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&second_entry)
            .expect("second target fingerprint");
    let prepared = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![RELATION_ID.into(), SECOND_TARGET_RELATION_ID.into()],
            problem_id: None,
            skill_id: None,
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::RemoveWithBackup),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: Vec::new(),
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect("prepare two independent release targets");
    assert_eq!(prepared.impacts.len(), 2);

    let blocked_entry = second_entry.clone();
    let database = fixture.facade.database_for_tests();
    {
        let connection = database.lock().expect("database lock");
        connection
            .connection_for_test()
            .create_scalar_function(
                "occupy_second_release_path",
                0,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    std::fs::create_dir(&blocked_entry)
                        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))?;
                    Ok(1_i64)
                },
            )
            .expect("install second-target blocker");
        connection
            .connection_for_test()
            .execute_batch(
                "CREATE TRIGGER fail_second_release_decision BEFORE INSERT ON usage_decisions
                 WHEN NEW.relative_entry_path = 'notes-second'
                 BEGIN SELECT occupy_second_release_path();
                       SELECT RAISE(ABORT, 'injected second target decision failure'); END;",
            )
            .expect("install second-target decision failure");
    }

    assert!(commit_release(&fixture.facade, &prepared).is_err());
    assert!(
        is_absent(&fixture.entry_path),
        "first target remains committed"
    );
    assert!(
        !second_entry.join("SKILL.md").exists(),
        "second target removal was interrupted before decision persistence"
    );
    {
        let database = fixture.facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let first_history = database
            .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
            .expect("first target decision remains committed");
        assert_eq!(first_history.len(), 1);
        assert_eq!(first_history[0].decision, UsageDecision::Released);
    }

    std::fs::remove_dir_all(&second_entry).expect("remove injected blocker");
    fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_second_release_decision")
        .expect("remove decision failure injection");
    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    restarted
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::api::ResolveRecovery {
                operation_id: prepared.operation_id,
                action: skillhub_core::RecoveryAction::RollbackOperation,
            },
        ))
        .await
        .expect("restore only unresolved target");
    assert!(
        is_absent(&fixture.entry_path),
        "committed target stays removed"
    );
    assert_eq!(
        skillhub_adapters::deployment::DeploymentFilesystem::hash_tree(&second_entry)
            .expect("second target restored"),
        second_fingerprint,
    );
    let database = restarted.database_for_tests();
    let database = database.lock().expect("database lock");
    let first_history = database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("first decision is not undone");
    assert_eq!(first_history.len(), 1);
    assert!(database
        .list_usage_decisions(
            &fixture.skill_id,
            &UsageEntryKey {
                directory_id: DIRECTORY_ID.into(),
                relative_entry_path: "notes-second".into(),
            },
        )
        .expect("failed target has no release decision")
        .is_empty());
    let operation = database
        .operation_repository()
        .get_sync(prepared.operation_id)
        .expect("operation query")
        .expect("operation after partial recovery");
    assert_eq!(operation.phase, skillhub_core::OperationPhase::Committed);
    let receipt: skillhub_core::relationship::UsageChangeResult =
        serde_json::from_value(operation.result.expect("partial result receipt"))
            .expect("receipt contract");
    assert_eq!(receipt.item_results.len(), 2);
    assert_eq!(
        receipt.item_results[0].status,
        skillhub_core::relationship::UsageChangeItemStatus::Applied
    );
    assert_eq!(
        receipt.item_results[1].status,
        skillhub_core::relationship::UsageChangeItemStatus::Failed
    );
}

#[tokio::test]
async fn missing_entry_ends_record_without_touching_neighbor() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let neighbor = fixture
        .entry_path
        .parent()
        .expect("entry parent")
        .join("keep");
    write_skill(&neighbor);
    std::fs::remove_dir_all(&fixture.entry_path).expect("remove missing entry fixture");

    let prepared = prepare_release(&fixture.facade, RELATION_ID, None);
    let result = commit_release(&fixture.facade, &prepared).expect("record missing entry");
    assert!(!result.recovery_required);
    assert!(neighbor.join("SKILL.md").exists());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
            .expect("decision for missing entry")[0]
            .decision,
        UsageDecision::Released,
    );
}

#[tokio::test]
async fn old_end_relationship_cannot_bypass_release_preview() {
    let fixture = fixture(EntryKind::FullCopy, false).await;
    let revision = fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .relationship_repository()
        .relationship_revision()
        .expect("current revision")
        .to_string();
    let result = fixture
        .facade
        .execute(AppCommand::EndRelationship(
            skillhub_core::api::EndRelationship {
                operation_id: OperationId::new(),
                relation_id: RELATION_ID.into(),
                expected_relationship_revision: revision,
            },
        ))
        .await;
    let error = result.expect_err("legacy write endpoint must not bypass prepare");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_change_preview_required"),
    );
    assert!(fixture.entry_path.join("SKILL.md").exists());
}

#[tokio::test]
async fn old_undeploy_endpoints_cannot_bypass_release_preview() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    for command in [
        AppCommand::PrepareUndeploy(skillhub_core::api::PrepareUndeploy {
            deployment_id: skillhub_core::DeploymentId::new(),
        }),
        AppCommand::CommitUndeploy(skillhub_core::api::CommitUndeploy {
            prepared_undeploy_id: OperationId::new(),
            decision: skillhub_core::RemovalDecision::RemoveOwnedTarget,
            confirm_shared_target_removal: false,
        }),
    ] {
        let error = fixture
            .facade
            .execute(command)
            .await
            .expect_err("old undeploy flow must require unified preview");
        assert_eq!(
            error.params.get("reason").and_then(Value::as_str),
            Some("usage_change_preview_required"),
        );
    }
    assert!(fixture.entry_path.join("SKILL.md").exists());
}

#[tokio::test]
async fn legacy_release_and_detach_commands_require_usage_preview() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let revision = fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .relationship_repository()
        .relationship_revision()
        .expect("current revision")
        .to_string();
    let commands = [
        AppCommand::RetainSourceCopy(skillhub_core::api::RetainSourceCopy {
            source_relation_id: RELATION_ID.into(),
        }),
        AppCommand::RevokeRetention(skillhub_core::api::RevokeRetention {
            operation_id: OperationId::new(),
            relation_id: RELATION_ID.into(),
            expected_relationship_revision: revision,
        }),
        AppCommand::DetachManagement(skillhub_core::api::DetachManagement {
            deployment_id: skillhub_core::DeploymentId::new(),
        }),
        AppCommand::KeepIndependentCopy(skillhub_core::api::KeepIndependentCopy {
            deployment_id: skillhub_core::DeploymentId::new(),
        }),
        AppCommand::PrepareRelationGovernanceBatch(
            skillhub_core::api::PrepareRelationGovernanceBatch {
                action: skillhub_core::api::RelationGovernanceBatchAction::RetainSourceCopy,
                relation_ids: vec![RELATION_ID.into()],
                confirmations: Default::default(),
            },
        ),
    ];
    for command in commands {
        let error = fixture
            .facade
            .execute(command)
            .await
            .expect_err("legacy release or detach command cannot bypass preview");
        assert_eq!(
            error.params.get("reason").and_then(Value::as_str),
            Some("usage_change_preview_required"),
        );
    }
    let legacy_batch_id = OperationId::new();
    let mut legacy_batch = skillhub_core::OperationRecord::planned(
        legacy_batch_id,
        "relation_governance_batch",
        "legacy-retain-source-copy",
    );
    legacy_batch.phase = skillhub_core::OperationPhase::Prepared;
    legacy_batch.progress.phase = skillhub_core::OperationPhase::Prepared;
    legacy_batch.recovery_data = serde_json::json!({
        "action": "retain_source_copy",
        "children": [],
    });
    fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .operation_repository()
        .insert_sync(&legacy_batch)
        .expect("seed pre-upgrade retain batch");
    let error = fixture
        .facade
        .execute(AppCommand::CommitRelationGovernanceBatch(
            skillhub_core::api::CommitRelationGovernanceBatch {
                batch_id: legacy_batch_id,
                relation_ids: vec![RELATION_ID.into()],
            },
        ))
        .await
        .expect_err("pre-upgrade retain batch cannot bypass preview after upgrade");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_change_preview_required"),
    );
    assert!(fixture.entry_path.join("SKILL.md").exists());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no decision from legacy endpoints")
        .is_empty());
}

#[tokio::test]
async fn healthy_builtin_release_is_rejected() {
    let fixture = fixture_with_directory(EntryKind::FullCopy, true, DirectoryKind::Builtin).await;
    let error = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![RELATION_ID.into()],
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
        })
        .expect_err("healthy built-in original cannot be released or reclaimed");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_builtin_healthy_release_forbidden"),
    );
    assert!(fixture.entry_path.join("SKILL.md").exists());
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert!(database
        .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
        .expect("no decision for protected built-in original")
        .is_empty());
}

#[tokio::test]
async fn abnormal_builtin_release_is_record_only() {
    let fixture = fixture_with_directory(EntryKind::FullCopy, true, DirectoryKind::Builtin).await;
    set_health_reason(&fixture, RelationHealthReason::ContentChanged);
    let prepared = prepare_release(&fixture.facade, RELATION_ID, None);
    assert_eq!(
        prepared.entry_evidence[0].directory_role,
        Some(AgentDirectoryRole::Builtin),
    );
    assert_eq!(
        prepared.impacts[0].action,
        UsageChangeImpactAction::RecordOnly,
    );
    let result = commit_release(&fixture.facade, &prepared).expect("record abnormal built-in end");
    assert!(fixture.entry_path.join("SKILL.md").exists());
    assert!(!result.recovery_required);
}

#[tokio::test]
async fn abnormal_managed_link_keeps_verified_release_action() {
    if skip_if_link_creation_unavailable() {
        return;
    }
    let fixture = fixture(EntryKind::Link, true).await;
    set_health_reason(&fixture, RelationHealthReason::ContentChanged);
    let prepared = prepare_release(&fixture.facade, RELATION_ID, None);
    assert_eq!(
        prepared.impacts[0].action,
        UsageChangeImpactAction::RemoveLink,
        "abnormal health alone must not downgrade a verified managed link to record-only",
    );
    commit_release(&fixture.facade, &prepared).expect("remove the verified managed link");
    assert!(is_absent(&fixture.entry_path));
    assert!(fixture.subject_path.join("SKILL.md").exists());
}

#[tokio::test]
async fn unknown_directory_does_not_silently_become_record_only() {
    let fixture = fixture_with_directory(EntryKind::FullCopy, true, DirectoryKind::Unknown).await;
    let error = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![RELATION_ID.into()],
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
        })
        .expect_err("unknown directory identity must require a safe verified action");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_entry_directory_unverified"),
    );
    assert!(fixture.entry_path.join("SKILL.md").exists());
}

#[tokio::test]
async fn unknown_directory_identity_cannot_remove_files() {
    let fixture = fixture_with_directory(EntryKind::FullCopy, true, DirectoryKind::Unknown).await;
    let error = fixture
        .facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![RELATION_ID.into()],
            problem_id: None,
            skill_id: None,
            requested_form: None,
            copy_disposition: Some(UsageCopyDisposition::RemoveWithBackup),
            content_basis: None,
            retain_entry_key: None,
            selected_entry_keys: Vec::new(),
            runtime_name: None,
            base_version_id: None,
            non_recognized_destination: None,
        })
        .expect_err("unverified directory identity cannot authorize deletion");
    assert_eq!(
        error.params.get("reason").and_then(Value::as_str),
        Some("usage_entry_directory_unverified"),
    );
    assert!(fixture.entry_path.join("SKILL.md").exists());
}

#[tokio::test]
async fn decision_history_is_exposed_through_relationship_query() {
    let fixture = fixture(EntryKind::FullCopy, true).await;
    let prepared = prepare_release(
        &fixture.facade,
        RELATION_ID,
        Some(UsageCopyDisposition::KeepIndependent),
    );
    commit_release(&fixture.facade, &prepared).expect("commit keep decision");

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
    assert!(
        overview.usage_relations.is_empty(),
        "released fact leaves active list"
    );

    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    assert_eq!(
        database
            .list_usage_decisions(&fixture.skill_id, &usage_entry_key())
            .expect("structured decision history")
            .len(),
        1,
    );
}

#[allow(dead_code)]
fn _assert_json_contract_is_readable(value: &Value) {
    assert!(value.get("item_results").is_some());
}
