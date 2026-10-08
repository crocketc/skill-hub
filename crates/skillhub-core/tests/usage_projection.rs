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
        path_key: skillhub_core::deployment::observed_path_key(&format!("{ROOT}/notes")),
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
    project_with_directory_facts(
        deployments,
        source_copies,
        agent_directories,
        decisions,
        management,
        &nodes,
        &recognition,
    )
}

fn project_with_directory_facts(
    deployments: &[DeploymentRelationFact],
    source_copies: &[SourceCopyRelationFact],
    agent_directories: &AgentDirectoryProjection,
    decisions: &[UsageDecisionEvidence],
    management: &[UsageManagementEvidence],
    nodes: &[DirectoryNodeFact],
    recognition: &[AgentDirectoryCapabilityFact],
) -> Vec<skillhub_core::relationship::UsageRelationView> {
    project_usage_relations(&UsageProjectionInput {
        deployments,
        source_copies,
        directory_nodes: nodes,
        directory_recognition: recognition,
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
    assert_eq!(view.physical_source_ids_evidence, vec!["file-id:ephemeral"]);
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
    name_only.path = format!("{ROOT}/name-only");
    name_only.path_key = name_only.path.to_ascii_lowercase();
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
    junction.link_target_path = Some("C:/library/notes".into());
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
    assert_eq!(views[0].health_reasons, vec![UsageHealthReason::Normal]);
}

#[test]
fn original_identity_change_is_not_reported_as_link_abnormal() {
    let original = source_copy();
    let skillhub_core::relationship::SourceCopyTransition::Update(original) =
        skillhub_core::relationship::validate_source_copy_transition(
            &original,
            skillhub_core::relationship::SourceCopyProbe::PhysicalIdentityChanged,
            2,
        )
    else {
        panic!("identity verification updates the active source fact");
    };

    let views = project(
        &[],
        &[original],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("recognized original remains visible");

    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view
        .health_reasons
        .contains(&UsageHealthReason::LinkAbnormal));
    assert!(!view
        .health_reasons
        .contains(&UsageHealthReason::ContentChanged));
}

#[test]
fn full_copy_replacement_is_not_reported_as_link_abnormal() {
    let mut relation = deployment(
        RelationshipType::ObservedCopy,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::TargetEntryReplaced,
        ]),
    );
    relation.file_representation = FileRepresentation::Copy;

    let views = project(
        &[relation],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views
        .first()
        .expect("active full-copy relation is projected");

    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view
        .health_reasons
        .contains(&UsageHealthReason::LinkAbnormal));
}

#[test]
fn replaced_link_still_reports_link_abnormal() {
    let mut relation = deployment(
        RelationshipType::ObservedLink,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::TargetEntryReplaced,
        ]),
    );
    relation.file_representation = FileRepresentation::SymbolicLink;

    let views = project(
        &[relation],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("active link relation is projected");

    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::LinkAbnormal));
}

#[test]
fn unknown_file_representation_is_not_reported_as_normal() {
    let mut relation = deployment(RelationshipType::ObservedCopy, Some(Vec::new()));
    relation.file_representation = FileRepresentation::Unknown;

    let views = project(
        &[relation],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("active relation is projected");

    assert_eq!(view.form, None);
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view.health_reasons.contains(&UsageHealthReason::Normal));
}

#[test]
fn ordinary_original_operation_failure_does_not_claim_copy_sync_failed() {
    let mut original = source_copy();
    original.health = SourceCopyHealth::OperationFailed;
    original.health_reasons = Some(vec![
        skillhub_core::relationship::RelationHealthReason::OperationFailed,
    ]);

    let views = project(
        &[],
        &[original],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("recognized original remains visible");

    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view.health_reasons.contains(&UsageHealthReason::SyncFailed));
}

#[test]
fn unmanaged_deployment_operation_failure_does_not_claim_copy_sync_failed() {
    let relation = deployment(
        RelationshipType::ObservedCopy,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::OperationFailed,
        ]),
    );
    let views = project(
        &[relation],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("active deployment is projected");

    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view.health_reasons.contains(&UsageHealthReason::SyncFailed));
}

#[test]
fn managed_link_operation_failure_does_not_claim_copy_sync_failed() {
    let mut relation = deployment(
        RelationshipType::ManagedLink,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::OperationFailed,
        ]),
    );
    relation.file_representation = FileRepresentation::SymbolicLink;
    relation.ownership = OwnershipState::SkillhubManaged;

    let views = project(
        &[relation],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    let view = views.first().expect("active managed link is projected");

    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view.health_reasons.contains(&UsageHealthReason::SyncFailed));
}

#[test]
fn conflicting_link_targets_require_confirmation_and_expose_no_actionable_target() {
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
        &[link, junction],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    assert_eq!(views.len(), 1, "same skill and entry has one usage view");
    let view = &views[0];

    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view.health_reasons.contains(&UsageHealthReason::Normal));
    assert_eq!(view.form, None);
    assert_eq!(view.file_representation, FileRepresentation::Unknown);
    assert_eq!(view.link_target_path, None);
    assert_eq!(view.link_target_path_key, None);
    assert_eq!(view.link_target_directory_id, None);
    assert_eq!(view.evidence_relation_ids.len(), 2);
}

