pub mod custom;
pub mod discovery;
pub mod profile;
pub mod target;

pub use custom::{
    CustomAgent, CustomAgentDraft, CustomAgentOverride, CustomAgentValidationError, PathGrant,
    PathGrantResolver, ResolvedPathGrant,
};
pub use discovery::{
    AgentDirectoryAvailability, AgentDirectoryFact, AgentDirectoryIdentity,
    AgentDirectoryMemberCapabilities, AgentDirectoryMemberFact, AgentDirectoryProjection,
    AgentDirectoryRole, AgentRepository, AgentRootObservation, ClientInstance, ClientPresence,
    DirectoryObservationStatus, DiscoverySnapshot, LogicalTarget, PhysicalTarget,
};
pub use profile::{
    validate_profile_strict, AgentClient, AgentProfile, CallPolicy, ClientKind,
    DeploymentCapability, DirectoryPrecedence, OperatingSystem, ProfileCatalog,
};
pub use target::{PathCandidate, TargetScope};
