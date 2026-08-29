use crate::{DeploymentId, DeploymentRecord, OperationId, SkillId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemovalImpact {
    pub operation_id: OperationId,
    pub skill_id: SkillId,
    pub deployments: Vec<DeploymentRecord>,
    pub requires_shared_target_choice: bool,
    pub dependencies: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemovalDecision {
    RemoveOwnedTarget,
    KeepSharedDeployment,
    RemoveRelationOnly,
    DetachManagement,
    Cancel,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemovalChoice {
    pub deployment_id: DeploymentId,
    pub decision: RemovalDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemovalResult {
    pub operation_id: OperationId,
    pub skill_id: SkillId,
    pub decisions: Vec<DeploymentRemovalResult>,
    pub central_skill_deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRemovalResult {
    pub deployment_id: DeploymentId,
    pub decision: RemovalDecision,
    pub target_removed: bool,
    pub relation_removed: bool,
    pub management_detached: bool,
}
