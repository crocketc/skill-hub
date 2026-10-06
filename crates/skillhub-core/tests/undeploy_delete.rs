use async_trait::async_trait;
use skillhub_core::application::{RemovalBackend, RemovalService};
use skillhub_core::deployment::reconcile::RelationTargetFact;
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::relationship::impact::{
    calculate_removal_impact, recommend_removal_action, MinimalImpactAction, RemovalFacts,
};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryRecognition, DirectoryRole, FileRepresentation,
    GovernanceTaskKind, RelationshipType,
};
use skillhub_core::{
    AppError, AppResult, DeploymentId, ErrorCode, OperationId, PreparedRemovalRecord,
    RemovalChoice, RemovalDecision, RemovalImpact, RemovalResultState, SkillId, VersionId,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeRemovalBackend {
    skill_id: SkillId,
    deployment: DeploymentRecord,
    delete_impact: Arc<Mutex<RemovalImpact>>,
    undeploy_impact: RemovalImpact,
    removed_targets: Arc<Mutex<Vec<DeploymentId>>>,
    removed_relations: Arc<Mutex<Vec<DeploymentId>>>,
    detached: Arc<Mutex<Vec<DeploymentId>>>,
    deleted_skills: Arc<Mutex<Vec<SkillId>>>,
    attempted_targets: Arc<Mutex<Vec<DeploymentId>>>,
    attempted_physical_targets: Arc<Mutex<Vec<String>>>,
    failing_target: Arc<Mutex<Option<DeploymentId>>>,
    /// 裁决1 注入：中央 Skill 删除本身的确定性失败。
    failing_delete: Arc<Mutex<bool>>,
    /// K2：prepared 持久化载体（生产实现写操作日志，测试用内存映射）。
    prepared_store: Arc<Mutex<HashMap<OperationId, PreparedRemovalRecord>>>,
    settled_prepared: Arc<Mutex<Vec<OperationId>>>,
}

#[async_trait]
impl RemovalBackend for FakeRemovalBackend {
    async fn inspect_delete(&self, skill_id: SkillId) -> AppResult<RemovalImpact> {
        if skill_id == self.skill_id {
            Ok(self.delete_impact.lock().unwrap().clone())
        } else {
            Err(AppError::new(
                ErrorCode::ObjectNotFound,
                skillhub_core::Severity::Error,
            ))
        }
    }

    async fn inspect_undeploy(&self, deployment_id: DeploymentId) -> AppResult<RemovalImpact> {
        if deployment_id == self.deployment.id {
            Ok(self.undeploy_impact.clone())
        } else {
            Err(AppError::new(
                ErrorCode::ObjectNotFound,
                skillhub_core::Severity::Error,
            ))
        }
    }

    async fn remove_owned_target(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.attempted_targets.lock().unwrap().push(deployment.id);
        self.attempted_physical_targets
            .lock()
            .unwrap()
            .push(deployment.target_id.clone());
        if *self.failing_target.lock().unwrap() == Some(deployment.id) {
            return Err(AppError::new(
                ErrorCode::InternalError,
                skillhub_core::Severity::Error,
            ));
        }
        self.removed_targets.lock().unwrap().push(deployment.id);
        Ok(())
    }

    async fn remove_relation(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.removed_relations.lock().unwrap().push(deployment.id);
        Ok(())
    }

    async fn detach_management(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.detached.lock().unwrap().push(deployment.id);
        Ok(())
    }

    async fn delete_skill(&self, skill_id: SkillId) -> AppResult<()> {
        if *self.failing_delete.lock().unwrap() {
            return Err(AppError::new(
                ErrorCode::InternalError,
                skillhub_core::Severity::Error,
            ));
        }
        self.deleted_skills.lock().unwrap().push(skill_id);
        Ok(())
    }

    async fn save_prepared_removal(&self, record: &PreparedRemovalRecord) -> AppResult<()> {
        self.prepared_store
            .lock()
            .unwrap()
            .insert(record.impact.operation_id, record.clone());
        Ok(())
    }

    async fn load_prepared_removal(
        &self,
        operation_id: OperationId,
    ) -> AppResult<Option<PreparedRemovalRecord>> {
        Ok(self
            .prepared_store
            .lock()
            .unwrap()
            .get(&operation_id)
            .filter(|record| record.state == skillhub_core::PreparedRemovalState::Prepared)
            .cloned())
    }

    async fn settle_prepared_removal(&self, operation_id: OperationId) -> AppResult<()> {
        self.settled_prepared.lock().unwrap().push(operation_id);
        Ok(())
    }
}

fn fixture() -> (RemovalService<FakeRemovalBackend>, FakeRemovalBackend) {
    fixture_with_undeploy_shared_choice(true)
}

fn fixture_with_undeploy_shared_choice(
    requires_shared_target_choice: bool,
) -> (RemovalService<FakeRemovalBackend>, FakeRemovalBackend) {
    let skill_id = SkillId::new();
    let deployment = DeploymentRecord {
        id: DeploymentId::new(),
        skill_id,
        version_id: VersionId::parse(
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap(),
        target_id: "shared-target".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "notes".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    };
    let impact = RemovalImpact {
        operation_id: OperationId::new(),
        skill_id,
        deployments: vec![
            deployment.clone(),
            DeploymentRecord {
                id: DeploymentId::new(),
                ..deployment.clone()
            },
        ],
        requires_shared_target_choice: true,
        dependencies: vec!["agent:codex".into(), "project:demo".into()],
        project_configs: Vec::new(),
        pinned_versions: Vec::new(),
        combinations: Vec::new(),
        related_skills: Vec::new(),
        unknown_external_references: Vec::new(),
        draft_count: 0,
    };
    let backend = FakeRemovalBackend {
        skill_id,
        deployment: deployment.clone(),
        delete_impact: Arc::new(Mutex::new(impact.clone())),
        undeploy_impact: RemovalImpact {
            operation_id: OperationId::new(),
            skill_id,
            deployments: vec![deployment.clone()],
            requires_shared_target_choice,
            dependencies: vec![],
            project_configs: Vec::new(),
            pinned_versions: Vec::new(),
            combinations: Vec::new(),
            related_skills: Vec::new(),
            unknown_external_references: Vec::new(),
            draft_count: 0,
        },
        removed_targets: Arc::new(Mutex::new(Vec::new())),
        removed_relations: Arc::new(Mutex::new(Vec::new())),
        detached: Arc::new(Mutex::new(Vec::new())),
        deleted_skills: Arc::new(Mutex::new(Vec::new())),
        attempted_targets: Arc::new(Mutex::new(Vec::new())),
        attempted_physical_targets: Arc::new(Mutex::new(Vec::new())),
        failing_target: Arc::new(Mutex::new(None)),
        failing_delete: Arc::new(Mutex::new(false)),
        prepared_store: Arc::new(Mutex::new(HashMap::new())),
        settled_prepared: Arc::new(Mutex::new(Vec::new())),
    };
    (RemovalService::new(Arc::new(backend.clone())), backend)
}

#[test]
fn delete_with_deployments_requires_explicit_relationship_decisions() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        assert_eq!(impact.deployments.len(), 2);
        assert!(service
            .commit_delete(impact.operation_id, Vec::new())
            .await
            .is_err());
        assert!(backend.deleted_skills.lock().unwrap().is_empty());
    });
}

