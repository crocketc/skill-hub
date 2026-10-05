mod command;
mod event;
mod query;

pub use crate::app_update::{
    CheckApplicationUpdate, OpenOfficialRelease, SetApplicationUpdatePolicy,
};
pub use crate::deployment::DeploymentPlanRequest;
pub use crate::relationship::{
    GovernanceHistoryAgent, GovernanceHistoryEntry, GovernanceHistoryPage, ListGovernanceHistory,
    RelationGovernanceAction, RelationGovernanceBlocker, RelationGovernanceBucket,
    RelationGovernanceCounts, RelationGovernanceFilters, RelationGovernanceImpact,
    RelationGovernanceLedger, RelationGovernanceReadiness, RelationGovernanceRow,
    RelationshipGraphFilters,
};
pub use command::{
    ActivateLibraryRoot, AddSkillRepo, AnalyzeConflict, AnalyzeSemanticDuplicates, AppCommand,
    AppCommandResult, ApplyUninstallDecision, BackupDecision, BatchTranslationItemFailure,
    BatchTranslationOutcome, BeginImportBatch, CheckSourceUpdate, ChooseExternalApplication,
    ClearLlmProviderCredential, CollectDeploymentChanges, CommitCallPolicyChange,
    CommitDeleteSkill, CommitDeployment, CommitDeploymentPreview, CommitDeploymentPreviewPair,
    CommitImport, CommitInitialRestore, CommitOriginalMigration, CommitProjectAssembly,
    CommitRelationGovernanceBatch, CommitRelationMigration, CommitRepair, CommitRestore,
    CommitSourceUpdate, CommitUndeploy, CompleteOnboarding, ConfirmSearchCandidate, CreateBackup,
    CreateCombination, CreateCustomAgent, CreateIgnoreRule, CreateSkill, CreateStandardExport,
    DeleteCombination, DeleteLlmProvider, DeploymentPairCommitOutcome, DeploymentPairCommitResult,
    DeploymentPreviewCommitResult, DetachManagement, DiscardMarkdownDraft, DiscoverAgentTargets,
    DismissSearchCandidate, DownloadApplicationUpdate, DownloadRepoSkill, EndRelationship,
    EnsureAgentTargetDirectory, FetchLlmModels, FetchLlmProvider, FinalizeImportBatch,
    GenerateOnlineSearchQuery, IgnoreExternalChange, IgnoreSourceUpdate, ImportAiCheckOutcome,
    ImportAiChecksReport, ImportBatchFinalized, ImportBatchStarted, InstallApplicationUpdate,
    KeepIndependentCopy, LibraryActivationMode, MarkdownDraftDiscarded, MarkdownDraftSaved,
    MarkdownValidationIssue, MarkdownValidationResult, OpenDefaultApplication, OpenExternalUrl,
    OpenImportBatch, OpenSkillFolder, PatchSkillMetadata, PinProjectSkillVersion,
    PrepareApplicationUpdate, PrepareBackup, PrepareCallPolicyChange, PrepareDeleteSkill,
    PrepareDeployment, PrepareImport, PrepareInitialRestore, PrepareOriginalMigration,
    PrepareProjectAssembly, PrepareRelationGovernanceBatch, PrepareRelationMigration,
    PrepareRepair, PrepareRestore, PrepareSourceUpdate, PrepareStandardExport, PrepareUndeploy,
    PrepareUninstall, QueryOpenImportBatch, ReadSharedProjectConfig, RecheckBasic,
    RecheckLlmSafety, RefreshSkillRepo, RegisterProject, RelationGovernanceBatchAction,
    RelationGovernanceBatchItem, RelationGovernanceBatchItemState, RelationGovernanceBatchOutcome,
    RelationGovernanceBatchState, RelationMigrationInput, RelationMigrationTargetMode,
    RelationshipGovernanceMutationResult, RelationshipMigrationBackupPolicy, RelinkSource,
    RelinkSourceCopy, RemoveCustomAgent, RemoveIgnoreRule, RemoveSkillRepo, RenameCombination,
    RenameSkill, RescanSkill, ResetProfileOverride, ResolveConflictCase, ResolveRecovery,
    RestoreDecision, RestoreDeployment, RestoreOriginalCallPolicy, RetainSourceCopy,
    RevokeRetention, RollbackApplicationUpdate, RollbackOriginalMigration,
    RollbackRelationGovernanceBatch, RollbackRelationMigration, RunBasicCheck, RunHealthCheck,
    RunImportAiChecks, RunInitializationScan, RunLlmSafetyCheck, RunRelationshipCheck,
    RunRollingBackup, SaveAsCopyInheritance, SaveAsCopyInheritanceOutcome, SaveAsCopyOrigin,
    SaveAsCopyOutcome, SaveAsCopyReplacementChoice, SaveAsCopyTargetResult, SaveAsCopyTargetStatus,
    SaveLlmProvider, SaveMarkdownAsCopy, SaveMarkdownContent, SaveMarkdownDraft, SaveProjectView,
    SaveSearchCandidates, SaveSkillContent, SaveUserTranslationRevision, SavedSkillContent,
    ScanTargets, SetCurrentVersion, SetDefaultLlmProvider, SetFindingDisposition, SetLifecycle,
    SetLlmProviderEnabled, SetMetadata, SetProfileOverride, SetProjectTags, SetTrial,
    SetUiPreference, SetVersionLabel, TestLlmConnection, TranslateDescription,
    TranslateDescriptionsBatch, UpdateCombination, UpdateCustomAgent, UpdateProject,
    ValidateMarkdown, VerifyBackup, WriteSharedProjectConfig,
};
pub use event::{AppEvent, FactsChanged};
pub use query::{
    AnalyzeGlobalSkillEvidence, AnalyzeImport, AppQuery, AppQueryResult, BasicCheckResult,
    CheckSourceUpdates, CombinationResult, DeploymentBatchPreview,
    DeploymentBatchPreviewRequestItem, DeploymentPairPreview, DeploymentTarget,
    DeterministicDuplicateEntry, DiffVersions, DiscoverImportCandidates, DiscoverRepoSkills,
    FindingResult, GetAgentDirectoryProjection, GetBasicCheckResult, GetBootstrapSnapshot,
    GetCallPolicy, GetConflictWorkspace, GetDeploymentBatchPreview, GetDeploymentPlan,
    GetDeploymentRelations, GetDiscoverySnapshot, GetLlmSafetyCheckResult, GetMarkdownDraft,
    GetProjectAssemblyPlan, GetReconcilePlan, GetRelationshipOverview,
    GetRelationshipRemovalImpact, GetRemovalImpact, GetRollbackImpact,
    GetSaveAsCopyReplacementPreview, GetSkill, GetSkillInsights, GetSkillProvenance,
    GetSkillRelationshipGraph, GetSourceUpdateStatus, GetUiPreference, GetUiPreferenceResult,
    ListCombinations, ListCustomAgents, ListDeploymentTargets, ListDeployments,
    ListDeterministicDuplicates, ListFindings, ListMarkdownFiles, ListPendingItems, ListProjects,
    ListRelationGovernance, ListSavedProjectViews, ListSearchCandidates, ListSkillOperations,
    ListSkillRelationshipCandidates, ListSkillRepos, ListSkills, ListTranslations, ListVersions,
    LlmCheckRun, LlmSafetyCheckResult, LocalAssetResolution, MarkdownDraftSummary,
    MarkdownFileContent, MarkdownFileEntry, PreviewProjectDirectory, ProjectDirectoryPreview,
    ReadMarkdownFile, RelationshipOverview, RelationshipOverviewScope, RelationshipScope,
    ResolveLocalAsset, RollbackImpact, SaveAsCopyReplacementPreview,
    SaveAsCopyReplacementTargetPreview, SearchOnlineSources, SearchOnlineSourcesAssisted,
    SkillDeploymentFilter, SkillInsightCombination, SkillInsightDependency,
    SkillInsightExternalChange, SkillInsightOperationEntry, SkillInsightsResult,
    SkillLifecycleFilter, SkillListFilters, SkillListItem, SkillListPage, SkillListSort,
    SkillOperationEntry, SkillOperationsResult, SkillProvenanceResult, SkillRelationshipCandidate,
    SkillRelationshipGraphResult, SkillResult, SkillSortColumn, SkillSortDirection,
    SkillUpstreamLineage, SkillVersionFilter, SourceUpdateCheckOutcome, SourceUpdateStatus,
    VersionAdoptionRelationImpact, VersionDiffResult, VersionResult,
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
