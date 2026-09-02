mod command;
mod event;
mod query;

pub use crate::app_update::{
    CheckApplicationUpdate, OpenOfficialRelease, SetApplicationUpdatePolicy,
};
pub use crate::deployment::DeploymentPlanRequest;
pub use command::{
    AnalyzeSemanticDuplicates, AppCommand, AppCommandResult, ApplySourceUpdate,
    ApplyUninstallDecision, BackupDecision, CheckSourceUpdate, CollectDeploymentChanges,
    CommitCallPolicyChange, CommitDeleteSkill, CommitDeployment, CommitImport,
    CommitProjectAssembly, CommitRepair, CommitRestore, CommitUndeploy, CompleteOnboarding,
    CreateBackup, CreateCombination, CreateCustomAgent, CreateIgnoreRule, CreateSkill,
    CreateStandardExport, DetachManagement, DiscoverAgentTargets, DownloadApplicationUpdate,
    GenerateOnlineSearchQuery, IgnoreExternalChange, InstallApplicationUpdate, KeepIndependentCopy,
    PinProjectSkillVersion, PrepareApplicationUpdate, PrepareBackup, PrepareCallPolicyChange,
    PrepareDeleteSkill, PrepareDeployment, PrepareImport, PrepareProjectAssembly, PrepareRepair,
    PrepareRestore, PrepareStandardExport, PrepareUndeploy, PrepareUninstall,
    ReadSharedProjectConfig, RecheckBasic, RecheckLlmSafety, RegisterProject, RelinkSource,
    RemoveCustomAgent, RemoveIgnoreRule, RenameSkill, RescanSkill, ResetProfileOverride,
    ResolveRecovery, RestoreDecision, RestoreDeployment, RestoreOriginalCallPolicy,
    RollbackApplicationUpdate, RunBasicCheck, RunHealthCheck, RunInitializationScan,
    RunLlmSafetyCheck, RunRollingBackup, SaveMarkdownContent, SaveProjectView, SaveSkillContent,
    SaveUserTranslationRevision, SavedSkillContent, ScanTargets, SetCurrentVersion,
    SetFindingDisposition, SetLifecycle, SetMetadata, SetProfileOverride, SetProjectTags, SetTrial,
    TranslateDescription, UpdateCustomAgent, UpdateProject, VerifyBackup, WriteSharedProjectConfig,
};
pub use event::{AppEvent, FactsChanged};
pub use query::{
    AnalyzeGlobalSkillEvidence, AnalyzeImport, AppQuery, AppQueryResult, BasicCheckResult,
    CombinationResult, DeploymentTarget, DiffVersions, DiscoverImportCandidates, FindingResult,
    GetBasicCheckResult, GetBootstrapSnapshot, GetCallPolicy, GetDeploymentPlan,
    GetDeploymentRelations, GetDiscoverySnapshot, GetLlmSafetyCheckResult, GetProjectAssemblyPlan,
    GetReconcilePlan, GetRemovalImpact, GetSkill, ListCombinations, ListCustomAgents,
    ListDeploymentTargets, ListDeployments, ListFindings, ListMarkdownFiles, ListPendingItems,
    ListProjects, ListSavedProjectViews, ListSkills, ListVersions, LlmSafetyCheckResult,
    MarkdownFileContent, MarkdownFileEntry, ReadMarkdownFile, SearchOnlineSources, SkillListItem,
    SkillListPage, SkillResult, VersionDiffResult, VersionResult,
};

use crate::AppResult;

#[async_trait::async_trait]
pub trait ApplicationFacade: Send + Sync {
    async fn execute(&self, command: AppCommand) -> AppResult<AppCommandResult>;
    async fn query(&self, query: AppQuery) -> AppResult<AppQueryResult>;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u32,
    pub next_cursor: Option<String>,
}

use serde::{Deserialize, Serialize};
