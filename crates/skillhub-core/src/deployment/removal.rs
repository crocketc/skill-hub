use crate::{
    DeploymentId, DeploymentRecord, ErrorCode, OperationId, ProjectId, SkillId, VersionId,
};
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
    /// K2/G-09：回收共享物理目标必须显式确认；缺省 false，绝不默认回收。
    #[serde(default)]
    pub confirm_shared_target_removal: bool,
}

/// 批次执行状态沿用既有完成/部分完成/失败语义（对齐关系治理批次），
/// 不是新的关系状态。
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemovalResultState {
    #[default]
    Committed,
    /// 至少一个目标决定失败：成功项保留，失败项与剩余项进入恢复候选。
    PartiallyCommitted,
    Failed,
}

/// 单项目执行结果；`pending` 表示尚未执行（排在失败组之后或属于失败组）。
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RemovalItemStatus {
    #[default]
    Applied,
    Failed,
    Pending,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemovalResult {
    pub operation_id: OperationId,
    pub skill_id: SkillId,
    pub decisions: Vec<DeploymentRemovalResult>,
    pub central_skill_deleted: bool,
    /// K2：批次执行状态；旧调用方读取的载荷缺省为 `committed`。
    #[serde(default)]
    pub state: RemovalResultState,
    /// 部分失败时指向恢复候选（同 prepared 操作 id），供前端跳转恢复入口。
    #[serde(default)]
    pub recovery_operation_id: Option<OperationId>,
    /// 中央 Skill 删除失败时的稳定错误码（恢复候选同步记录该不一致）。
    #[serde(default)]
    pub central_delete_error: Option<ErrorCode>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRemovalResult {
    pub deployment_id: DeploymentId,
    pub decision: RemovalDecision,
    pub target_removed: bool,
    pub relation_removed: bool,
    pub management_detached: bool,
    /// K2：逐项执行状态；旧载荷缺省按已执行读取。
    #[serde(default)]
    pub status: RemovalItemStatus,
    /// `failed` 项携带的稳定错误码。
    #[serde(default)]
    pub error_code: Option<ErrorCode>,
}

impl RemovalDecision {
    pub fn from_minimal_impact(
        action: crate::relationship::impact::MinimalImpactAction,
    ) -> Option<Self> {
        use crate::relationship::impact::MinimalImpactAction;
        match action {
            MinimalImpactAction::RemoveCurrentAgentTarget => Some(Self::RemoveOwnedTarget),
            MinimalImpactAction::RemoveCurrentRelationKeepSharedFiles => {
                Some(Self::KeepSharedDeployment)
            }
            MinimalImpactAction::RemoveCurrentSharedAlias => Some(Self::RemoveRelationOnly),
            MinimalImpactAction::ConvertCopyToManagedLink => None,
            MinimalImpactAction::CreateGovernanceTask => Some(Self::Cancel),
        }
    }
}

/// 持久化 prepared 记录归属的操作日志种类；对应 `operations.kind`。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedRemovalKind {
    DeleteSkill,
    UndeploySkill,
}

impl PreparedRemovalKind {
    pub fn as_journal_kind(self) -> &'static str {
        match self {
            Self::DeleteSkill => "delete_skill",
            Self::UndeploySkill => "undeploy_skill",
        }
    }
}

/// 持久化 prepared 记录的阶段：`prepared` 本会话可提交；`partially_committed`
/// 已有真实副作用（journal `applying` 相位），只能通过重新 prepare 续作。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedRemovalState {
    Prepared,
    PartiallyCommitted,
}

/// K2：prepared 状态的持久化载荷。存于操作日志恢复载荷中，含影响快照、
/// 用户已给出的共享目标决定与已处理/剩余项，重启后既不能误放行过期预览，
/// 也不丢失已确认的决定。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedRemovalRecord {
    pub kind: PreparedRemovalKind,
    pub impact: RemovalImpact,
    /// 最近一次提交尝试中用户给出的决定（含共享目标确认标记）。
    pub decisions: Vec<RemovalChoice>,
    pub applied_deployment_ids: Vec<DeploymentId>,
    pub remaining_deployment_ids: Vec<DeploymentId>,
    pub state: PreparedRemovalState,
    #[serde(default)]
    pub last_error_code: Option<ErrorCode>,
}
