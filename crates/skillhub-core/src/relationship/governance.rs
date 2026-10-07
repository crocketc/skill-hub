//! Pure projection behind the relationship-governance ledger.
//!
//! The ledger is a *read model*: it derives one row per established
//! relationship edge from facts that are already persisted, and it decides
//! whether that edge could be brought under central-library management right
//! now.  It performs no filesystem I/O, calls no AI and writes no fact.
//!
//! Two rules keep it honest:
//!
//! 1. It never invents an edge.  Rows come from the relationship facts, so a
//!    deleted or released relationship simply stops being listed.
//! 2. It never overstates readiness.  Every blocker below is the same
//!    condition that the application-level `prepare_relation_migration` chain
//!    enforces — stale fingerprints, unsupported directory recognition,
//!    shared-body rewrites and unconfirmed shared impact all surface here
//!    *before* a user can select a row.
//!
//! Readiness describes legacy conversion feasibility only. `AlreadyCentralized`
//! is retained for serialized compatibility with existing link rows; it is not
//! evidence of a user's decision, takeover, completed governance or action
//! availability. The `governance` projection and its action conditions are the
//! authoritative user-facing facts.

use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use super::source_copy::{SourceCopyDecision, SourceCopyHealth, SourceCopyRelationFact};
use super::RelationHealthReason;
use crate::deployment::{DeploymentRelationFact, ObservedMatchState, ObservedOrigin};
use crate::import::ImportSourceClass;
use crate::relationship::{
    calculate_removal_impact, AgentDirectoryCapabilityFact, DirectoryNodeFact,
    DirectoryRecognition, DirectoryRole, FileRepresentation, OwnershipState, RelatedSkillPath,
    RelationshipType, RemovalFacts, RemovalImpactFact,
};
use crate::SkillId;

/// Tagged current relation; existing deployment ledger remains intact.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", content = "fact", rename_all = "snake_case")]
pub enum GovernableRelationFact {
    SourceCopy(SourceCopyRelationFact),
    Deployment(DeploymentRelationFact),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GovernableRelationStatus {
    NeedsAttention,
    Retained,
    Normal,
    NeedsValidation,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GovernableRelationProjection {
    pub relation_id: String,
    pub skill_id: Option<SkillId>,
    pub endpoint: String,
    pub status: GovernableRelationStatus,
}

pub fn project_governable_relation(
    fact: &GovernableRelationFact,
) -> Option<GovernableRelationProjection> {
    match fact {
        GovernableRelationFact::SourceCopy(copy) => {
            if !copy.active || copy.archived_at.is_some() {
                return None;
            }
            let status = match copy.health {
                SourceCopyHealth::ContentChanged | SourceCopyHealth::OperationFailed => {
                    GovernableRelationStatus::NeedsAttention
                }
                SourceCopyHealth::PermissionLimited | SourceCopyHealth::ManagedOccupied => {
                    GovernableRelationStatus::Blocked
                }
                SourceCopyHealth::NeedsValidation => GovernableRelationStatus::NeedsValidation,
                SourceCopyHealth::Normal if copy.decision == SourceCopyDecision::Retained => {
                    GovernableRelationStatus::Retained
                }
                SourceCopyHealth::Normal => GovernableRelationStatus::Normal,
            };
            Some(GovernableRelationProjection {
                relation_id: copy.relation_id.clone(),
                skill_id: Some(copy.skill_id),
                endpoint: copy.source_path.clone(),
                status,
            })
        }
        GovernableRelationFact::Deployment(deployment) => {
            if !deployment.active || deployment.released_at.is_some() {
                return None;
            }
            Some(GovernableRelationProjection {
                relation_id: deployment.relation_id.clone(),
                skill_id: deployment.skill_id,
                endpoint: deployment.path.clone(),
                status: GovernableRelationStatus::Normal,
            })
        }
    }
}

/// The four quick filters of the governance list.  They select from one
/// ledger; they are not four separate pages.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceBucket {
    #[default]
    All,
    EligibleToCentralize,
    NeedsValidation,
    Blocked,
}

impl RelationGovernanceBucket {
    pub const fn accepts(self, readiness: RelationGovernanceReadiness) -> bool {
        match self {
            Self::All => true,
            Self::EligibleToCentralize => {
                matches!(readiness, RelationGovernanceReadiness::EligibleToCentralize)
            }
            Self::NeedsValidation => {
                matches!(readiness, RelationGovernanceReadiness::NeedsValidation)
            }
            Self::Blocked => matches!(readiness, RelationGovernanceReadiness::Blocked),
        }
    }
}

/// Whether an edge can be brought under central-library management.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceReadiness {
    /// Convertible now: content verified, directory recognized, no shared body
    /// rewrite and no other consumer of the same shared directory.
    EligibleToCentralize,
    /// Convertible in principle, but the evidence is stale or an explicit
    /// confirmation is still outstanding.
    NeedsValidation,
    /// Not convertible until the listed fact-level obstacle is resolved.
    Blocked,
    /// Legacy link representation value. It does not imply the link is healthy,
    /// taken over or governed, and must not suppress its action conditions.
    AlreadyCentralized,
}

/// The single most appropriate next step for one edge.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceAction {
    /// 用户术语：「纳入集中库管理」。
    CentralizeManagement,
    /// 移除 SkillHub 创建的目标入口；沿用既有移除影响预览。
    Undeploy,
    /// 重新检查/重新扫描后回到清单；不写文件、不写关系事实。
    Revalidate,
    /// 来源副本转用户自留（复用既有 KeepIndependentCopy 命令）。
    KeepIndependentCopy,
    /// 部署副本解除受管但保留目标文件（复用既有 DetachManagement 命令）。
    DetachKeepFiles,
    /// 撤销独立副本保留决定；不修改当前健康事实或文件。
    RevokeRetention,
    /// 显式结束来源副本关系；保留来源文件，不绕过受管入口回收。
    EndRelationship,
    /// 受阻或无适用动作。
    None,
}

/// User-facing governance classification. This is independent of the
/// feasibility/readiness needed to execute a particular action.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceClassification {
    Pending,
    Completed,
}

/// The last confirmed management state for one relationship target.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationManagementStatus {
    NotTakenOver,
    TakenOver,
}

/// A durable user decision that is separate from the current health facts.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceDecision {
    Undecided,
    RetainedIndependentCopy,
}

/// Current conditions shown by the governance presenter. These are facts, not
/// action labels, and multiple reasons may be present at once.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceReason {
    DecisionRequired,
    VerificationRequired,
    ContentChanged,
    PermissionLimited,
    ManagedTargetOccupied,
    OperationFailed,
    TargetIdentityUnconfirmed,
    RelationshipNotConvertible,
    SharedImpactConfirmationRequired,
    LinkTargetUnavailable,
    LinkReplaced,
    SubjectUnavailable,
    ManagedEntryRequiresVerifiedRemoval,
}

/// An executable option and the conditions that currently prevent it. The
/// caller can render only the user-facing action and explanation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceActionCondition {
    pub action: RelationGovernanceAction,
    pub available: bool,
    pub reasons: Vec<RelationGovernanceReason>,
}

