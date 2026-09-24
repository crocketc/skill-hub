//! Task 5A 纯状态转换测试：原始文件系统探测 → 业务探测 → 关系转换。
//! Light 只核可达性/存在/类型/物理身份；Full 额外算内容指纹与受管占用
//! （plan 5.1/5.2）。十类探测结果的转换语义在此钉死。

use skillhub_core::import::ImportProvenanceEvent;
use skillhub_core::relationship::{
    evaluate_relationship_probe, map_path_probe_to_source_copy, update_is_meaningful,
    validate_source_copy_transition, RelationshipCheckLevel, RelationshipPathProbe,
    SourceCopyArchiveReason, SourceCopyHealth, SourceCopyProbe, SourceCopyRelationFact,
    SourceCopyTransition,
};
use skillhub_core::{ImportSourceClass, SkillId};
use skillhub_core::{SourceDescriptor, SourceKind, SourceLocator};

fn provenance_event() -> ImportProvenanceEvent {
    ImportProvenanceEvent {
        provenance_id: "prov-1".to_owned(),
        batch_id: "batch-1".to_owned(),
        skill_id: SkillId::new(),
        source_class: ImportSourceClass::UserLocal,
        source: SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path("C:/src/notes")),
        local_source_path: Some("C:/src/notes".to_owned()),
        source_container_id: None,
        physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
        agent_client_id: Some("codebuddy.code".to_owned()),
        content_fingerprint: "hash-a".to_owned(),
        imported_at: 42,
    }
}

fn relation() -> SourceCopyRelationFact {
    SourceCopyRelationFact::from_import_event(
        "rel-1",
        &provenance_event(),
        "c:/src/notes",
        "fs:dev-1-ino-2",
    )
    .expect("UserLocal + physical id is governable")
}

#[test]
fn light_check_maps_accessible_directory_to_needs_validation() {
    let relation = relation();
    let probe = RelationshipPathProbe::Accessible {
        physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
    };
    let business = map_path_probe_to_source_copy(
        &relation,
        RelationshipCheckLevel::Light,
        &probe,
        false,
        None,
    );
    assert_eq!(business, SourceCopyProbe::AccessibleDirectory);
    let transition = validate_source_copy_transition(&relation, business, 100);
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("accessible directory never archives");
    };
    assert_eq!(updated.health, SourceCopyHealth::NeedsValidation);
    assert_eq!(updated.last_verified_at, Some(100));
    assert!(updated.active);
}

#[test]
fn full_check_with_matching_identity_and_fingerprint_is_normal() {
    let relation = relation();
    let probe = RelationshipPathProbe::Accessible {
        physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
    };
    let business = map_path_probe_to_source_copy(
        &relation,
        RelationshipCheckLevel::Full,
        &probe,
        false,
        Some("hash-a"),
    );
    assert_eq!(
        business,
        SourceCopyProbe::VerifiedDirectory {
            physical_source_id: "fs:dev-1-ino-2".to_owned(),
            content_fingerprint: "hash-a".to_owned(),
        }
    );
    let transition = validate_source_copy_transition(&relation, business, 100);
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("verified directory never archives");
    };
    assert_eq!(updated.health, SourceCopyHealth::Normal);
    assert_eq!(updated.current_fingerprint.as_deref(), Some("hash-a"));
}

#[test]
fn full_check_with_changed_content_reports_content_changed() {
    let relation = relation();
    let probe = RelationshipPathProbe::Accessible {
        physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
    };
    let business = map_path_probe_to_source_copy(
        &relation,
        RelationshipCheckLevel::Full,
        &probe,
        false,
        Some("hash-b"),
    );
    let transition = validate_source_copy_transition(&relation, business, 100);
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("content change is an update, not an archive");
    };
    assert_eq!(updated.health, SourceCopyHealth::ContentChanged);
}

#[test]
fn full_check_with_changed_physical_identity_stays_needs_validation() {
    let relation = relation();
    let probe = RelationshipPathProbe::Accessible {
        physical_source_id: Some("fs:dev-9-ino-9".to_owned()),
    };
    let business = map_path_probe_to_source_copy(
        &relation,
        RelationshipCheckLevel::Full,
        &probe,
        false,
        Some("hash-a"),
    );
    let transition = validate_source_copy_transition(&relation, business, 100);
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("identity drift is never an archive");
    };
    assert_eq!(updated.health, SourceCopyHealth::NeedsValidation);
}

