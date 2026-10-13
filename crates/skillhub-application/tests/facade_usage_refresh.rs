//! T20 relationship refresh coverage. Watch roots must include original
//! import sources, managed links/copies, and confirmed usage environments.

use std::path::Path;
use std::sync::Arc;

use skillhub_application::relationship_watch_confirmation::{
    FacadeRelationshipCheckExecutor, RelationshipCheckExecuting,
};
use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::DirectoryPrecedence;
use skillhub_core::api::SaveSkillContent;
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::RelationshipCheckReport;
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryNodeFact, DirectoryRecognition, DirectoryRole,
    FileRepresentation, OwnershipState, RelationshipType,
};
use skillhub_core::{
    AppCommand, AppCommandResult, ApplicationFacade, CommitImport, FactsChanged, ImportCandidate,
    ImportDecision, ImportGovernanceDecision, PrepareImport, SourceDescriptor, SourceKind,
    SourceLocator,
};
use skillhub_storage::{CentralLibrary, Database};

fn facade_with(workspace: &Path) -> LocalApplicationFacade {
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, &library_root)
}

fn write_skill(root: &Path, body: &str) {
    std::fs::create_dir_all(root).expect("create skill directory");
    std::fs::write(root.join("SKILL.md"), body).expect("write skill");
}

async fn import_original(facade: &LocalApplicationFacade, source: &Path) -> skillhub_core::SkillId {
    write_skill(source, "# Imported original\n");
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source)),
        source.to_string_lossy(),
        ".",
        "SKILL.md",
        "Imported original",
    );
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepare import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let committed = facade
        .execute(AppCommand::CommitImport(CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision: ImportGovernanceDecision {
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
            batch_signature: None,
            security_decision: None,
        }))
        .await
        .expect("commit import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary.items[0].skill_id.expect("imported skill id")
}

fn seed_managed_relation(
    facade: &LocalApplicationFacade,
    relation_id: &str,
    skill_id: skillhub_core::SkillId,
    path: &Path,
    representation: FileRepresentation,
    relationship: RelationshipType,
) {
    let database = facade.database_for_tests().clone();
    let database = database.lock().expect("database");
    database
        .relationship_repository()
        .upsert_deployment_relation(&skillhub_core::relationship::DeploymentRelationFact {
            relation_id: relation_id.into(),
            skill_id: Some(skill_id),
            agent_client_id: "agent.refresh-fixture".into(),
            path: path.to_string_lossy().into_owned(),
            path_key: skillhub_core::deployment::observed_path_key(&path.to_string_lossy()),
            directory_node_id: Some("directory:refresh-agent".into()),
            relationship,
            file_representation: representation,
            ownership: OwnershipState::SkillhubManaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: "sha256:fixture".into(),
            origin: ObservedOrigin::Import,
            match_state: ObservedMatchState::ContentVerified,
            health_reasons: Some(Vec::new()),
            active: true,
            observed_at: 1,
            released_at: None,
        })
        .expect("seed managed relation");
}

