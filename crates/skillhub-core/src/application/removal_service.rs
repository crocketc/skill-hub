use async_trait::async_trait;
use std::collections::HashSet;
use std::sync::Arc;

use crate::deployment::removal::{
    DeploymentRemovalResult, PreparedRemovalKind, PreparedRemovalRecord, PreparedRemovalState,
    RemovalChoice, RemovalDecision, RemovalImpact, RemovalItemStatus, RemovalResult,
    RemovalResultState,
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
}

impl<B> RemovalService<B>
where
    B: RemovalBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self { backend }
    }

    pub async fn prepare_delete(&self, skill_id: SkillId) -> AppResult<RemovalImpact> {
        let impact = self.backend.inspect_delete(skill_id).await?;
        self.backend
            .save_prepared_removal(&PreparedRemovalRecord {
                kind: PreparedRemovalKind::DeleteSkill,
                impact: impact.clone(),
                decisions: Vec::new(),
                applied_deployment_ids: Vec::new(),
                remaining_deployment_ids: Vec::new(),
                state: PreparedRemovalState::Prepared,
                last_error_code: None,
            })
            .await?;
        Ok(impact)
    }

    pub async fn prepare_undeploy(&self, deployment_id: DeploymentId) -> AppResult<RemovalImpact> {
        let impact = self.backend.inspect_undeploy(deployment_id).await?;
        self.backend
            .save_prepared_removal(&PreparedRemovalRecord {
                kind: PreparedRemovalKind::UndeploySkill,
                impact: impact.clone(),
                decisions: Vec::new(),
                applied_deployment_ids: Vec::new(),
                remaining_deployment_ids: Vec::new(),
                state: PreparedRemovalState::Prepared,
                last_error_code: None,
            })
            .await?;
        Ok(impact)
    }

    pub async fn commit_undeploy(
        &self,
        operation_id: OperationId,
        decision: RemovalDecision,
        confirm_shared_target_removal: bool,
    ) -> AppResult<RemovalResult> {
        let record = self.commitable_prepared(operation_id).await?;
        let deployment = record
            .impact
            .deployments
            .first()
            .cloned()
            .ok_or_else(|| conflict("undeploy target relation is missing"))?;
        // 提交端重新核对：预览之后关系漂移必须作废本次确认。
        let fresh = self.backend.inspect_undeploy(deployment.id).await?;
        let current = fresh.deployments.first();
        let unchanged = match current {
            Some(record) => record.id == deployment.id,
            None => false,
        };
        if !unchanged {
            return Err(conflict("deployment relation changed since the preview"));
        }
        let current = current.expect("checked above");
        if fresh.requires_shared_target_choice
            && decision == RemovalDecision::RemoveOwnedTarget
            && !confirm_shared_target_removal
        {
            return Err(shared_confirmation_conflict());
        }
        let result = self.apply_decision(current, decision).await?;
        self.backend.settle_prepared_removal(operation_id).await?;
        Ok(RemovalResult {
            operation_id,
            skill_id: fresh.skill_id,
            decisions: vec![result],
            central_skill_deleted: false,
            state: RemovalResultState::Committed,
            recovery_operation_id: None,
            central_delete_error: None,
        })
    }

    pub async fn undeploy(
        &self,
        deployment_id: DeploymentId,
        decision: RemovalDecision,
        confirm_shared_target_removal: bool,
    ) -> AppResult<RemovalResult> {
        let impact = self.prepare_undeploy(deployment_id).await?;
        self.commit_undeploy(impact.operation_id, decision, confirm_shared_target_removal)
            .await
    }

    pub async fn commit_delete(
        &self,
        operation_id: OperationId,
        decisions: Vec<RemovalChoice>,
    ) -> AppResult<RemovalResult> {
        let record = self.commitable_prepared(operation_id).await?;
        // 重新核对消费者快照：预览之后出现或消失的关系都会作废本次提交，
        // 必须重新 prepare（不允许对过期快照盲重放）。
        let fresh = self.backend.inspect_delete(record.impact.skill_id).await?;
        ensure_same_consumers(&record.impact, &fresh)?;
        validate_decisions(&fresh, &decisions)?;
        ensure_shared_confirmations(&fresh, &decisions)?;

        let mut results: Vec<DeploymentRemovalResult> = Vec::new();
        let mut applied: Vec<DeploymentId> = Vec::new();
        let mut remaining: Vec<DeploymentId> = Vec::new();
        let mut first_failure: Option<ErrorCode> = None;
        let mut removed_physical_targets: HashSet<String> = HashSet::new();
        let mut abandoned_groups: HashSet<String> = HashSet::new();

        for choice in &decisions {
            let deployment = fresh
                .deployments
                .iter()
                .find(|record| record.id == choice.deployment_id)
                .expect("validated decisions always target a live deployment");
            if abandoned_groups.contains(&deployment.target_id) {
                // 同组物理目标拆除失败后，其余记录不再尝试，等待恢复续作。
                remaining.push(choice.deployment_id);
                results.push(item_result(
                    deployment,
                    choice.decision,
                    RemovalItemStatus::Pending,
                ));
                continue;
            }
            let outcome = match choice.decision {
                RemovalDecision::RemoveOwnedTarget => {
                    if removed_physical_targets.contains(&deployment.target_id) {
                        // 共享物理目标已由同组记录回收一次；本记录只关闭自身
                        // 关系，不再触碰文件系统。
                        self.backend.remove_relation(deployment).await.map(|()| {
                            let mut item = item_result(
                                deployment,
                                choice.decision,
                                RemovalItemStatus::Applied,
                            );
                            item.target_removed = true;
                            item
                        })
                    } else {
                        self.backend
                            .remove_owned_target(deployment)
                            .await
                            .map(|()| {
                                removed_physical_targets.insert(deployment.target_id.clone());
                                let mut item = item_result(
                                    deployment,
                                    choice.decision,
                                    RemovalItemStatus::Applied,
                                );
                                item.target_removed = true;
                                item
                            })
                    }
                }
                RemovalDecision::KeepSharedDeployment | RemovalDecision::RemoveRelationOnly => {
                    self.backend.remove_relation(deployment).await.map(|()| {
                        item_result(deployment, choice.decision, RemovalItemStatus::Applied)
                    })
                }
                // validate_decisions 拒绝之后两种决定不会到达这里。
                RemovalDecision::DetachManagement | RemovalDecision::Cancel => {
                    Err(conflict("every deployment requires one explicit decision"))
                }
            };
            match outcome {
                Ok(mut item) => {
                    item.relation_removed = true;
                    applied.push(choice.deployment_id);
                    results.push(item);
                }
                Err(error) => {
                    let shared_group = fresh
                        .deployments
                        .iter()
                        .filter(|record| record.target_id == deployment.target_id)
                        .count()
                        > 1;
                    if shared_group && choice.decision == RemovalDecision::RemoveOwnedTarget {
                        abandoned_groups.insert(deployment.target_id.clone());
                    }
                    first_failure.get_or_insert(error.code);
                    remaining.push(choice.deployment_id);
                    let mut item =
                        item_result(deployment, choice.decision, RemovalItemStatus::Failed);
                    item.error_code = Some(error.code);
                    results.push(item);
                }
            }
        }

        if !remaining.is_empty() {
            // 部分失败：成功项保留，失败/剩余项与用户决定持久化，登记恢复
            // 候选；中央 Skill 不删，续作必须重新 prepare 核对身份。
            self.backend
                .save_prepared_removal(&PreparedRemovalRecord {
                    kind: PreparedRemovalKind::DeleteSkill,
                    impact: record.impact.clone(),
                    decisions,
                    applied_deployment_ids: applied,
                    remaining_deployment_ids: remaining,
                    state: PreparedRemovalState::PartiallyCommitted,
                    last_error_code: first_failure,
                })
                .await?;
            return Ok(RemovalResult {
                operation_id,
                skill_id: record.impact.skill_id,
                decisions: results,
                central_skill_deleted: false,
                state: RemovalResultState::PartiallyCommitted,
                recovery_operation_id: Some(operation_id),
                central_delete_error: None,
            });
        }

        // 裁决1/K2：中央删除失败是结构化部分结果——目标决定已全部应用、
        // 中央 Skill 未删除，持久化 PartiallyCommitted（journal Applying
        // 相位＝恢复候选）并携带稳定错误码与恢复引用；裸 Err 会让补偿完整
        // 的 RolledBack 行静默吸收"目标已回收、中央仍在"的真实不一致。
        if let Err(error) = self.backend.delete_skill(record.impact.skill_id).await {
            let code = error.code;
            self.backend
                .save_prepared_removal(&PreparedRemovalRecord {
                    kind: PreparedRemovalKind::DeleteSkill,
                    impact: record.impact.clone(),
                    decisions,
                    applied_deployment_ids: applied,
                    remaining_deployment_ids: Vec::new(),
                    state: PreparedRemovalState::PartiallyCommitted,
                    last_error_code: Some(code),
                })
                .await?;
            return Ok(RemovalResult {
                operation_id,
                skill_id: record.impact.skill_id,
                decisions: results,
                central_skill_deleted: false,
                state: RemovalResultState::PartiallyCommitted,
                recovery_operation_id: Some(operation_id),
                central_delete_error: Some(code),
            });
        }
        self.backend.settle_prepared_removal(operation_id).await?;
        Ok(RemovalResult {
            operation_id,
            skill_id: record.impact.skill_id,
            decisions: results,
            central_skill_deleted: true,
            state: RemovalResultState::Committed,
            recovery_operation_id: None,
            central_delete_error: None,
        })
    }

    async fn commitable_prepared(
        &self,
        operation_id: OperationId,
    ) -> AppResult<PreparedRemovalRecord> {
        self.backend
            .load_prepared_removal(operation_id)
            .await?
            .ok_or_else(|| not_found("prepared_removal"))
    }

    async fn apply_decision(
        &self,
        deployment: &DeploymentRecord,
        decision: RemovalDecision,
    ) -> AppResult<DeploymentRemovalResult> {
        let mut result = item_result(deployment, decision, RemovalItemStatus::Applied);
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

fn item_result(
    deployment: &DeploymentRecord,
    decision: RemovalDecision,
    status: RemovalItemStatus,
) -> DeploymentRemovalResult {
    DeploymentRemovalResult {
        deployment_id: deployment.id,
        decision,
        target_removed: false,
        relation_removed: false,
        management_detached: false,
        status,
        error_code: None,
    }
}

/// K2：预览与提交之间的消费者快照漂移（新增或消失的关系）作废提交。
fn ensure_same_consumers(prepared: &RemovalImpact, fresh: &RemovalImpact) -> AppResult<()> {
    let mut expected: Vec<_> = prepared
        .deployments
        .iter()
        .map(|record| record.id)
        .collect();
    expected.sort_by_key(|id| id.to_string());
    let mut actual: Vec<_> = fresh.deployments.iter().map(|record| record.id).collect();
    actual.sort_by_key(|id| id.to_string());
    if expected != actual {
        return Err(conflict(
            "deployment relations changed since the preview; prepare again",
        ));
    }
    Ok(())
}

fn validate_decisions(impact: &RemovalImpact, decisions: &[RemovalChoice]) -> AppResult<()> {
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

/// K2/G-09：回收共享物理目标必须逐条显式确认；缺省 false，绝不默认回收。
fn ensure_shared_confirmations(
    impact: &RemovalImpact,
    decisions: &[RemovalChoice],
) -> AppResult<()> {
    for choice in decisions {
        if choice.decision != RemovalDecision::RemoveOwnedTarget
            || choice.confirm_shared_target_removal
        {
            continue;
        }
        let group_size = impact
            .deployments
            .iter()
            .filter(|record| record.id == choice.deployment_id)
            .map(|record| record.target_id.clone())
            .next()
            .map(|target_id| {
                impact
                    .deployments
                    .iter()
                    .filter(|other| other.target_id == target_id)
                    .count()
            })
            .unwrap_or(0);
        if group_size > 1 {
            return Err(shared_confirmation_conflict());
        }
    }
    Ok(())
}

fn shared_confirmation_conflict() -> AppError {
    conflict("shared target removal requires explicit confirmation")
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
