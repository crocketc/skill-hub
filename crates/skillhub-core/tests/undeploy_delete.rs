use async_trait::async_trait;
use skillhub_core::application::{RemovalBackend, RemovalService};
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
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

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
