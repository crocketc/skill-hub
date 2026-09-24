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
//! Readiness is deliberately narrower than "the migration command would accept
//! this edge": links are already the centralized form, so they are reported as
//! `AlreadyCentralized` and never enter the eligible bucket.  The migration
//! command remains the authority for a single explicit conversion.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::source_copy::{SourceCopyDecision, SourceCopyHealth, SourceCopyRelationFact};
use crate::deployment::{DeploymentRelationFact, ObservedMatchState};
use crate::relationship::{
    calculate_removal_impact, AgentDirectoryCapabilityFact, DirectoryRecognition,
    FileRepresentation, OwnershipState, RelatedSkillPath, RelationshipType, RemovalFacts,
    RemovalImpactFact,
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
    /// Already a managed/observed link, so there is nothing to centralize.
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
    /// 受阻或无适用动作。
    None,
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

/// One relationship edge, ready for display and for batch selection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceRow {
    /// 对象、关系类型、目标路径、存证与验证状态的唯一事实来源。
    pub relation: DeploymentRelationFact,
    pub skill_display_name: Option<String>,
    pub readiness: RelationGovernanceReadiness,
    pub primary_action: RelationGovernanceAction,
    pub blockers: Vec<RelationGovernanceBlocker>,
    pub impact: RelationGovernanceImpact,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub struct RelationGovernanceCounts {
    pub all: u32,
    pub eligible_to_centralize: u32,
    pub needs_validation: u32,
    pub blocked: u32,
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
    let facts = RemovalFacts::new(relations.to_vec(), directory_capabilities.to_vec());
    let mut rows = relations
        .iter()
        .filter(|relation| relation.active && relation.released_at.is_none())
        .map(|relation| {
            let impact = calculate_removal_impact(&relation.relation_id, &facts);
            let blockers = blockers_for(relation, directory_capabilities, &impact);
            let readiness = readiness_for(relation, &blockers);
            RelationGovernanceRow {
                relation: relation.clone(),
                skill_display_name: relation.skill_id.and_then(|skill_id| {
                    names
                        .iter()
                        .find(|(candidate, _)| *candidate == skill_id)
                        .map(|(_, name)| name.clone())
                }),
                readiness,
                primary_action: primary_action_for(relation, readiness),
                blockers,
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
            }
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| left.relation.relation_id.cmp(&right.relation.relation_id));

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
    };

    let text = filters.text.trim().to_lowercase();
    let selected = rows
        .into_iter()
        .filter(|row| filters.bucket.accepts(row.readiness))
        .filter(|row| {
            filters
                .skill_id
                .is_none_or(|skill_id| row.relation.skill_id == Some(skill_id))
        })
        .filter(|row| {
            filters
                .agent_client_id
                .as_ref()
                .is_none_or(|agent| &row.relation.agent_client_id == agent)
        })
        .filter(|row| {
            filters.relationship_types.is_empty()
                || filters
                    .relationship_types
                    .contains(&row.relation.relationship)
        })
        .filter(|row| {
            text.is_empty()
                || row.relation.path.to_lowercase().contains(text.as_str())
                || row
                    .relation
                    .link_target_path
                    .as_deref()
                    .is_some_and(|target| target.to_lowercase().contains(text.as_str()))
                || row
                    .relation
                    .agent_client_id
                    .to_lowercase()
                    .contains(text.as_str())
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
        RelationGovernanceReadiness::Blocked => RelationGovernanceAction::None,
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
    //    `plan_relation_conversion`, which only accepts copies, links and a
    //    shared-directory *reference* — a direct shared read has no per-agent
    //    entry to replace and would have to rewrite the shared body.
    match relation.relationship {
        RelationshipType::SharedDirectoryRead => {
            blockers.push(RelationGovernanceBlocker::SharedBodyProtected);
        }
        RelationshipType::ObservedCopy
        | RelationshipType::ManagedCopy
        | RelationshipType::ObservedLink
        | RelationshipType::ManagedLink
        | RelationshipType::SharedDirectoryReference => {}
        RelationshipType::Unknown | RelationshipType::ImportCopy => {
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
