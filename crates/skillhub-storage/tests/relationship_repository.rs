use skillhub_core::agent::DirectoryPrecedence;
use skillhub_core::deployment::{
    DeploymentMode, DeploymentRecord, DeploymentState, ObservedRowAction,
};
use skillhub_core::duplicate::{
    AnalyzeConflictScope, ConflictAnalysisRecord, DuplicateAnalysisSource,
};
use skillhub_core::import::{CandidateOwnership, ImportProvenance};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, DeploymentRelationFact, DirectoryRecognition, DirectoryRole, FileRepresentation,
    RelationshipType, SourceRelationFact,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{
    DeploymentId, ObservedMatchState, ObservedOrigin, OwnershipState, SkillId, VersionId,
};
use skillhub_storage::{Database, CURRENT_SCHEMA_VERSION};

fn skill(db: &Database, skill_id: SkillId) {
    db.connection_for_test()
        .execute(
            "INSERT INTO skills(id, display_name, runtime_name, created_at, updated_at) VALUES (?1, 'Notes', 'notes', 1, 1)",
            [skill_id.to_string()],
        )
        .expect("skill");
}

fn capability() -> AgentDirectoryCapabilityFact {
    AgentDirectoryCapabilityFact {
        agent_client_id: "agent.demo".into(),
        directory_node_id: "directory:agent".into(),
        recognition: DirectoryRecognition::Supported,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: None,
        researched_at: Some("2026-09-16".into()),
        applicable_platforms: vec!["windows".into()],
    }
}

fn deployment(skill_id: SkillId) -> DeploymentRelationFact {
    DeploymentRelationFact {
        relation_id: "relation:notes".into(),
        skill_id: Some(skill_id),
        agent_client_id: "agent.demo".into(),
        path: "C:/agent/notes".into(),
        path_key: String::new(),
        directory_node_id: None,
        relationship: RelationshipType::ObservedCopy,
        file_representation: FileRepresentation::Copy,
        ownership: OwnershipState::ObservedUnmanaged,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: "sha256:notes".into(),
        origin: ObservedOrigin::Scan,
        match_state: ObservedMatchState::ContentVerified,
        active: true,
        observed_at: 42,
        released_at: None,
    }
}

fn source(skill_id: SkillId) -> SourceRelationFact {
    SourceRelationFact {
        provenance_id: "provenance:notes".into(),
        skill_id,
        directory_node_id: None,
        agent_client_id: None,
        source_path: "C:/incoming/notes".into(),
        source_path_key: String::new(),
        relationship: RelationshipType::ImportCopy,
        file_representation: FileRepresentation::Directory,
        ownership: OwnershipState::ObservedUnmanaged,
        link_target_path: None,
        link_target_directory_id: None,
        content_fingerprint: "sha256:notes".into(),
        source: SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path("C:/incoming/notes"),
        ),
        imported_at: 43,
    }
}

fn conflict(skill_id: SkillId) -> ConflictCaseFact {
    ConflictCaseFact {
        conflict_id: "conflict:notes".into(),
        kind: ConflictKind::SameNameDifferentContent,
        classification: ConflictClassification::Uncertain,
        member_skill_ids: vec![skill_id],
        members: Vec::new(),
        evidence: ConflictEvidence::default(),
        user_decision: None,
        decided_at: None,
    }
}

