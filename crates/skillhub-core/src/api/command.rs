use serde::{Deserialize, Serialize};

use crate::agent::{CustomAgent, CustomAgentDraft, CustomAgentOverride, PathGrant};
use crate::app_update::{
    ApplicationUpdate, DownloadedApplicationUpdate, OpenOfficialRelease, PreparedApplicationUpdate,
    SetApplicationUpdatePolicy, UpdateArtifact, UpdateManifest, UpdatePlatform, UpdateState,
};
use crate::backup::{
    BackupCreated, BackupManifest, BackupPlan, BackupRetentionPolicy, BackupRetentionResult,
    BackupScope, RestoreConflictDecision, RestorePlan, RestoreResult, SensitiveContentDecision,
};
use crate::catalog::SkillLifecycle;
use crate::check::{CheckKind, FindingDisposition};
use crate::export::{
    ExportDecision, ExportInput, ExportPlan, ExportResult, UninstallAction, UninstallImpact,
};
pub use crate::external_link::OpenExternalUrl;
use crate::import::{ImportCandidate, ImportDecision};
use crate::llm::search_query::SearchQuerySuggestion;
use crate::llm::translation::TranslationResult;
use crate::project::{AssemblyPlan, Project, SavedProjectView, SharedProjectConfig};
use crate::scan::ScanResult;
use crate::source::{SourceDescriptor, UpdateDecision};
use crate::{
    DeploymentId, ErrorCode, InitializationStatus, OperationId, OperationSummary, ProjectId,
    SkillId, VersionId,
};

