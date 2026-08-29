use async_trait::async_trait;
use std::sync::Arc;

use crate::health::RecoveryCandidate;
use crate::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity};

#[async_trait]
pub trait RecoveryBackend: Send + Sync {
    async fn list_candidates(&self) -> AppResult<Vec<RecoveryCandidate>>;
    async fn resolve(&self, operation_id: OperationId, action: RecoveryAction) -> AppResult<()>;
}

pub struct RecoveryService<B> {
    backend: Arc<B>,
}

impl<B> RecoveryService<B>
where
    B: RecoveryBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self { backend }
    }

    pub async fn list(&self) -> AppResult<Vec<RecoveryCandidate>> {
        self.backend.list_candidates().await
    }

    pub async fn resolve(
        &self,
        operation_id: OperationId,
        action: RecoveryAction,
    ) -> AppResult<()> {
        let candidates = self.backend.list_candidates().await?;
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.operation_id == operation_id)
            .ok_or_else(|| not_found("recovery_candidate"))?;
        if !candidate.actions.contains(&action) {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("action", action.as_str())
                .with_action(RecoveryAction::InspectTarget));
        }
        self.backend.resolve(operation_id, action).await
    }
}

fn not_found(field: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::Retry)
}