#[test]
fn three_way_link_target_conflict_stays_sticky_when_unknown_evidence_follows() {
    let mut link = deployment(RelationshipType::ManagedLink, Some(Vec::new()));
    link.relation_id = "relation:a-link".into();
    link.file_representation = FileRepresentation::SymbolicLink;
    link.link_target_path = Some("C:/library/notes".into());
    let mut junction = deployment(RelationshipType::ObservedLink, Some(Vec::new()));
    junction.relation_id = "relation:b-junction".into();
    junction.file_representation = FileRepresentation::DirectoryJunction;
    junction.link_target_path = Some("C:/library/other".into());
    let mut unknown = deployment(RelationshipType::ObservedLink, Some(Vec::new()));
    unknown.relation_id = "relation:c-unknown".into();
    unknown.file_representation = FileRepresentation::Unknown;
    unknown.link_target_path = Some("C:/library/third".into());
    let skill_id = SkillId::new();
    link.skill_id = Some(skill_id);
    junction.skill_id = Some(skill_id);
    unknown.skill_id = Some(skill_id);

    for relations in [
        [link.clone(), junction.clone(), unknown.clone()],
        [unknown.clone(), link.clone(), junction.clone()],
        [link.clone(), unknown.clone(), junction.clone()],
    ] {
        let views = project(
            &relations,
            &[],
            &directory(AgentDirectoryRole::AgentUser),
            &[],
            &[],
        );
        assert_eq!(views.len(), 1);
        let view = &views[0];
        assert!(view
            .health_reasons
            .contains(&UsageHealthReason::UserConfirmation));
        assert!(!view.health_reasons.contains(&UsageHealthReason::Normal));
        assert_eq!(view.form, None);
        assert_eq!(view.file_representation, FileRepresentation::Unknown);
        assert_eq!(view.link_target_path, None);
        assert_eq!(view.link_target_path_key, None);
        assert_eq!(view.link_target_directory_id, None);
        assert_eq!(view.evidence_relation_ids.len(), 3);
    }
}

#[test]
fn conflicting_skills_at_one_usage_entry_are_both_unconfirmed() {
    let mut first = deployment(RelationshipType::ObservedCopy, Some(Vec::new()));
    let mut second = deployment(RelationshipType::ObservedCopy, Some(Vec::new()));
    first.skill_id = Some(SkillId::new());
    second.skill_id = Some(SkillId::new());
    second.relation_id = "relation:other-skill".into();

    let views = project(
        &[first, second],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );

    assert_eq!(
        views.len(),
        2,
        "conflicting skill evidence is not collapsed"
    );
    assert!(views.iter().all(|view| view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation)));
    assert!(views
        .iter()
        .all(|view| !view.health_reasons.contains(&UsageHealthReason::Normal)));
}

#[test]
fn different_usage_forms_at_one_entry_do_not_choose_a_normal_form() {
    let mut copy = deployment(RelationshipType::ObservedCopy, Some(Vec::new()));
    copy.file_representation = FileRepresentation::Copy;
    let mut link = deployment(RelationshipType::ObservedLink, Some(Vec::new()));
    link.relation_id = "relation:link".into();
    link.file_representation = FileRepresentation::SymbolicLink;
    link.link_target_path = Some("C:/library/notes".into());
    let skill_id = SkillId::new();
    copy.skill_id = Some(skill_id);
    link.skill_id = Some(skill_id);

    let views = project(
        &[copy, link],
        &[],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    assert_eq!(views.len(), 1);
    assert!(views[0]
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!views[0].health_reasons.contains(&UsageHealthReason::Normal));
    assert_eq!(views[0].form, None);
    assert_eq!(views[0].file_representation, FileRepresentation::Unknown);
    assert_eq!(views[0].link_target_path, None);
}

#[test]
fn physical_identity_conflict_at_one_usage_entry_requires_confirmation() {
    let first = source_copy();
    let mut second = source_copy();
    second.relation_id = "relation:other-original".into();
    second.skill_id = first.skill_id;
    second.physical_source_id = "file-id:replacement".into();

    let views = project(
        &[],
        &[first, second],
        &directory(AgentDirectoryRole::AgentUser),
        &[],
        &[],
    );
    assert_eq!(views.len(), 1);
    assert!(views[0]
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!views[0].health_reasons.contains(&UsageHealthReason::Normal));
    assert_eq!(
        views[0].physical_source_ids_evidence,
        vec!["file-id:ephemeral", "file-id:replacement"]
    );
    assert_eq!(views[0].evidence_relation_ids.len(), 2);
}

#[test]
fn unsupported_shared_and_project_directories_do_not_create_source_usage() {
    for role in [DirectoryRole::SharedDirectory, DirectoryRole::Project] {
        let mut fact = node();
        fact.role = role;
        let nodes = vec![fact];
        let mut recognition = directory_recognition();
        recognition[0].recognition = DirectoryRecognition::Unsupported;
        let views = project_with_directory_facts(
            &[],
            &[source_copy()],
            &AgentDirectoryProjection::default(),
            &[],
            &[],
            &nodes,
            &recognition,
        );
        assert!(
            views.is_empty(),
            "unsupported {role:?} source directory is not a usage target"
        );
    }
}

#[test]
fn unknown_shared_directory_role_keeps_usage_unverified() {
    let mut fact = node();
    fact.role = DirectoryRole::SharedDirectory;
    let nodes = vec![fact];
    let mut recognition = directory_recognition();
    recognition[0].recognition = DirectoryRecognition::Unknown;
    let views = project_with_directory_facts(
        &[],
        &[source_copy()],
        &AgentDirectoryProjection::default(),
        &[],
        &[],
        &nodes,
        &recognition,
    );

    let view = views
        .first()
        .expect("explicit shared role evidence is retained");
    assert_eq!(view.target.recognition, Some(DirectoryRecognition::Unknown));
    assert_eq!(
        view.target.kind,
        skillhub_core::relationship::RelationGovernanceTargetKind::SharedDirectory
    );
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UnableToVerify));
    assert!(view
        .health_reasons
        .contains(&UsageHealthReason::UserConfirmation));
    assert!(!view.health_reasons.contains(&UsageHealthReason::Normal));
}
