use serde::{Deserialize, Serialize};

use crate::agent::{CustomAgent, CustomAgentDraft, CustomAgentOverride, PathGrant};
use crate::catalog::SkillLifecycle;
use crate::check::{CheckKind, FindingDisposition};
use crate::import::{ImportCandidate, ImportDecision};
use crate::project::{AssemblyPlan, Project, SavedProjectView, SharedProjectConfig};
use crate::scan::ScanResult;
use crate::source::{SourceDescriptor, UpdateDecision};
use crate::{OperationId, OperationSummary, ProjectId, SkillId, VersionId};

use super::query::BasicCheckResult;

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
    #[serde(rename = "create_skill")]
    CreateSkill(CreateSkill),
    #[serde(rename = "save_skill_content")]
    SaveSkillContent(SaveSkillContent),
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
    #[serde(rename = "operation_summary")]
    OperationSummary(OperationSummary),
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
}
