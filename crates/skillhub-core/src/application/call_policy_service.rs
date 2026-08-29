use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

use crate::call_policy::{CallPolicyCapability, CallPolicyPlan};
use crate::catalog::CallPolicy;
use crate::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity, SkillId};

#[async_trait]
pub trait CallPolicyBackend: Send + Sync {
    async fn inspect(&self, skill_id: SkillId) -> AppResult<(CallPolicyCapability, CallPolicy)>;
    async fn apply(&self, skill_id: SkillId, policy: CallPolicy) -> AppResult<()>;
    async fn restore_original(&self, skill_id: SkillId) -> AppResult<()>;
}

pub struct CallPolicyService<B> {
    backend: Arc<B>,
    prepared: tokio::sync::Mutex<HashMap<OperationId, CallPolicyPlan>>,
}

impl<B> CallPolicyService<B>
where
    B: CallPolicyBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self {
            backend,
            prepared: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub async fn inspect(
        &self,
        skill_id: SkillId,
    ) -> AppResult<(CallPolicyCapability, CallPolicy)> {
        self.backend.inspect(skill_id).await
    }

    pub async fn prepare(&self, skill_id: SkillId, after: CallPolicy) -> AppResult<CallPolicyPlan> {
        let (capability, before) = self.backend.inspect(skill_id).await?;
        if capability != CallPolicyCapability::Editable {
            return Err(
                AppError::new(ErrorCode::CallPolicyNotSupported, Severity::Warning)
                    .with_action(RecoveryAction::OpenReadOnly),
            );
        }
        let plan = CallPolicyPlan {
            id: OperationId::new(),
            skill_id,
            capability,
            before,
            after,
        };
        self.prepared.lock().await.insert(plan.id, plan.clone());
        Ok(plan)
    }

    pub async fn commit(&self, id: OperationId) -> AppResult<()> {
        let plan = self
            .prepared
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| not_found("call_policy_plan"))?;
        self.backend.apply(plan.skill_id, plan.after).await?;
        self.prepared.lock().await.remove(&id);
        Ok(())
    }

    pub async fn restore_original(&self, skill_id: SkillId) -> AppResult<()> {
        self.backend.restore_original(skill_id).await
    }
}

fn not_found(field: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::Retry)
}
