use std::sync::Arc;

use crate::source::update::{
    AppliedSourceUpdate, SourceState, SourceUpdateBackend, UpdateDecision, UpstreamCheckResult,
};
use crate::source::SourceDescriptor;
use crate::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId};

pub struct SourceService<B> {
    backend: Arc<B>,
}

impl<B> Clone for SourceService<B> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
        }
    }
}

impl<B> SourceService<B>
where
    B: SourceUpdateBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self { backend }
    }

    pub async fn relink_source(
        &self,
        skill_id: SkillId,
        source: SourceDescriptor,
    ) -> AppResult<()> {
        self.backend.relink_source(skill_id, source).await
    }

    pub async fn check_update(&self, skill_id: SkillId) -> AppResult<UpstreamCheckResult> {
        self.backend.check_source_update(skill_id).await
    }

    pub async fn apply_update(
        &self,
        skill_id: SkillId,
        decision: UpdateDecision,
    ) -> AppResult<AppliedSourceUpdate> {
        if matches!(decision, UpdateDecision::KeepLocal | UpdateDecision::Cancel) {
            return Ok(AppliedSourceUpdate::new(skill_id, decision));
        }

        let check = self.check_update(skill_id).await?;
        if check.skill_id != skill_id {
            return Err(conflict("source check returned a different Skill"));
        }
        if matches!(
            (check.state, decision),
            (
                SourceState::UpdateAvailableWithLocalChanges,
                UpdateDecision::TakeUpstream
            )
        ) {
            return Err(conflict(
                "upstream update would overwrite local modifications",
            ));
        }
        self.backend.apply_source_update(skill_id, decision).await
    }
}

fn conflict(detail: &str) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("detail", detail)
        .with_action(RecoveryAction::Acknowledge)
}
