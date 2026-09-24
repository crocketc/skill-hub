use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::import::{
    final_skill_for_import, AcquisitionWorkspaceKind, ImportAcquisitionContext,
    ImportOutcomeStatus, ImportProvenanceEvent, ImportSourceClass,
};
use skillhub_core::relationship::{
    project_governable_relation, validate_source_copy_transition, DeploymentRelationFact,
    FileRepresentation, GovernableRelationFact, GovernableRelationStatus, RelationshipType,
    SourceCopyArchiveReason, SourceCopyDecision, SourceCopyHealth, SourceCopyProbe,
    SourceCopyRelationFact, SourceCopyTransition,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::SkillId;

fn event(
    skill_id: SkillId,
    source_class: ImportSourceClass,
    path: Option<&str>,
) -> ImportProvenanceEvent {
    ImportProvenanceEvent {
        provenance_id: "event-1".into(),
        batch_id: "batch-1".into(),
        skill_id,
        source_class,
        source: SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path("/source")),
        local_source_path: path.map(str::to_owned),
        source_container_id: Some("container".into()),
        physical_source_id: path.map(str::to_owned),
        agent_client_id: None,
        content_fingerprint: "hash".into(),
        imported_at: 1,
    }
}

fn relation(skill_id: SkillId, id: &str, physical: &str) -> SourceCopyRelationFact {
    SourceCopyRelationFact::from_import_event(
        id,
        &event(skill_id, ImportSourceClass::AgentLocal, Some(physical)),
        physical,
        physical,
    )
    .unwrap()
}

#[test]
fn one_skill_can_have_multiple_sources_and_one_container_multiple_skills() {
    let first_skill = SkillId::new();
    let second_skill = SkillId::new();
    let first = relation(first_skill, "relation-a", "/source/a");
    let second = relation(first_skill, "relation-b", "/source/b");
    let third = relation(second_skill, "relation-c", "/source/c");
    assert_ne!(first.relation_id, second.relation_id);
    assert_eq!(first.skill_id, second.skill_id);
    assert_eq!(first.source_container_id, third.source_container_id);
    assert_ne!(first.skill_id, third.skill_id);
}

#[test]
fn same_physical_source_cannot_be_active_for_two_skills() {
    let first = relation(SkillId::new(), "relation-a", "/source/a");
    let other = relation(SkillId::new(), "relation-b", "/source/a");
    assert!(SourceCopyRelationFact::active_physical_conflict(
        &[first],
        &other
    ));
    let mut archived = other.clone();
    archived.active = false;
    assert!(!SourceCopyRelationFact::active_physical_conflict(
        &[archived],
        &other
    ));
}

#[test]
fn decision_and_health_are_orthogonal() {
    let mut copy = relation(SkillId::new(), "relation-a", "/source/a");
    assert_eq!(copy.decision, SourceCopyDecision::Pending);
    copy.decision = SourceCopyDecision::Retained;
    copy.health = SourceCopyHealth::ContentChanged;
    assert_eq!(
        project_governable_relation(&GovernableRelationFact::SourceCopy(copy))
            .unwrap()
            .status,
        GovernableRelationStatus::NeedsAttention
    );
}

#[test]
fn import_outcome_maps_reuse_to_final_skill_and_omits_unsuccessful_copies() {
    use skillhub_core::import::ImportDecision;
    let existing = SkillId::new();
    let created = SkillId::new();
    assert_eq!(
        final_skill_for_import(
            ImportDecision::ReuseExisting,
            ImportOutcomeStatus::Succeeded,
            Some(existing),
            Some(created)
        ),
        Some(existing)
    );
    for status in [ImportOutcomeStatus::Failed, ImportOutcomeStatus::Cancelled] {
        assert_eq!(
            final_skill_for_import(ImportDecision::CopyIntoLibrary, status, None, Some(created)),
            None
        );
    }
    assert_eq!(
        final_skill_for_import(
            ImportDecision::Skip,
            ImportOutcomeStatus::Succeeded,
            Some(existing),
            Some(created)
        ),
        None
    );
}