/// One authoritative projection shared by the governance list and graph.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceState {
    pub governance_status: RelationGovernanceClassification,
    pub management_status: RelationManagementStatus,
    pub decision: RelationGovernanceDecision,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub management_confirmed_at: Option<i64>,
    pub health_reasons: Vec<RelationGovernanceReason>,
    pub action_conditions: Vec<RelationGovernanceActionCondition>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceTargetKind {
    Agent,
    Project,
    SharedDirectory,
}

/// Stable identity for deduplicating one Skill's use at one verified physical
/// target. `entry_path_key` is the normalized full entry path; the directory
/// id is retained from the registered target fact even when its current health
/// later becomes abnormal.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationTargetIdentity {
    pub skill_id: SkillId,
    pub target_kind: RelationGovernanceTargetKind,
    pub directory_node_id: String,
    pub entry_path_key: String,
}

/// Persisted, explicit management/decision facts for deployment relationships.
/// Source-copy decisions remain stored in their source-copy JSON fact.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceConfirmationFact {
    pub relation_id: String,
    pub management_status: RelationManagementStatus,
    pub decision: RelationGovernanceDecision,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub confirmed_at: Option<i64>,
}

/// Why an edge is not `EligibleToCentralize`.  The list is exhaustive and
/// ordered, so a caller can show the first reason and the full set.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceBlocker {
    /// 目录联接或未知表示：目标无法被安全校验，禁止转换。
    UnverifiableRepresentation,
    /// 关系类型没有可转换的入口（未知关系、导入副本等）。
    RelationshipNotConvertible,
    /// 该条目本身就是共享目录的读取入口；转换会改写共享本体。
    SharedBodyProtected,
    /// 条目不在任何已登记目录节点下。
    DirectoryNotRegistered,
    /// Agent 对该目录的识别状态未知，必须先复核。
    DirectoryRecognitionUnknown,
    /// Agent 对该目录的识别状态为不支持，禁止操作。
    DirectoryRecognitionUnsupported,
    /// 存证不是"指纹一致"状态，必须先重新校验。
    VerificationNotCurrent,
    /// 其他 Agent 读取同一共享目录，共享影响必须由用户显式确认。
    SharedImpactConfirmationRequired,
    /// 关系缺少确定性的 Skill 身份或内容指纹。
    SkillIdentityUnconfirmed,
}

/// 行上的影响范围：另一端的消费者、同一 Skill 的其它路径与备份回退条件。
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceImpact {
    pub other_consumer_agent_ids: Vec<String>,
    pub other_skill_paths: Vec<RelatedSkillPath>,
    pub backup_required: bool,
    pub rollback_available: bool,
}

/// One relationship edge, ready for display and for batch selection. The
/// tagged `relation` carries either a source-copy edge or a deployment edge;
/// the accessors below keep call sites free of enum plumbing.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceRow {
    /// 对象、关系类型、目标路径、存证与验证状态的唯一事实来源。
    pub relation: GovernableRelationFact,
    /// 五个快捷状态（plan 7.1/7.9）：Normal/Retained/NeedsValidation/
    /// NeedsAttention/Blocked。
    pub status: GovernableRelationStatus,
    pub skill_display_name: Option<String>,
    pub readiness: RelationGovernanceReadiness,
    pub primary_action: RelationGovernanceAction,
    pub blockers: Vec<RelationGovernanceBlocker>,
    /// FB-④（2026-10-06）：行内证据包含只读内置目录导入原件（第 7 类）。
    /// 前端据此渲染只读卡：无动作区、不参与勾选、不显示受阻原因。
    pub source_read_only: bool,
    pub impact: RelationGovernanceImpact,
    /// New authoritative three-layer model. Legacy status/readiness fields
    /// remain during the frontend transition, but do not determine completion.
    pub governance: RelationGovernanceState,
    /// Absent when the facts do not carry a registered, verified target.
    pub target_identity: Option<RelationTargetIdentity>,
    /// Every internal fact represented by this single physical use relation.
    /// `relation` remains the deterministic representative for existing
    /// commands; callers can use these ids to resolve merged evidence.
    pub evidence_relation_ids: Vec<String>,
}

impl RelationGovernanceRow {
    pub fn relation_id(&self) -> &str {
        match &self.relation {
            GovernableRelationFact::SourceCopy(fact) => &fact.relation_id,
            GovernableRelationFact::Deployment(fact) => &fact.relation_id,
        }
    }

    pub fn skill_id(&self) -> Option<SkillId> {
        match &self.relation {
            GovernableRelationFact::SourceCopy(fact) => Some(fact.skill_id),
            GovernableRelationFact::Deployment(fact) => fact.skill_id,
        }
    }

    pub fn path(&self) -> &str {
        match &self.relation {
            GovernableRelationFact::SourceCopy(fact) => &fact.source_path,
            GovernableRelationFact::Deployment(fact) => &fact.path,
        }
    }

    /// 部署端总是有 Agent；来源副本的 Agent 关联方可缺省。
    pub fn agent_client_id(&self) -> Option<&str> {
        match &self.relation {
            GovernableRelationFact::SourceCopy(fact) => fact.agent_client_id.as_deref(),
            GovernableRelationFact::Deployment(fact) => Some(&fact.agent_client_id),
        }
    }

    /// 只有部署边有关系类型语义；来源副本返回 None。
    pub fn relationship(&self) -> Option<RelationshipType> {
        match &self.relation {
            GovernableRelationFact::SourceCopy(_) => None,
            GovernableRelationFact::Deployment(fact) => Some(fact.relationship),
        }
    }

    pub fn deployment(&self) -> Option<&DeploymentRelationFact> {
        match &self.relation {
            GovernableRelationFact::SourceCopy(_) => None,
            GovernableRelationFact::Deployment(fact) => Some(fact),
        }
    }

