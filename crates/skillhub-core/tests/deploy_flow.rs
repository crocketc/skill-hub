use async_trait::async_trait;
use skillhub_core::application::{DeploymentBackend, DeploymentService};
use skillhub_core::deployment::{
    plan_relation_conversion, DeploymentMode, DeploymentPlan, DeploymentRecord, DeploymentState,
    RelationConversionFacts, TargetChange, TargetPlan,
};
use skillhub_core::relationship::RelationshipType;
use skillhub_core::{
    AppError, AppResult, DeploymentCapability, DeploymentId, ErrorCode, Severity, SkillId,
    VersionId,
};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct RecordingDeploymentBackend {
    applied: Mutex<Vec<String>>,
    fail_target: Option<String>,
}

#[async_trait]
impl DeploymentBackend for RecordingDeploymentBackend {
    async fn revalidate(&self, plan: &DeploymentPlan) -> AppResult<DeploymentPlan> {
        Ok(plan.clone())
    }

    async fn apply_target(&self, target: &TargetPlan) -> AppResult<DeploymentRecord> {
        if self.fail_target.as_deref() == Some(target.physical_target_id.as_str()) {
            return Err(AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("detail", "target parent is unavailable")
                .with_action(skillhub_core::RecoveryAction::Retry));
        }
        self.applied
            .lock()
            .unwrap()
            .push(target.physical_target_id.clone());
        Ok(DeploymentRecord {
            id: DeploymentId::new(),
            skill_id: target.skill_id,
            version_id: target.version_id.clone(),
            target_id: target.physical_target_id.clone(),
            state: DeploymentState::Deployed,
            mode: target.mode,
            managed: true,
            runtime_name: target.runtime_name.clone(),
            expected_hash: "sha256:tree".into(),
            observed_hash: Some("sha256:tree".into()),
        })
    }
}

