mod command;
mod event;
mod query;

pub use crate::app_update::{
    CheckApplicationUpdate, OpenOfficialRelease, SetApplicationUpdatePolicy,
};
pub use crate::deployment::DeploymentPlanRequest;
pub use command::{
    ActivateLibraryRoot, AddSkillRepo, AnalyzeSemanticDuplicates, AppCommand, AppCommandResult,
    ApplySourceUpdate, ApplyUninstallDecision, BackupDecision, BatchTranslationItemFailure,
    BatchTranslationOutcome, CheckSourceUpdate, ClearLlmProviderCredential,
    CollectDeploymentChanges, CommitCallPolicyChange, CommitDeleteSkill, CommitDeployment,
    CommitImport, CommitInitialRestore, CommitProjectAssembly, CommitRepair, CommitRestore,
    CommitUndeploy, CompleteOnboarding, CreateBackup, CreateCombination, CreateCustomAgent,
    CreateIgnoreRule, CreateSkill, CreateStandardExport, DeleteCombination, DeleteLlmProvider,
    DetachManagement, DiscoverAgentTargets, DownloadApplicationUpdate, DownloadRepoSkill,
    FetchLlmModels, FetchLlmProvider, GenerateOnlineSearchQuery, IgnoreExternalChange,
    ImportAiCheckOutcome, ImportAiChecksReport, InstallApplicationUpdate, KeepIndependentCopy,
    LibraryActivationMode, OpenExternalUrl, PinProjectSkillVersion, PrepareApplicationUpdate,
    PrepareBackup, PrepareCallPolicyChange, PrepareDeleteSkill, PrepareDeployment, PrepareImport,
    PrepareInitialRestore, PrepareProjectAssembly, PrepareRepair, PrepareRestore,
    PrepareStandardExport, PrepareUndeploy, PrepareUninstall, ReadSharedProjectConfig,
    RecheckBasic, RecheckLlmSafety, RegisterProject, RelinkSource, RemoveCustomAgent,
    RemoveIgnoreRule, RemoveSkillRepo, RenameSkill, RescanSkill, ResetProfileOverride,
    ResolveRecovery, RestoreDecision, RestoreDeployment, RestoreOriginalCallPolicy,
    RollbackApplicationUpdate, RunBasicCheck, RunHealthCheck, RunImportAiChecks,
    RunInitializationScan, RunLlmSafetyCheck, RunRollingBackup, SaveLlmProvider,
    SaveMarkdownAsCopy, SaveMarkdownContent, SaveProjectView, SaveSkillContent,
    SaveUserTranslationRevision, SavedSkillContent, ScanTargets, SetCurrentVersion,
    SetDefaultLlmProvider, SetFindingDisposition, SetLifecycle, SetLlmProviderEnabled, SetMetadata,
    SetProfileOverride, SetProjectTags, SetTrial, SetUiPreference, SetVersionLabel,
    TestLlmConnection, TranslateDescription, TranslateDescriptionsBatch, UpdateCombination,
    UpdateCustomAgent, UpdateProject, VerifyBackup, WriteSharedProjectConfig,
};
pub use event::{AppEvent, FactsChanged};
pub use query::{
    AnalyzeGlobalSkillEvidence, AnalyzeImport, AppQuery, AppQueryResult, BasicCheckResult,
    CheckSourceUpdates, CombinationResult, DeploymentTarget, DeterministicDuplicateEntry,
    DiffVersions, DiscoverAgentsLockSkills, DiscoverImportCandidates, DiscoverRepoSkills,
    FindingResult, GetBasicCheckResult, GetBootstrapSnapshot, GetCallPolicy, GetDeploymentPlan,
    GetDeploymentRelations, GetDiscoverySnapshot, GetLlmSafetyCheckResult, GetProjectAssemblyPlan,
    GetReconcilePlan, GetRemovalImpact, GetSkill, GetUiPreference, GetUiPreferenceResult,
    ListCombinations, ListCustomAgents, ListDeploymentTargets, ListDeployments,
    ListDeterministicDuplicates, ListFindings, ListMarkdownFiles, ListPendingItems, ListProjects,
    ListSavedProjectViews, ListSkillOperations, ListSkillRepos, ListSkills, ListTranslations,
    ListVersions, LlmCheckRun, LlmSafetyCheckResult, MarkdownFileContent, MarkdownFileEntry,
    PreviewProjectDirectory, ProjectDirectoryPreview, ReadMarkdownFile, SearchOnlineSources,
    SearchOnlineSourcesAssisted, SkillDeploymentFilter, SkillLifecycleFilter, SkillListFilters,
    SkillListItem, SkillListPage, SkillListSort, SkillOperationEntry, SkillOperationsResult,
    SkillResult, SkillSortColumn, SkillSortDirection, SourceUpdateCheckOutcome, VersionDiffResult,
    VersionResult,
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
