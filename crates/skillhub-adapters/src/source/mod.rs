mod acquisition;
mod agents_lock;
mod archive;
mod git;
mod http;
mod parser;
mod redirect_policy;
mod repo_discovery;
mod repo_ref;
mod skills_sh;

pub use acquisition::{
    AcquiredSource, AcquisitionError, AcquisitionErrorCode, AcquisitionLimits, AcquisitionResult,
    AcquisitionWorkspace, CleanupFailure,
};
pub use agents_lock::{agents_lock_path, parse_agents_lock, read_agents_lock, AgentsLockEntry};
pub use archive::ArchiveExtractor;
pub use git::GixSourceFetcher;
pub use http::{
    HttpsSourceFetcher, SourceFetchError, SourceFetchErrorCode, SourceFetchResult, SourceFetcher,
};
pub use parser::SourceInputParser;
pub use redirect_policy::RedirectPolicy;
pub use repo_discovery::{
    cleanup_stale_downloads, stale_download_retention, RepoDiscovery, RepoDiscoveryProvider,
};
pub use skills_sh::SkillsShProvider;
