use crate::{DeploymentId, DeploymentRecord, OperationId, ProjectId, SkillId, VersionId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemovalImpact {
    pub operation_id: OperationId,
    pub skill_id: SkillId,
    pub deployments: Vec<DeploymentRecord>,
    pub requires_shared_target_choice: bool,
    pub dependencies: Vec<String>,
    /// QA-001/US-051：删除前必须重新扫描的其余影响维度；
    /// `serde(default)` 保持既有持久化操作负载的向后兼容。
    #[serde(default)]
    pub project_configs: Vec<String>,
    #[serde(default)]
    pub pinned_versions: Vec<ProjectVersionPin>,
    #[serde(default)]
    pub combinations: Vec<String>,
    #[serde(default)]
    pub related_skills: Vec<String>,
    /// SkillHub 未托管的同名内容路径；只提示、不修改。
    #[serde(default)]
    pub unknown_external_references: Vec<String>,
}

/// QA-001：项目对某 Skill 的固定版本（US-051“项目固定版本”）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ProjectVersionPin {
    pub project_id: ProjectId,
    pub version_id: VersionId,
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
