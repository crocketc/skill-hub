mod command;
mod event;
mod query;

pub use crate::deployment::DeploymentPlanRequest;
pub use command::{
    AppCommand, AppCommandResult, CommitProjectAssembly, CreateCombination, CreateCustomAgent,
    CreateSkill, PinProjectSkillVersion, PrepareProjectAssembly, ReadSharedProjectConfig,
    RegisterProject, RemoveCustomAgent, RenameSkill, RescanSkill, ResetProfileOverride,
    RunInitializationScan, SaveProjectView, SaveSkillContent, ScanTargets, SetCurrentVersion,
    SetLifecycle, SetMetadata, SetProfileOverride, SetProjectTags, SetTrial, UpdateCustomAgent,
    UpdateProject, WriteSharedProjectConfig,
};
pub use event::{AppEvent, FactsChanged};
pub use query::{
    AppQuery, AppQueryResult, CombinationResult, DiffVersions, GetBootstrapSnapshot,
    GetDeploymentPlan, GetDiscoverySnapshot, GetProjectAssemblyPlan, GetSkill, ListCombinations,
    ListCustomAgents, ListPendingItems, ListProjects, ListSavedProjectViews, ListVersions,
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
