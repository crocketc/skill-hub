use async_trait::async_trait;
use std::sync::Arc;

use crate::deployment::reconcile::{
    ExternalChangeObservation, ExternalChangeState, ReconcileAction, ReconcilePlan, ReconcileResult,
};
use crate::{
    AppError, AppResult, DeploymentId, DeploymentRecord, ErrorCode, RecoveryAction, Severity,
    VersionId,
};

/// Platform boundary for inspecting and changing one deployed target.
///
/// `inspect_target` is where a filesystem adapter compares identity and the
/// selected-version manifest. Mutating methods are explicit so a missing or
/// externally modified target is never silently recreated or overwritten.
#[async_trait]
pub trait ReconcileBackend: Send + Sync {
    async fn get_deployment(&self, id: DeploymentId) -> AppResult<DeploymentRecord>;
    async fn inspect_target(
        &self,
        deployment: &DeploymentRecord,
    ) -> AppResult<ExternalChangeObservation>;
    /// Run basic preflight on the target and capture its content as a new
    /// version. The returned version becomes the caller's selected version.
    async fn collect_target_changes(&self, deployment: &DeploymentRecord) -> AppResult<VersionId>;
    /// Reapply the selected version to the owned target after explicit user
    /// confirmation.
    async fn restore_target(&self, deployment: &DeploymentRecord) -> AppResult<()>;
    /// Remove the management relation while leaving target files untouched.
    async fn keep_independent(&self, deployment: &DeploymentRecord) -> AppResult<()>;
    /// Persist a scoped dismissal/evidence record without changing files.
    async fn ignore_external_change(&self, deployment: &DeploymentRecord) -> AppResult<()>;
}

pub struct ReconcileService<B> {
    backend: Arc<B>,
}

impl<B> ReconcileService<B>
where
    B: ReconcileBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self { backend }
    }

    pub async fn plan(&self, deployment_id: DeploymentId) -> AppResult<ReconcilePlan> {
        let deployment = self.backend.get_deployment(deployment_id).await?;
        let observation = self.backend.inspect_target(&deployment).await?;
        Ok(ReconcilePlan::from_observation(&deployment, observation))
    }

    pub async fn collect_changes(&self, deployment_id: DeploymentId) -> AppResult<ReconcileResult> {
        let (deployment, observation) = self.load_observation(deployment_id).await?;
        ensure_allowed(observation.state, ReconcileAction::CollectChanges)?;
        let version_id = self.backend.collect_target_changes(&deployment).await?;
        Ok(ReconcileResult {
            deployment_id,
            state_before: observation.state,
            action: ReconcileAction::CollectChanges,
            version_id: Some(version_id),
            management_retained: true,
        })
    }

    pub async fn restore(&self, deployment_id: DeploymentId) -> AppResult<ReconcileResult> {
        let (deployment, observation) = self.load_observation(deployment_id).await?;
        ensure_allowed(observation.state, ReconcileAction::Restore)?;
        self.backend.restore_target(&deployment).await?;
        Ok(ReconcileResult {
            deployment_id,
            state_before: observation.state,
            action: ReconcileAction::Restore,
            version_id: Some(deployment.version_id),
            management_retained: true,
        })
    }

    pub async fn keep_independent(
        &self,
        deployment_id: DeploymentId,
    ) -> AppResult<ReconcileResult> {
        let (deployment, observation) = self.load_observation(deployment_id).await?;
        ensure_allowed(observation.state, ReconcileAction::KeepIndependentCopy)?;
        self.backend.keep_independent(&deployment).await?;
        Ok(ReconcileResult {
            deployment_id,
            state_before: observation.state,
            action: ReconcileAction::KeepIndependentCopy,
            version_id: None,
            management_retained: false,
        })
    }

    pub async fn ignore_external_change(
        &self,
        deployment_id: DeploymentId,
    ) -> AppResult<ReconcileResult> {
        let (deployment, observation) = self.load_observation(deployment_id).await?;
        ensure_allowed(observation.state, ReconcileAction::Ignore)?;
        self.backend.ignore_external_change(&deployment).await?;
        Ok(ReconcileResult {
            deployment_id,
            state_before: observation.state,
            action: ReconcileAction::Ignore,
            version_id: None,
            management_retained: true,
        })
    }

    async fn load_observation(
        &self,
        deployment_id: DeploymentId,
    ) -> AppResult<(DeploymentRecord, ExternalChangeObservation)> {
        let deployment = self.backend.get_deployment(deployment_id).await?;
        let observation = self.backend.inspect_target(&deployment).await?;
        Ok((deployment, observation))
    }
}

fn ensure_allowed(state: ExternalChangeState, action: ReconcileAction) -> AppResult<()> {
    let allowed = match state {
        ExternalChangeState::Modified => true,
        ExternalChangeState::Missing => matches!(
            action,
            ReconcileAction::Restore
                | ReconcileAction::KeepIndependentCopy
                | ReconcileAction::Ignore
        ),
        ExternalChangeState::Unchanged | ExternalChangeState::Ignored => false,
    };
    if allowed {
        return Ok(());
    }
    Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("state", format!("{state:?}"))
        .with_param("action", format!("{action:?}"))
        .with_action(RecoveryAction::InspectTarget))
}
