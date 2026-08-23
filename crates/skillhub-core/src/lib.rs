pub mod api;
pub mod application;
pub mod bootstrap;
pub mod catalog;
mod error;
mod ids;
mod operation;
mod path_policy;
pub mod pending;
pub mod search;
pub mod versioning;

pub use api::{
    AppCommand, AppCommandResult, AppEvent, AppQuery, AppQueryResult, ApplicationFacade,
    FactsChanged, Page,
};
pub use bootstrap::{
    BootstrapSnapshot, PendingSummary, RecentOperationSummary, StartupRecoveryState,
};
pub use error::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
pub use operation::{OperationPhase, OperationProgress, OperationSummary};
pub use path_policy::{AllowedRoot, AllowedRootId, PathPolicy, SafePath};

pub use catalog::{LibraryManifest, LibraryPaths, PortableSkillRecord};
pub use ids::{
    AgentProfileId, ClientInstanceId, CombinationId, DeploymentId, LogicalTargetId, OperationId,
    PhysicalTargetId, ProjectId, SkillId, VersionId,
};
pub use versioning::{FileEntry, VersionDiff, VersionManifest, VersionRecord, VersionRepository};
