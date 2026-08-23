pub mod discovery;
pub mod profile;
pub mod target;

pub use discovery::{
    AgentRepository, ClientInstance, ClientPresence, DiscoverySnapshot, LogicalTarget,
    PhysicalTarget,
};
pub use profile::{
    AgentClient, AgentProfile, CallPolicy, ClientKind, DeploymentCapability, DirectoryPrecedence,
    OperatingSystem, ProfileCatalog,
};
pub use target::{PathCandidate, TargetScope};
