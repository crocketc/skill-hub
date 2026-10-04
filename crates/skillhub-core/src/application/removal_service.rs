use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

use crate::deployment::removal::{
    DeploymentRemovalResult, PreparedRemovalRecord, RemovalChoice, RemovalDecision, RemovalImpact,
    RemovalItemStatus, RemovalResult, RemovalResultState,
};
use crate::{
    AppError, AppResult, DeploymentId, DeploymentRecord, ErrorCode, OperationId, RecoveryAction,
    Severity, SkillId,
};

/// Platform/storage boundary for removal impact inspection and explicit
/// relation/target operations. Implementations must never cascade into unknown
/// or unrelated files.
#[async_trait]
pub trait RemovalBackend: Send + Sync {
    async fn inspect_delete(&self, skill_id: SkillId) -> AppResult<RemovalImpact>;
    async fn inspect_undeploy(&self, deployment_id: DeploymentId) -> AppResult<RemovalImpact>;
    async fn remove_owned_target(&self, deployment: &DeploymentRecord) -> AppResult<()>;
    async fn remove_relation(&self, deployment: &DeploymentRecord) -> AppResult<()>;
    async fn detach_management(&self, deployment: &DeploymentRecord) -> AppResult<()>;
    async fn delete_skill(&self, skill_id: SkillId) -> AppResult<()>;
    /// K2：持久化 prepared 记录（影响快照 + 用户决定 + 已处理/剩余项）。
    async fn save_prepared_removal(&self, record: &PreparedRemovalRecord) -> AppResult<()>;
    /// K2：读取仍可提交（journal `prepared` 相位）的记录；过期/已推进的
    /// 记录返回 `None`，提交端据此要求重新预览。
    async fn load_prepared_removal(
        &self,
        operation_id: OperationId,
    ) -> AppResult<Option<PreparedRemovalRecord>>;
    /// K2：全部决定成功执行并删除主体后，将 journal 行结算为 `committed`。
    async fn settle_prepared_removal(&self, operation_id: OperationId) -> AppResult<()>;
}

pub struct RemovalService<B> {
    backend: Arc<B>,
    prepared: tokio::sync::Mutex<HashMap<OperationId, RemovalImpact>>,
}