use super::query::{BasicCheckResult, CombinationResult, LlmSafetyCheckResult};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct CreateSkill {
    pub name: String,
    pub source_path: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SaveSkillContent {
    pub skill_id: SkillId,
    pub source_path: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SaveMarkdownContent {
    pub skill_id: SkillId,
    pub path: String,
    pub markdown: String,
    pub expected_identity: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SaveMarkdownAsCopy {
    pub skill_id: SkillId,
    pub path: String,
    pub markdown: String,
    pub expected_identity: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct RenameSkill {
    pub skill_id: SkillId,
    pub name: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SetLifecycle {
    pub skill_id: SkillId,
    pub lifecycle: SkillLifecycle,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SetMetadata {
    pub skill_id: SkillId,
    pub display_name: Option<String>,
    pub note: Option<String>,
    pub tags: Vec<String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub user_purpose: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SetTrial {
    pub skill_id: SkillId,
    pub due: Option<(i32, u8, u8)>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct CreateCombination {
    pub name: String,
    pub members: Vec<SkillId>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct UpdateCombination {
    pub name: String,
    pub members: Vec<SkillId>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DeleteCombination {
    pub name: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct RenameCombination {
    pub from: String,
    pub to: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SetCurrentVersion {
    pub skill_id: SkillId,
    pub version_id: VersionId,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PinProjectSkillVersion {
    pub project_id: ProjectId,
    pub skill_id: SkillId,
    pub version_id: VersionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct CreateCustomAgent {
    pub agent: CustomAgentDraft,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct UpdateCustomAgent {
    pub agent: CustomAgentDraft,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct RemoveCustomAgent {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ResetProfileOverride {
    pub profile_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SetProfileOverride {
    pub profile_id: String,
    pub directory: PathGrant,
    pub profile: crate::agent::AgentProfile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct RegisterProject {
    pub project: Project,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct UpdateProject {
    pub project: Project,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SetProjectTags {
    pub project_id: ProjectId,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareApplicationUpdate {
    pub current_version: String,
    pub manifest: UpdateManifest,
    pub platform: UpdatePlatform,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DownloadApplicationUpdate {
    pub artifact: UpdateArtifact,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct InstallApplicationUpdate;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct RollbackApplicationUpdate;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SaveProjectView {
    pub view: SavedProjectView,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct WriteSharedProjectConfig {
    pub project_id: ProjectId,
    pub config: SharedProjectConfig,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ReadSharedProjectConfig {
    pub project_id: ProjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PrepareProjectAssembly {
    pub project_id: ProjectId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct CommitProjectAssembly {
    pub plan: AssemblyPlan,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareImport {
    pub candidate: ImportCandidate,
    pub tree_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitImport {
    pub prepared_import_id: OperationId,
    pub decision: ImportDecision,
    #[serde(default)]
    pub governance_decision: crate::import::ImportGovernanceDecision,
    /// 本次导入向导会话的批次；缺省时应用层派生隐式批次，事实写入不变。
    #[serde(default)]
    pub batch_id: Option<String>,
    /// 稳定的候选键（acquisition identity + normalized relative root）；
    /// 缺省时由应用层从来源与相对根派生，绝不使用显示名。
    #[serde(default)]
    pub candidate_key: Option<String>,
}

/// 打开一个导入批次；返回的 batch_id 由同一向导会话的所有提交共享。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BeginImportBatch {}

/// 终结导入批次。幂等：重复终结返回相同的 manageable_source_count。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct FinalizeImportBatch {
    pub batch_id: String,
}

/// 查询仍在进行中的导入批次（进程重启后可继续或标记放弃）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct QueryOpenImportBatch {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatchStarted {
    pub batch_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportBatchFinalized {
    pub batch_id: String,
    /// 有活动来源副本关系的成功项数量；由持久化映射计算，不信任前端汇总。
    /// 跨 IPC 以字符串承载（与 epoch 计数同一裁决，见 `crate::i64_string`）。
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub manageable_source_count: i64,
}

/// 一个仍在进行中的导入批次。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OpenImportBatch {
    pub batch_id: String,
    /// 批次开始时间（epoch 秒；跨 IPC 以字符串承载，见 `crate::i64_string`）。
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub started_at: i64,
}

/// OPT-20260914-08：原始文件迁移的准备请求。准备只读地核验存证、路径
/// 与冲突，绝不触碰用户文件；与扫描/导入完全解耦。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareOriginalMigration {
    pub skill_id: SkillId,
}

/// OPT-20260914-08：原始文件迁移的提交请求。`ownership_confirmed` 是
/// 硬门槛：必须由用户在界面上显式确认，缺省/未确认一律拒绝执行。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitOriginalMigration {
    pub prepared_migration_id: OperationId,
    pub ownership_confirmed: bool,
}

/// OPT-20260914-08：用备份恢复已迁移的原始目录。记录本身保留审计痕迹。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RollbackOriginalMigration {
    pub migration_id: OperationId,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationMigrationTargetMode {
    ManagedLink,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipMigrationBackupPolicy {
    Required,
}

/// Relationship conversion is intentionally a separate command family from
/// `original_migration`: it never authorizes deleting the user's original
/// source directory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareRelationMigration {
    pub relation_id: String,
    pub target_mode: RelationMigrationTargetMode,
    pub backup_policy: RelationshipMigrationBackupPolicy,
    pub confirmation_token: Option<String>,
}

pub type RelationMigrationInput = PrepareRelationMigration;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitRelationMigration {
    pub prepared_relation_migration_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RollbackRelationMigration {
    pub operation_id: OperationId,
}

/// Which governance change a batch applies to every selected relationship
/// edge.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceBatchAction {
    /// 用户术语「纳入集中库管理」：复用 required-backup ManagedLink 的
    /// prepare/commit/rollback 四段安全链路。
    CentralizeManagement,
}

/// 批次准备：每条关系边各自 prepare、备份、校验与确认。
///
/// `confirmations` 逐项携带共享影响确认令牌；缺失即视为未确认，该行会被
/// 如实报为受阻，而不是替用户默认同意。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareRelationGovernanceBatch {
    pub action: RelationGovernanceBatchAction,
    pub relation_ids: Vec<String>,
    #[serde(default)]
    pub confirmations: std::collections::BTreeMap<String, String>,
}

/// 批次提交：`relation_ids` 是用户在预览后仍保留的行。批次内已准备但未列出
/// 的行按「取消」处理，不改动任何文件，也不影响其余行。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitRelationGovernanceBatch {
    pub batch_id: OperationId,
    pub relation_ids: Vec<String>,
}

/// 批次回退：逐项回退已提交的子项，失败项保留其余成功项。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RollbackRelationGovernanceBatch {
    pub batch_id: OperationId,
    pub relation_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceBatchItemState {
    Prepared,
    Committed,
    RolledBack,
    Failed,
    /// 准备阶段就按事实判定为不可执行，未触碰文件系统。
    Blocked,
    /// 用户在预览后取消该行；其余行不受影响。
    Cancelled,
}

/// One child item of a governance batch.  `operation_id` is the child
/// operation, so the parent operation log can be followed to each item.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceBatchItem {
    pub relation_id: String,
    pub operation_id: Option<OperationId>,
    pub state: RelationGovernanceBatchItemState,
    pub error_code: Option<ErrorCode>,
    pub detail: Option<String>,
    /// 用户可对该行单独重试。
    pub retryable: bool,
    pub rollback_available: bool,
    pub backup_path: Option<String>,
    pub affected_paths: Vec<String>,
    pub blockers: Vec<crate::relationship::RelationGovernanceBlocker>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationGovernanceBatchState {
    Prepared,
    Committed,
    /// 部分成功：成功项保留，失败项逐项可重试或回退。
    PartiallyCommitted,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationGovernanceBatchOutcome {
    pub batch_id: OperationId,
    pub action: RelationGovernanceBatchAction,
    pub state: RelationGovernanceBatchState,
    pub items: Vec<RelationGovernanceBatchItem>,
    pub prepared_count: u32,
    pub committed_count: u32,
    pub failed_count: u32,
    pub blocked_count: u32,
    pub cancelled_count: u32,
    pub relationship_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelinkSource {
    pub skill_id: SkillId,
    pub source: SourceDescriptor,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CheckSourceUpdate {
    pub skill_id: SkillId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ApplySourceUpdate {
    pub skill_id: SkillId,
    pub decision: UpdateDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareDeployment {
    pub plan: crate::deployment::DeploymentPlan,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitDeployment {
    pub prepared_deployment_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CollectDeploymentChanges {
    pub deployment_id: crate::DeploymentId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RestoreDeployment {
    pub deployment_id: crate::DeploymentId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct KeepIndependentCopy {
    pub deployment_id: crate::DeploymentId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct IgnoreExternalChange {
    pub deployment_id: crate::DeploymentId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareUndeploy {
    pub deployment_id: crate::DeploymentId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitUndeploy {
    pub prepared_undeploy_id: OperationId,
    pub decision: crate::RemovalDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareDeleteSkill {
    pub skill_id: SkillId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitDeleteSkill {
    pub prepared_delete_id: OperationId,
    pub decisions: Vec<crate::RemovalChoice>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DetachManagement {
    pub deployment_id: crate::DeploymentId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct RunHealthCheck;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareRepair {
    pub health_report_id: OperationId,
    pub finding_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitRepair {
    pub repair_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ResolveRecovery {
    pub operation_id: OperationId,
    pub action: crate::RecoveryAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareCallPolicyChange {
    pub skill_id: SkillId,
    pub policy: crate::catalog::CallPolicy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitCallPolicyChange {
    pub plan_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RestoreOriginalCallPolicy {
    pub skill_id: SkillId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CreateIgnoreRule {
    pub subject: crate::IgnoreSubject,
    pub reason: String,
    pub defer_until: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemoveIgnoreRule {
    pub rule_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RunLlmSafetyCheck {
    pub skill_id: SkillId,
    pub version_id: VersionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RecheckLlmSafety {
    pub skill_id: SkillId,
    pub version_id: VersionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AnalyzeSemanticDuplicates {
    pub skill_id: SkillId,
}

/// Task 8: optional, user-initiated AI conflict analysis over deterministic
/// conflict groups. The result is advisory; it never writes a user decision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AnalyzeConflict {
    pub scope: crate::duplicate::AnalyzeConflictScope,
}

/// One explicit user decision on a pending `uncertain` conflict. Only a
/// conclusion-writing decision closes the conflict; 「纳入集中库管理」 answers
/// with a governance preview intent and never touches a file here.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ResolveConflictCase {
    pub conflict_id: String,
    pub decision: crate::relationship::ConflictDecision,
    /// Relationship fact revision the workspace was read from. A decision taken
    /// on stale facts is refused instead of silently applied.
    pub expected_relationship_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TranslateDescription {
    pub skill_id: SkillId,
    pub language: String,
    /// Only an explicit user confirmation may replace a stored revision
    /// (requirement 5.35); the default keeps revisions refusal-protected.
    #[serde(default)]
    pub overwrite_user_revision: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SaveUserTranslationRevision {
    pub skill_id: SkillId,
    pub language: String,
    pub source_description_hash: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GenerateOnlineSearchQuery {
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TranslateDescriptionsBatch {
    pub skill_ids: Vec<SkillId>,
    pub language: String,
}

/// One failed item of a batch translation. The batch never aborts on a
/// single failure; every item is reported so none is silently lost.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BatchTranslationItemFailure {
    pub skill_id: SkillId,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BatchTranslationOutcome {
    pub language: String,
    pub translated: Vec<crate::llm::translation::TranslationResult>,
    pub failed: Vec<BatchTranslationItemFailure>,
}

/// Step 5 of the import flow: run the AI safety layer over prepared imports.
/// Strictly user-initiated (or enabled by preference); purely advisory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RunImportAiChecks {
    pub prepared_import_ids: Vec<crate::OperationId>,
}

/// One prepared import's AI pre-check outcome. `Failed` objects carry a
/// display-safe failure code; the rest of the batch is unaffected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportAiCheckOutcome {
    pub prepared_import_id: crate::OperationId,
    pub state: crate::check::CheckState,
    pub finding_count: u32,
    pub file_count: u32,
    pub failure_code: Option<String>,
}

/// Batch report carrying the provider/model that answered, so the UI can
/// show scope and cost-relevant facts before any commit.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportAiChecksReport {
    pub provider: String,
    pub model: String,
    pub requested: u32,
    pub outcomes: Vec<ImportAiCheckOutcome>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SaveLlmProvider {
    pub provider: crate::llm::LlmProviderConfig,
    /// Credential material for the OS store. Never persisted anywhere else.
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeleteLlmProvider {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ClearLlmProviderCredential {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SetLlmProviderEnabled {
    pub id: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SetDefaultLlmProvider {
    pub id: Option<String>,
}

/// Whether an administration call targets a stored provider or an unsaved
/// draft straight from the settings form.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum FetchLlmProvider {
    Saved {
        id: String,
    },
    Draft {
        provider: crate::llm::LlmProviderConfig,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct FetchLlmModels {
    pub provider: FetchLlmProvider,
    /// Inline credential for a draft (not yet stored in the OS store).
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TestLlmConnection {
    pub provider: FetchLlmProvider,
    pub credential: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareBackup {
    pub scope: BackupScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupDecision {
    pub skill_id: SkillId,
    pub decision: SensitiveContentDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CreateBackup {
    pub scope: BackupScope,
    pub decisions: Vec<BackupDecision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct VerifyBackup {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareRestore {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RestoreDecision {
    pub skill_id: SkillId,
    pub decision: RestoreConflictDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitRestore {
    pub path: String,
    pub decisions: Vec<RestoreDecision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareInitialRestore {
    pub backup_path: String,
    pub library_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CommitInitialRestore {
    pub backup_path: String,
    pub library_path: String,
    pub decisions: Vec<RestoreDecision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RunRollingBackup {
    pub scope: BackupScope,
    pub retention: BackupRetentionPolicy,
    pub decisions: Vec<BackupDecision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareStandardExport {
    pub input: ExportInput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CreateStandardExport {
    pub input: ExportInput,
    pub decisions: Vec<ExportDecision>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PrepareUninstall {
    pub deployment_ids: Vec<DeploymentId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ApplyUninstallDecision {
    pub actions: Vec<UninstallAction>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RunInitializationScan {
    pub scope_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CompleteOnboarding {
    pub library_path: String,
    pub skipped: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum LibraryActivationMode {
    Create,
    Existing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ActivateLibraryRoot {
    pub path: String,
    pub mode: LibraryActivationMode,
}

/// Stores a UI preference value (raw JSON) under a non-empty key.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SetUiPreference {
    pub key: String,
    pub value_json: String,
}

/// AR-021：为指定版本设置用户可读名称（来源版本/用户版本/内容哈希分离
/// 中的“用户版本”）。名称去除首尾空白、非空且不超过 64 字符。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SetVersionLabel {
    pub skill_id: crate::SkillId,
    pub version_id: crate::VersionId,
    pub label: String,
}

/// Adds or replaces a GitHub repo entry (upsert on owner+name). Empty branch
/// or "HEAD" is the default-branch sentinel.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AddSkillRepo {
    pub repo: crate::source::SkillRepo,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemoveSkillRepo {
    pub owner: String,
    pub name: String,
}

/// Re-runs discovery for a single configured repository (network required)
/// and records its most recent scan state for the repository list view.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RefreshSkillRepo {
    pub owner: String,
    pub name: String,
}

/// Downloads the requested repo skill into an application-managed temporary
/// directory so it can enter the existing import wizard as a local source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DownloadRepoSkill {
    pub skill: crate::source::DiscoverableRepoSkill,
}

/// P1-05：把一次联网搜索结果保存为待确认候选。只写候选表，
/// 绝不写 sources/skill_sources/catalog（搜索候选绝不自动成为来源）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SaveSearchCandidates {
    pub page: crate::source::SourceSearchPage,
}

/// P1-05：确认一条搜索候选。只登记导入意向（status=confirmed）；
/// 真正的来源记录仍然只能由导入向导提交产生。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConfirmSearchCandidate {
    pub candidate_id: String,
}

/// P1-05：拒绝一条搜索候选。不写任何来源，已拒绝的候选不能再次确认。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DismissSearchCandidate {
    pub candidate_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiscoverAgentTargets;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ScanTargets {
    pub scope_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RescanSkill {
    pub scope_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RunBasicCheck {
    pub skill_id: SkillId,
    pub version_id: VersionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RecheckBasic {
    pub skill_id: SkillId,
    pub version_id: VersionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SetFindingDisposition {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub kind: CheckKind,
    pub finding_id: String,
    pub disposition: FindingDisposition,
    pub high_risk_confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppCommand {
    #[serde(rename = "set_desktop_preferences")]
    SetDesktopPreferences(crate::DesktopPreferences),
    #[serde(rename = "begin_import_batch")]
    BeginImportBatch(BeginImportBatch),
    #[serde(rename = "finalize_import_batch")]
    FinalizeImportBatch(FinalizeImportBatch),
    #[serde(rename = "open_official_release")]
    OpenOfficialRelease(OpenOfficialRelease),
    #[serde(rename = "open_external_url")]
    OpenExternalUrl(OpenExternalUrl),
    #[serde(rename = "set_application_update_policy")]
    SetApplicationUpdatePolicy(SetApplicationUpdatePolicy),
    #[serde(rename = "prepare_application_update")]
    PrepareApplicationUpdate(PrepareApplicationUpdate),
    #[serde(rename = "download_application_update")]
    DownloadApplicationUpdate(DownloadApplicationUpdate),
    #[serde(rename = "install_application_update")]
    InstallApplicationUpdate(InstallApplicationUpdate),
    #[serde(rename = "rollback_application_update")]
    RollbackApplicationUpdate(RollbackApplicationUpdate),
    #[serde(rename = "create_skill")]
    CreateSkill(CreateSkill),
    #[serde(rename = "save_skill_content")]
    SaveSkillContent(SaveSkillContent),
    #[serde(rename = "save_markdown_content")]
    SaveMarkdownContent(SaveMarkdownContent),
    #[serde(rename = "save_markdown_as_copy")]
    SaveMarkdownAsCopy(SaveMarkdownAsCopy),
    #[serde(rename = "rename_skill")]
    RenameSkill(RenameSkill),
    #[serde(rename = "set_lifecycle")]
    SetLifecycle(SetLifecycle),
    #[serde(rename = "set_metadata")]
    SetMetadata(SetMetadata),
    #[serde(rename = "set_trial")]
    SetTrial(SetTrial),
    #[serde(rename = "create_combination")]
    CreateCombination(CreateCombination),
    #[serde(rename = "update_combination")]
    UpdateCombination(UpdateCombination),
    #[serde(rename = "delete_combination")]
    DeleteCombination(DeleteCombination),
    #[serde(rename = "rename_combination")]
    RenameCombination(RenameCombination),
    #[serde(rename = "set_current_version")]
    SetCurrentVersion(SetCurrentVersion),
    #[serde(rename = "pin_project_skill_version")]
    PinProjectSkillVersion(PinProjectSkillVersion),
    #[serde(rename = "create_custom_agent")]
    CreateCustomAgent(CreateCustomAgent),
    #[serde(rename = "update_custom_agent")]
    UpdateCustomAgent(UpdateCustomAgent),
    #[serde(rename = "remove_custom_agent")]
    RemoveCustomAgent(RemoveCustomAgent),
    #[serde(rename = "reset_profile_override")]
    ResetProfileOverride(ResetProfileOverride),
    #[serde(rename = "set_profile_override")]
    SetProfileOverride(SetProfileOverride),
    #[serde(rename = "register_project")]
    RegisterProject(RegisterProject),
    #[serde(rename = "update_project")]
    UpdateProject(UpdateProject),
    #[serde(rename = "set_project_tags")]
    SetProjectTags(SetProjectTags),
    #[serde(rename = "save_project_view")]
    SaveProjectView(SaveProjectView),
    #[serde(rename = "write_shared_project_config")]
    WriteSharedProjectConfig(WriteSharedProjectConfig),
    #[serde(rename = "read_shared_project_config")]
    ReadSharedProjectConfig(ReadSharedProjectConfig),
    #[serde(rename = "prepare_project_assembly")]
    PrepareProjectAssembly(PrepareProjectAssembly),
    #[serde(rename = "commit_project_assembly")]
    CommitProjectAssembly(CommitProjectAssembly),
    #[serde(rename = "prepare_import")]
    PrepareImport(PrepareImport),
    #[serde(rename = "commit_import")]
    CommitImport(CommitImport),
    #[serde(rename = "prepare_original_migration")]
    PrepareOriginalMigration(PrepareOriginalMigration),
    #[serde(rename = "commit_original_migration")]
    CommitOriginalMigration(CommitOriginalMigration),
    #[serde(rename = "rollback_original_migration")]
    RollbackOriginalMigration(RollbackOriginalMigration),
    #[serde(rename = "prepare_relation_migration")]
    PrepareRelationMigration(PrepareRelationMigration),
    #[serde(rename = "commit_relation_migration")]
    CommitRelationMigration(CommitRelationMigration),
    #[serde(rename = "rollback_relation_migration")]
    RollbackRelationMigration(RollbackRelationMigration),
    #[serde(rename = "prepare_relation_governance_batch")]
    PrepareRelationGovernanceBatch(PrepareRelationGovernanceBatch),
    #[serde(rename = "commit_relation_governance_batch")]
    CommitRelationGovernanceBatch(CommitRelationGovernanceBatch),
    #[serde(rename = "rollback_relation_governance_batch")]
    RollbackRelationGovernanceBatch(RollbackRelationGovernanceBatch),
    #[serde(rename = "relink_source")]
    RelinkSource(RelinkSource),
    #[serde(rename = "check_source_update")]
    CheckSourceUpdate(CheckSourceUpdate),
    #[serde(rename = "apply_source_update")]
    ApplySourceUpdate(ApplySourceUpdate),
    #[serde(rename = "prepare_deployment")]
    PrepareDeployment(PrepareDeployment),
    #[serde(rename = "commit_deployment")]
    CommitDeployment(CommitDeployment),
    #[serde(rename = "collect_deployment_changes")]
    CollectDeploymentChanges(CollectDeploymentChanges),
    #[serde(rename = "restore_deployment")]
    RestoreDeployment(RestoreDeployment),
    #[serde(rename = "keep_independent_copy")]
    KeepIndependentCopy(KeepIndependentCopy),
    #[serde(rename = "ignore_external_change")]
    IgnoreExternalChange(IgnoreExternalChange),
    #[serde(rename = "prepare_undeploy")]
    PrepareUndeploy(PrepareUndeploy),
    #[serde(rename = "commit_undeploy")]
    CommitUndeploy(CommitUndeploy),
    #[serde(rename = "prepare_delete_skill")]
    PrepareDeleteSkill(PrepareDeleteSkill),
    #[serde(rename = "commit_delete_skill")]
    CommitDeleteSkill(CommitDeleteSkill),
    #[serde(rename = "detach_management")]
    DetachManagement(DetachManagement),
    #[serde(rename = "run_health_check")]
    RunHealthCheck(RunHealthCheck),
    #[serde(rename = "prepare_repair")]
    PrepareRepair(PrepareRepair),
    #[serde(rename = "commit_repair")]
    CommitRepair(CommitRepair),
    #[serde(rename = "resolve_recovery")]
    ResolveRecovery(ResolveRecovery),
    #[serde(rename = "prepare_call_policy_change")]
    PrepareCallPolicyChange(PrepareCallPolicyChange),
    #[serde(rename = "commit_call_policy_change")]
    CommitCallPolicyChange(CommitCallPolicyChange),
    #[serde(rename = "restore_original_call_policy")]
    RestoreOriginalCallPolicy(RestoreOriginalCallPolicy),
    #[serde(rename = "create_ignore_rule")]
    CreateIgnoreRule(CreateIgnoreRule),
    #[serde(rename = "remove_ignore_rule")]
    RemoveIgnoreRule(RemoveIgnoreRule),
    #[serde(rename = "run_llm_safety_check")]
    RunLlmSafetyCheck(RunLlmSafetyCheck),
    #[serde(rename = "recheck_llm_safety")]
    RecheckLlmSafety(RecheckLlmSafety),
    #[serde(rename = "analyze_semantic_duplicates")]
    AnalyzeSemanticDuplicates(AnalyzeSemanticDuplicates),
    #[serde(rename = "analyze_conflict")]
    AnalyzeConflict(AnalyzeConflict),
    #[serde(rename = "resolve_conflict_case")]
    ResolveConflictCase(ResolveConflictCase),
    #[serde(rename = "translate_description")]
    TranslateDescription(TranslateDescription),
    #[serde(rename = "translate_descriptions_batch")]
    TranslateDescriptionsBatch(TranslateDescriptionsBatch),
    #[serde(rename = "save_user_translation_revision")]
    SaveUserTranslationRevision(SaveUserTranslationRevision),
    #[serde(rename = "generate_online_search_query")]
    GenerateOnlineSearchQuery(GenerateOnlineSearchQuery),
    #[serde(rename = "save_llm_provider")]
    SaveLlmProvider(SaveLlmProvider),
    #[serde(rename = "delete_llm_provider")]
    DeleteLlmProvider(DeleteLlmProvider),
    #[serde(rename = "clear_llm_provider_credential")]
    ClearLlmProviderCredential(ClearLlmProviderCredential),
    #[serde(rename = "set_llm_provider_enabled")]
    SetLlmProviderEnabled(SetLlmProviderEnabled),
    #[serde(rename = "set_default_llm_provider")]
    SetDefaultLlmProvider(SetDefaultLlmProvider),
    #[serde(rename = "fetch_llm_models")]
    FetchLlmModels(FetchLlmModels),
    #[serde(rename = "test_llm_connection")]
    TestLlmConnection(TestLlmConnection),
    #[serde(rename = "run_import_ai_checks")]
    RunImportAiChecks(RunImportAiChecks),
    #[serde(rename = "prepare_backup")]
    PrepareBackup(PrepareBackup),
    #[serde(rename = "create_backup")]
    CreateBackup(CreateBackup),
    #[serde(rename = "verify_backup")]
    VerifyBackup(VerifyBackup),
    #[serde(rename = "prepare_restore")]
    PrepareRestore(PrepareRestore),
    #[serde(rename = "commit_restore")]
    CommitRestore(CommitRestore),
    #[serde(rename = "prepare_initial_restore")]
    PrepareInitialRestore(PrepareInitialRestore),
    #[serde(rename = "commit_initial_restore")]
    CommitInitialRestore(CommitInitialRestore),
    #[serde(rename = "run_rolling_backup")]
    RunRollingBackup(RunRollingBackup),
    #[serde(rename = "prepare_standard_export")]
    PrepareStandardExport(PrepareStandardExport),
    #[serde(rename = "create_standard_export")]
    CreateStandardExport(CreateStandardExport),
    #[serde(rename = "prepare_uninstall")]
    PrepareUninstall(PrepareUninstall),
    #[serde(rename = "apply_uninstall_decision")]
    ApplyUninstallDecision(ApplyUninstallDecision),
    #[serde(rename = "cancel_import")]
    CancelImport { prepared_import_id: OperationId },
    #[serde(rename = "run_initialization_scan")]
    RunInitializationScan(RunInitializationScan),
    #[serde(rename = "complete_onboarding")]
    CompleteOnboarding(CompleteOnboarding),
    #[serde(rename = "activate_library_root")]
    ActivateLibraryRoot(ActivateLibraryRoot),
    #[serde(rename = "set_ui_preference")]
    SetUiPreference(SetUiPreference),
    #[serde(rename = "set_version_label")]
    SetVersionLabel(SetVersionLabel),
    #[serde(rename = "add_skill_repo")]
    AddSkillRepo(AddSkillRepo),
    #[serde(rename = "remove_skill_repo")]
    RemoveSkillRepo(RemoveSkillRepo),
    #[serde(rename = "refresh_skill_repo")]
    RefreshSkillRepo(RefreshSkillRepo),
    #[serde(rename = "download_repo_skill")]
    DownloadRepoSkill(DownloadRepoSkill),
    #[serde(rename = "save_search_candidates")]
    SaveSearchCandidates(SaveSearchCandidates),
    #[serde(rename = "confirm_search_candidate")]
    ConfirmSearchCandidate(ConfirmSearchCandidate),
    #[serde(rename = "dismiss_search_candidate")]
    DismissSearchCandidate(DismissSearchCandidate),
    #[serde(rename = "discover_agent_targets")]
    DiscoverAgentTargets(DiscoverAgentTargets),
    #[serde(rename = "scan_targets")]
    ScanTargets(ScanTargets),
    #[serde(rename = "rescan_skill")]
    RescanSkill(RescanSkill),
    #[serde(rename = "run_basic_check")]
    RunBasicCheck(RunBasicCheck),
    #[serde(rename = "recheck_basic")]
    RecheckBasic(RecheckBasic),
    #[serde(rename = "set_finding_disposition")]
    SetFindingDisposition(SetFindingDisposition),
    #[serde(rename = "cancel_operation")]
    CancelOperation { operation_id: OperationId },
    #[serde(rename = "acknowledge_recovery")]
    AcknowledgeRecovery { operation_id: OperationId },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppCommandResult {
    #[serde(rename = "desktop_preferences")]
    DesktopPreferences(crate::DesktopPreferences),
    #[serde(rename = "import_batch_started")]
    ImportBatchStarted(ImportBatchStarted),
    #[serde(rename = "import_batch_finalized")]
    ImportBatchFinalized(ImportBatchFinalized),
    #[serde(rename = "application_update")]
    ApplicationUpdate(ApplicationUpdate),
    #[serde(rename = "application_update_policy")]
    ApplicationUpdatePolicy(crate::ApplicationUpdatePolicy),
    #[serde(rename = "prepared_application_update")]
    PreparedApplicationUpdate(PreparedApplicationUpdate),
    #[serde(rename = "downloaded_application_update")]
    DownloadedApplicationUpdate(DownloadedApplicationUpdate),
    #[serde(rename = "application_update_state")]
    ApplicationUpdateState(UpdateState),
    #[serde(rename = "operation_summary")]
    OperationSummary(OperationSummary),
    #[serde(rename = "initialization_status")]
    InitializationStatus(InitializationStatus),
    #[serde(rename = "discovery_snapshot")]
    DiscoverySnapshot(crate::DiscoverySnapshot),
    #[serde(rename = "saved_skill_content")]
    SavedSkillContent(SavedSkillContent),
    #[serde(rename = "custom_agent")]
    CustomAgent(CustomAgent),
    #[serde(rename = "custom_agent_override")]
    CustomAgentOverride(CustomAgentOverride),
    #[serde(rename = "project")]
    Project(Project),
    #[serde(rename = "saved_project_view")]
    SavedProjectView(SavedProjectView),
    #[serde(rename = "shared_project_config")]
    SharedProjectConfig(SharedProjectConfig),
    #[serde(rename = "assembly_plan")]
    AssemblyPlan(AssemblyPlan),
    #[serde(rename = "scan_result")]
    ScanResult(ScanResult),
    #[serde(rename = "basic_check_result")]
    BasicCheckResult(BasicCheckResult),
    #[serde(rename = "prepared_import")]
    PreparedImport(Box<crate::application::PreparedImport>),
    #[serde(rename = "import_summary")]
    ImportSummary(Box<crate::application::ImportSummary>),
    #[serde(rename = "original_migration_plan")]
    OriginalMigrationPlan(crate::import::OriginalMigrationPlan),
    #[serde(rename = "original_migration_result")]
    OriginalMigrationResult(crate::import::OriginalMigrationResult),
    #[serde(rename = "prepared_relation_migration")]
    PreparedRelationMigration(crate::PreparedRelationMigration),
    #[serde(rename = "relation_migration_result")]
    RelationMigrationResult(crate::RelationMigrationResult),
    #[serde(rename = "relation_governance_batch")]
    RelationGovernanceBatch(RelationGovernanceBatchOutcome),
    #[serde(rename = "upstream_check_result")]
    UpstreamCheckResult(crate::source::UpstreamCheckResult),
    #[serde(rename = "applied_source_update")]
    AppliedSourceUpdate(crate::source::AppliedSourceUpdate),
    #[serde(rename = "prepared_deployment")]
    PreparedDeployment(Box<crate::application::PreparedDeployment>),
    #[serde(rename = "deployment_summary")]
    DeploymentSummary(Box<crate::application::DeploymentSummary>),
    #[serde(rename = "reconcile_result")]
    ReconcileResult(crate::ReconcileResult),
    #[serde(rename = "removal_impact")]
    RemovalImpact(crate::RemovalImpact),
    #[serde(rename = "removal_result")]
    RemovalResult(crate::RemovalResult),
    #[serde(rename = "health_report")]
    HealthReport(crate::HealthReport),
    #[serde(rename = "repair_plan")]
    RepairPlan(crate::RepairPlan),
    #[serde(rename = "call_policy_plan")]
    CallPolicyPlan(crate::CallPolicyPlan),
    #[serde(rename = "ignore_rule")]
    IgnoreRule(crate::IgnoreRule),
    #[serde(rename = "llm_safety_check_result")]
    LlmSafetyCheckResult(LlmSafetyCheckResult),
    #[serde(rename = "duplicate_analysis")]
    DuplicateAnalysis(crate::duplicate::DuplicateAnalysis),
    #[serde(rename = "conflict_analysis")]
    ConflictAnalysis(crate::duplicate::ConflictAnalysis),
    #[serde(rename = "conflict_resolved")]
    ConflictResolved(crate::relationship::ConflictResolutionOutcome),
    #[serde(rename = "translation_result")]
    TranslationResult(TranslationResult),
    #[serde(rename = "batch_translation_result")]
    BatchTranslationResult(BatchTranslationOutcome),
    #[serde(rename = "online_search_query")]
    OnlineSearchQuery(SearchQuerySuggestion),
    #[serde(rename = "llm_provider_view")]
    LlmProviderView(crate::llm::LlmProviderView),
    #[serde(rename = "llm_models")]
    LlmModels(Vec<String>),
    #[serde(rename = "connection_test")]
    ConnectionTest(crate::llm::ConnectionTestResult),
    #[serde(rename = "import_ai_checks_report")]
    ImportAiChecksReport(ImportAiChecksReport),
    #[serde(rename = "backup_plan")]
    BackupPlan(BackupPlan),
    #[serde(rename = "backup_manifest")]
    BackupManifest(BackupManifest),
    #[serde(rename = "backup_created")]
    BackupCreated(BackupCreated),
    #[serde(rename = "restore_plan")]
    RestorePlan(RestorePlan),
    #[serde(rename = "restore_result")]
    RestoreResult(RestoreResult),
    #[serde(rename = "backup_retention_result")]
    BackupRetentionResult(BackupRetentionResult),
    #[serde(rename = "export_plan")]
    ExportPlan(ExportPlan),
    #[serde(rename = "export_result")]
    ExportResult(ExportResult),
    #[serde(rename = "uninstall_impact")]
    UninstallImpact(UninstallImpact),
    #[serde(rename = "skill_repos")]
    SkillRepos(Vec<crate::source::SkillRepoView>),
    #[serde(rename = "repo_discovery_report")]
    RepoDiscoveryReport(crate::source::RepoDiscoveryReport),
    #[serde(rename = "downloaded_repo_skill")]
    DownloadedRepoSkill(crate::source::DownloadedRepoSkill),
    #[serde(rename = "search_candidates")]
    SearchCandidates(Vec<crate::source::SearchCandidateRecord>),
    #[serde(rename = "combination")]
    Combination(CombinationResult),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SavedSkillContent {
    pub skill_id: SkillId,
    pub path: String,
    pub version_id: VersionId,
    pub content_identity: String,
}