#[test]
fn delete_rejects_a_changed_shared_consumer_snapshot_before_removing_targets() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let decisions = impact
            .deployments
            .iter()
            .map(|deployment| RemovalChoice {
                deployment_id: deployment.id,
                decision: RemovalDecision::RemoveOwnedTarget,
                confirm_shared_target_removal: false,
            })
            .collect();
        let mut changed = backend.delete_impact.lock().unwrap().clone();
        changed.deployments.push(DeploymentRecord {
            id: DeploymentId::new(),
            ..backend.deployment.clone()
        });
        *backend.delete_impact.lock().unwrap() = changed;

        let error = service
            .commit_delete(impact.operation_id, decisions)
            .await
            .expect_err("shared consumer drift must invalidate the destructive decision");

        assert_eq!(error.code, ErrorCode::OperationConflict);
        assert!(backend.removed_targets.lock().unwrap().is_empty());
        assert!(backend.deleted_skills.lock().unwrap().is_empty());
    });
}

#[test]
fn delete_rejects_detach_management_before_mutating_relationships() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let decisions = impact
            .deployments
            .iter()
            .map(|deployment| RemovalChoice {
                deployment_id: deployment.id,
                decision: RemovalDecision::DetachManagement,
                confirm_shared_target_removal: false,
            })
            .collect();

        assert!(service
            .commit_delete(impact.operation_id, decisions)
            .await
            .is_err());
        assert!(backend.detached.lock().unwrap().is_empty());
        assert!(backend.deleted_skills.lock().unwrap().is_empty());
    });
}

