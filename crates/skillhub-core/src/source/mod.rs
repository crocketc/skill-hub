mod acquisition;
mod model;
pub mod update;

pub use acquisition::{
    AcquiredSource, AcquisitionError, AcquisitionErrorCode, AcquisitionLimits, AcquisitionResult,
    AcquisitionWorkspace, CleanupFailure,
};
pub use model::{
    ParsedSourceInput, SourceDescriptor, SourceErrorCode, SourceInputError, SourceKind,
    SourceLocator,
};
pub use update::{
    AppliedSourceUpdate, SourceState, SourceUpdateBackend, UpdateDecision, UpstreamCheckResult,
};