fn plan() -> DeploymentPlan {
    let skill_id = SkillId::new();
    let version_id =
        VersionId::parse("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap();
    let target = |id: &str| TargetPlan {
        physical_target_id: id.into(),
        logical_target_ids: vec![id.into()],
        target_path: format!("C:/agents/{id}"),
        destination_path: format!("C:/agents/{id}/notes"),
        source_path: "C:/skillhub/notes".into(),
        runtime_name: "notes".into(),
        skill_id,
        version_id: version_id.clone(),
        mode: DeploymentMode::ManagedCopy,
        change: TargetChange::Create,
        warnings: vec![],
        conflicts: vec![],
    };
    DeploymentPlan {
        skill_id,
        version_id: version_id.clone(),
        runtime_name: "notes".into(),
        mode: DeploymentMode::ManagedCopy,
        targets: vec![target("codex"), target("claude")],
        warnings: vec![],
        conflicts: vec![],
    }
}

#[test]
fn committed_deployment_links_selected_version_and_records_relation() {
    block_on(async {
        let backend = Arc::new(RecordingDeploymentBackend::default());
        let service = DeploymentService::new(backend.clone());
        let prepared = service.prepare(plan()).await.unwrap();
        let result = service.commit(prepared.id).await.unwrap();
        assert_eq!(
            result.targets[0].status,
            skillhub_core::TargetOperationStatus::Succeeded
        );
        assert_eq!(result.targets[0].version_id, result.version_id);
        assert_eq!(backend.applied.lock().unwrap().len(), 2);
    });
}

#[test]
fn batch_keeps_success_and_reports_failed_target_separately() {
    block_on(async {
        let backend = Arc::new(RecordingDeploymentBackend {
            fail_target: Some("claude".into()),
            ..Default::default()
        });
        let service = DeploymentService::new(backend.clone());
        let prepared = service.prepare(plan()).await.unwrap();
        let result = service.commit(prepared.id).await.unwrap();
        assert_eq!(
            result.targets[0].status,
            skillhub_core::TargetOperationStatus::Succeeded
        );
        assert_eq!(
            result.targets[1].status,
            skillhub_core::TargetOperationStatus::Failed
        );
        assert_eq!(
            result.targets[1].error_code.as_deref(),
            Some("internal.error")
        );
        let error = result.targets[1]
            .error
            .as_ref()
            .expect("failed target keeps structured error");
        assert_eq!(error.params["detail"], "target parent is unavailable");
        assert_eq!(error.actions, vec![skillhub_core::RecoveryAction::Retry]);
        assert_eq!(backend.applied.lock().unwrap().as_slice(), &["codex"]);
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

// ---------------------------------------------------------------------------
// Task 6: observed copy / shared reference -> managed-link conversion plan.
// The conversion plan is pure: platform capability decides the technical link
// form, and an unavailable link must never silently degrade to a copy.
// ---------------------------------------------------------------------------

fn link_capabilities(symlink: bool, junction: bool) -> DeploymentCapability {
    // Copy is always available; only the link forms vary per probe.
    DeploymentCapability::new(symlink, junction, true)
}

#[test]
fn conversion_plan_selects_the_platform_link_mode_for_a_managed_copy() {
    let plan = plan_relation_conversion(&RelationConversionFacts {
        relationship: RelationshipType::ManagedCopy,
        link_capabilities: link_capabilities(true, false),
        link_target_same_volume: true,
        other_shared_consumers: 0,
    })
    .expect("managed copy converts to a managed link");
    assert_eq!(plan.mode, DeploymentMode::SymbolicLink);
    assert!(!plan.requires_shared_impact_confirmation);
    assert!(plan.keeps_shared_body);
}

#[test]
fn conversion_plan_never_degrades_to_a_copy_when_links_are_unavailable() {
    let error = plan_relation_conversion(&RelationConversionFacts {
        relationship: RelationshipType::ObservedCopy,
        link_capabilities: link_capabilities(false, false),
        link_target_same_volume: true,
        other_shared_consumers: 0,
    })
    .expect_err("link-unavailable conversion must fail instead of copying");
    assert_eq!(error.code, ErrorCode::SymlinkNotSupported);
}

#[test]
fn conversion_plan_rejects_a_cross_volume_junction_instead_of_copying() {
    let cross_volume = RelationConversionFacts {
        relationship: RelationshipType::ObservedCopy,
        link_capabilities: link_capabilities(false, true),
        link_target_same_volume: false,
        other_shared_consumers: 0,
    };
    let error = plan_relation_conversion(&cross_volume)
        .expect_err("a junction cannot span volumes; must fail instead of copying");
    assert_eq!(error.code, ErrorCode::JunctionNotSupported);

    let same_volume = RelationConversionFacts {
        link_target_same_volume: true,
        ..cross_volume
    };
    let plan = plan_relation_conversion(&same_volume).expect("same-volume junction is usable");
    assert_eq!(plan.mode, DeploymentMode::DirectoryJunction);
}

#[test]
fn conversion_plan_requires_confirmation_and_keeps_the_shared_body() {
    let with_other_consumers = RelationConversionFacts {
        other_shared_consumers: 2,
        ..relation_conversion_facts_for(RelationshipType::SharedDirectoryReference)
    };
    let plan = plan_relation_conversion(&with_other_consumers)
        .expect("shared reference conversion is plannable");
    assert!(plan.requires_shared_impact_confirmation);
    assert!(plan.keeps_shared_body);

    let solo = RelationConversionFacts {
        other_shared_consumers: 0,
        ..relation_conversion_facts_for(RelationshipType::SharedDirectoryReference)
    };
    let plan = plan_relation_conversion(&solo).expect("solo shared reference still plans");
    assert!(!plan.requires_shared_impact_confirmation);
    assert!(plan.keeps_shared_body);
}

#[test]
fn conversion_plan_rejects_a_shared_direct_read_as_a_governance_todo() {
    // A direct shared-directory read has no per-agent entry to replace.
    // Converting it would have to rewrite the shared body itself, which is
    // forbidden, so the deterministic plan must refuse it.
    let error = plan_relation_conversion(&RelationConversionFacts {
        relationship: RelationshipType::SharedDirectoryRead,
        link_capabilities: link_capabilities(true, false),
        link_target_same_volume: true,
        other_shared_consumers: 0,
    })
    .expect_err("shared direct read needs a governance decision, not a conversion");
    assert_eq!(error.code, ErrorCode::OperationConflict);
}

#[test]
fn conversion_plan_rejects_relations_without_a_convertible_entry() {
    let error = plan_relation_conversion(&RelationConversionFacts {
        relationship: RelationshipType::ImportCopy,
        link_capabilities: link_capabilities(true, false),
        link_target_same_volume: true,
        other_shared_consumers: 0,
    })
    .expect_err("import copies are not deployment entries");
    assert_eq!(error.code, ErrorCode::OperationConflict);

    let error = plan_relation_conversion(&RelationConversionFacts {
        relationship: RelationshipType::Unknown,
        ..relation_conversion_facts_for(RelationshipType::ImportCopy)
    })
    .expect_err("unknown relations carry no convertible fact");
    assert_eq!(error.code, ErrorCode::OperationConflict);
}

fn relation_conversion_facts_for(relationship: RelationshipType) -> RelationConversionFacts {
    RelationConversionFacts {
        relationship,
        link_capabilities: link_capabilities(true, false),
        link_target_same_volume: true,
        other_shared_consumers: 0,
    }
}