#[test]
fn delete_continues_after_a_target_failure_and_does_not_delete_the_central_skill() {
    block_on(async {
        let (service, backend) = fixture();
        let mut distinct_targets = backend.delete_impact.lock().unwrap().clone();
        distinct_targets.deployments[1].target_id = "independent-target-2".into();
        let third = DeploymentRecord {
            id: DeploymentId::new(),
            target_id: "independent-target-3".into(),
            ..backend.deployment.clone()
        };
        let mut impact = distinct_targets;
        impact.requires_shared_target_choice = false;
        impact.deployments.push(third.clone());
        *backend.delete_impact.lock().unwrap() = impact;
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let failed_id = impact.deployments[1].id;
        *backend.failing_target.lock().unwrap() = Some(failed_id);
        let expected_ids = impact
            .deployments
            .iter()
            .map(|deployment| deployment.id)
            .collect::<Vec<_>>();
        let decisions = expected_ids
            .iter()
            .map(|id| RemovalChoice {
                deployment_id: *id,
                decision: RemovalDecision::RemoveOwnedTarget,
                confirm_shared_target_removal: false,
            })
            .collect();

        let _ = service.commit_delete(impact.operation_id, decisions).await;

        assert_eq!(
            backend.attempted_targets.lock().unwrap().as_slice(),
            expected_ids.as_slice(),
            "a failed target must be reported without preventing later targets from being attempted"
        );
        assert_eq!(
            backend
                .attempted_physical_targets
                .lock()
                .unwrap()
                .as_slice(),
            &[
                "shared-target",
                "independent-target-2",
                "independent-target-3"
            ],
            "each record here represents a distinct physical target"
        );
        assert_eq!(
            backend.removed_targets.lock().unwrap().as_slice(),
            &[expected_ids[0], expected_ids[2]],
            "successful target effects must remain individually attributable"
        );
        assert!(
            backend.deleted_skills.lock().unwrap().is_empty(),
            "the central Skill stays while any target decision failed"
        );
    });
}

#[test]
fn delete_removes_a_shared_physical_target_only_once_for_all_consumers() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let decisions = impact
            .deployments
            .iter()
            .map(|deployment| RemovalChoice {
                deployment_id: deployment.id,
                decision: RemovalDecision::RemoveOwnedTarget,
                confirm_shared_target_removal: true,
            })
            .collect();

        let _ = service.commit_delete(impact.operation_id, decisions).await;

        assert_eq!(
            backend
                .attempted_physical_targets
                .lock()
                .unwrap()
                .as_slice(),
            &["shared-target"],
            "relationships sharing one physical target must trigger one filesystem removal"
        );
    });
}