impl<B> RemovalService<B>
where
    B: RemovalBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self {
            backend,
            prepared: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn prepare_delete(&self, skill_id: SkillId) -> AppResult<RemovalImpact> {
        let impact = self.backend.inspect_delete(skill_id).await?;
        self.prepared
            .lock()
            .await
            .insert(impact.operation_id, impact.clone());
        Ok(impact)
    }

    pub async fn prepare_undeploy(&self, deployment_id: DeploymentId) -> AppResult<RemovalImpact> {
        let impact = self.backend.inspect_undeploy(deployment_id).await?;
        self.prepared
            .lock()
            .await
            .insert(impact.operation_id, impact.clone());
        Ok(impact)
    }

    pub async fn commit_undeploy(
        &self,
        operation_id: OperationId,
        decision: RemovalDecision,
        // K2 RED scaffolding: confirmation accepted but not yet enforced.
        confirm_shared_target_removal: bool,
    ) -> AppResult<RemovalResult> {
        let _ = confirm_shared_target_removal;
        let impact = self.get_prepared(operation_id).await?;
        let deployment_id = impact
            .deployments
            .first()
            .map(|record| record.id)
            .ok_or_else(|| conflict("undeploy target relation is missing"))?;
        let deployment = impact
            .deployments
            .iter()
            .find(|record| record.id == deployment_id)
            .cloned()
            .ok_or_else(|| conflict("undeploy target relation is missing"))?;
        self.commit_undeploy_with_target(impact, deployment, decision)
            .await
    }

    pub async fn undeploy(
        &self,
        deployment_id: DeploymentId,
        decision: RemovalDecision,
        confirm_shared_target_removal: bool,
    ) -> AppResult<RemovalResult> {
        let _ = confirm_shared_target_removal;
        let impact = self.prepare_undeploy(deployment_id).await?;
        let deployment = impact
            .deployments
            .iter()
            .find(|record| record.id == deployment_id)
            .cloned()
            .ok_or_else(|| conflict("undeploy target relation is missing"))?;
        self.commit_undeploy_with_target(impact, deployment, decision)
            .await
    }

    pub async fn commit_delete(
        &self,
        operation_id: OperationId,
        decisions: Vec<RemovalChoice>,
    ) -> AppResult<RemovalResult> {
        let impact = self.get_prepared(operation_id).await?;
        validate_decisions(&impact, &decisions)?;
        let mut results = Vec::with_capacity(decisions.len());
        for choice in decisions {
            let deployment = impact
                .deployments
                .iter()
                .find(|record| record.id == choice.deployment_id)
                .ok_or_else(|| conflict("deployment relation changed during removal"))?;
            results.push(self.apply_decision(deployment, choice.decision).await?);
        }
        self.backend.delete_skill(impact.skill_id).await?;
        self.prepared.lock().await.remove(&operation_id);
        Ok(RemovalResult {
            operation_id,
            skill_id: impact.skill_id,
            decisions: results,
            central_skill_deleted: true,
            state: RemovalResultState::Committed,
            recovery_operation_id: None,
            central_delete_error: None,
        })
    }

    async fn commit_undeploy_with_target(
        &self,
        impact: RemovalImpact,
        deployment: DeploymentRecord,
        decision: RemovalDecision,
    ) -> AppResult<RemovalResult> {
        let result = self.apply_decision(&deployment, decision).await?;
        self.prepared.lock().await.remove(&impact.operation_id);
        Ok(RemovalResult {
            operation_id: impact.operation_id,
            skill_id: impact.skill_id,
            decisions: vec![result],
            central_skill_deleted: false,
            state: RemovalResultState::Committed,
            recovery_operation_id: None,
            central_delete_error: None,
        })
    }

    async fn get_prepared(&self, operation_id: OperationId) -> AppResult<RemovalImpact> {
        self.prepared
            .lock()
            .await
            .get(&operation_id)
            .cloned()
            .ok_or_else(|| not_found("prepared_removal"))
    }

    async fn apply_decision(
        &self,
        deployment: &DeploymentRecord,
        decision: RemovalDecision,
    ) -> AppResult<DeploymentRemovalResult> {
        let mut result = DeploymentRemovalResult {
            deployment_id: deployment.id,
            decision,
            target_removed: false,
            relation_removed: false,
            management_detached: false,
            status: RemovalItemStatus::Applied,
            error_code: None,
        };
        match decision {
            RemovalDecision::RemoveOwnedTarget => {
                self.backend.remove_owned_target(deployment).await?;
                result.target_removed = true;
                result.relation_removed = true;
            }
            RemovalDecision::KeepSharedDeployment | RemovalDecision::RemoveRelationOnly => {
                self.backend.remove_relation(deployment).await?;
                result.relation_removed = true;
            }
            RemovalDecision::DetachManagement => {
                self.backend.detach_management(deployment).await?;
                result.management_detached = true;
            }
            RemovalDecision::Cancel => return Err(conflict("removal cancelled")),
        }
        Ok(result)
    }
}

fn validate_decisions(impact: &RemovalImpact, decisions: &[RemovalChoice]) -> AppResult<()> {
    if impact.deployments.is_empty() {
        return Ok(());
    }
    let mut expected: Vec<_> = impact.deployments.iter().map(|record| record.id).collect();
    expected.sort_by_key(|id| id.to_string());
    let mut actual: Vec<_> = decisions
        .iter()
        .map(|choice| choice.deployment_id)
        .collect();
    actual.sort_by_key(|id| id.to_string());
    if expected != actual
        || decisions
            .iter()
            .any(|choice| choice.decision == RemovalDecision::Cancel)
    {
        return Err(conflict("every deployment requires one explicit decision"));
    }
    if decisions
        .iter()
        .any(|choice| choice.decision == RemovalDecision::DetachManagement)
    {
        return Err(conflict(
            "detach management is only available when keeping the central Skill",
        ));
    }
    Ok(())
}

fn conflict(detail: &str) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("detail", detail)
        .with_action(RecoveryAction::InspectTarget)
}

fn not_found(field: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::Retry)
}
