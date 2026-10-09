//! Shared contract for preparing and committing a change to a usage relation.

use serde::{Deserialize, Serialize};

use crate::agent::AgentDirectoryRole;
use crate::relationship::{
    FileRepresentation, UsageEntryKey, UsageForm, UsageHealthReason, UsageManagement,
    UsageRelationTarget,
};
use crate::{OperationId, SkillId, VersionId};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageChangeAction {
    Release,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageCopyDisposition {
    KeepIndependent,
    RemoveWithBackup,
}

/// Shared input type reserved for the later Manage task. Release requires it
/// to be absent and rejects any supplied value.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageContentBasis {
    LibraryCurrent,
    OriginalEntry,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageSubjectVersion {
    pub skill_id: SkillId,
    pub version_id: Option<VersionId>,
}

/// Durable user decision for one skill and one confirmed usage-entry identity.
/// Storage repositories own the transaction semantics; this shared type is
/// also used by application history queries and generated clients.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageDecisionRecord {
    pub decision_id: String,
    pub skill_id: SkillId,
    pub entry_key: UsageEntryKey,
    pub relation_ids: Vec<String>,
    pub physical_source_ids: Vec<String>,
    pub decision: super::UsageDecision,
    pub content_fingerprint: Option<String>,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub decided_at: i64,
    pub operation_id: Option<String>,
}

/// File and identity facts frozen into the preview. Paths are descriptive
/// evidence; commit never accepts a path from its caller.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEntryEvidence {
    pub skill_id: SkillId,
    pub entry_key: UsageEntryKey,
    pub relation_ids: Vec<String>,
    pub physical_source_ids: Vec<String>,
    pub path: String,
    pub directory_role: Option<AgentDirectoryRole>,
    pub form: Option<UsageForm>,
    pub management: UsageManagement,
    pub representation: FileRepresentation,
    pub content_fingerprint: Option<String>,
    pub physical_identity: Option<String>,
    pub link_target_path: Option<String>,
    pub exists: bool,
}

/// A consumer included in the full impact snapshot. One item can summarize
/// multiple source rows that identify the same canonical entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageChangeConsumer {
    pub relation_ids: Vec<String>,
    pub skill_id: Option<SkillId>,
    pub entry_key: Option<UsageEntryKey>,
    pub target: UsageRelationTarget,
    pub path: Option<String>,
    pub form: Option<UsageForm>,
    pub management: UsageManagement,
    pub representation: FileRepresentation,
    pub health_reasons: Vec<UsageHealthReason>,
    pub physical_source_ids: Vec<String>,
    pub content_fingerprint: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageChangeImpactAction {
    RemoveLink,
    KeepIndependentCopy,
    RemoveCopyWithBackup,
    RecordOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageChangeImpact {
    pub relation_ids: Vec<String>,
    pub skill_id: SkillId,
    pub target: UsageRelationTarget,
    pub action: UsageChangeImpactAction,
    pub description: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageChangeItemStatus {
    Applied,
    Failed,
    RecoveryRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageRecoveryPoint {
    pub path: String,
    pub fingerprint: Option<String>,
    pub representation: FileRepresentation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageChangeItemResult {
    pub relation_ids: Vec<String>,
    pub skill_id: SkillId,
    pub target: UsageRelationTarget,
    pub action: UsageChangeImpactAction,
    pub status: UsageChangeItemStatus,
    pub reason: Option<String>,
    pub recovery_point: Option<UsageRecoveryPoint>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PreparedUsageChange {
    pub operation_id: OperationId,
    pub prepared_id: OperationId,
    pub action: UsageChangeAction,
    pub relationship_revision: String,
    pub affected_skill_ids: Vec<SkillId>,
    pub subject_versions: Vec<UsageSubjectVersion>,
    pub entry_evidence: Vec<UsageEntryEvidence>,
    pub consumers: Vec<UsageChangeConsumer>,
    pub impacts: Vec<UsageChangeImpact>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageChangeResult {
    pub operation_id: OperationId,
    pub prepared_id: OperationId,
    pub item_results: Vec<UsageChangeItemResult>,
    pub recovery_required: bool,
}