#[test]
fn undeploy_requires_explicit_confirmation_before_removing_a_shared_target() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service
            .prepare_undeploy(backend.deployment.id)
            .await
            .unwrap();
        assert!(impact.requires_shared_target_choice);

        let error = service
            .commit_undeploy(
                impact.operation_id,
                RemovalDecision::RemoveOwnedTarget,
                false,
            )
            .await
            .expect_err("missing explicit shared-target confirmation must be rejected");

        assert_eq!(error.code, ErrorCode::OperationConflict);
        assert!(backend.removed_targets.lock().unwrap().is_empty());
    });
}

#[test]
fn undeploy_removes_owned_target_and_preserves_central_skill() {
    block_on(async {
        let (service, backend) = fixture_with_undeploy_shared_choice(false);
        service
            .undeploy(
                backend.deployment.id,
                RemovalDecision::RemoveOwnedTarget,
                false,
            )
            .await
            .unwrap();
        assert_eq!(
            backend.removed_targets.lock().unwrap().as_slice(),
            &[backend.deployment.id]
        );
        assert!(backend.deleted_skills.lock().unwrap().is_empty());
    });
}

#[test]
fn removing_one_logical_relation_from_shared_target_keeps_shared_files() {
    block_on(async {
        let (service, backend) = fixture();
        service
            .undeploy(
                backend.deployment.id,
                RemovalDecision::KeepSharedDeployment,
                false,
            )
            .await
            .unwrap();
        assert!(backend.removed_targets.lock().unwrap().is_empty());
        assert_eq!(
            backend.removed_relations.lock().unwrap().as_slice(),
            &[backend.deployment.id]
        );
    });
}

#[test]
fn delete_requires_explicit_confirmation_to_recycle_a_shared_target() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let decisions = impact
            .deployments
            .iter()
            .map(|deployment| RemovalChoice {
                deployment_id: deployment.id,
                decision: RemovalDecision::RemoveOwnedTarget,
                confirm_shared_target_removal: false,
            })
            .collect();

        let error = service
            .commit_delete(impact.operation_id, decisions)
            .await
            .expect_err("missing explicit shared-target confirmation must be rejected");

        assert_eq!(error.code, ErrorCode::OperationConflict);
        assert!(
            backend.attempted_targets.lock().unwrap().is_empty(),
            "no target may be touched before every shared decision is confirmed"
        );
        assert!(backend.deleted_skills.lock().unwrap().is_empty());

        // 同一 prepared 上补齐显式确认后按安全动作执行：共享物理目标只做一次
        // 文件系统回收，两条关系记录一并关闭。
        let confirmed = impact
            .deployments
            .iter()
            .map(|deployment| RemovalChoice {
                deployment_id: deployment.id,
                decision: RemovalDecision::RemoveOwnedTarget,
                confirm_shared_target_removal: true,
            })
            .collect();
        let result = service
            .commit_delete(impact.operation_id, confirmed)
            .await
            .expect("confirmed shared removal must proceed");
        assert_eq!(result.state, RemovalResultState::Committed);
        assert_eq!(
            backend
                .attempted_physical_targets
                .lock()
                .unwrap()
                .as_slice(),
            &["shared-target"],
            "confirmed or not, one physical target is removed exactly once"
        );
    });
}

