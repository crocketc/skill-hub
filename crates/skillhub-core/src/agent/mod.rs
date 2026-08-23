pub mod custom;
pub mod discovery;
pub mod profile;
pub mod target;

pub use custom::{CustomAgent, CustomAgentOverride, CustomAgentValidationError, PathGrant};
pub use discovery::{
    AgentRepository, ClientInstance, ClientPresence, DiscoverySnapshot, LogicalTarget,
    PhysicalTarget,
};
pub use profile::{
    validate_profile_strict, AgentClient, AgentProfile, CallPolicy, ClientKind,
    DeploymentCapability, DirectoryPrecedence, OperatingSystem, ProfileCatalog,
};
pub use target::{PathCandidate, TargetScope};
