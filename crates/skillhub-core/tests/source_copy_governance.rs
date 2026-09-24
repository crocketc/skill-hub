use skillhub_core::import::{
    final_skill_for_import, AcquisitionWorkspaceKind, ImportAcquisitionContext,
    ImportOutcomeStatus, ImportProvenanceEvent, ImportSourceClass,
};
use skillhub_core::relationship::{
    project_governable_relation, validate_source_copy_transition, GovernableRelationFact,
    GovernableRelationStatus, SourceCopyArchiveReason, SourceCopyDecision, SourceCopyHealth,
    SourceCopyProbe, SourceCopyRelationFact, SourceCopyTransition,
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
        project_governable_relation(&GovernableRelationFact::SourceCopy(copy)).status,
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
    assert!(event(skill, ImportSourceClass::Online, None).has_valid_source_coordinates());
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