#[test]
fn a_partially_failed_delete_keeps_decisions_and_remaining_items_recoverable() {
    block_on(async {
        let (service, backend) = fixture();
        let mut distinct_targets = backend.delete_impact.lock().unwrap().clone();
        distinct_targets.deployments[1].target_id = "independent-target-2".into();
        let third = DeploymentRecord {
            id: DeploymentId::new(),
            target_id: "independent-target-3".into(),
            ..backend.deployment.clone()
        };
        let mut impact = distinct_targets;
        impact.requires_shared_target_choice = false;
        impact.deployments.push(third.clone());
        *backend.delete_impact.lock().unwrap() = impact;
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let failed_id = impact.deployments[1].id;
        *backend.failing_target.lock().unwrap() = Some(failed_id);
        let decisions: Vec<RemovalChoice> = impact
            .deployments
            .iter()
            .map(|deployment| RemovalChoice {
                deployment_id: deployment.id,
                decision: RemovalDecision::RemoveOwnedTarget,
                confirm_shared_target_removal: false,
            })
            .collect();

        let result = service
            .commit_delete(impact.operation_id, decisions.clone())
            .await
            .expect("a failed item must yield a per-item outcome, not an aborted batch");

        assert_eq!(result.state, RemovalResultState::PartiallyCommitted);
        assert_eq!(result.recovery_operation_id, Some(impact.operation_id));
        assert!(!result.central_skill_deleted);
        let statuses = result
            .decisions
            .iter()
            .map(|item| (item.deployment_id, item.status, item.error_code))
            .collect::<Vec<_>>();
        assert_eq!(statuses.len(), 3);
        assert!(
            statuses
                .iter()
                .all(|(id, _, _)| impact.deployments.iter().any(|record| record.id == *id)),
            "every requested decision keeps its own row in the result"
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|(_, status, _)| *status == skillhub_core::RemovalItemStatus::Failed)
                .count(),
            1,
            "exactly the injected failure is reported as failed"
        );
        assert!(backend.deleted_skills.lock().unwrap().is_empty());

        // 持久化 prepared 记录保留用户决定与剩余项，重启后可用于恢复续作。
        let stored = backend
            .prepared_store
            .lock()
            .unwrap()
            .get(&impact.operation_id)
            .cloned()
            .expect("partially failed delete must persist its prepared record");
        assert_eq!(stored.decisions, decisions);
        assert_eq!(
            stored.remaining_deployment_ids,
            vec![failed_id],
            "the failed item is the remaining work for a later retry"
        );
        assert_eq!(stored.applied_deployment_ids.len(), 2);
        assert_eq!(stored.last_error_code, Some(ErrorCode::InternalError));
    });
}

/// 裁决1：中央 Skill 删除失败必须返回结构化部分结果——目标决定已全部
/// 应用、中央未删除、携带稳定错误码与恢复引用；持久化记录转为
/// PartiallyCommitted（journal Applying 相位＝恢复候选），不是裸 Err。
#[test]
fn a_failed_central_deletion_returns_a_structured_partial_result_with_a_recovery_reference() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let decisions: Vec<RemovalChoice> = impact
            .deployments
            .iter()
            .map(|deployment| RemovalChoice {
                deployment_id: deployment.id,
                decision: RemovalDecision::RemoveOwnedTarget,
                confirm_shared_target_removal: true,
            })
            .collect();
        *backend.failing_delete.lock().unwrap() = true;

        let result = service
            .commit_delete(impact.operation_id, decisions.clone())
            .await
            .expect("a failed central deletion is a structured outcome, not a bare error");

        assert_eq!(result.state, RemovalResultState::PartiallyCommitted);
        assert_eq!(result.recovery_operation_id, Some(impact.operation_id));
        assert!(!result.central_skill_deleted);
        assert_eq!(result.central_delete_error, Some(ErrorCode::InternalError));
        assert!(
            result
                .decisions
                .iter()
                .all(|item| item.status == skillhub_core::RemovalItemStatus::Applied),
            "every target decision already applied before the central failure"
        );
        assert!(
            backend.deleted_skills.lock().unwrap().is_empty(),
            "the central skill must not be reported as deleted"
        );

        // 持久化记录转为 PartiallyCommitted：目标已回收、中央仍在的真实
        // 不一致通过恢复候选可见，等待重新 prepare 后续作。
        let stored = backend
            .prepared_store
            .lock()
            .unwrap()
            .get(&impact.operation_id)
            .cloned()
            .expect("the failed central deletion must persist its prepared record");
        assert_eq!(
            stored.state,
            skillhub_core::PreparedRemovalState::PartiallyCommitted
        );
        assert_eq!(stored.last_error_code, Some(ErrorCode::InternalError));
        assert!(
            stored.remaining_deployment_ids.is_empty(),
            "no relation work is left; only the central body remains"
        );
        assert_eq!(stored.applied_deployment_ids.len(), 2);
        assert_eq!(stored.decisions, decisions);
    });
}

