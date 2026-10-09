use std::path::{Path, PathBuf};

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::compatibility::{CompatibilityStatus, RecordAgentCompatibility};
use skillhub_core::agent::{
    AgentRootObservation, ClientInstance, ClientKind, ClientPresence, DirectoryObservationStatus,
    DirectoryPrecedence, DiscoverySnapshot, LogicalTarget, OperatingSystem, PhysicalTarget,
    TargetScope,
};
use skillhub_core::api::{
    CommitDeployment, CreateSkill, DiscoverImportCandidates, GetDeploymentPlan,
    GetRelationshipOverview, GetSkill, ListSkills, PrepareDeployment, PrepareUsageChange,
    RelationshipOverviewScope, RunInitializationScan,
};
use skillhub_core::relationship::{UsageChangeAction, UsageDecision, UsageEntryKey};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, OperationId, SkillId,
};
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_ID: &str = "agent.usage-rescan-fixture";
const DIRECTORY_ID: &str = "directory:usage-rescan-fixture";
const SKILL_BODY: &str = "---\nname: notes\n---\n\nrescan fixture\n";

struct Fixture {
    _workspace: tempfile::TempDir,
    database_path: PathBuf,
    library_root: PathBuf,
    facade: LocalApplicationFacade,
    skill_id: SkillId,
    entry_path: PathBuf,
}

async fn fixture() -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    let database = Database::open(&database_path).expect("database");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    let source = workspace.path().join("source/notes");
    write_skill(&source);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create library skill");
    let AppQueryResult::SkillPage(page) = facade
        .query(AppQuery::ListSkills(ListSkills {
            text: "Notes".into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list library skills")
    else {
        panic!("expected skill page");
    };
    let skill_id = page.items[0].skill_id;

    let agent_directory = workspace.path().join("agent/skills");
    std::fs::create_dir_all(&agent_directory).expect("Agent directory");
    let agent_root = workspace.path().join("agent");
    let entry_path = agent_directory.join("notes");
    write_skill(&entry_path);
    let canonical_agent_root = std::fs::canonicalize(&agent_root).expect("canonical Agent root");
    let agent_root_physical_id =
        skillhub_core::physical_id_for_path(&agent_root).expect("Agent root physical identity");
    let physical_id = skillhub_core::physical_id_for_path(&agent_directory)
        .expect("Agent directory physical identity");
    let canonical_agent_directory =
        std::fs::canonicalize(&agent_directory).expect("canonical Agent directory");
    let database = facade.database_for_tests();
    let database = database.lock().expect("database lock");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-10-09T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: "usage-rescan-fixture".into(),
                client_id: CLIENT_ID.into(),
                kind: ClientKind::Cli,
                display_name: "Usage Rescan Fixture".into(),
                supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: vec![LogicalTarget {
                id: "target-usage-rescan".into(),
                profile_id: "usage-rescan-fixture".into(),
                client_id: CLIENT_ID.into(),
                scope: TargetScope::Global,
                path: canonical_agent_directory.to_string_lossy().into_owned(),
                agent_root_id: "usage-rescan-root".into(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: physical_id.clone(),
                status: DirectoryObservationStatus::Existing,
                physical_identity_verified: true,
            }],
            physical_targets: vec![PhysicalTarget {
                id: physical_id,
                path: canonical_agent_directory.to_string_lossy().into_owned(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "sensitive".into(),
                logical_target_ids: vec!["target-usage-rescan".into()],
            }],
            agent_roots: vec![AgentRootObservation {
                id: "usage-rescan-root".into(),
                profile_id: "usage-rescan-fixture".into(),
                client_id: CLIENT_ID.into(),
                scope: TargetScope::Global,
                path: canonical_agent_root.to_string_lossy().into_owned(),
                status: DirectoryObservationStatus::Existing,
                exists: true,
                readable: true,
                writable: true,
                physical_id: Some(agent_root_physical_id),
                physical_identity_verified: true,
            }],
        })
        .expect("register Agent target");
    database
        .directory_repository()
        .upsert_node(&skillhub_core::relationship::DirectoryNodeFact {
            node_id: DIRECTORY_ID.into(),
            path: canonical_agent_directory.to_string_lossy().into_owned(),
            path_key: String::new(),
            role: skillhub_core::relationship::DirectoryRole::AgentNative,
            profile_id: Some("usage-rescan-fixture".into()),
            agent_client_id: Some(CLIENT_ID.into()),
            exists: true,
            observed_at: 1,
            scan_source: Some("usage-rescan-test".into()),
        })
        .expect("register directory identity");
    database
        .relationship_repository()
        .upsert_capability(&skillhub_core::relationship::AgentDirectoryCapabilityFact {
            agent_client_id: CLIENT_ID.into(),
            directory_node_id: DIRECTORY_ID.into(),
            recognition: skillhub_core::relationship::DirectoryRecognition::Supported,
            precedence: DirectoryPrecedence::Preferred,
            evidence_reference: Some("usage-rescan-test".into()),
            researched_at: Some("2026-10-09".into()),
            applicable_platforms: vec!["macos".into(), "windows".into()],
        })
        .expect("register directory capability");
    drop(database);

    Fixture {
        _workspace: workspace,
        database_path,
        library_root,
        facade,
        skill_id,
        entry_path,
    }
}

fn write_skill(path: &Path) {
    write_skill_body(path, SKILL_BODY);
}

fn write_skill_body(path: &Path, body: &str) {
    std::fs::create_dir_all(path).expect("skill directory");
    std::fs::write(path.join("SKILL.md"), body).expect("write SKILL.md");
}

fn entry_key() -> UsageEntryKey {
    UsageEntryKey {
        directory_id: DIRECTORY_ID.into(),
        relative_entry_path: "notes".into(),
    }
}

async fn scan(facade: &LocalApplicationFacade) {
    let result = facade
        .execute(AppCommand::RunInitializationScan(RunInitializationScan {
            scope_ids: Vec::new(),
        }))
        .await
        .expect("scan known Agent directory");
    assert!(matches!(result, AppCommandResult::ScanResult(_)));
}

async fn has_active_relation(facade: &LocalApplicationFacade, skill_id: SkillId) -> bool {
    let AppQueryResult::RelationshipOverview(overview) = facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::All,
        }))
        .await
        .expect("query relationship overview")
    else {
        panic!("expected relationship overview");
    };
    overview
        .usage_relations
        .iter()
        .any(|relation| relation.skill_id == Some(skill_id) && relation.active)
}