#[test]
fn only_local_sources_are_governable_and_cache_is_acquisition_only() {
    let skill = SkillId::new();
    for class in [
        ImportSourceClass::Online,
        ImportSourceClass::RegisteredProject,
        ImportSourceClass::CentralLibrary,
    ] {
        let e = event(skill, class, Some("/source"));
        assert!(SourceCopyRelationFact::from_import_event("r", &e, "/source", "/source").is_none());
    }
    for class in [ImportSourceClass::AgentLocal, ImportSourceClass::UserLocal] {
        let e = event(skill, class, Some("/source"));
        let copy =
            SourceCopyRelationFact::from_import_event("r", &e, "/source", "/source").unwrap();
        assert_eq!(copy.decision, SourceCopyDecision::Pending);
    }
    let cache = ImportAcquisitionContext {
        workspace_kind: AcquisitionWorkspaceKind::TemporaryCache,
        workspace_path: Some("/cache/download".into()),
    };
    assert_eq!(
        cache.workspace_kind,
        AcquisitionWorkspaceKind::TemporaryCache
    );
    assert!(serde_json::to_string(&ImportSourceClass::Online)
        .unwrap()
        .contains("online"));
    assert!(
        !event(skill, ImportSourceClass::Online, Some("/cache/download"))
            .has_valid_source_coordinates()
    );
    assert!(!event(skill, ImportSourceClass::Online, None).has_valid_source_coordinates());
    let mut online = event(skill, ImportSourceClass::Online, None);
    online.source = SourceDescriptor::new(
        SourceKind::Https,
        SourceLocator::https_url("https://example.com/skill"),
    );
    assert!(online.has_valid_source_coordinates());
    online.source = SourceDescriptor::new(
        SourceKind::Https,
        SourceLocator::https_url("file:///cache/skill"),
    );
    assert!(!online.has_valid_source_coordinates());
    online.source = SourceDescriptor::new(SourceKind::Https, SourceLocator::https_url(""));
    assert!(!online.has_valid_source_coordinates());
    online.source = SourceDescriptor::new(
        SourceKind::Git,
        SourceLocator::git_url("ssh://git@example.com/repo"),
    );
    assert!(online.has_valid_source_coordinates());
    online.source =
        SourceDescriptor::new(SourceKind::Git, SourceLocator::local_path("/cache/repo"));
    assert!(!online.has_valid_source_coordinates());
}

#[test]
fn accessibility_without_verified_identity_and_fingerprint_is_not_normal() {
    let copy = relation(SkillId::new(), "r", "/source");
    let SourceCopyTransition::Update(accessible) =
        validate_source_copy_transition(&copy, SourceCopyProbe::AccessibleDirectory, 2)
    else {
        panic!("accessible directory stays current")
    };
    assert_eq!(accessible.health, SourceCopyHealth::NeedsValidation);
    assert_eq!(accessible.current_fingerprint, None);
    let SourceCopyTransition::Update(verified) = validate_source_copy_transition(
        &copy,
        SourceCopyProbe::VerifiedDirectory {
            physical_source_id: "/source".into(),
            content_fingerprint: "hash".into(),
        },
        3,
    ) else {
        panic!("verified directory stays current")
    };
    assert_eq!(verified.health, SourceCopyHealth::Normal);
    assert_eq!(verified.current_fingerprint.as_deref(), Some("hash"));
    let SourceCopyTransition::Update(changed) = validate_source_copy_transition(
        &copy,
        SourceCopyProbe::VerifiedDirectory {
            physical_source_id: "/source".into(),
            content_fingerprint: "changed".into(),
        },
        4,
    ) else {
        panic!("changed directory stays current")
    };
    assert_eq!(changed.health, SourceCopyHealth::ContentChanged);
    assert_eq!(changed.current_fingerprint.as_deref(), Some("changed"));
    let SourceCopyTransition::Update(moved) = validate_source_copy_transition(
        &copy,
        SourceCopyProbe::VerifiedDirectory {
            physical_source_id: "/other".into(),
            content_fingerprint: "hash".into(),
        },
        5,
    ) else {
        panic!("identity mismatch stays current")
    };
    assert_eq!(moved.health, SourceCopyHealth::NeedsValidation);
}

#[test]
fn current_projection_excludes_archived_source_and_released_deployment() {
    let mut copy = relation(SkillId::new(), "r", "/source");
    copy.active = false;
    copy.archived_at = Some(4);
    assert!(project_governable_relation(&GovernableRelationFact::SourceCopy(copy)).is_none());
    let mut deployment = DeploymentRelationFact {
        relation_id: "deployment".into(),
        skill_id: Some(SkillId::new()),
        agent_client_id: "agent".into(),
        path: "/target".into(),
        path_key: "/target".into(),
        directory_node_id: None,
        relationship: RelationshipType::ManagedCopy,
        file_representation: FileRepresentation::Copy,
        ownership: skillhub_core::OwnershipState::SkillhubManaged,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: "hash".into(),
        origin: ObservedOrigin::Scan,
        match_state: ObservedMatchState::ContentVerified,
        active: true,
        observed_at: 1,
        released_at: Some(4),
    };
    assert!(
        project_governable_relation(&GovernableRelationFact::Deployment(deployment.clone()))
            .is_none()
    );
    deployment.released_at = None;
    assert!(project_governable_relation(&GovernableRelationFact::Deployment(deployment)).is_some());
}

#[test]
fn only_confirmed_missing_with_accessible_parent_archives_external_removed() {
    let copy = relation(SkillId::new(), "r", "/source");
    for probe in [
        SourceCopyProbe::ParentMissing,
        SourceCopyProbe::PermissionDenied,
        SourceCopyProbe::DriveOrVolumeUnavailable,
        SourceCopyProbe::TimeoutOrUnknown,
    ] {
        assert!(!matches!(
            validate_source_copy_transition(&copy, probe, 2),
            SourceCopyTransition::Archive { .. }
        ));
    }
    assert!(matches!(
        validate_source_copy_transition(&copy, SourceCopyProbe::MissingWithAccessibleParent, 2),
        SourceCopyTransition::Archive {
            reason: SourceCopyArchiveReason::ExternalRemoved,
            ..
        }
    ));
}
