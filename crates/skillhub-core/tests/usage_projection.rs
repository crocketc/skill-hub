use skillhub_core::agent::{
    AgentDirectoryAvailability, AgentDirectoryDeploymentStatus, AgentDirectoryFact,
    AgentDirectoryIdentity, AgentDirectoryMemberCapabilities, AgentDirectoryMemberFact,
    AgentDirectoryProjection, AgentDirectoryRole,
};
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::import::{ImportProvenanceEvent, ImportSourceClass};
use skillhub_core::relationship::{
    project_usage_relations, AgentDirectoryCapabilityFact, DeploymentRelationFact,
    DirectoryNodeFact, DirectoryRecognition, DirectoryRole, FileRepresentation, OwnershipState,
    RelationshipType, SourceCopyDecision, SourceCopyHealth, SourceCopyRelationFact, UsageDecision,
    UsageDecisionEvidence, UsageEntryKey, UsageForm, UsageHealthReason, UsageManagement,
    UsageManagementEvidence, UsageProjectionInput,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::SkillId;

const ROOT: &str = "C:/agent/skills";

fn directory(role: AgentDirectoryRole) -> AgentDirectoryProjection {
    AgentDirectoryProjection {
        directories: vec![AgentDirectoryFact {
            role,
            is_shared_directory: false,
            identity: AgentDirectoryIdentity::VerifiedPhysical("directory-physical".into()),
            path: ROOT.into(),
            status: skillhub_core::DirectoryObservationStatus::Existing,
            exists: true,
            readable: true,
            writable: role != AgentDirectoryRole::Builtin,
            available: true,
            members: vec![AgentDirectoryMemberFact {
                logical_target_id: "target:agent".into(),
                brand: Some("agent".into()),
                client_id: Some("agent.demo".into()),
                kind: None,
                supports_shared_directory: false,
                availability: AgentDirectoryAvailability {
                    status: skillhub_core::DirectoryObservationStatus::Existing,
                    exists: true,
                    readable: true,
                    writable: role != AgentDirectoryRole::Builtin,
                    available: true,
                },
                capabilities: AgentDirectoryMemberCapabilities {
                    compatibility: None,
                    deployment: skillhub_core::DeploymentCapability::new(false, false, false),
                    modes: Vec::new(),
                    preferred_mode: None,
                },
                deployment_status: AgentDirectoryDeploymentStatus::NotDeployed,
                managed_deployment_relation_count: 0,
                managed_deployment_count: 0,
            }],
        }],
    }
}

fn node() -> DirectoryNodeFact {
    DirectoryNodeFact {
        node_id: "directory:agent".into(),
        path: ROOT.into(),
        path_key: skillhub_core::deployment::observed_path_key(ROOT),
        role: DirectoryRole::AgentNative,
        profile_id: Some("agent".into()),
        agent_client_id: Some("agent.demo".into()),
        exists: true,
        observed_at: 1,
        scan_source: Some("fixture".into()),
    }
}

fn directory_recognition() -> Vec<AgentDirectoryCapabilityFact> {
    vec![AgentDirectoryCapabilityFact {
        agent_client_id: "agent.demo".into(),
        directory_node_id: "directory:agent".into(),
        recognition: DirectoryRecognition::Supported,
        precedence: skillhub_core::agent::DirectoryPrecedence::Preferred,
        evidence_reference: Some("fixture".into()),
        researched_at: None,
        applicable_platforms: vec!["windows".into()],
    }]
}

fn deployment(
    relationship: RelationshipType,
    reasons: Option<Vec<skillhub_core::relationship::RelationHealthReason>>,
) -> DeploymentRelationFact {
    DeploymentRelationFact {
        relation_id: format!("relation:{relationship:?}"),
        skill_id: Some(SkillId::new()),
        agent_client_id: "agent.demo".into(),
        path: format!("{ROOT}/notes"),
        path_key: format!("{ROOT}/notes").to_ascii_lowercase(),
        directory_node_id: Some("directory:agent".into()),
        relationship,
        file_representation: FileRepresentation::Copy,
        ownership: OwnershipState::ObservedUnmanaged,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: "sha256:entry".into(),
        origin: ObservedOrigin::Scan,
        match_state: ObservedMatchState::ContentVerified,
        health_reasons: reasons,
        active: true,
        observed_at: 1,
        released_at: None,
    }
}

fn source_copy() -> SourceCopyRelationFact {
    let event = ImportProvenanceEvent {
        provenance_id: "provenance:import".into(),
        batch_id: "batch:import".into(),
        skill_id: SkillId::new(),
        source_class: ImportSourceClass::AgentLocal,
        source: SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path(format!("{ROOT}/notes")),
        ),
        local_source_path: Some(format!("{ROOT}/notes")),
        source_container_id: Some("directory:agent".into()),
        physical_source_id: Some("file-id:ephemeral".into()),
        agent_client_id: Some("agent.demo".into()),
        content_fingerprint: "sha256:import-snapshot".into(),
        imported_at: 1,
    };
    let mut copy = SourceCopyRelationFact::from_import_event(
        "relation:source",
        &event,
        skillhub_core::deployment::observed_path_key(&format!("{ROOT}/notes")),
        "file-id:ephemeral",
    )
    .expect("local source copy");
    copy.current_fingerprint = Some("sha256:import-snapshot".into());
    copy.health = SourceCopyHealth::Normal;
    copy.health_reasons = Some(Vec::new());
    copy.decision = SourceCopyDecision::Retained;
    copy
}

