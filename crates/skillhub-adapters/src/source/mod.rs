mod acquisition;
mod archive;
mod git;
mod http;
mod parser;
mod redirect_policy;

pub use acquisition::{
    AcquiredSource, AcquisitionError, AcquisitionErrorCode, AcquisitionLimits, AcquisitionResult,
    AcquisitionWorkspace, CleanupFailure,
};
pub use archive::ArchiveExtractor;
pub use git::GixSourceFetcher;
pub use http::{
    HttpsSourceFetcher, SourceFetchError, SourceFetchErrorCode, SourceFetchResult, SourceFetcher,
};
pub use parser::SourceInputParser;
pub use redirect_policy::RedirectPolicy;