#[test]
fn frozen_contract_keeps_direct_identity_and_fingerprint_probe_verdicts() {
    let relation = relation();
    let identity =
        validate_source_copy_transition(&relation, SourceCopyProbe::PhysicalIdentityChanged, 100);
    let SourceCopyTransition::Update(updated) = identity else {
        panic!("identity probe never archives");
    };
    assert_eq!(updated.health, SourceCopyHealth::ContentChanged);
    let fingerprint =
        validate_source_copy_transition(&relation, SourceCopyProbe::FingerprintChanged, 100);
    let SourceCopyTransition::Update(updated) = fingerprint else {
        panic!("fingerprint probe never archives");
    };
    assert_eq!(updated.health, SourceCopyHealth::ContentChanged);
}

#[test]
fn full_check_reports_managed_occupancy() {
    let relation = relation();
    let probe = RelationshipPathProbe::Accessible {
        physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
    };
    let business = map_path_probe_to_source_copy(
        &relation,
        RelationshipCheckLevel::Full,
        &probe,
        true,
        Some("hash-a"),
    );
    assert_eq!(business, SourceCopyProbe::ManagedOccupied);
    let transition = validate_source_copy_transition(&relation, business, 100);
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("occupancy is an update, not an archive");
    };
    assert_eq!(updated.health, SourceCopyHealth::ManagedOccupied);
}

#[test]
fn light_check_never_reports_occupancy_or_content_change() {
    let relation = relation();
    let probe = RelationshipPathProbe::Accessible {
        physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
    };
    // Light 级不提供指纹：即便目录内容已变，Light 也只判定可达。
    let business =
        map_path_probe_to_source_copy(&relation, RelationshipCheckLevel::Light, &probe, true, None);
    assert_eq!(business, SourceCopyProbe::AccessibleDirectory);
    let transition = validate_source_copy_transition(&relation, business, 100);
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("light check never archives");
    };
    assert_eq!(updated.health, SourceCopyHealth::NeedsValidation);
}

#[test]
fn unavailable_failure_modes_keep_the_relation_active() {
    let relation = relation();
    for probe in [
        RelationshipPathProbe::ParentMissing,
        RelationshipPathProbe::DriveOrVolumeUnavailable,
        RelationshipPathProbe::TimeoutOrUnknown,
        RelationshipPathProbe::WrongRepresentation,
    ] {
        let business = map_path_probe_to_source_copy(
            &relation,
            RelationshipCheckLevel::Light,
            &probe,
            false,
            None,
        );
        let transition = evaluate_relationship_probe(
            &relation,
            RelationshipCheckLevel::Full,
            &probe,
            false,
            None,
            100,
        );
        let SourceCopyTransition::Update(updated) = transition else {
            panic!("{business:?} must never archive");
        };
        assert_eq!(updated.health, SourceCopyHealth::NeedsValidation);
        assert!(updated.active, "{business:?} keeps the relation active");
    }
}

#[test]
fn permission_denied_sets_permission_limited_without_archiving() {
    let relation = relation();
    let probe = RelationshipPathProbe::PermissionDenied;
    let transition = evaluate_relationship_probe(
        &relation,
        RelationshipCheckLevel::Full,
        &probe,
        false,
        None,
        100,
    );
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("permission denial never archives");
    };
    assert_eq!(updated.health, SourceCopyHealth::PermissionLimited);
    assert!(updated.active);
}

#[test]
fn only_missing_with_accessible_parent_archives_as_external_removed() {
    let relation = relation();
    let probe = RelationshipPathProbe::MissingWithAccessibleParent;
    let transition = evaluate_relationship_probe(
        &relation,
        RelationshipCheckLevel::Full,
        &probe,
        false,
        None,
        100,
    );
    let SourceCopyTransition::Archive { fact, reason } = transition else {
        panic!("verified missing must archive");
    };
    assert_eq!(reason, SourceCopyArchiveReason::ExternalRemoved);
    assert!(!fact.active);
    assert_eq!(
        fact.archive_reason,
        Some(SourceCopyArchiveReason::ExternalRemoved)
    );
    assert_eq!(fact.archived_at, Some(100));
}

#[test]
fn identical_update_never_counts_as_a_meaningful_change() {
    let relation = relation();
    let probe = RelationshipPathProbe::Accessible {
        physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
    };
    let transition = evaluate_relationship_probe(
        &relation,
        RelationshipCheckLevel::Full,
        &probe,
        false,
        Some("hash-a"),
        100,
    );
    let SourceCopyTransition::Update(updated) = transition else {
        panic!("verified directory never archives");
    };
    // Normal → Normal：仅 last_verified_at 推进不算有意义变化。
    let mut normal = relation.clone();
    normal.health = SourceCopyHealth::Normal;
    normal.current_fingerprint = Some("hash-a".to_owned());
    assert!(!update_is_meaningful(&normal, &updated));
    // NeedsValidation → Normal 是有意义变化。
    assert!(update_is_meaningful(&relation, &updated));
}
