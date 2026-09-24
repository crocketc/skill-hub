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

// ===================== 8A：来源关系维度的原始文件清理 =====================

mod relation_scoped_original_migration {
    use skillhub_core::import::{
        ensure_original_deletion_authorized, plan_original_migration, AgentPresentationFact,
        OriginalMigrationConflictReason, OriginalMigrationFacts, OriginalMigrationTargetContext,
    };
    use skillhub_core::OperationId;

    use super::*;

    /// 干净事实：Full 校验后的关系（Normal）+ 真实目录 + 指纹一致。
    fn clean_facts(relation: &SourceCopyRelationFact) -> OriginalMigrationFacts {
        let mut checked = relation.clone();
        checked.health = SourceCopyHealth::Normal;
        checked.current_fingerprint = Some(relation.expected_fingerprint.clone());
        OriginalMigrationFacts {
            relation: Some(checked),
            path_exists: true,
            is_symlink_or_junction: false,
            is_directory: true,
            current_fingerprint: Some(relation.expected_fingerprint.clone()),
            has_managed_deployment_at_path: false,
            relationship_revision: 7,
            agent_client_id: relation.agent_client_id.clone(),
            shared_directory_node_id: None,
            associated_agent_client_ids: Vec::new(),
        }
    }

    // 8.1/8.11：计划绑定单一来源关系。同一 Skill 两条来源各自成计划，
    // 路径/关系 ID 互不混淆；计划同时携带呈现、目标上下文与关系修订号。
    #[test]
    fn plan_is_scoped_to_one_source_relation_and_carries_context() {
        let skill = SkillId::new();
        let first = relation(skill, "relation-a", "/source/a");
        let second = relation(skill, "relation-b", "/source/b");

        let plan = plan_original_migration(OperationId::new(), skill, &clean_facts(&first));
        assert_eq!(plan.relation_id, "relation-a");
        assert_eq!(plan.original_path, "/source/a");
        assert_eq!(plan.skill_id, skill);
        assert_eq!(plan.content_fingerprint, first.expected_fingerprint);
        assert!(plan.conflicts.is_empty());

        let other = plan_original_migration(OperationId::new(), skill, &clean_facts(&second));
        assert_eq!(other.relation_id, "relation-b");
        assert_eq!(other.original_path, "/source/b");

        assert_eq!(plan.agent, AgentPresentationFact { client_id: None });
        assert_eq!(
            plan.target_context,
            OriginalMigrationTargetContext {
                agent_client_id: None,
                shared_directory_node_id: None,
                associated_agent_client_ids: Vec::new(),
            }
        );
        assert_eq!(plan.relationship_revision, 7);
        assert!(plan.requires_confirmation);
    }

    // 8.2：Full 校验后的健康异常全部阻断备份与删除，且逐类给名：
    // 内容变化、身份/修订不可证、权限受限、managed 占用。
    #[test]
    fn unhealthy_relations_block_backup_and_delete_with_distinct_reasons() {
        let cases = [
            (
                SourceCopyHealth::ContentChanged,
                OriginalMigrationConflictReason::ContentDiverged,
            ),
            (
                SourceCopyHealth::NeedsValidation,
                OriginalMigrationConflictReason::NeedsValidation,
            ),
            (
                SourceCopyHealth::PermissionLimited,
                OriginalMigrationConflictReason::PermissionLimited,
            ),
            (
                SourceCopyHealth::ManagedOccupied,
                OriginalMigrationConflictReason::ManagedOccupied,
            ),
            (
                SourceCopyHealth::OperationFailed,
                OriginalMigrationConflictReason::NeedsValidation,
            ),
        ];
        for (health, reason) in cases {
            // 指纹一致，只让健康一项异常：验证健康裁决逐类给名。
            let mut facts = clean_facts(&relation(SkillId::new(), "r", "/source"));
            if let Some(checked) = facts.relation.as_mut() {
                checked.health = health;
            }
            let skill_id = facts.relation.as_ref().expect("relation").skill_id;
            let plan = plan_original_migration(OperationId::new(), skill_id, &facts);
            assert_eq!(plan.conflicts.len(), 1, "health {health:?} blocks alone");
            assert_eq!(plan.conflicts[0].reason, reason);
            assert!(ensure_original_deletion_authorized(&plan, true).is_err());
        }
    }

    // 8.6：Retained 决策不阻断清理准备——纯判定不读决策字段，保留后
    // 直接进入 prepare，不要求先伪造 Pending 过渡。
    #[test]
    fn retained_decision_does_not_block_cleanup_prepare() {
        let mut retained = relation(SkillId::new(), "r", "/source");
        retained.decision = SourceCopyDecision::Retained;
        let plan = plan_original_migration(
            OperationId::new(),
            retained.skill_id,
            &clean_facts(&retained),
        );
        assert!(plan.conflicts.is_empty());
        assert!(ensure_original_deletion_authorized(&plan, true).is_ok());
    }

    // 关系事实缺失（查无此关系）：ProvenanceMissing 阻断，且不暴露路径。
    #[test]
    fn missing_relation_blocks_and_hides_paths() {
        let facts = OriginalMigrationFacts::default();
        let plan = plan_original_migration(OperationId::new(), SkillId::new(), &facts);
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(
            plan.conflicts[0].reason,
            OriginalMigrationConflictReason::ProvenanceMissing
        );
        assert_eq!(plan.original_path, String::new());
        assert_eq!(plan.relation_id, String::new());
    }
}

// ===================== 8B：清理提交状态机与崩溃恢复 =====================

mod original_migration_recovery {
    use skillhub_core::import::{
        original_migration_backup_key, resolve_original_migration_recovery,
        OriginalMigrationRecoveryAdvancement,
    };

    // 8.13：备份目录键必须内部编码——不含路径分隔符、稳定、可区分。
    #[test]
    fn backup_key_is_path_safe_stable_and_distinct() {
        let key = original_migration_backup_key("rel-abc.123");
        assert!(!key.is_empty());
        assert!(!key.contains('/') && !key.contains('\\') && !key.contains(':'));
        assert!(
            !key.contains("rel-abc"),
            "raw relation id must not be the key"
        );
        assert_eq!(key, original_migration_backup_key("rel-abc.123"));
        assert_ne!(
            original_migration_backup_key("rel-abc.123"),
            original_migration_backup_key("rel-other.456")
        );
    }

    // 8.3/8.14：checkpoint 之后崩溃，按"原路径/备份/关系"三方事实推进：
    // 删除已发生（原目录不在、备份在）→ 前滚为已完成；
    // 删除未发生（原目录仍在、备份在）→ 回退为失败且现场保留；
    // 备份缺失 → 既不能前滚也不能回滚 → 需要人工恢复。
    #[test]
    fn recovery_advances_by_original_and_backup_facts() {
        assert_eq!(
            resolve_original_migration_recovery(false, true),
            OriginalMigrationRecoveryAdvancement::RollForward
        );
        assert_eq!(
            resolve_original_migration_recovery(true, true),
            OriginalMigrationRecoveryAdvancement::RollBackToFailed
        );
        assert_eq!(
            resolve_original_migration_recovery(false, false),
            OriginalMigrationRecoveryAdvancement::NeedsRecovery
        );
        assert_eq!(
            resolve_original_migration_recovery(true, false),
            OriginalMigrationRecoveryAdvancement::NeedsRecovery
        );
    }
}