async fn create_library_skill(
    facade: &LocalApplicationFacade,
    source_path: &Path,
    display_name: &str,
    body: &str,
) -> SkillId {
    write_skill_body(source_path, body);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: display_name.into(),
            source_path: source_path.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create library skill");
    let AppQueryResult::SkillPage(page) = facade
        .query(AppQuery::ListSkills(ListSkills {
            text: display_name.into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list library skills")
    else {
        panic!("expected skill page");
    };
    page.items
        .into_iter()
        .find(|item| item.display_name == display_name)
        .expect("created library skill")
        .skill_id
}

async fn release_active_entry(facade: &LocalApplicationFacade, skill_id: SkillId) {
    let AppQueryResult::RelationshipOverview(overview) = facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::All,
        }))
        .await
        .expect("query relationship overview before release")
    else {
        panic!("expected relationship overview");
    };
    let relation = overview
        .usage_relations
        .iter()
        .find(|relation| relation.skill_id == Some(skill_id) && relation.active)
        .expect("scanned usage relation");
    let prepared = facade
        .prepare_usage_change(PrepareUsageChange {
            operation_id: OperationId::new(),
            action: UsageChangeAction::Release,
            relation_ids: vec![relation.relation_id.clone()],
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
        .expect("prepare release");
    facade
        .commit_usage_change(skillhub_core::api::CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("release usage relation");
}

async fn reuse_import_from_path(facade: &LocalApplicationFacade, path: &Path, skill_id: SkillId) {
    let canonical_path = std::fs::canonicalize(path).expect("canonical import path");
    let candidate = skillhub_core::import::ImportCandidate::detected(
        skillhub_core::source::SourceDescriptor::new(
            skillhub_core::source::SourceKind::Local,
            skillhub_core::source::SourceLocator::local_path(&canonical_path),
        ),
        canonical_path.to_string_lossy(),
        ".",
        "SKILL.md",
        "notes",
    )
    .with_ownership(
        skillhub_core::import::CandidateOwnership::KnownAgentTarget,
        skillhub_core::import::ImportAction::Review,
        None,
    );
    let result = facade
        .execute(AppCommand::PrepareImport(
            skillhub_core::api::PrepareImport {
                candidate,
                tree_hash: None,
                runtime_name_override: None,
            },
        ))
        .await
        .expect("prepare reuse import");
    let AppCommandResult::PreparedImport(prepared) = result else {
        panic!("expected prepared import");
    };
    assert!(prepared
        .analysis
        .matches
        .iter()
        .any(|matched| matched.skill_id == skill_id));
    let governance_decision = skillhub_core::ImportGovernanceDecision {
        group_actions: prepared
            .analysis
            .governance_groups
            .iter()
            .map(|group| (group.group_id.clone(), group.default_action))
            .collect(),
        item_overrides: Default::default(),
    };
    let result = facade
        .execute(AppCommand::CommitImport(skillhub_core::api::CommitImport {
            prepared_import_id: prepared.id,
            decision: skillhub_core::ImportDecision::ReuseExisting,
            governance_decision,
            batch_id: None,
            candidate_key: None,
            runtime_name_override: None,
            batch_signature: None,
            security_decision: None,
        }))
        .await
        .expect("commit reuse import");
    let AppCommandResult::ImportSummary(summary) = result else {
        panic!("expected import summary");
    };
    assert_eq!(summary.items[0].skill_id, Some(skill_id));
}

#[tokio::test]
async fn released_entry_survives_two_scans_and_restart() {
    let fixture = fixture().await;
    scan(&fixture.facade).await;
    assert!(has_active_relation(&fixture.facade, fixture.skill_id).await);

    release_active_entry(&fixture.facade, fixture.skill_id).await;
    assert!(!has_active_relation(&fixture.facade, fixture.skill_id).await);
    assert_eq!(
        fixture
            .facade
            .database_for_tests()
            .lock()
            .expect("database lock")
            .list_usage_decisions(&fixture.skill_id, &entry_key())
            .expect("persisted decision")[0]
            .decision,
        UsageDecision::Released
    );

    scan(&fixture.facade).await;
    scan(&fixture.facade).await;
    assert!(!has_active_relation(&fixture.facade, fixture.skill_id).await);
    assert_eq!(
        std::fs::read_to_string(fixture.entry_path.join("SKILL.md")).expect("entry remains"),
        SKILL_BODY
    );

    drop(fixture.facade);
    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    assert!(!has_active_relation(&restarted, fixture.skill_id).await);
    scan(&restarted).await;
    assert!(!has_active_relation(&restarted, fixture.skill_id).await);
}

#[tokio::test]
async fn changed_released_entry_is_not_reactivated() {
    const CHANGED_BODY: &str = "---\nname: notes\n---\n\nchanged after release\n";
    let fixture = fixture().await;
    scan(&fixture.facade).await;
    release_active_entry(&fixture.facade, fixture.skill_id).await;

    write_skill_body(&fixture.entry_path, CHANGED_BODY);
    scan(&fixture.facade).await;
    assert!(!has_active_relation(&fixture.facade, fixture.skill_id).await);

    let AppQueryResult::ImportCandidates(candidates) = fixture
        .facade
        .query(AppQuery::DiscoverImportCandidates(
            DiscoverImportCandidates {
                source: skillhub_core::SourceDescriptor::new(
                    skillhub_core::SourceKind::Local,
                    skillhub_core::SourceLocator::local_path(&fixture.entry_path),
                ),
            },
        ))
        .await
        .expect("discover changed released entry")
    else {
        panic!("expected import candidates");
    };
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        candidates[0].usage_history.classification,
        skillhub_core::ImportCandidateUsageHistoryClassification::PreviouslyReleasedChanged
    );
}

#[tokio::test]
async fn uncertain_identity_does_not_guess_release_history() {
    let fixture = fixture().await;
    let unknown_entry = fixture._workspace.path().join("unregistered/notes");
    write_skill(&unknown_entry);

    let AppQueryResult::ImportCandidates(candidates) = fixture
        .facade
        .query(AppQuery::DiscoverImportCandidates(
            DiscoverImportCandidates {
                source: skillhub_core::SourceDescriptor::new(
                    skillhub_core::SourceKind::Local,
                    skillhub_core::SourceLocator::local_path(&unknown_entry),
                ),
            },
        ))
        .await
        .expect("discover an entry without registered directory identity")
    else {
        panic!("expected import candidates");
    };
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        candidates[0].usage_history.classification,
        skillhub_core::ImportCandidateUsageHistoryClassification::IdentityUncertain
    );
}

#[tokio::test]
async fn new_skill_or_entry_has_no_inherited_release() {
    const REPLACEMENT_BODY: &str = "---\nname: replacement\n---\n\nnew skill\n";
    let fixture = fixture().await;
    scan(&fixture.facade).await;
    release_active_entry(&fixture.facade, fixture.skill_id).await;

    let replacement_skill = create_library_skill(
        &fixture.facade,
        &fixture._workspace.path().join("source/replacement"),
        "Replacement",
        REPLACEMENT_BODY,
    )
    .await;
    write_skill_body(&fixture.entry_path, REPLACEMENT_BODY);
    let new_entry = fixture
        .entry_path
        .parent()
        .expect("Agent directory")
        .join("fresh");
    write_skill(&new_entry);
    scan(&fixture.facade).await;

    let AppQueryResult::RelationshipOverview(overview) = fixture
        .facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::All,
        }))
        .await
        .expect("query relationship overview after replacement")
    else {
        panic!("expected relationship overview");
    };
    assert!(overview.usage_relations.iter().any(|relation| {
        relation.skill_id == Some(replacement_skill)
            && relation.entry_key == Some(entry_key())
            && relation.active
    }));
    assert!(overview.usage_relations.iter().any(|relation| {
        relation.skill_id == Some(fixture.skill_id)
            && relation.entry_key.as_ref().is_some_and(|key| {
                key.directory_id == DIRECTORY_ID && key.relative_entry_path == "fresh"
            })
            && relation.active
    }));
    let AppQueryResult::ImportCandidates(candidates) = fixture
        .facade
        .query(AppQuery::DiscoverImportCandidates(
            DiscoverImportCandidates {
                source: skillhub_core::SourceDescriptor::new(
                    skillhub_core::SourceKind::Local,
                    skillhub_core::SourceLocator::local_path(&fixture.entry_path),
                ),
            },
        ))
        .await
        .expect("discover replacement skill candidate")
    else {
        panic!("expected import candidates");
    };
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        candidates[0].usage_history.classification,
        skillhub_core::ImportCandidateUsageHistoryClassification::NoKnownRelease
    );
}

