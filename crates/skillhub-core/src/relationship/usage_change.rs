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
    Manage,
    Sync,
    Repair,
    Restore,
    ResolveDuplicate,
    MigrateSharedUsage,
    RenameSubject,
    DeriveAndReplace,
}

/// One managed target whose directory entry will move when a skill subject is
/// renamed. Paths are descriptive preview facts; commit resolves them again
/// from the stored deployment and target records.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SubjectRenameTargetPreview {
    pub deployment_id: String,
    pub target_id: String,
    pub previous_path: String,
    pub path: String,
    pub mode: crate::deployment::DeploymentMode,
}

/// Complete impact snapshot for an explicit, subject-wide runtime rename.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SubjectRenamePreview {
    pub skill_id: SkillId,
    pub previous_runtime_name: String,
    pub runtime_name: String,
    pub targets: Vec<SubjectRenameTargetPreview>,
}

/// One explicitly selected managed relation affected by a local derived rename.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DerivedRenameTargetPreview {
    pub relation_id: String,
    pub deployment_id: String,
    pub previous_path: String,
    pub replacement_path: String,
    pub requires_shared_target_confirmation: bool,
    pub blocker: Option<String>,
}

/// Frozen source and target scope for creating a locally renamed independent subject.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DerivedRenamePreview {
    pub source_skill_id: SkillId,
    pub base_version_id: VersionId,
    pub runtime_name: String,
    pub selected_relation_ids: Vec<String>,
    pub targets: Vec<DerivedRenameTargetPreview>,
}

/// The verified environmental issue and the exact user selection frozen into
/// a duplicate-cleanup preview. The application still re-scans these facts at
/// commit time before touching files.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DuplicateCleanupPreview {
    pub problem: super::EnvironmentProblemView,
    pub retain_entry_key: UsageEntryKey,
    pub selected_entry_keys: Vec<UsageEntryKey>,
    pub non_recognized_destination: Option<String>,
}

/// A complete replacement plan for one consumer of a shared skill entry.
/// `target_ids` are resolved by the application from registered Agent/project
/// targets; callers cannot supply destination paths or remove consumers.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SharedUsageReplacement {
    pub environment: super::UsageEnvironmentKey,
    pub target_ids: Vec<String>,
    pub form: Option<UsageForm>,
    pub reused_existing: bool,
    pub relationship_revision: String,
}

/// Verified, backend-owned impact snapshot for moving a shared entry to direct
/// Agent/project deployments.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SharedUsageMigrationPreview {
    pub problem: super::EnvironmentProblemView,
    pub replacements: Vec<SharedUsageReplacement>,
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
    ManageLink,
    ManageCopy,
    Synchronize,
    Repair,
    Restore,
    RenameSubject,
    DeriveAndReplace,
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
    #[serde(default)]
    pub duplicate_cleanup: Option<DuplicateCleanupPreview>,
    #[serde(default)]
    pub shared_usage_migration: Option<SharedUsageMigrationPreview>,
    #[serde(default)]
    pub subject_rename: Option<SubjectRenamePreview>,
    #[serde(default)]
    pub derived_rename: Option<DerivedRenamePreview>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageChangeResult {
    pub operation_id: OperationId,
    pub prepared_id: OperationId,
    pub item_results: Vec<UsageChangeItemResult>,
    pub recovery_required: bool,
    #[serde(default)]
    pub derived_skill_id: Option<SkillId>,
    #[serde(default)]
    pub recovery_operation_id: Option<OperationId>,
}
