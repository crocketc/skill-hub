use async_trait::async_trait;
use skillhub_core::application::{RemovalBackend, RemovalService};
use skillhub_core::deployment::reconcile::RelationTargetFact;
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::relationship::impact::{
    calculate_removal_impact, recommend_removal_action, MinimalImpactAction, RemovalFacts,
};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryRecognition, DirectoryRole, RelationshipType,
};
use skillhub_core::{
    AppError, AppResult, DeploymentId, ErrorCode, OperationId, RemovalDecision, RemovalImpact,
    SkillId, VersionId,
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeRemovalBackend {
    skill_id: SkillId,
    deployment: DeploymentRecord,
    delete_impact: RemovalImpact,
    undeploy_impact: RemovalImpact,
    removed_targets: Arc<Mutex<Vec<DeploymentId>>>,
    removed_relations: Arc<Mutex<Vec<DeploymentId>>>,
    detached: Arc<Mutex<Vec<DeploymentId>>>,
    deleted_skills: Arc<Mutex<Vec<SkillId>>>,
}

#[async_trait]
impl RemovalBackend for FakeRemovalBackend {
    async fn inspect_delete(&self, skill_id: SkillId) -> AppResult<RemovalImpact> {
        if skill_id == self.skill_id {
            Ok(self.delete_impact.clone())
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
        self.deleted_skills.lock().unwrap().push(skill_id);
        Ok(())
    }
}

fn fixture() -> (RemovalService<FakeRemovalBackend>, FakeRemovalBackend) {
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
    };
    let backend = FakeRemovalBackend {
        skill_id,
        deployment: deployment.clone(),
        delete_impact: impact.clone(),
        undeploy_impact: RemovalImpact {
            operation_id: OperationId::new(),
            skill_id,
            deployments: vec![deployment.clone()],
            requires_shared_target_choice: true,
            dependencies: vec![],
            project_configs: Vec::new(),
            pinned_versions: Vec::new(),
            combinations: Vec::new(),
            related_skills: Vec::new(),
            unknown_external_references: Vec::new(),
        },
        removed_targets: Arc::new(Mutex::new(Vec::new())),
        removed_relations: Arc::new(Mutex::new(Vec::new())),
        detached: Arc::new(Mutex::new(Vec::new())),
        deleted_skills: Arc::new(Mutex::new(Vec::new())),
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
fn delete_rejects_detach_management_before_mutating_relationships() {
    block_on(async {
        let (service, backend) = fixture();
        let impact = service.prepare_delete(backend.skill_id).await.unwrap();
        let decisions = impact
            .deployments
            .iter()
            .map(|deployment| (deployment.id, RemovalDecision::DetachManagement))
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
fn undeploy_removes_owned_target_and_preserves_central_skill() {
    block_on(async {
        let (service, backend) = fixture();
        service
            .undeploy(backend.deployment.id, RemovalDecision::RemoveOwnedTarget)
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
            .undeploy(backend.deployment.id, RemovalDecision::KeepSharedDeployment)
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
    .with_relation("alias", RelationshipType::SharedDirectoryReference);
    let facts = RemovalFacts::new(vec![alias.to_deployment_relation_fact()], vec![]);
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