#[tokio::test]
async fn reimport_only_adds_provenance() {
    let fixture = fixture().await;
    reuse_import_from_path(&fixture.facade, &fixture.entry_path, fixture.skill_id).await;
    let AppQueryResult::RelationshipOverview(overview) = fixture
        .facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::All,
        }))
        .await
        .expect("overview after import")
    else {
        panic!("expected relationship overview");
    };
    assert!(overview.usage_relations.iter().any(|relation| {
        relation.skill_id == Some(fixture.skill_id)
            && relation.entry_key == Some(entry_key())
            && relation.active
    }));
    let before = fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .provenance_repository()
        .list_provenance_events_for_skill(fixture.skill_id)
        .expect("initial provenance events")
        .len();
    assert_eq!(before, 1);
    release_active_entry(&fixture.facade, fixture.skill_id).await;
    assert!(!has_active_relation(&fixture.facade, fixture.skill_id).await);

    let source_relation_before = fixture
        .facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .relationship_repository()
        .list_source_copy_relations(false)
        .expect("released source copy history")
        .into_iter()
        .find(|relation| relation.source_path.ends_with("/agent/skills/notes"))
        .expect("released source copy fact");

    reuse_import_from_path(&fixture.facade, &fixture.entry_path, fixture.skill_id).await;

    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let events = database
        .provenance_repository()
        .list_provenance_events_for_skill(fixture.skill_id)
        .expect("provenance history");
    let source_relations = database
        .relationship_repository()
        .list_source_copy_relations(false)
        .expect("source copy history");
    assert_eq!(events.len(), 2, "reimport adds provenance history");
    let canonical_source = std::fs::canonicalize(&fixture.entry_path)
        .expect("canonical source")
        .to_string_lossy()
        .into_owned();
    assert!(source_relations
        .iter()
        .any(|relation| { relation.source_path == canonical_source && !relation.active }));
    assert!(source_relations.contains(&source_relation_before));
    assert!(
        source_relations
            .iter()
            .filter(|relation| relation.source_path == canonical_source)
            .all(|relation| !relation.active),
        "reimport must not reactivate a released source-copy relation"
    );
    let decisions = database
        .list_usage_decisions(&fixture.skill_id, &entry_key())
        .expect("release decision history");
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].decision, UsageDecision::Released);
}

