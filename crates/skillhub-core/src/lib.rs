pub mod agent;
pub mod api;
pub mod application;
pub mod bootstrap;
pub mod catalog;
pub mod check;
pub mod deployment;
mod error;
mod ids;
pub mod import;
mod operation;
mod path_policy;
pub mod pending;
pub mod project;
pub mod scan;
pub mod search;
pub mod source;
pub mod versioning;

pub use agent::{
    AgentClient, AgentProfile, AgentRepository, CallPolicy, ClientInstance, ClientKind,
    ClientPresence, CustomAgent, CustomAgentDraft, CustomAgentOverride, CustomAgentValidationError,
    DeploymentCapability, DirectoryPrecedence, DiscoverySnapshot, LogicalTarget, OperatingSystem,
    PathCandidate, PathGrant, PathGrantResolver, PhysicalTarget, ProfileCatalog, ResolvedPathGrant,
    TargetScope,
};
pub use api::{
    AppCommand, AppCommandResult, AppEvent, AppQuery, AppQueryResult, ApplicationFacade,
    FactsChanged, GetDeploymentPlan, GetProjectAssemblyPlan, Page,
};
pub use application::{
    BasicCheckOutput, BasicCheckScanner, CheckService, OperationService, ProjectAssemblyService,
    VersionMaterializer,
};
pub use application::{WatchConfirmation, WatchHint, WatchHintKind, WatchService};
pub use bootstrap::{
    BootstrapSnapshot, DeploymentChartCategory, DeploymentDimension, PendingSummary,
    RecentOperationSummary, StartupRecoveryState,
};
pub use error::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
pub use operation::{
    InverseOperation, OperationContext, OperationJournal, OperationObjectResult, OperationPhase,
    OperationProgress, OperationRecord, OperationRepository, OperationStatus, OperationSummary,
    UndoPlan,
};
pub use path_policy::{physical_id_for_path, AllowedRoot, AllowedRootId, PathPolicy, SafePath};

pub use catalog::{LibraryManifest, LibraryPaths, PortableSkillRecord};
pub use deployment::{
    DeploymentCapabilities, DeploymentMode, DeploymentPlan, DeploymentPlanInput,
    DeploymentPlanRequest, DeploymentPlanner, DeploymentRecord, DeploymentRepository,
    DeploymentRequest, DeploymentState, ExistingDeployment, ExistingOwnership,
    RegisteredTargetIndex, RegisteredTargetResolver, TargetCapabilities, TargetChange,
    TargetConflict, TargetConflictReason, TargetFact, TargetFactSource, TargetPlan, VerifiedTarget,
};
pub use ids::{
    AgentProfileId, ClientInstanceId, CombinationId, DeploymentId, LogicalTargetId, OperationId,
    PhysicalTargetId, ProjectId, SkillId, VersionId,
};
pub use import::{CandidateOwnership, ImportAction, ImportCandidate};
pub use project::{
    AssemblyChoice, AssemblyConflictKind, AssemblyItemPlan, AssemblyItemStatus, AssemblyPlan,
    CheckPreparation, CheckPreparationPort, DeploymentPreparation, DeploymentPreparationPort,
    PortableSource, Project, ProjectMetadata, ProjectRepository, ProjectTag, SavedProjectView,
    SharedProjectConfig, SharedSkillRequirement, SkillResolution, SkillResolutionPort,
    SourcePreparation, SourcePreparationPort,
};
pub use scan::{DiscoveredSkill, ScanGeneration, ScanIssue, ScanRepository, ScanResult, ScanScope};
pub use versioning::{FileEntry, VersionDiff, VersionManifest, VersionRecord, VersionRepository};
