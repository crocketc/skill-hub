mod model;
mod planner;

pub use model::{
    DeploymentCapabilities, DeploymentMode, DeploymentPlan, DeploymentPlanInput,
    DeploymentPlanRequest, DeploymentRecord, DeploymentRequest, DeploymentState,
    ExistingDeployment, ExistingOwnership, PlannerInput, RegisteredTargetIndex, TargetCapabilities,
    TargetChange, TargetConflict, TargetConflictReason, TargetFact, TargetFactSource, TargetPlan,
    VerifiedTarget,
};
pub use planner::DeploymentPlanner;

/// Resolves logical IDs selected by an API caller to currently verified target
/// facts.  The application implementation is responsible for loading only
/// registered discovery/custom/project records and using PathPolicy.
pub trait RegisteredTargetResolver {
    fn resolve(&self, logical_target_ids: &[String]) -> crate::AppResult<Vec<VerifiedTarget>>;
}

use async_trait::async_trait;

use crate::{AppResult, DeploymentId};

/// Storage boundary for deployment facts.  Planning does not require this
/// trait; executors and queries can use the SQLite implementation later.
#[async_trait(?Send)]
pub trait DeploymentRepository {
    async fn insert(&self, deployment: &DeploymentRecord) -> AppResult<()>;
    async fn get(&self, id: DeploymentId) -> AppResult<Option<DeploymentRecord>>;
    async fn list(&self) -> AppResult<Vec<DeploymentRecord>>;
    async fn list_for_target(&self, target_id: &str) -> AppResult<Vec<DeploymentRecord>>;
}
