mod command;
mod event;
mod query;

pub use crate::deployment::DeploymentPlanRequest;
pub use command::{
    AnalyzeSemanticDuplicates, AppCommand, AppCommandResult, ApplySourceUpdate, CheckSourceUpdate,
    CollectDeploymentChanges, CommitCallPolicyChange, CommitDeleteSkill, CommitDeployment,
    CommitImport, CommitProjectAssembly, CommitRepair, CommitUndeploy, CreateCombination,
    CreateCustomAgent, CreateIgnoreRule, CreateSkill, DetachManagement, GenerateOnlineSearchQuery,
    IgnoreExternalChange, KeepIndependentCopy, PinProjectSkillVersion, PrepareCallPolicyChange,
    PrepareDeleteSkill, PrepareDeployment, PrepareImport, PrepareProjectAssembly, PrepareRepair,
    PrepareUndeploy, ReadSharedProjectConfig, RecheckBasic, RecheckLlmSafety, RegisterProject,
    RelinkSource, RemoveCustomAgent, RemoveIgnoreRule, RenameSkill, RescanSkill,
    ResetProfileOverride, ResolveRecovery, RestoreDeployment, RestoreOriginalCallPolicy,
    RunBasicCheck, RunHealthCheck, RunInitializationScan, RunLlmSafetyCheck, SaveProjectView,
    SaveSkillContent, SaveUserTranslationRevision, ScanTargets, SetCurrentVersion,
    SetFindingDisposition, SetLifecycle, SetMetadata, SetProfileOverride, SetProjectTags, SetTrial,
    TranslateDescription, UpdateCustomAgent, UpdateProject, WriteSharedProjectConfig,
};
pub use event::{AppEvent, FactsChanged};
pub use query::{
    AnalyzeGlobalSkillEvidence, AnalyzeImport, AppQuery, AppQueryResult, BasicCheckResult,
    CombinationResult, DiffVersions, FindingResult, GetBasicCheckResult, GetBootstrapSnapshot,
    GetCallPolicy, GetDeploymentPlan, GetDeploymentRelations, GetDiscoverySnapshot,
    GetLlmSafetyCheckResult, GetProjectAssemblyPlan, GetReconcilePlan, GetRemovalImpact, GetSkill,
    ListCombinations, ListCustomAgents, ListDeployments, ListFindings, ListPendingItems,
    ListProjects, ListSavedProjectViews, ListVersions, LlmSafetyCheckResult, SearchOnlineSources,
    SkillResult, VersionDiffResult, VersionResult,
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