#[test]
fn removal_impact_for_shared_direct_read_lists_other_consumers() {
    let relation = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("relation-codex", RelationshipType::SharedDirectoryRead);
    let other = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "claude",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("relation-claude", RelationshipType::SharedDirectoryRead);
    let facts = RemovalFacts::new(
        vec![
            relation.to_deployment_relation_fact(),
            other.to_deployment_relation_fact(),
        ],
        vec![
            AgentDirectoryCapabilityFact {
                agent_client_id: "codex".into(),
                directory_node_id: "shared".into(),
                recognition: DirectoryRecognition::Supported,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec![],
            },
            AgentDirectoryCapabilityFact {
                agent_client_id: "claude".into(),
                directory_node_id: "shared".into(),
                recognition: DirectoryRecognition::Supported,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec![],
            },
        ],
    );

    let impact = calculate_removal_impact("relation-codex", &facts);

    assert_eq!(impact.other_consumers.len(), 1);
    assert_eq!(impact.other_consumers[0].agent_client_id, "claude");
    assert_eq!(
        recommend_removal_action(&impact),
        MinimalImpactAction::RemoveCurrentRelationKeepSharedFiles
    );
}

#[test]
#[test]
fn removal_impact_keeps_read_only_import_originals_record_only() {
    // FB-④（2026-10-06）：可写原件随主体删除一并清理必须显式确认并备份；
    // 只读原件只结束关系记录，不删除文件、无需备份。
    let relation = RelationTargetFact::directory(
        "agent",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("relation", RelationshipType::ImportCopy);
    let facts = RemovalFacts::new(vec![relation.to_deployment_relation_fact()], vec![]);

    let writable = calculate_removal_impact("relation", &facts);
    assert_eq!(
        recommend_removal_action(&writable),
        MinimalImpactAction::RemoveCurrentAgentTarget
    );
    assert!(writable.backup.required, "writable cleanup requires a backup");

    let read_only = calculate_removal_impact(
        "relation",
        &facts.clone().with_read_only_relation_ids(["relation"]),
    );
    assert_eq!(
        recommend_removal_action(&read_only),
        MinimalImpactAction::EndRelationRecordOnly
    );
    assert!(!read_only.backup.required, "record-only exits touch no files");
}

fn removal_impact_for_unknown_capability_is_a_governance_todo() {
    let relation = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("relation", RelationshipType::Unknown);
    let facts = RemovalFacts::new(vec![relation.to_deployment_relation_fact()], vec![]);

    let impact = calculate_removal_impact("relation", &facts);

    assert_eq!(
        recommend_removal_action(&impact),
        MinimalImpactAction::CreateGovernanceTask
    );
    assert!(!impact.governance_tasks.is_empty());
    assert_eq!(
        impact.governance_tasks[0].kind,
        GovernanceTaskKind::UnknownDirectoryRecognition
    );
}

#[test]
fn removal_impact_keeps_unknown_and_unsupported_shared_consumers_visible() {
    let current = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("current", RelationshipType::SharedDirectoryRead);
    let unknown = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "claude",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("unknown", RelationshipType::SharedDirectoryRead);
    let unsupported = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "cursor",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("unsupported", RelationshipType::SharedDirectoryReference);
    let mut inactive = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "inactive",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("inactive", RelationshipType::SharedDirectoryRead)
    .to_deployment_relation_fact();
    inactive.active = false;
    let ignored_copy = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "copy",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("copy", RelationshipType::ObservedCopy);

    let facts = RemovalFacts::new(
        vec![
            current.to_deployment_relation_fact(),
            unknown.to_deployment_relation_fact(),
            unsupported.to_deployment_relation_fact(),
            inactive,
            ignored_copy.to_deployment_relation_fact(),
        ],
        vec![
            AgentDirectoryCapabilityFact {
                agent_client_id: "codex".into(),
                directory_node_id: "shared".into(),
                recognition: DirectoryRecognition::Supported,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec![],
            },
            AgentDirectoryCapabilityFact {
                agent_client_id: "claude".into(),
                directory_node_id: "shared".into(),
                recognition: DirectoryRecognition::Unknown,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec![],
            },
            AgentDirectoryCapabilityFact {
                agent_client_id: "cursor".into(),
                directory_node_id: "shared".into(),
                recognition: DirectoryRecognition::Unsupported,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec![],
            },
        ],
    );

    let impact = calculate_removal_impact("current", &facts);

    assert_eq!(
        impact
            .other_consumers
            .iter()
            .map(|consumer| consumer.agent_client_id.as_str())
            .collect::<Vec<_>>(),
        vec!["claude", "cursor"]
    );
    assert_eq!(
        impact
            .other_consumers
            .iter()
            .map(|consumer| consumer.recognition)
            .collect::<Vec<_>>(),
        vec![
            DirectoryRecognition::Unknown,
            DirectoryRecognition::Unsupported
        ]
    );
    assert!(impact
        .governance_tasks
        .iter()
        .all(|task| task.kind == GovernanceTaskKind::UnknownDirectoryRecognition));
    assert_eq!(
        impact.minimal_action,
        MinimalImpactAction::CreateGovernanceTask
    );
}

#[test]
fn removal_impact_sorts_related_paths_and_only_counts_active_shared_relations() {
    let skill_id = SkillId::new();
    let current = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("current", RelationshipType::SharedDirectoryRead)
    .with_skill(skill_id, "sha256:current");
    let path_b = RelationTargetFact::directory(
        "native-b",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("b", RelationshipType::ObservedCopy)
    .with_file_representation(FileRepresentation::Copy)
    .with_skill(skill_id, "sha256:b");
    let path_a = RelationTargetFact::directory(
        "native-a",
        "/home/ada/.claude/skills",
        "claude",
        DirectoryRole::AgentNative,
    )
    .with_relation("a", RelationshipType::ObservedLink)
    .with_file_representation(FileRepresentation::SymbolicLink)
    .with_skill(skill_id, "sha256:a");
    let mut inactive_shared = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "gemini",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("inactive-shared", RelationshipType::SharedDirectoryRead)
    .to_deployment_relation_fact();
    inactive_shared.active = false;

    let impact = calculate_removal_impact(
        "current",
        &RemovalFacts::new(
            vec![
                current.to_deployment_relation_fact(),
                path_b.to_deployment_relation_fact(),
                path_a.to_deployment_relation_fact(),
                inactive_shared,
            ],
            vec![],
        ),
    );

    assert!(impact.other_consumers.is_empty());
    assert_eq!(
        impact
            .other_skill_paths
            .iter()
            .map(|path| path.relation_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
}

#[test]
fn removal_impact_governs_inactive_or_released_relations_and_excludes_released_paths() {
    let skill_id = SkillId::new();
    let mut inactive = RelationTargetFact::directory(
        "inactive",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("inactive", RelationshipType::ManagedCopy)
    .with_file_representation(FileRepresentation::Copy)
    .with_ownership(skillhub_core::OwnershipState::SkillhubManaged)
    .with_skill(skill_id, "sha256:inactive")
    .to_deployment_relation_fact();
    inactive.active = false;

    let mut released = RelationTargetFact::directory(
        "released",
        "/home/ada/.claude/skills",
        "claude",
        DirectoryRole::AgentNative,
    )
    .with_relation("released", RelationshipType::ObservedCopy)
    .with_file_representation(FileRepresentation::Copy)
    .with_skill(skill_id, "sha256:released")
    .to_deployment_relation_fact();
    released.released_at = Some(88);

    let active = RelationTargetFact::directory(
        "active",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    )
    .with_relation("active", RelationshipType::ObservedCopy)
    .with_file_representation(FileRepresentation::Copy)
    .with_skill(skill_id, "sha256:active")
    .to_deployment_relation_fact();

    let facts = RemovalFacts::new(vec![inactive, released, active], vec![]);
    let inactive_impact = calculate_removal_impact("inactive", &facts);
    assert_eq!(
        inactive_impact.minimal_action,
        MinimalImpactAction::CreateGovernanceTask
    );
    assert!(!inactive_impact.governance_tasks.is_empty());
    assert_eq!(
        inactive_impact
            .other_skill_paths
            .iter()
            .map(|path| path.relation_id.as_str())
            .collect::<Vec<_>>(),
        vec!["active"]
    );

    let released_impact = calculate_removal_impact("released", &facts);
    assert_eq!(
        released_impact.minimal_action,
        MinimalImpactAction::CreateGovernanceTask
    );
    assert!(!released_impact.governance_tasks.is_empty());
}

#[test]
fn permission_and_missing_relation_use_operation_failure_governance() {
    let facts = RemovalFacts::default().with_permission_limited(true);
    let permission = calculate_removal_impact("missing", &facts);
    assert_eq!(
        permission.governance_tasks[0].kind,
        GovernanceTaskKind::OperationFailureRecovery
    );

    let missing = calculate_removal_impact("missing", &RemovalFacts::default());
    assert_eq!(
        missing.governance_tasks[0].kind,
        GovernanceTaskKind::OperationFailureRecovery
    );
}

#[test]
fn copy_conversion_is_not_mapped_to_legacy_detach_management() {
    assert_eq!(
        RemovalDecision::from_minimal_impact(MinimalImpactAction::ConvertCopyToManagedLink),
        None
    );
}

#[test]
fn removal_impact_keeps_native_removal_local_and_suggests_copy_conversion() {
    let native = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("native", RelationshipType::ManagedLink);
    let copy = RelationTargetFact::directory(
        "native-2",
        "/home/ada/.claude/skills",
        "claude",
        DirectoryRole::AgentNative,
    )
    .with_relation("copy", RelationshipType::ObservedCopy);

    let native_impact = calculate_removal_impact(
        "native",
        &RemovalFacts::new(vec![native.to_deployment_relation_fact()], vec![]),
    );
    assert!(native_impact.other_consumers.is_empty());
    assert_eq!(
        recommend_removal_action(&native_impact),
        MinimalImpactAction::RemoveCurrentAgentTarget
    );

    let copy_impact = calculate_removal_impact(
        "copy",
        &RemovalFacts::new(vec![copy.to_deployment_relation_fact()], vec![]),
    );
    assert_eq!(
        recommend_removal_action(&copy_impact),
        MinimalImpactAction::ConvertCopyToManagedLink
    );
    assert!(copy_impact.backup.required);
    assert!(copy_impact.backup.rollback_available);
}

#[test]
fn removal_impact_removes_only_a_shared_alias_and_is_pure_across_retries() {
    let alias = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("alias", RelationshipType::SharedDirectoryReference)
    .with_link_target("/home/ada/.agents/skills/demo", Some("shared".into()));
    let facts = RemovalFacts::new(
        vec![alias.to_deployment_relation_fact()],
        vec![AgentDirectoryCapabilityFact {
            agent_client_id: "codex".into(),
            directory_node_id: "shared".into(),
            recognition: DirectoryRecognition::Supported,
            precedence: skillhub_core::DirectoryPrecedence::Preferred,
            evidence_reference: None,
            researched_at: None,
            applicable_platforms: vec![],
        }],
    );
    let first = calculate_removal_impact("alias", &facts);
    let second = calculate_removal_impact("alias", &facts);

    assert_eq!(first, second);
    assert_eq!(
        first.minimal_action,
        MinimalImpactAction::RemoveCurrentSharedAlias
    );
    assert!(first.other_consumers.is_empty());
    assert!(!first.current_agent_reads_shared_directory);

    let permission =
        calculate_removal_impact("alias", &facts.clone().with_permission_limited(true));
    assert_eq!(
        permission.minimal_action,
        MinimalImpactAction::CreateGovernanceTask
    );
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
