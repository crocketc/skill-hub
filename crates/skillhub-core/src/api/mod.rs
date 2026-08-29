mod command;
mod event;
mod query;

pub use crate::deployment::DeploymentPlanRequest;
pub use command::{
    AppCommand, AppCommandResult, ApplySourceUpdate, CheckSourceUpdate, CommitDeployment,
    CommitImport, CommitProjectAssembly, CreateCombination, CreateCustomAgent, CreateSkill,
    PinProjectSkillVersion, PrepareDeployment, PrepareImport, PrepareProjectAssembly,
    ReadSharedProjectConfig, RecheckBasic, RegisterProject, RelinkSource, RemoveCustomAgent,
    RenameSkill, RescanSkill, ResetProfileOverride, RunBasicCheck, RunInitializationScan,
    SaveProjectView, SaveSkillContent, ScanTargets, SetCurrentVersion, SetFindingDisposition,
    SetLifecycle, SetMetadata, SetProfileOverride, SetProjectTags, SetTrial, UpdateCustomAgent,
    UpdateProject, WriteSharedProjectConfig,
};
pub use event::{AppEvent, FactsChanged};
pub use query::{
    AnalyzeImport, AppQuery, AppQueryResult, BasicCheckResult, CombinationResult, DiffVersions,
    FindingResult, GetBasicCheckResult, GetBootstrapSnapshot, GetDeploymentPlan,
    GetDeploymentRelations, GetDiscoverySnapshot, GetProjectAssemblyPlan, GetSkill,
    ListCombinations, ListCustomAgents, ListDeployments, ListFindings, ListPendingItems,
    ListProjects, ListSavedProjectViews, ListVersions, SearchOnlineSources, SkillResult,
    VersionDiffResult, VersionResult,
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
