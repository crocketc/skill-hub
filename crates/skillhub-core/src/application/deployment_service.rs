use std::collections::HashMap;
use std::sync::Arc;

use crate::deployment::{DeploymentPlan, DeploymentRecord, TargetChange, TargetPlan};
use crate::{
    AppError, AppResult, DeploymentId, OperationId, RecoveryAction, Severity, SkillId, VersionId,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetOperationStatus {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PreparedDeployment {
    pub id: OperationId,
    pub plan: DeploymentPlan,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TargetOperationResult {
    pub physical_target_id: String,
    pub logical_target_ids: Vec<String>,
    pub status: TargetOperationStatus,
    pub deployment_id: Option<DeploymentId>,
    pub version_id: VersionId,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentSummary {
    pub operation_id: OperationId,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub targets: Vec<TargetOperationResult>,
    pub committed: bool,
}

#[async_trait::async_trait]
pub trait DeploymentBackend: Send + Sync {
    async fn revalidate(&self, plan: &DeploymentPlan) -> AppResult<DeploymentPlan> {
        Ok(plan.clone())
    }

    async fn apply_target(&self, target: &TargetPlan) -> AppResult<DeploymentRecord>;
}

pub struct DeploymentService<B> {
    backend: Arc<B>,
    prepared: tokio::sync::Mutex<HashMap<OperationId, PreparedDeployment>>,
}

impl<B> DeploymentService<B>
where
    B: DeploymentBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self {
            backend,
            prepared: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn prepare(&self, plan: DeploymentPlan) -> AppResult<PreparedDeployment> {
        let prepared = PreparedDeployment {
            id: OperationId::new(),
            plan,
        };
        self.prepared
            .lock()
            .await
            .insert(prepared.id, prepared.clone());
        Ok(prepared)
    }

    pub async fn commit(&self, id: OperationId) -> AppResult<DeploymentSummary> {
        let prepared = self
            .prepared
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(crate::ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("field", "prepared_deployment")
                    .with_action(RecoveryAction::Retry)
            })?;
        let plan = self.backend.revalidate(&prepared.plan).await?;
        let mut targets = Vec::with_capacity(plan.targets.len());
        for target in &plan.targets {
            if target.change == TargetChange::NoOp {
                targets.push(TargetOperationResult {
                    physical_target_id: target.physical_target_id.clone(),
                    logical_target_ids: target.logical_target_ids.clone(),
                    status: TargetOperationStatus::Succeeded,
                    deployment_id: None,
                    version_id: target.version_id.clone(),
                    error_code: None,
                });
                continue;
            }
            match self.backend.apply_target(target).await {
                Ok(record) => targets.push(result_from_record(target, record)),
                Err(error) => targets.push(TargetOperationResult {
                    physical_target_id: target.physical_target_id.clone(),
                    logical_target_ids: target.logical_target_ids.clone(),
                    status: TargetOperationStatus::Failed,
                    deployment_id: None,
                    version_id: target.version_id.clone(),
                    error_code: Some(error.code.as_str().to_owned()),
                }),
            }
        }
        let committed = targets
            .iter()
            .all(|target| target.status == TargetOperationStatus::Succeeded);
        if committed {
            self.prepared.lock().await.remove(&id);
        }
        Ok(DeploymentSummary {
            operation_id: id,
            skill_id: plan.skill_id,
            version_id: plan.version_id,
            targets,
            committed,
        })
    }
}

fn result_from_record(target: &TargetPlan, record: DeploymentRecord) -> TargetOperationResult {
    TargetOperationResult {
        physical_target_id: target.physical_target_id.clone(),
        logical_target_ids: target.logical_target_ids.clone(),
        status: TargetOperationStatus::Succeeded,
        deployment_id: Some(record.id),
        version_id: record.version_id,
        error_code: None,
    }
}
