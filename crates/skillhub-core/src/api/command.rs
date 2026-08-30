use serde::{Deserialize, Serialize};

use crate::agent::{CustomAgent, CustomAgentDraft, CustomAgentOverride, PathGrant};
use crate::app_update::{ApplicationUpdate, OpenOfficialRelease, SetApplicationUpdatePolicy};
use crate::backup::{
    BackupCreated, BackupManifest, BackupPlan, BackupRetentionPolicy, BackupRetentionResult,
    BackupScope, RestoreConflictDecision, RestorePlan, RestoreResult, SensitiveContentDecision,
};
use crate::catalog::SkillLifecycle;
use crate::check::{CheckKind, FindingDisposition};
use crate::export::{
    ExportDecision, ExportInput, ExportPlan, ExportResult, UninstallAction, UninstallImpact,
};
use crate::import::{ImportCandidate, ImportDecision};
use crate::llm::search_query::SearchQuerySuggestion;
use crate::llm::translation::TranslationResult;
use crate::project::{AssemblyPlan, Project, SavedProjectView, SharedProjectConfig};
use crate::scan::ScanResult;
use crate::source::{SourceDescriptor, UpdateDecision};
use crate::{DeploymentId, OperationId, OperationSummary, ProjectId, SkillId, VersionId};

use super::query::{BasicCheckResult, LlmSafetyCheckResult};

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TranslateDescription {
    pub skill_id: SkillId,
    pub language: String,
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
    #[serde(rename = "open_official_release")]
    OpenOfficialRelease(OpenOfficialRelease),
    #[serde(rename = "set_application_update_policy")]
    SetApplicationUpdatePolicy(SetApplicationUpdatePolicy),
    #[serde(rename = "create_skill")]
    CreateSkill(CreateSkill),
    #[serde(rename = "save_skill_content")]
    SaveSkillContent(SaveSkillContent),
    #[serde(rename = "save_markdown_content")]
    SaveMarkdownContent(SaveMarkdownContent),
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
    #[serde(rename = "translate_description")]
    TranslateDescription(TranslateDescription),
    #[serde(rename = "save_user_translation_revision")]
    SaveUserTranslationRevision(SaveUserTranslationRevision),
    #[serde(rename = "generate_online_search_query")]
    GenerateOnlineSearchQuery(GenerateOnlineSearchQuery),
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
    #[serde(rename = "application_update")]
    ApplicationUpdate(ApplicationUpdate),
    #[serde(rename = "application_update_policy")]
    ApplicationUpdatePolicy(crate::ApplicationUpdatePolicy),
    #[serde(rename = "operation_summary")]
    OperationSummary(OperationSummary),
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
    #[serde(rename = "translation_result")]
    TranslationResult(TranslationResult),
    #[serde(rename = "online_search_query")]
    OnlineSearchQuery(SearchQuerySuggestion),
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SavedSkillContent {
    pub skill_id: SkillId,
    pub path: String,
    pub version_id: VersionId,
    pub content_identity: String,
}