#[test]
fn relationship_revision_advances_at_fact_repository_boundaries_but_not_for_ai_analysis() {
    let db = Database::open_in_memory().expect("database");
    let skill_id = SkillId::new();
    skill(&db, skill_id);
    db.directory_repository()
        .upsert_node(&skillhub_core::relationship::DirectoryNodeFact {
            node_id: "directory:agent".into(),
            path: "C:/agent".into(),
            path_key: String::new(),
            role: DirectoryRole::AgentNative,
            profile_id: None,
            agent_client_id: Some("agent.demo".into()),
            exists: true,
            observed_at: 1,
            scan_source: None,
        })
        .expect("directory");

    let revision0 = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    db.relationship_repository()
        .upsert_capability(&capability())
        .expect("capability");
    let revision1 = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(revision1 > revision0);

    db.relationship_repository()
        .upsert_deployment_relation(&deployment(skill_id))
        .expect("deployment relation");
    let revision2 = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(revision2 > revision1);

    db.relationship_repository()
        .upsert_source_relation(&source(skill_id))
        .expect("source relation");
    let revision3 = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(revision3 > revision2);

    db.conflict_repository()
        .create_case(&conflict(skill_id))
        .expect("conflict case");
    let revision4 = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(revision4 > revision3);

    db.conflict_repository()
        .record_decision("conflict:notes", ConflictClassification::DistinctSkill, 44)
        .expect("conflict decision");
    let revision5 = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(revision5 > revision4);

    db.conflict_analysis_repository()
        .insert_record(&ConflictAnalysisRecord {
            record_id: "analysis:notes".into(),
            conflict_id: "conflict:notes".into(),
            scope: AnalyzeConflictScope::All,
            input_fingerprint: "sha256:input".into(),
            baseline_classification: ConflictClassification::DistinctSkill,
            conclusion: None,
            source: DuplicateAnalysisSource::Llm,
            analyzed_at: 45,
            failure_code: None,
            adopted_by_user: false,
        })
        .expect("analysis");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        revision5,
        "AI analysis is advisory and must not invalidate graph structure"
    );
}

#[test]
fn schema_0015_upgrades_to_relationship_projection_state_without_editing_old_migrations() {
    let db = Database::open_in_memory().expect("database");
    assert_eq!(db.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        0
    );
}

#[test]
fn capability_revision_changes_only_for_committed_fact_changes() {
    let db = Database::open_in_memory().expect("database");
    db.directory_repository()
        .upsert_node(&skillhub_core::relationship::DirectoryNodeFact {
            node_id: "directory:agent".into(),
            path: "C:/agent".into(),
            path_key: String::new(),
            role: DirectoryRole::AgentNative,
            profile_id: None,
            agent_client_id: Some("agent.demo".into()),
            exists: true,
            observed_at: 1,
            scan_source: None,
        })
        .expect("directory");

    let capability = capability();
    db.relationship_repository()
        .upsert_capability(&capability)
        .expect("initial capability");
    let first_revision = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    db.relationship_repository()
        .upsert_capability(&capability)
        .expect("idempotent capability");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        first_revision
    );

    let mut changed = capability.clone();
    changed.recognition = DirectoryRecognition::Unknown;
    db.relationship_repository()
        .upsert_capability(&changed)
        .expect("changed capability");
    let changed_revision = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(changed_revision > first_revision);

    let mut invalid = changed;
    invalid.directory_node_id = "directory:missing".into();
    assert!(db
        .relationship_repository()
        .upsert_capability(&invalid)
        .is_err());
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        changed_revision
    );
}

#[test]
fn relationship_fact_replays_and_failed_conflict_decisions_do_not_advance_revision() {
    let db = Database::open_in_memory().expect("database");
    let skill_id = SkillId::new();
    skill(&db, skill_id);

    let deployment = deployment(skill_id);
    db.relationship_repository()
        .upsert_deployment_relation(&deployment)
        .expect("initial deployment");
    let deployment_revision = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    db.relationship_repository()
        .upsert_deployment_relation(&deployment)
        .expect("idempotent deployment");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        deployment_revision
    );

    let source = source(skill_id);
    db.relationship_repository()
        .upsert_source_relation(&source)
        .expect("initial source");
    let source_revision = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    db.relationship_repository()
        .upsert_source_relation(&source)
        .expect("idempotent source");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        source_revision
    );

    let conflict = conflict(skill_id);
    db.conflict_repository()
        .create_case(&conflict)
        .expect("initial conflict");
    let conflict_revision = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    db.conflict_repository()
        .create_case(&conflict)
        .expect("idempotent conflict");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        conflict_revision
    );

    db.conflict_repository()
        .record_decision(
            &conflict.conflict_id,
            ConflictClassification::DistinctSkill,
            44,
        )
        .expect("changed decision");
    let decision_revision = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    db.conflict_repository()
        .record_decision(
            &conflict.conflict_id,
            ConflictClassification::DistinctSkill,
            44,
        )
        .expect("idempotent decision");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        decision_revision
    );

    assert!(db
        .conflict_repository()
        .record_decision(
            "conflict:missing",
            ConflictClassification::DistinctSkill,
            45
        )
        .is_err());
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        decision_revision
    );
}