fn project(
    deployments: &[DeploymentRelationFact],
    source_copies: &[SourceCopyRelationFact],
    agent_directories: &AgentDirectoryProjection,
    decisions: &[UsageDecisionEvidence],
    management: &[UsageManagementEvidence],
) -> Vec<skillhub_core::relationship::UsageRelationView> {
    let nodes = vec![node()];
    let recognition = directory_recognition();
    project_usage_relations(&UsageProjectionInput {
        deployments,
        source_copies,
        directory_nodes: &nodes,
        directory_recognition: &recognition,
        agent_directories,
        decision_evidence: decisions,
        management_evidence: management,
    })
}

#[test]
fn historical_technical_types_remain_readable() {
    let values = [
        "import_copy",
        "shared_directory_read",
        "shared_directory_reference",
        "managed_copy",
        "managed_link",
        "observed_copy",
        "observed_link",
        "unknown",
    ];
    let projection = directory(AgentDirectoryRole::AgentUser);
    let mut relations = Vec::new();
    for value in values {
        let relationship: RelationshipType = serde_json::from_str(&format!("\"{value}\""))
            .expect("legacy relationship type remains readable");
        relations.push(deployment(relationship, Some(Vec::new())));
    }
    let views = project(&relations, &[], &projection, &[], &[]);
    assert_eq!(views.len(), values.len());
    assert!(views
        .iter()
        .all(|view| view.form == Some(UsageForm::FullCopy)));
    let unknown = views
        .iter()
        .find(|view| view.relation_id == "relation:Unknown")
        .expect("unknown legacy type remains projected");
    assert!(unknown
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!unknown.health_reasons.contains(&UsageHealthReason::Normal));
}

#[test]
fn source_baseline_is_import_snapshot() {
    let copies = vec![source_copy()];
    let views = project(
        &[],
        &copies,
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("recognized source original is a use");
    assert_eq!(view.health_reasons, vec![UsageHealthReason::Normal]);
    assert_eq!(view.form, Some(UsageForm::FullCopy));
    assert_eq!(view.management, UsageManagement::Unmanaged);
    assert_eq!(
        view.decision, None,
        "legacy auto-retained is not user evidence"
    );
    assert_eq!(
        view.physical_source_id_evidence.as_deref(),
        Some("file-id:ephemeral")
    );
    assert_eq!(
        view.entry_key,
        Some(UsageEntryKey {
            directory_id: "directory:agent".into(),
            relative_entry_path: "notes".into(),
        })
    );
}

#[test]
fn unknown_probe_is_not_normal() {
    let relations = vec![deployment(RelationshipType::ManagedLink, None)];
    let views = project(
        &relations,
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("active relation is projected");
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(!view.health_reasons.contains(&UsageHealthReason::Normal));
}

#[test]
fn builtin_original_is_not_retained_copy() {
    let copies = vec![source_copy()];
    let views = project(
        &[],
        &copies,
        &directory(AgentDirectoryRole::Builtin),
        &[],
        &[],
    );
    let view = views.first().expect("built-in original remains visible");
    assert_eq!(
        view.target.directory_role,
        Some(AgentDirectoryRole::Builtin)
    );
    assert_eq!(view.management, UsageManagement::Unmanaged);
    assert_eq!(view.decision, None);
    assert!(view.decision_history_ids.is_empty());
}

#[test]
fn explicit_decision_evidence_is_kept_separate_from_health() {
    let relations = vec![deployment(
        RelationshipType::ManagedCopy,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::ContentChanged,
        ]),
    )];
    let decision = UsageDecisionEvidence {
        relation_id: relations[0].relation_id.clone(),
        decision: UsageDecision::RetainedIndependentCopy,
        history_id: Some("decision:explicit".into()),
    };
    let views = project(
        &relations,
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[decision],
        &[UsageManagementEvidence {
            relation_id: relations[0].relation_id.clone(),
            management: UsageManagement::Managed,
        }],
    );
    let view = views.first().expect("active relation is projected");
    assert_eq!(view.decision, Some(UsageDecision::RetainedIndependentCopy));
    assert_eq!(view.decision_history_ids, vec!["decision:explicit"]);
    assert_eq!(view.management, UsageManagement::Managed);
    assert_eq!(view.health_reasons, vec![UsageHealthReason::ContentChanged]);
}

