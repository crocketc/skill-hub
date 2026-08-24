mod model;
mod planner;

pub use model::{
    DeploymentCapabilities, DeploymentMode, DeploymentPlan, DeploymentPlanInput, DeploymentRecord,
    DeploymentRequest, DeploymentState, ExistingDeployment, ExistingOwnership,
    LogicalTargetSelection, PhysicalTargetInput, PlannerInput, TargetCapabilities, TargetChange,
    TargetConflict, TargetConflictReason, TargetPlan,
};
pub use planner::DeploymentPlanner;

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