/// 托管部署由 `deployment_repository` 而不是 `relationship_repository` 写入，
/// 但落到同一张 `deployment_relations` 事实表，因此必须同样使投影失效。
fn managed_target(db: &Database, skill_id: SkillId) -> DeploymentRecord {
    db.connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('target:agent', 'agent', 'global', 'C:/agent', 0)",
            [],
        )
        .expect("target");
    let version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000011")
            .expect("version id");
    db.connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'sha256:notes', '{}', 0)",
            rusqlite::params![version.to_string(), skill_id.to_string()],
        )
        .expect("version");
    DeploymentRecord {
        id: DeploymentId::new(),
        skill_id,
        version_id: version,
        target_id: "target:agent".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "notes".into(),
        expected_hash: "sha256:notes".into(),
        observed_hash: None,
    }
}

#[test]
fn managed_deployment_sync_detach_and_release_advance_the_relationship_revision() {
    let db = Database::open_in_memory().expect("database");
    let skill_id = SkillId::new();
    skill(&db, skill_id);
    let deployment = managed_target(&db, skill_id);
    let before = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();

    db.deployment_repository()
        .insert_sync(&deployment)
        .expect("managed deployment");
    let inserted = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(
        inserted > before,
        "a managed deployment writes a relationship fact and must invalidate the projection"
    );

    // 解除集中库管理改写 ownership，是另一条必须失效的事实写入路径。
    db.deployment_repository()
        .detach_management_sync(deployment.id)
        .expect("detach managed deployment");
    let detached = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(
        detached > inserted,
        "detaching management changes the ownership fact and must invalidate the projection"
    );

    db.deployment_repository()
        .mark_removed_sync(deployment.id)
        .expect("release managed deployment");
    let released = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(
        released > detached,
        "releasing a managed deployment must invalidate the projection"
    );

    let relation = db
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{}", deployment.id))
        .expect("managed relation");
    assert!(
        !relation.active,
        "release must be visible as an inactive fact"
    );
    assert_eq!(relation.ownership, OwnershipState::ObservedUnmanaged);
}

#[test]
fn provenance_writes_advance_the_relationship_revision_only_for_new_facts() {
    let db = Database::open_in_memory().expect("database");
    let skill_id = SkillId::new();
    skill(&db, skill_id);
    let before = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    let provenance = ImportProvenance::new(
        skill_id,
        "C:/incoming/notes",
        SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path("C:/incoming/notes"),
        ),
        CandidateOwnership::KnownAgentTarget,
        "sha256:notes",
        43,
    );

    db.provenance_repository()
        .upsert_provenance(&provenance)
        .expect("provenance");
    let written = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(
        written > before,
        "recording import provenance writes a source relationship fact"
    );

    db.provenance_repository()
        .upsert_provenance(&provenance)
        .expect("idempotent provenance");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        written,
        "re-importing the identical provenance writes no new relationship fact"
    );
}

#[test]
fn observed_deployment_release_advances_the_relationship_revision() {
    let db = Database::open_in_memory().expect("database");
    let skill_id = SkillId::new();
    skill(&db, skill_id);
    let relation = deployment(skill_id);
    db.relationship_repository()
        .upsert_deployment_relation(&relation)
        .expect("observed relation");
    let established = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();

    db.provenance_repository()
        .apply_observed_row_action(
            "agent.demo",
            &relation.path,
            &ObservedRowAction::Release,
            ObservedOrigin::Scan,
            50,
        )
        .expect("release observed deployment");
    let released = db
        .relationship_repository()
        .relationship_revision()
        .unwrap();
    assert!(
        released > established,
        "releasing an observed deployment changes the relationship fact"
    );

    db.provenance_repository()
        .apply_observed_row_action(
            "agent.demo",
            &relation.path,
            &ObservedRowAction::Release,
            ObservedOrigin::Scan,
            51,
        )
        .expect("idempotent release");
    assert_eq!(
        db.relationship_repository()
            .relationship_revision()
            .unwrap(),
        released,
        "releasing an already released relation writes no new fact"
    );
}