#[tokio::test]
async fn watcher_covers_link_copy_original_and_environment() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let original = workspace.path().join("original-source");
    let skill_id = import_original(&facade, &original).await;

    let agent_root = workspace.path().join("agent-environment");
    let link_entry = agent_root.join("linked-skill");
    let copy_entry = agent_root.join("copied-skill");
    write_skill(&link_entry, "# Linked\n");
    write_skill(&copy_entry, "# Copied\n");
    {
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database");
        database
            .directory_repository()
            .upsert_node(&DirectoryNodeFact {
                node_id: "directory:refresh-agent".into(),
                path: agent_root.to_string_lossy().into_owned(),
                path_key: skillhub_core::deployment::observed_path_key(
                    &agent_root.to_string_lossy(),
                ),
                role: DirectoryRole::SharedDirectory,
                profile_id: Some("refresh-fixture".into()),
                agent_client_id: Some("agent.refresh-fixture".into()),
                exists: true,
                observed_at: 1,
                scan_source: Some("test".into()),
            })
            .expect("seed environment directory");
        database
            .relationship_repository()
            .upsert_capability(&AgentDirectoryCapabilityFact {
                agent_client_id: "agent.refresh-fixture".into(),
                directory_node_id: "directory:refresh-agent".into(),
                recognition: DirectoryRecognition::Supported,
                precedence: DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: Some("2026-10-10".into()),
                applicable_platforms: vec!["windows".into(), "macos".into(), "linux".into()],
            })
            .expect("seed environment recognition");
    }
    seed_managed_relation(
        &facade,
        "relation:refresh-link",
        skill_id,
        &link_entry,
        FileRepresentation::SymbolicLink,
        RelationshipType::ManagedLink,
    );
    seed_managed_relation(
        &facade,
        "relation:refresh-copy",
        skill_id,
        &copy_entry,
        FileRepresentation::Copy,
        RelationshipType::ManagedCopy,
    );

    let facade = Arc::new(facade);
    let executor = FacadeRelationshipCheckExecutor::new(facade.clone());
    let roots = executor.active_roots().expect("watch roots");
    let roots = roots.into_iter().collect::<std::collections::BTreeSet<_>>();

    for expected in [original, link_entry, copy_entry, agent_root.clone()] {
        assert!(
            roots.contains(&expected),
            "watcher omits relationship or recognized environment root: {}",
            expected.display()
        );
    }

    let facts = executor
        .facts_changed_for_path(
            &agent_root.join("linked-skill/SKILL.md"),
            &RelationshipCheckReport {
                items: Vec::new(),
                relationship_revision: 0,
            },
        )
        .expect("scope watcher facts")
        .expect("recognized usage path is mapped");
    assert_eq!(facts.skill_ids, vec![skill_id]);
    assert!(facts.entry_keys.iter().any(|key| {
        key.directory_id == "directory:refresh-agent" && key.relative_entry_path == "linked-skill"
    }));
    assert!(facts.environment_keys.iter().any(|environment| {
        environment.agent_client_id == "agent.refresh-fixture" && environment.project_id.is_none()
    }));
}

#[tokio::test]
async fn source_baseline_is_not_overwritten_by_deployment_probe() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let original = workspace.path().join("original-source");
    let skill_id = import_original(&facade, &original).await;
    let before = {
        let database = facade.database_for_tests().clone();
        let database = database.lock().expect("database");
        database
            .relationship_repository()
            .list_source_copy_relations(true)
            .expect("source-copy relations")
            .into_iter()
            .find(|relation| relation.skill_id == skill_id)
            .expect("imported original relation")
            .expected_fingerprint
    };

    let updated_subject = workspace.path().join("updated-subject");
    write_skill(&updated_subject, "# Updated subject\n");
    let saved = facade
        .execute(AppCommand::SaveSkillContent(SaveSkillContent {
            skill_id,
            source_path: updated_subject.to_string_lossy().into_owned(),
        }))
        .await
        .expect("update managed subject");
    assert!(matches!(saved, AppCommandResult::OperationSummary(_)));

    let managed_copy = workspace.path().join("managed-copy");
    write_skill(&managed_copy, "# managed copy with an independent probe\n");
    seed_managed_relation(
        &facade,
        "relation:baseline-probe",
        skill_id,
        &managed_copy,
        FileRepresentation::Copy,
        RelationshipType::ManagedCopy,
    );
    let facade = Arc::new(facade);
    let executor = FacadeRelationshipCheckExecutor::new(facade.clone());
    let report = executor
        .check_path(&managed_copy.join("SKILL.md"))
        .expect("confirm watched deployment path");
    assert!(
        report.items.is_empty(),
        "a managed deployment path must not be reinterpreted as the import source"
    );

    let database = facade.database_for_tests().clone();
    let database = database.lock().expect("database");
    let imported = database
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("source-copy relations")
        .into_iter()
        .find(|relation| relation.skill_id == skill_id)
        .expect("imported original relation");
    assert_eq!(imported.expected_fingerprint, before);
    assert_eq!(
        std::fs::read_to_string(original.join("SKILL.md")).expect("original source remains intact"),
        "# Imported original\n"
    );
}

#[test]
fn facts_changed_carries_all_refresh_scope_dimensions() {
    let payload = serde_json::to_value(FactsChanged::new()).expect("serialize event payload");
    assert_eq!(
        payload,
        serde_json::json!({
            "operation_id": null,
            "skill_ids": [],
            "entry_keys": [],
            "environment_keys": [],
            "problem_ids": [],
        }),
        "the existing app event must carry an explicit, stable refresh scope"
    );
}
