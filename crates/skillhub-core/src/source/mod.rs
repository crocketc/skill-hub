mod acquisition;
pub mod discovery;
mod model;
pub mod repo;
pub mod update;

pub use acquisition::{
    AcquiredSource, AcquisitionError, AcquisitionErrorCode, AcquisitionLimits, AcquisitionResult,
    AcquisitionWorkspace, CleanupFailure,
};
pub use discovery::{SourceSearchHit, SourceSearchPage, SourceSearchQuery};
pub use model::{
    ParsedSourceInput, SourceDescriptor, SourceErrorCode, SourceInputError, SourceKind,
    SourceLocator,
};
pub use repo::{
    AgentsLockEntry, DiscoverableRepoSkill, DownloadedRepoSkill, RepoDiscoveryReport,
    RepoDiscoveryWarning, SkillRepo,
};
pub use update::{
    AppliedSourceUpdate, SourceState, SourceUpdateBackend, UpdateDecision, UpstreamCheckResult,
};