#[test]
fn ordinary_source_directory_does_not_create_a_usage_relation() {
    let copies = vec![source_copy()];
    let views = project(&[], &copies, &AgentDirectoryProjection::default(), &[], &[]);
    assert!(views.is_empty());
}

#[test]
fn agent_native_directory_role_remains_unconfirmed_without_agent_projection_evidence() {
    let copies = vec![source_copy()];
    let views = project(
        &[],
        &copies,
        &directory(AgentDirectoryRole::AgentNative),
        &[],
        &[],
    );
    assert!(views.is_empty());
}

#[test]
fn conflicting_directory_identity_is_not_replaced_by_a_path_guess() {
    let mut copy = source_copy();
    copy.directory_node_id = Some("directory:stale".into());
    let views = project(
        &[],
        &[copy],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    assert!(views.is_empty());
}

#[test]
fn shared_scope_comes_from_the_agent_directory_projection() {
    let copies = vec![source_copy()];
    let mut projection = directory(AgentDirectoryRole::AgentUser);
    projection.directories[0].is_shared_directory = true;

    let views = project(&[], &copies, &projection, &[], &[]);
    let view = views
        .first()
        .expect("confirmed shared directory is projected");
    assert_eq!(
        view.target.kind,
        skillhub_core::relationship::RelationGovernanceTargetKind::SharedDirectory
    );
    assert_eq!(
        view.target.directory_role,
        Some(AgentDirectoryRole::SharedDirectory)
    );
}

#[test]
fn verification_match_state_is_not_discarded_when_health_reasons_are_empty() {
    let mut diverged = deployment(RelationshipType::ObservedCopy, Some(Vec::new()));
    diverged.match_state = ObservedMatchState::Diverged;
    let mut name_only = deployment(RelationshipType::ObservedCopy, Some(Vec::new()));
    name_only.relation_id = "relation:name-only".into();
    name_only.match_state = ObservedMatchState::NameOnly;

    let views = project(
        &[diverged, name_only],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let diverged = views
        .iter()
        .find(|view| view.relation_id == "relation:ObservedCopy")
        .expect("diverged deployment is projected");
    assert_eq!(
        diverged.health_reasons,
        vec![UsageHealthReason::ContentChanged]
    );
    let name_only = views
        .iter()
        .find(|view| view.relation_id == "relation:name-only")
        .expect("name-only deployment is projected");
    assert_eq!(
        name_only.health_reasons,
        vec![UsageHealthReason::UserConfirmation]
    );
}

#[test]
fn link_and_junction_evidence_are_preserved_under_one_business_form() {
    let mut link = deployment(RelationshipType::ManagedLink, Some(Vec::new()));
    link.file_representation = FileRepresentation::SymbolicLink;
    link.link_target_path = Some("C:/library/notes".into());
    let mut junction = deployment(RelationshipType::ObservedLink, Some(Vec::new()));
    junction.relation_id = "relation:junction".into();
    junction.file_representation = FileRepresentation::DirectoryJunction;
    junction.link_target_path = Some("C:/library/other".into());
    let skill_id = SkillId::new();
    link.skill_id = Some(skill_id);
    junction.skill_id = Some(skill_id);
    let views = project(
        &[link.clone(), junction.clone()],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    assert_eq!(views.len(), 1, "same skill and entry is one usage relation");
    assert_eq!(views[0].form, Some(UsageForm::Link));
    assert!(matches!(
        views[0].file_representation,
        FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction
    ));
    assert!(views[0].link_target_path.is_some());
    assert_eq!(views[0].evidence_relation_ids.len(), 2);
}
