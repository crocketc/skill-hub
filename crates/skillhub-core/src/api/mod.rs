mod command;
mod event;
mod query;

pub use crate::app_update::{
    CheckApplicationUpdate, OpenOfficialRelease, SetApplicationUpdatePolicy,
};
pub use crate::deployment::DeploymentPlanRequest;
pub use crate::relationship::{
    RelationGovernanceAction, RelationGovernanceBlocker, RelationGovernanceBucket,
    RelationGovernanceCounts, RelationGovernanceFilters, RelationGovernanceImpact,
    RelationGovernanceLedger, RelationGovernanceReadiness, RelationGovernanceRow,
    RelationshipGraphFilters,
};
pub use command::{
    ActivateLibraryRoot, AddSkillRepo, AnalyzeConflict, AnalyzeSemanticDuplicates, AppCommand,
    AppCommandResult, ApplySourceUpdate, ApplyUninstallDecision, BackupDecision,
    BatchTranslationItemFailure, BatchTranslationOutcome, BeginImportBatch, CheckSourceUpdate,
    ClearLlmProviderCredential, CollectDeploymentChanges, CommitCallPolicyChange,
    CommitDeleteSkill, CommitDeployment, CommitImport, CommitInitialRestore,
    CommitOriginalMigration, CommitProjectAssembly, CommitRelationGovernanceBatch,
    CommitRelationMigration, CommitRepair, CommitRestore, CommitUndeploy, CompleteOnboarding,
    ConfirmSearchCandidate, CreateBackup, CreateCombination, CreateCustomAgent, CreateIgnoreRule,
    CreateSkill, CreateStandardExport, DeleteCombination, DeleteLlmProvider, DetachManagement,
    DiscoverAgentTargets, DismissSearchCandidate, DownloadApplicationUpdate, DownloadRepoSkill,
    FetchLlmModels, FetchLlmProvider, FinalizeImportBatch, GenerateOnlineSearchQuery,
    IgnoreExternalChange, ImportAiCheckOutcome, ImportAiChecksReport, ImportBatchFinalized,
    ImportBatchStarted, InstallApplicationUpdate, KeepIndependentCopy, LibraryActivationMode,
    OpenExternalUrl, OpenImportBatch, PinProjectSkillVersion, PrepareApplicationUpdate,
    PrepareBackup, PrepareCallPolicyChange, PrepareDeleteSkill, PrepareDeployment, PrepareImport,
    PrepareInitialRestore, PrepareOriginalMigration, PrepareProjectAssembly,
    PrepareRelationGovernanceBatch, PrepareRelationMigration, PrepareRepair, PrepareRestore,
    PrepareStandardExport, PrepareUndeploy, PrepareUninstall, QueryOpenImportBatch,
    ReadSharedProjectConfig, RecheckBasic, RecheckLlmSafety, RefreshSkillRepo, RegisterProject,
    RelationGovernanceBatchAction, RelationGovernanceBatchItem, RelationGovernanceBatchItemState,
    RelationGovernanceBatchOutcome, RelationGovernanceBatchState, RelationMigrationInput,
    RelationMigrationTargetMode, RelationshipMigrationBackupPolicy, RelinkSource,
    RemoveCustomAgent, RemoveIgnoreRule, RemoveSkillRepo, RenameCombination, RenameSkill,
    RescanSkill, ResetProfileOverride, ResolveConflictCase, ResolveRecovery, RestoreDecision,
    RestoreDeployment, RestoreOriginalCallPolicy, RollbackApplicationUpdate,
    RollbackOriginalMigration, RollbackRelationGovernanceBatch, RollbackRelationMigration,
    RunBasicCheck, RunHealthCheck, RunImportAiChecks, RunInitializationScan, RunLlmSafetyCheck,
    RunRollingBackup, SaveLlmProvider, SaveMarkdownAsCopy, SaveMarkdownContent, SaveProjectView,
    SaveSearchCandidates, SaveSkillContent, SaveUserTranslationRevision, SavedSkillContent,
    ScanTargets, SetCurrentVersion, SetDefaultLlmProvider, SetFindingDisposition, SetLifecycle,
    SetLlmProviderEnabled, SetMetadata, SetProfileOverride, SetProjectTags, SetTrial,
    SetUiPreference, SetVersionLabel, TestLlmConnection, TranslateDescription,
    TranslateDescriptionsBatch, UpdateCombination, UpdateCustomAgent, UpdateProject, VerifyBackup,
    WriteSharedProjectConfig,
};
pub use event::{AppEvent, FactsChanged};
pub use query::{
    AnalyzeGlobalSkillEvidence, AnalyzeImport, AppQuery, AppQueryResult, BasicCheckResult,
    CheckSourceUpdates, CombinationResult, DeploymentTarget, DeterministicDuplicateEntry,
    DiffVersions, DiscoverImportCandidates, DiscoverRepoSkills, FindingResult, GetBasicCheckResult,
    GetBootstrapSnapshot, GetCallPolicy, GetConflictWorkspace, GetDeploymentPlan,
    GetDeploymentRelations, GetDiscoverySnapshot, GetLlmSafetyCheckResult, GetProjectAssemblyPlan,
    GetReconcilePlan, GetRelationshipOverview, GetRelationshipRemovalImpact, GetRemovalImpact,
    GetSkill, GetSkillProvenance, GetSkillRelationshipGraph, GetUiPreference,
    GetUiPreferenceResult, ListCombinations, ListCustomAgents, ListDeploymentTargets,
    ListDeployments, ListDeterministicDuplicates, ListFindings, ListMarkdownFiles,
    ListPendingItems, ListProjects, ListRelationGovernance, ListSavedProjectViews,
    ListSearchCandidates, ListSkillOperations, ListSkillRelationshipCandidates, ListSkillRepos,
    ListSkills, ListTranslations, ListVersions, LlmCheckRun, LlmSafetyCheckResult,
    MarkdownFileContent, MarkdownFileEntry, PreviewProjectDirectory, ProjectDirectoryPreview,
    ReadMarkdownFile, RelationshipOverview, RelationshipOverviewScope, RelationshipScope,
    SearchOnlineSources, SearchOnlineSourcesAssisted, SkillDeploymentFilter, SkillLifecycleFilter,
    SkillListFilters, SkillListItem, SkillListPage, SkillListSort, SkillOperationEntry,
    SkillOperationsResult, SkillProvenanceResult, SkillRelationshipCandidate,
    SkillRelationshipGraphResult, SkillResult, SkillSortColumn, SkillSortDirection,
    SkillVersionFilter, SourceUpdateCheckOutcome, VersionDiffResult, VersionResult,
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
