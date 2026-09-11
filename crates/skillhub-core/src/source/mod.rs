mod acquisition;
pub mod discovery;
mod model;
pub mod repo;
mod role;
pub mod update;

pub use acquisition::{
    AcquiredSource, AcquisitionError, AcquisitionErrorCode, AcquisitionLimits, AcquisitionResult,
    AcquisitionWorkspace, CleanupFailure,
};
pub use discovery::{SearchHitOrigin, SourceSearchHit, SourceSearchPage, SourceSearchQuery};
pub use model::{
    ParsedSourceInput, SourceDescriptor, SourceErrorCode, SourceInputError, SourceKind,
    SourceLocator,
};
pub use repo::{
    AgentsLockEntry, DiscoverableRepoSkill, DownloadedRepoSkill, RepoDiscoveryReport,
    RepoDiscoveryWarning, SkillRepo, UpstreamOrigin,
};
pub use role::{SearchCandidateRecord, SearchCandidateStatus, SourceRecord, SourceRole};
pub use update::{
    AppliedSourceUpdate, SourceState, SourceUpdateBackend, UpdateDecision, UpstreamCheckResult,
};
