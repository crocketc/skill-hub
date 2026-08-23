pub mod api;
pub mod catalog;
mod error;
mod ids;
mod operation;
mod path_policy;

pub use api::{
    AppCommand, AppCommandResult, AppEvent, AppQuery, AppQueryResult, ApplicationFacade,
    BootstrapSnapshot, FactsChanged, Page,
};
pub use error::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
pub use operation::{OperationPhase, OperationProgress, OperationSummary};
pub use path_policy::{AllowedRoot, AllowedRootId, PathPolicy, SafePath};

pub use catalog::{LibraryManifest, LibraryPaths, PortableSkillRecord};
pub use ids::{
    AgentProfileId, ClientInstanceId, CombinationId, DeploymentId, LogicalTargetId, OperationId,
    PhysicalTargetId, ProjectId, SkillId, VersionId,
};