#[tokio::test]
async fn explicit_redeployment_creates_a_new_relation_and_keeps_release_history() {
    let fixture = fixture().await;
    scan(&fixture.facade).await;
    release_active_entry(&fixture.facade, fixture.skill_id).await;
    assert!(!has_active_relation(&fixture.facade, fixture.skill_id).await);

    // The fixture simulates the user removing the released independent copy
    // before explicitly asking SkillHub to manage a fresh deployment there.
    std::fs::remove_dir_all(&fixture.entry_path).expect("remove released fixture copy");
    fixture
        .facade
        .execute(AppCommand::RecordAgentCompatibility(
            RecordAgentCompatibility {
                target_id: "target-usage-rescan".into(),
                mode: skillhub_core::DeploymentMode::ManagedCopy,
                status: CompatibilityStatus::Supported,
                agent_version: "fixture".into(),
                evidence: "isolated automated deployment fixture".into(),
                agent_reading_checked: true,
            },
        ))
        .await
        .expect("record fixture target capability");

    let AppQueryResult::Skill(detail) = fixture
        .facade
        .query(AppQuery::GetSkill(GetSkill {
            skill_id: fixture.skill_id,
        }))
        .await
        .expect("read skill before explicit redeployment")
    else {
        panic!("expected skill detail");
    };
    let AppQueryResult::DeploymentPlan(plan) = fixture
        .facade
        .query(AppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::DeploymentPlanRequest {
                skill_id: fixture.skill_id,
                version_id: detail.current_version.expect("current skill version"),
                runtime_name: "notes".into(),
                logical_target_ids: vec!["target-usage-rescan".into()],
                mode_override: Some(skillhub_core::DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect("prepare explicit redeployment plan")
    else {
        panic!("expected deployment plan");
    };
    let AppCommandResult::PreparedDeployment(prepared) = fixture
        .facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare explicit redeployment")
    else {
        panic!("expected prepared deployment");
    };
    let AppCommandResult::DeploymentSummary(summary) = fixture
        .facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("commit explicit redeployment")
    else {
        panic!("expected deployment summary");
    };
    assert!(summary.committed, "explicit redeployment must commit");
    assert!(has_active_relation(&fixture.facade, fixture.skill_id).await);

    let database = Database::open(&fixture.database_path).expect("reopen database");
    let decisions = database
        .list_usage_decisions(&fixture.skill_id, &entry_key())
        .expect("preserved release decision");
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].decision, UsageDecision::Released);
}