    pub fn source_copy(&self) -> Option<&SourceCopyRelationFact> {
        match &self.relation {
            GovernableRelationFact::SourceCopy(fact) => Some(fact),
            GovernableRelationFact::Deployment(_) => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub struct RelationGovernanceCounts {
    pub all: u32,
    pub eligible_to_centralize: u32,
    pub needs_validation: u32,
    pub blocked: u32,
    /// 五个快捷状态计数（plan 7.9）。
    pub status_normal: u32,
    pub status_retained: u32,
    pub status_needs_validation: u32,
    pub status_needs_attention: u32,
    pub status_blocked: u32,
    /// 两侧 kind 计数。
    pub source_copies: u32,
    pub deployments: u32,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceFilters {
    #[serde(default)]
    pub bucket: RelationGovernanceBucket,
    #[serde(default)]
    pub skill_id: Option<SkillId>,
    #[serde(default)]
    pub agent_client_id: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub relationship_types: Vec<RelationshipType>,
    /// 项目 scope：命中来源副本的 source_container_id。
    #[serde(default)]
    pub project_id: Option<String>,
    /// 来源类别过滤；部署边不受此过滤影响。
    #[serde(default)]
    pub source_class: Option<ImportSourceClass>,
    /// 批次过滤：只命中 import_batch_items 映射的关系（由服务层传入集合）。
    #[serde(default)]
    pub batch_id: Option<String>,
    /// 五个快捷状态过滤；空集合表示不过滤。
    #[serde(default)]
    pub statuses: Vec<GovernableRelationStatus>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceLedger {
    pub rows: Vec<RelationGovernanceRow>,
    pub counts: RelationGovernanceCounts,
    pub bucket: RelationGovernanceBucket,
    pub total: u32,
    pub relationship_revision: String,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
}

/// Display name lookup used to render a row without a second query.  The
/// projection stays pure: callers pass the already-resolved names.
pub type RelationGovernanceNames = Vec<(SkillId, String)>;

/// Projects the governance ledger from persisted relationship facts.
///
/// `relations` is the full active relationship-fact set; released edges are
/// history and are dropped here rather than being reported as governed edges.
pub fn project_relation_governance_ledger(
    filters: &RelationGovernanceFilters,
    relations: &[DeploymentRelationFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    relationship_revision: i64,
    last_verified_at: Option<i64>,
) -> RelationGovernanceLedger {
    project_relation_governance_ledger_with_names(
        filters,
        relations,
        directory_capabilities,
        &RelationGovernanceNames::new(),
        relationship_revision,
        last_verified_at,
    )
}

pub fn project_relation_governance_ledger_with_names(
    filters: &RelationGovernanceFilters,
    relations: &[DeploymentRelationFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    names: &RelationGovernanceNames,
    relationship_revision: i64,
    last_verified_at: Option<i64>,
) -> RelationGovernanceLedger {
    let facts = relations
        .iter()
        .map(|relation| GovernableRelationFact::Deployment(relation.clone()))
        .collect::<Vec<_>>();
    project_unified_governance_ledger(
        filters,
        &facts,
        directory_capabilities,
        &BTreeSet::new(),
        &BTreeSet::new(),
        names,
        relationship_revision,
        last_verified_at,
    )
}

/// Unified projection entry (plan 7.8): consumes source-copy relations and
/// deployment relations in one ledger, plus the batch→relation map used by
/// the `batch_id` filter. Pure: no filesystem I/O, no writes.
#[allow(clippy::too_many_arguments)]
pub fn project_unified_governance_ledger(
    filters: &RelationGovernanceFilters,
    facts: &[GovernableRelationFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    batch_relation_ids: &BTreeSet<String>,
    read_only_source_relation_ids: &BTreeSet<String>,
    names: &RelationGovernanceNames,
    relationship_revision: i64,
    last_verified_at: Option<i64>,
) -> RelationGovernanceLedger {
    project_unified_governance_ledger_with_context(
        filters,
        facts,
        directory_capabilities,
        &[],
        &[],
        batch_relation_ids,
        read_only_source_relation_ids,
        names,
        relationship_revision,
        last_verified_at,
    )
}

/// Projects the authoritative governance rows from relationship, registered
/// directory, and explicit management-confirmation facts. The graph query uses
/// these exact rows rather than rebuilding governance from `active` or
/// `match_state`.
///
/// `read_only_source_relation_ids` carries the relation ids of source-copy
/// originals that live under an Agent's read-only builtin directory (FB-④,
/// 2026-10-06). Rows whose evidence includes one of these ids are classified
/// from the read-only fact instead of the conversion blockers.
#[allow(clippy::too_many_arguments)]
pub fn project_unified_governance_ledger_with_context(
    filters: &RelationGovernanceFilters,
    facts: &[GovernableRelationFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    directory_nodes: &[DirectoryNodeFact],
    confirmations: &[RelationGovernanceConfirmationFact],
    batch_relation_ids: &BTreeSet<String>,
    read_only_source_relation_ids: &BTreeSet<String>,
    names: &RelationGovernanceNames,
    relationship_revision: i64,
    last_verified_at: Option<i64>,
) -> RelationGovernanceLedger {
    let confirmation_by_relation_id = confirmations
        .iter()
        .map(|fact| (fact.relation_id.as_str(), fact))
        .collect::<HashMap<_, _>>();
    let directory_by_node_id = directory_nodes
        .iter()
        .map(|directory| (directory.node_id.as_str(), directory))
        .collect::<HashMap<_, _>>();
    let deployment_facts = facts
        .iter()
        .filter_map(|fact| match fact {
            GovernableRelationFact::Deployment(relation) => Some(relation.clone()),
            GovernableRelationFact::SourceCopy(_) => None,
        })
        .collect::<Vec<_>>();
    let removal_facts =
        RemovalFacts::new(deployment_facts.clone(), directory_capabilities.to_vec());

    let mut rows = facts
        .iter()
        .filter_map(|fact| {
            // 普通用户目录仅作为来源事实保留，不是 Agent/项目的使用目标。
            if matches!(fact, GovernableRelationFact::SourceCopy(copy)
                if copy.source_class == ImportSourceClass::UserLocal)
            {
                return None;
            }
            let projection = project_governable_relation(fact)?;
            let status = projection.status;
            Some((fact, projection.relation_id, status))
        })
        .map(|(fact, _relation_id, status)| match fact {
            GovernableRelationFact::SourceCopy(copy) => {
                let target_identity = target_identity_for_fact(fact, &directory_by_node_id);
                let management_status = RelationManagementStatus::NotTakenOver;
                // FB-④（2026-10-06）：核验健康的原件由导入自动记录保留决定，
                // 呈现层不再给出待决策动作；旧行的显式保留决定沿用原映射。
                let healthy_original = healthy_import_original(copy);
                let decision = if healthy_original || copy.decision == SourceCopyDecision::Retained
                {
                    RelationGovernanceDecision::RetainedIndependentCopy
                } else {
                    RelationGovernanceDecision::Undecided
                };
                let readiness = RelationGovernanceReadiness::AlreadyCentralized;
                let primary_action = if healthy_original {
                    RelationGovernanceAction::None
                } else {
                    source_copy_action(copy, status)
                };
                let governance =
                    governance_state(fact, management_status, decision, None, primary_action, &[]);
                RelationGovernanceRow {
                    relation: GovernableRelationFact::SourceCopy(copy.clone()),
                    status,
                    skill_display_name: names
                        .iter()
                        .find(|(candidate, _)| *candidate == copy.skill_id)
                        .map(|(_, name)| name.clone()),
                    // Compatibility value only. Importing a source copy is not a
                    // user's management decision and does not complete governance.
                    readiness,
                    primary_action,
                    blockers: Vec::new(),
                    source_read_only: false,
                    impact: RelationGovernanceImpact::default(),
                    governance,
                    target_identity,
                    evidence_relation_ids: vec![copy.relation_id.clone()],
                }
            }
            GovernableRelationFact::Deployment(relation) => {
                let impact = calculate_removal_impact(&relation.relation_id, &removal_facts);
                let blockers = blockers_for(relation, directory_capabilities, &impact);
                let readiness = readiness_for(relation, &blockers);
                let confirmation = confirmation_by_relation_id
                    .get(relation.relation_id.as_str())
                    .copied();
                let management_status = confirmation
                    .map(|fact| fact.management_status)
                    .unwrap_or(RelationManagementStatus::NotTakenOver);
                let decision = confirmation
                    .map(|fact| fact.decision)
                    .unwrap_or(RelationGovernanceDecision::Undecided);
                let primary_action = primary_action_for(relation, readiness);
                let governance = governance_state(
                    fact,
                    management_status,
                    decision,
                    confirmation.and_then(|fact| fact.confirmed_at),
                    primary_action,
                    &blockers,
                );
                RelationGovernanceRow {
                    relation: GovernableRelationFact::Deployment(relation.clone()),
                    status: deployment_status(relation),
                    skill_display_name: relation.skill_id.and_then(|skill_id| {
                        names
                            .iter()
                            .find(|(candidate, _)| *candidate == skill_id)
                            .map(|(_, name)| name.clone())
                    }),
                    readiness,
                    primary_action,
                    blockers,
                    source_read_only: false,
                    impact: RelationGovernanceImpact {
                        other_consumer_agent_ids: impact
                            .other_consumers
                            .iter()
                            .map(|consumer| consumer.agent_client_id.clone())
                            .collect::<BTreeSet<_>>()
                            .into_iter()
                            .collect(),
                        other_skill_paths: impact.other_skill_paths.clone(),
                        backup_required: impact.backup.required,
                        rollback_available: impact.backup.rollback_available,
                    },
                    governance,
                    target_identity: target_identity_for_fact(fact, &directory_by_node_id),
                    evidence_relation_ids: vec![relation.relation_id.clone()],
                }
            }
        })
        .collect::<Vec<_>>();
    rows = merge_rows_for_same_target(rows);
    apply_read_only_original_governance(&mut rows, facts, read_only_source_relation_ids);
    rows.sort_by(|left, right| left.relation_id().cmp(right.relation_id()));

    let counts = RelationGovernanceCounts {
        all: rows.len() as u32,
        eligible_to_centralize: rows
            .iter()
            .filter(|row| row.readiness == RelationGovernanceReadiness::EligibleToCentralize)
            .count() as u32,
        needs_validation: rows
            .iter()
            .filter(|row| row.readiness == RelationGovernanceReadiness::NeedsValidation)
            .count() as u32,
        blocked: rows
            .iter()
            .filter(|row| row.readiness == RelationGovernanceReadiness::Blocked)
            .count() as u32,
        status_normal: status_count(&rows, GovernableRelationStatus::Normal),
        status_retained: status_count(&rows, GovernableRelationStatus::Retained),
        status_needs_validation: status_count(&rows, GovernableRelationStatus::NeedsValidation),
        status_needs_attention: status_count(&rows, GovernableRelationStatus::NeedsAttention),
        status_blocked: status_count(&rows, GovernableRelationStatus::Blocked),
        source_copies: rows
            .iter()
            .filter(|row| row.source_copy().is_some())
            .count() as u32,
        deployments: rows.iter().filter(|row| row.deployment().is_some()).count() as u32,
    };

    let text = filters.text.trim().to_lowercase();
    let selected = rows
        .into_iter()
        .filter(|row| bucket_accepts_governance_actions(filters.bucket, row))
        .filter(|row| filters.statuses.is_empty() || filters.statuses.contains(&row.status))
        .filter(|row| {
            filters
                .skill_id
                .is_none_or(|skill_id| row.skill_id() == Some(skill_id))
        })
        .filter(|row| {
            filters
                .agent_client_id
                .as_ref()
                .is_none_or(|agent| row.agent_client_id() == Some(agent.as_str()))
        })
        .filter(|row| {
            filters
                .project_id
                .as_ref()
                .is_none_or(|project| match row.source_copy() {
                    Some(copy) => copy.source_container_id.as_deref() == Some(project.as_str()),
                    None => false,
                })
        })
        .filter(|row| {
            filters
                .source_class
                .is_none_or(|source_class| match row.source_copy() {
                    Some(copy) => copy.source_class == source_class,
                    None => false,
                })
        })
        .filter(|row| {
            filters
                .batch_id
                .as_ref()
                .is_none_or(|_batch| batch_relation_ids.contains(row.relation_id()))
        })
        .filter(|row| {
            filters.relationship_types.is_empty()
                || row
                    .relationship()
                    .is_some_and(|relationship| filters.relationship_types.contains(&relationship))
        })
        .filter(|row| {
            text.is_empty()
                || row.path().to_lowercase().contains(text.as_str())
                || row
                    .deployment()
                    .and_then(|relation| relation.link_target_path.as_deref())
                    .is_some_and(|target| target.to_lowercase().contains(text.as_str()))
                || row
                    .agent_client_id()
                    .is_some_and(|agent| agent.to_lowercase().contains(text.as_str()))
                || row
                    .skill_display_name
                    .as_deref()
                    .is_some_and(|name| name.to_lowercase().contains(text.as_str()))
        })
        .collect::<Vec<_>>();

    RelationGovernanceLedger {
        total: selected.len() as u32,
        rows: selected,
        counts,
        bucket: filters.bucket,
        relationship_revision: relationship_revision.to_string(),
        last_verified_at,
    }
}

fn target_identity_for_fact(
    fact: &GovernableRelationFact,
    directories: &HashMap<&str, &DirectoryNodeFact>,
) -> Option<RelationTargetIdentity> {
    if let GovernableRelationFact::Deployment(relation) = fact {
        let skill_id = relation.skill_id?;
        if let Some(directory_node_id) =
            relation
                .link_target_directory_id
                .as_deref()
                .filter(|directory_id| {
                    directories
                        .get(directory_id)
                        .is_some_and(|directory| directory.role == DirectoryRole::SharedDirectory)
                })
        {
            let entry_path_key = relation
                .link_target_path_key
                .as_deref()
                .filter(|key| !key.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    relation
                        .link_target_path
                        .as_deref()
                        .map(crate::deployment::observed_path_key)
                })?;
            return Some(RelationTargetIdentity {
                skill_id,
                target_kind: RelationGovernanceTargetKind::SharedDirectory,
                directory_node_id: directory_node_id.to_owned(),
                entry_path_key,
            });
        }
    }
    let (skill_id, directory_node_id, entry_path_key) = match fact {
        GovernableRelationFact::SourceCopy(copy) => {
            if !matches!(
                copy.source_class,
                ImportSourceClass::AgentLocal | ImportSourceClass::RegisteredProject
            ) {
                return None;
            }
            (
                copy.skill_id,
                copy.directory_node_id
                    .as_deref()
                    .or(copy.source_container_id.as_deref())?,
                copy.source_path_key.as_str(),
            )
        }
        GovernableRelationFact::Deployment(relation) => (
            relation.skill_id?,
            relation.directory_node_id.as_deref()?,
            relation.path_key.as_str(),
        ),
    };
    let directory = directories.get(directory_node_id)?;
    let target_kind = match directory.role {
        DirectoryRole::AgentNative => RelationGovernanceTargetKind::Agent,
        DirectoryRole::Project => RelationGovernanceTargetKind::Project,
        DirectoryRole::SharedDirectory => RelationGovernanceTargetKind::SharedDirectory,
        DirectoryRole::CentralLibrary => return None,
    };
    let entry_path_key = if entry_path_key.trim().is_empty() {
        match fact {
            GovernableRelationFact::SourceCopy(copy) => {
                crate::deployment::observed_path_key(&copy.source_path)
            }
            GovernableRelationFact::Deployment(relation) => {
                crate::deployment::observed_path_key(&relation.path)
            }
        }
    } else {
        entry_path_key.to_owned()
    };
    Some(RelationTargetIdentity {
        skill_id,
        target_kind,
        directory_node_id: directory_node_id.to_owned(),
        entry_path_key,
    })
}

fn governance_state(
    fact: &GovernableRelationFact,
    management_status: RelationManagementStatus,
    decision: RelationGovernanceDecision,
    management_confirmed_at: Option<i64>,
    primary_action: RelationGovernanceAction,
    blockers: &[RelationGovernanceBlocker],
) -> RelationGovernanceState {
    let health_reasons = match fact {
        GovernableRelationFact::SourceCopy(copy) => source_copy_health_reasons(copy),
        GovernableRelationFact::Deployment(relation) => deployment_health_reasons(relation),
    };
    let governance_status = if health_reasons.is_empty()
        && (management_status == RelationManagementStatus::TakenOver
            || decision == RelationGovernanceDecision::RetainedIndependentCopy)
    {
        RelationGovernanceClassification::Completed
    } else {
        RelationGovernanceClassification::Pending
    };
    let action_conditions = action_conditions(
        fact,
        management_status,
        primary_action,
        blockers,
        &health_reasons,
        GovernanceActionEvidence::for_fact(fact),
    );
    RelationGovernanceState {
        governance_status,
        management_status,
        decision,
        management_confirmed_at,
        health_reasons,
        action_conditions,
    }
}

fn source_copy_health_reasons(copy: &SourceCopyRelationFact) -> Vec<RelationGovernanceReason> {
    let mut reasons: Vec<RelationGovernanceReason> = copy
        .health_reasons
        .as_deref()
        .map(|reasons| {
            reasons
                .iter()
                .copied()
                .map(governance_health_reason)
                .collect()
        })
        .unwrap_or_default();
    if copy.health_reasons.is_none() {
        reasons.push(RelationGovernanceReason::VerificationRequired);
    }
    match copy.health {
        SourceCopyHealth::Normal => {}
        SourceCopyHealth::NeedsValidation => {
            reasons.push(RelationGovernanceReason::VerificationRequired)
        }
        SourceCopyHealth::ContentChanged => reasons.push(RelationGovernanceReason::ContentChanged),
        SourceCopyHealth::PermissionLimited => {
            reasons.push(RelationGovernanceReason::PermissionLimited)
        }
        SourceCopyHealth::ManagedOccupied => {
            reasons.push(RelationGovernanceReason::ManagedTargetOccupied)
        }
        SourceCopyHealth::OperationFailed => {
            reasons.push(RelationGovernanceReason::OperationFailed)
        }
    }
    sort_dedup_reasons(&mut reasons);
    reasons
}

fn deployment_health_reasons(relation: &DeploymentRelationFact) -> Vec<RelationGovernanceReason> {
    let mut reasons: Vec<RelationGovernanceReason> = relation
        .health_reasons
        .as_deref()
        .map(|reasons| {
            reasons
                .iter()
                .copied()
                .map(governance_health_reason)
                .collect()
        })
        .unwrap_or_default();
    if relation.health_reasons.is_none() {
        reasons.push(RelationGovernanceReason::VerificationRequired);
    }
    match relation.match_state {
        ObservedMatchState::ContentVerified => {}
        ObservedMatchState::NameOnly => {
            reasons.push(RelationGovernanceReason::VerificationRequired)
        }
        ObservedMatchState::Diverged => reasons.push(RelationGovernanceReason::ContentChanged),
    }
    if relation.skill_id.is_none() {
        reasons.push(RelationGovernanceReason::TargetIdentityUnconfirmed);
    }
    sort_dedup_reasons(&mut reasons);
    reasons
}

fn governance_health_reason(reason: RelationHealthReason) -> RelationGovernanceReason {
    match reason {
        RelationHealthReason::TargetEntryMissing | RelationHealthReason::TargetLinkUnavailable => {
            RelationGovernanceReason::LinkTargetUnavailable
        }
        RelationHealthReason::TargetEntryReplaced => RelationGovernanceReason::LinkReplaced,
        RelationHealthReason::PermissionLimited => RelationGovernanceReason::PermissionLimited,
        RelationHealthReason::ContentChanged => RelationGovernanceReason::ContentChanged,
        RelationHealthReason::ManagedTargetOccupied => {
            RelationGovernanceReason::ManagedTargetOccupied
        }
        RelationHealthReason::OperationFailed => RelationGovernanceReason::OperationFailed,
        RelationHealthReason::SubjectUnavailable => RelationGovernanceReason::SubjectUnavailable,
        RelationHealthReason::ProbeUnavailable => RelationGovernanceReason::VerificationRequired,
    }
}

fn sort_dedup_reasons(reasons: &mut Vec<RelationGovernanceReason>) {
    reasons.sort_by_key(|reason| *reason as u8);
    reasons.dedup();
}

fn action_conditions(
    fact: &GovernableRelationFact,
    management_status: RelationManagementStatus,
    primary_action: RelationGovernanceAction,
    blockers: &[RelationGovernanceBlocker],
    health_reasons: &[RelationGovernanceReason],
    evidence: GovernanceActionEvidence,
) -> Vec<RelationGovernanceActionCondition> {
    let mut conditions = Vec::new();
    // #10 第 2 项（2026-10-07 定稿）：结束关系对未受管部署边是纯记录
    // 操作；「受管条目须先验证移除」只约束 Skillhub 管理的条目
    // （托管链接／托管副本）。
    if evidence.contains_source_copy || evidence.contains_deployment {
        let end_available = !evidence.contains_managed_deployment;
        conditions.push(RelationGovernanceActionCondition {
            action: RelationGovernanceAction::EndRelationship,
            available: end_available,
            reasons: if end_available {
                Vec::new()
            } else {
                vec![RelationGovernanceReason::ManagedEntryRequiresVerifiedRemoval]
            },
        });
    }
    if evidence.contains_retained_source_copy {
        conditions.push(RelationGovernanceActionCondition {
            action: RelationGovernanceAction::RevokeRetention,
            available: true,
            reasons: Vec::new(),
        });
    }

    match fact {
        GovernableRelationFact::SourceCopy(_) => {
            if primary_action != RelationGovernanceAction::None {
                conditions.push(RelationGovernanceActionCondition {
                    action: primary_action,
                    available: true,
                    reasons: Vec::new(),
                });
            }
        }
        GovernableRelationFact::Deployment(relation) => {
            if primary_action == RelationGovernanceAction::Revalidate
                && blockers.iter().any(|blocker| {
                    *blocker != RelationGovernanceBlocker::SharedImpactConfirmationRequired
                })
            {
                conditions.push(RelationGovernanceActionCondition {
                    action: RelationGovernanceAction::Revalidate,
                    available: true,
                    reasons: Vec::new(),
                });
            }

            if management_status == RelationManagementStatus::TakenOver {
                if relation.relationship == RelationshipType::ManagedLink
                    && relation.ownership == OwnershipState::SkillhubManaged
                {
                    conditions.push(RelationGovernanceActionCondition {
                        action: RelationGovernanceAction::Undeploy,
                        available: true,
                        reasons: Vec::new(),
                    });
                }
                return conditions;
            }

            let reasons = if !health_reasons.is_empty() {
                health_reasons.to_vec()
            } else {
                // 不可校验表示与不可转换关系都会落到同一个用户原因上；
                // 同一原因只呈现一次。
                let mut reasons = blockers
                    .iter()
                    .map(|blocker| match blocker {
                        RelationGovernanceBlocker::VerificationNotCurrent
                        | RelationGovernanceBlocker::DirectoryRecognitionUnknown => {
                            RelationGovernanceReason::VerificationRequired
                        }
                        RelationGovernanceBlocker::SharedImpactConfirmationRequired => {
                            RelationGovernanceReason::SharedImpactConfirmationRequired
                        }
                        RelationGovernanceBlocker::SkillIdentityUnconfirmed => {
                            RelationGovernanceReason::TargetIdentityUnconfirmed
                        }
                        _ => RelationGovernanceReason::RelationshipNotConvertible,
                    })
                    .collect::<Vec<_>>();
                sort_dedup_reasons(&mut reasons);
                reasons
            };
            conditions.push(RelationGovernanceActionCondition {
                action: RelationGovernanceAction::CentralizeManagement,
                available: reasons.is_empty(),
                reasons,
            });
        }
    }

    conditions
}

#[derive(Clone, Copy, Debug, Default)]
struct GovernanceActionEvidence {
    contains_source_copy: bool,
    contains_deployment: bool,
    contains_managed_deployment: bool,
    contains_retained_source_copy: bool,
}

impl GovernanceActionEvidence {
    fn for_fact(fact: &GovernableRelationFact) -> Self {
        match fact {
            GovernableRelationFact::SourceCopy(copy) => Self {
                contains_source_copy: true,
                contains_deployment: false,
                contains_managed_deployment: false,
                contains_retained_source_copy: copy.decision == SourceCopyDecision::Retained,
            },
            GovernableRelationFact::Deployment(relation) => Self {
                contains_source_copy: false,
                contains_deployment: true,
                contains_managed_deployment: relation.ownership == OwnershipState::SkillhubManaged,
                contains_retained_source_copy: false,
            },
        }
    }

    fn merge(self, other: Self) -> Self {
        Self {
            contains_source_copy: self.contains_source_copy || other.contains_source_copy,
            contains_deployment: self.contains_deployment || other.contains_deployment,
            contains_managed_deployment: self.contains_managed_deployment
                || other.contains_managed_deployment,
            contains_retained_source_copy: self.contains_retained_source_copy
                || other.contains_retained_source_copy,
        }
    }
}

fn merge_rows_for_same_target(rows: Vec<RelationGovernanceRow>) -> Vec<RelationGovernanceRow> {
    let mut merged: Vec<RelationGovernanceRow> = Vec::new();
    let mut action_evidence = Vec::new();
    for mut row in rows {
        let row_action_evidence = GovernanceActionEvidence::for_fact(&row.relation);
        let Some(identity) = row.target_identity.as_ref() else {
            merged.push(row);
            action_evidence.push(row_action_evidence);
            continue;
        };
        let Some(existing_index) = merged
            .iter()
            .position(|existing| existing.target_identity.as_ref() == Some(identity))
        else {
            merged.push(row);
            action_evidence.push(row_action_evidence);
            continue;
        };
        let existing = &mut merged[existing_index];
        let merged_action_evidence = action_evidence[existing_index].merge(row_action_evidence);
        let mut evidence = existing.evidence_relation_ids.clone();
        evidence.append(&mut row.evidence_relation_ids);
        evidence.sort();
        evidence.dedup();

        // Deployment facts are the executable representative when a source
        // copy and deployment describe the same verified physical target.
        let replace_representative = existing.deployment().is_none() && row.deployment().is_some();
        let retained_decision = [existing.governance.decision, row.governance.decision]
            .contains(&RelationGovernanceDecision::RetainedIndependentCopy);
        let taken_over = [
            existing.governance.management_status,
            row.governance.management_status,
        ]
        .contains(&RelationManagementStatus::TakenOver);
        let mut reasons = existing.governance.health_reasons.clone();
        reasons.extend(row.governance.health_reasons.iter().copied());
        reasons.sort_by_key(|reason| *reason as u8);
        reasons.dedup();
        let decision = if taken_over {
            RelationGovernanceDecision::Undecided
        } else if retained_decision {
            RelationGovernanceDecision::RetainedIndependentCopy
        } else {
            RelationGovernanceDecision::Undecided
        };
        let management_status = if taken_over {
            RelationManagementStatus::TakenOver
        } else {
            RelationManagementStatus::NotTakenOver
        };
        let governance_status = if reasons.is_empty()
            && (management_status == RelationManagementStatus::TakenOver
                || decision == RelationGovernanceDecision::RetainedIndependentCopy)
        {
            RelationGovernanceClassification::Completed
        } else {
            RelationGovernanceClassification::Pending
        };
        existing.governance.management_status = management_status;
        existing.governance.decision = decision;
        existing.governance.management_confirmed_at = existing
            .governance
            .management_confirmed_at
            .into_iter()
            .chain(row.governance.management_confirmed_at)
            .max();
        existing.governance.governance_status = governance_status;
        existing.governance.health_reasons = reasons;
        existing.governance.action_conditions = action_conditions(
            &existing.relation,
            existing.governance.management_status,
            existing.primary_action,
            &existing.blockers,
            &existing.governance.health_reasons,
            merged_action_evidence,
        );
        action_evidence[existing_index] = merged_action_evidence;
        existing.evidence_relation_ids = evidence;
        existing
            .impact
            .other_consumer_agent_ids
            .extend(row.impact.other_consumer_agent_ids);
        existing.impact.other_consumer_agent_ids.sort();
        existing.impact.other_consumer_agent_ids.dedup();
        if replace_representative {
            let evidence_relation_ids = existing.evidence_relation_ids.clone();
            let merged_consumers = existing.impact.other_consumer_agent_ids.clone();
            let mut governance = existing.governance.clone();
            governance.action_conditions = action_conditions(
                &row.relation,
                governance.management_status,
                row.primary_action,
                &row.blockers,
                &governance.health_reasons,
                merged_action_evidence,
            );
            row.governance = governance;
            row.evidence_relation_ids = evidence_relation_ids;
            row.impact.other_consumer_agent_ids = merged_consumers;
            merged[existing_index] = row;
        }
    }
    merged.sort_by(|left, right| left.relation_id().cmp(right.relation_id()));
    merged
}

/// FB-④（2026-10-06）：只读内置目录里的导入原件不是可转换的受管候选。
///
/// 命中只读集合的行改用只读事实分类：核验健康的原件视为已完成的保留；
/// 仍有健康异常的原件回到待处理并提供重新校验与结束关系两个出口——
/// 结束关系只清理观察记录，不删除只读目录里的用户文件，因此不受
/// 「受管条目须先验证移除」约束。
///
/// #10 第 1 项（2026-10-07 定稿）：导入原件（部署边 origin=import／关系
/// 类型=导入副本、未受管、活跃）不再要求命中「内置只读根」才享受第七类
/// 待遇——只读根路径判定漏掉的行（现场 150 条 doubao 行）不再卡死。命中
/// 只读根的行维持第七类完整改写（健康 → 只读终端卡；异常 → 记录出口）；
/// 未命中只读根的行：健康 → 投影时自动归「已完成（已保留副本）」，不再
/// 推回待处理；异常 → 维持待处理事实，重查与记录出口由受阻重查与未受管
/// 放行两条规则提供。障碍保留不动：转集中管理是否可用仍由真实事实决定。
fn apply_read_only_original_governance(
    rows: &mut [RelationGovernanceRow],
    facts: &[GovernableRelationFact],
    read_only_ids: &BTreeSet<String>,
) {
    if read_only_ids.is_empty() && !facts.iter().any(fact_is_import_original) {
        return;
    }
    for row in rows.iter_mut() {
        let has_read_only_evidence = row
            .evidence_relation_ids
            .iter()
            .any(|relation_id| read_only_ids.contains(relation_id));
        let has_import_original_evidence = row
            .deployment()
            .is_some_and(fact_is_import_original_edge);
        if !has_read_only_evidence && !has_import_original_evidence {
            continue;
        }
        let evidence_copies = facts
            .iter()
            .filter_map(|fact| match fact {
                GovernableRelationFact::SourceCopy(copy)
                    if row.evidence_relation_ids.contains(&copy.relation_id) =>
                {
                    Some(copy)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        // W2-2（FB-④）：部署侧 ImportCopy 行即使没有导入建档的副本事实
        // （来源记录缺失的旧行），也按第七类只读原件呈现。
        if evidence_copies.is_empty() && row.deployment().is_none() {
            continue;
        }
        if has_read_only_evidence {
            rewrite_read_only_original_row(row, &evidence_copies);
            continue;
        }
        // 未命中只读根的导入原件：健康 → 已完成·已保留副本；异常 →
        // 不覆盖健康证据之外的事实，交还给通用投影与行动作规则。
        let healthy = row.governance.health_reasons.is_empty()
            && evidence_copies
                .iter()
                .all(|copy| healthy_import_original(copy))
            && row.deployment().is_some_and(|relation| {
                relation.match_state == ObservedMatchState::ContentVerified
                    && relation
                        .health_reasons
                        .as_ref()
                        .is_some_and(|reasons| reasons.is_empty())
            });
        if !healthy {
            continue;
        }
        row.readiness = RelationGovernanceReadiness::AlreadyCentralized;
        row.primary_action = RelationGovernanceAction::None;
        row.governance.governance_status = RelationGovernanceClassification::Completed;
        if row.governance.management_status != RelationManagementStatus::TakenOver {
            row.status = GovernableRelationStatus::Retained;
            row.governance.decision = RelationGovernanceDecision::RetainedIndependentCopy;
        }
        // 依据完整证据重算动作条件：结束关系按未受管放行；转集中管理
        // 的可用性由保留的障碍如实决定；撤销保留跟随保留副本证据。
        let evidence_flags = facts
            .iter()
            .filter(|fact| match fact {
                GovernableRelationFact::SourceCopy(copy) => {
                    row.evidence_relation_ids.contains(&copy.relation_id)
                }
                GovernableRelationFact::Deployment(relation) => {
                    row.evidence_relation_ids.contains(&relation.relation_id)
                }
            })
            .fold(GovernanceActionEvidence::default(), |acc, fact| {
                acc.merge(GovernanceActionEvidence::for_fact(fact))
            });
        row.governance.action_conditions = action_conditions(
            &row.relation,
            row.governance.management_status,
            RelationGovernanceAction::None,
            &row.blockers,
            &row.governance.health_reasons,
            evidence_flags,
        );
    }
}

/// 只读原件的第七类完整改写：健康原件是权限边界内的正常终态（只读终端
/// 卡，无动作区、无受阻原因）；异常原件回到待处理并保证「重新检查 +
/// 结束关系记录」两个出口。
fn rewrite_read_only_original_row(
    row: &mut RelationGovernanceRow,
    evidence_copies: &[&SourceCopyRelationFact],
) {
    row.source_read_only = true;
    let all_copies_healthy = evidence_copies
        .iter()
        .all(|copy| healthy_import_original(copy));
    let healthy = all_copies_healthy && row.governance.health_reasons.is_empty();
    if healthy {
        row.blockers = Vec::new();
        row.readiness = RelationGovernanceReadiness::AlreadyCentralized;
        row.primary_action = RelationGovernanceAction::None;
        row.governance.action_conditions = Vec::new();
        row.governance.governance_status = RelationGovernanceClassification::Completed;
        if row.governance.management_status != RelationManagementStatus::TakenOver {
            row.status = GovernableRelationStatus::Retained;
            row.governance.decision = RelationGovernanceDecision::RetainedIndependentCopy;
        }
    } else {
        row.status = GovernableRelationStatus::NeedsValidation;
        row.blockers = Vec::new();
        row.readiness = RelationGovernanceReadiness::NeedsValidation;
        row.primary_action = RelationGovernanceAction::Revalidate;
        row.governance.governance_status = RelationGovernanceClassification::Pending;
        row.governance.action_conditions = vec![
            RelationGovernanceActionCondition {
                action: RelationGovernanceAction::Revalidate,
                available: true,
                reasons: Vec::new(),
            },
            RelationGovernanceActionCondition {
                action: RelationGovernanceAction::EndRelationship,
                available: true,
                reasons: Vec::new(),
            },
        ];
    }
}

fn fact_is_import_original(fact: &GovernableRelationFact) -> bool {
    match fact {
        GovernableRelationFact::Deployment(relation) => fact_is_import_original_edge(relation),
        GovernableRelationFact::SourceCopy(_) => false,
    }
}

/// #10 第 1 项：导入原件部署边判定——origin=import 或关系类型=导入副本、
/// 未受管、活跃。
fn fact_is_import_original_edge(relation: &DeploymentRelationFact) -> bool {
    relation.active
        && relation.ownership != OwnershipState::SkillhubManaged
        && (relation.origin == ObservedOrigin::Import
            || relation.relationship == RelationshipType::ImportCopy)
}

/// 健康原件判定：核验为 Normal 且没有任何健康异常（`None` 表示旧版
/// 未核验事实，不算健康，维持原有待处理呈现）。
fn healthy_import_original(copy: &SourceCopyRelationFact) -> bool {
    copy.health == SourceCopyHealth::Normal
        && copy
            .health_reasons
            .as_ref()
            .is_some_and(|reasons| reasons.is_empty())
}

fn status_count(rows: &[RelationGovernanceRow], status: GovernableRelationStatus) -> u32 {
    rows.iter().filter(|row| row.status == status).count() as u32
}

fn bucket_accepts_governance_actions(
    bucket: RelationGovernanceBucket,
    row: &RelationGovernanceRow,
) -> bool {
    match bucket {
        RelationGovernanceBucket::All => true,
        RelationGovernanceBucket::EligibleToCentralize => {
            row.governance.action_conditions.iter().any(|condition| {
                matches!(
                    condition.action,
                    RelationGovernanceAction::CentralizeManagement
                        | RelationGovernanceAction::KeepIndependentCopy
                ) && condition.available
            })
        }
        RelationGovernanceBucket::NeedsValidation => {
            // #10 第 3 项之后受阻行也带可用的重新检查；「待核验」桶仍只收
            // 真正处于待核验准备的行，受阻行留在受阻桶。
            row.governance.action_conditions.iter().any(|condition| {
                (condition.action == RelationGovernanceAction::Revalidate
                    && condition.available
                    && row.readiness != RelationGovernanceReadiness::Blocked)
                    || (condition.action == RelationGovernanceAction::CentralizeManagement
                        && !condition.available
                        && condition.reasons.iter().any(|reason| {
                            matches!(
                                reason,
                                RelationGovernanceReason::VerificationRequired
                                    | RelationGovernanceReason::SharedImpactConfirmationRequired
                            )
                        }))
            })
        }
        RelationGovernanceBucket::Blocked => {
            row.governance.action_conditions.iter().any(|condition| {
                condition.action == RelationGovernanceAction::CentralizeManagement
                    && !condition.available
                    && condition.reasons.iter().any(|reason| {
                        !matches!(
                            reason,
                            RelationGovernanceReason::VerificationRequired
                                | RelationGovernanceReason::SharedImpactConfirmationRequired
                        )
                    })
            })
        }
    }
}

/// Deployment edges carry no source-copy health, so their quick status is
/// derived from the edge's own evidence state.
fn deployment_status(relation: &DeploymentRelationFact) -> GovernableRelationStatus {
    match relation.match_state {
        ObservedMatchState::ContentVerified => GovernableRelationStatus::Normal,
        _ => GovernableRelationStatus::NeedsValidation,
    }
}

/// 来源副本的可行动作只覆盖当前已有执行实现的命令（plan 7.4）。
fn source_copy_action(
    copy: &SourceCopyRelationFact,
    status: GovernableRelationStatus,
) -> RelationGovernanceAction {
    match status {
        GovernableRelationStatus::NeedsValidation | GovernableRelationStatus::NeedsAttention => {
            RelationGovernanceAction::Revalidate
        }
        GovernableRelationStatus::Normal => {
            if copy.decision == SourceCopyDecision::Pending {
                RelationGovernanceAction::KeepIndependentCopy
            } else {
                RelationGovernanceAction::None
            }
        }
        GovernableRelationStatus::Retained | GovernableRelationStatus::Blocked => {
            RelationGovernanceAction::None
        }
    }
}

/// 旧深链 bucket 到新五状态的等价映射（plan 7.11）；空集合表示不过滤。
pub fn legacy_bucket_statuses(bucket: RelationGovernanceBucket) -> Vec<GovernableRelationStatus> {
    match bucket {
        RelationGovernanceBucket::All => Vec::new(),
        RelationGovernanceBucket::EligibleToCentralize => vec![GovernableRelationStatus::Normal],
        RelationGovernanceBucket::NeedsValidation => {
            vec![GovernableRelationStatus::NeedsValidation]
        }
        RelationGovernanceBucket::Blocked => vec![GovernableRelationStatus::Blocked],
    }
}

fn readiness_for(
    relation: &DeploymentRelationFact,
    blockers: &[RelationGovernanceBlocker],
) -> RelationGovernanceReadiness {
    // Already a link: the centralized form.  It is never "eligible to
    // centralize" and it never silently disappears from the ledger either —
    // it stays visible under the `all` filter with a removal action.
    if matches!(
        relation.relationship,
        RelationshipType::ManagedLink | RelationshipType::ObservedLink
    ) {
        return RelationGovernanceReadiness::AlreadyCentralized;
    }
    if blockers.iter().any(|blocker| blocker.is_hard_block()) {
        return RelationGovernanceReadiness::Blocked;
    }
    if blockers.is_empty() {
        return RelationGovernanceReadiness::EligibleToCentralize;
    }
    RelationGovernanceReadiness::NeedsValidation
}

impl RelationGovernanceBlocker {
    /// A hard block cannot be cleared by re-checking; it needs the underlying
    /// fact to change.
    pub const fn is_hard_block(self) -> bool {
        matches!(
            self,
            Self::UnverifiableRepresentation
                | Self::RelationshipNotConvertible
                | Self::SharedBodyProtected
                | Self::DirectoryNotRegistered
                | Self::DirectoryRecognitionUnsupported
                | Self::SkillIdentityUnconfirmed
        )
    }
}

fn primary_action_for(
    relation: &DeploymentRelationFact,
    readiness: RelationGovernanceReadiness,
) -> RelationGovernanceAction {
    match readiness {
        RelationGovernanceReadiness::EligibleToCentralize => {
            RelationGovernanceAction::CentralizeManagement
        }
        RelationGovernanceReadiness::NeedsValidation => RelationGovernanceAction::Revalidate,
        // #10 第 3 项（2026-10-07 定稿）：受阻行不再零操作——「重新检查」
        // 是可用的行级动作（RunRelationshipCheck，仅人工触发；自动路径是
        // 扫描时的关系再推导）。
        RelationGovernanceReadiness::Blocked => RelationGovernanceAction::Revalidate,
        // Only an entry SkillHub created may be removed by the undeploy flow;
        // a foreign entry is left alone rather than offered as a one-click
        // target.
        RelationGovernanceReadiness::AlreadyCentralized => {
            if relation.ownership == OwnershipState::SkillhubManaged {
                RelationGovernanceAction::Undeploy
            } else {
                RelationGovernanceAction::None
            }
        }
    }
}

fn blockers_for(
    relation: &DeploymentRelationFact,
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    impact: &RemovalImpactFact,
) -> Vec<RelationGovernanceBlocker> {
    let mut blockers = Vec::new();

    // 1. Identity and representation: what the entry physically is.
    if relation.skill_id.is_none() || relation.content_fingerprint.trim().is_empty() {
        blockers.push(RelationGovernanceBlocker::SkillIdentityUnconfirmed);
    }
    if matches!(
        relation.file_representation,
        FileRepresentation::DirectoryJunction | FileRepresentation::Unknown
    ) {
        blockers.push(RelationGovernanceBlocker::UnverifiableRepresentation);
    }

    // 2. Relationship type: which conversions actually exist.  This mirrors
    //    `plan_relation_conversion`, which accepts copies, links, a
    //    shared-directory *reference* and (FB-④, W2-2) import copies in
    //    writable directories.  Read-only import originals are rewritten by
    //    the read-only post-processor, so this blocker never reaches them.
    match relation.relationship {
        RelationshipType::SharedDirectoryRead => {
            blockers.push(RelationGovernanceBlocker::SharedBodyProtected);
        }
        RelationshipType::ObservedCopy
        | RelationshipType::ManagedCopy
        | RelationshipType::ObservedLink
        | RelationshipType::ManagedLink
        | RelationshipType::SharedDirectoryReference
        | RelationshipType::ImportCopy => {}
        RelationshipType::Unknown => {
            blockers.push(RelationGovernanceBlocker::RelationshipNotConvertible);
        }
    }

    // 3. Directory registration and recognition.
    match relation.directory_node_id.as_deref() {
        None => blockers.push(RelationGovernanceBlocker::DirectoryNotRegistered),
        Some(directory_node_id) => {
            match capability_recognition(
                directory_capabilities,
                &relation.agent_client_id,
                directory_node_id,
            ) {
                DirectoryRecognition::Supported => {}
                DirectoryRecognition::Unknown => {
                    blockers.push(RelationGovernanceBlocker::DirectoryRecognitionUnknown);
                }
                DirectoryRecognition::Unsupported => {
                    blockers.push(RelationGovernanceBlocker::DirectoryRecognitionUnsupported);
                }
            }
        }
    }

    // 4. Evidence freshness.
    if relation.match_state != ObservedMatchState::ContentVerified {
        blockers.push(RelationGovernanceBlocker::VerificationNotCurrent);
    }

    // 5. Shared impact: another agent reads the same shared directory, so the
    //    conversion must be explicitly confirmed instead of assumed safe.
    if !impact.other_consumers.is_empty() {
        blockers.push(RelationGovernanceBlocker::SharedImpactConfirmationRequired);
    }

    blockers
}

fn capability_recognition(
    capabilities: &[AgentDirectoryCapabilityFact],
    agent_client_id: &str,
    directory_node_id: &str,
) -> DirectoryRecognition {
    capabilities
        .iter()
        .find(|capability| {
            capability.agent_client_id == agent_client_id
                && capability.directory_node_id == directory_node_id
        })
        .map(|capability| capability.recognition)
        .unwrap_or(DirectoryRecognition::Unknown)
}
