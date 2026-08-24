mod acquisition;
mod model;

pub use acquisition::{
    AcquiredSource, AcquisitionError, AcquisitionErrorCode, AcquisitionLimits, AcquisitionResult,
    AcquisitionWorkspace,
};
pub use model::{
    ParsedSourceInput, SourceDescriptor, SourceErrorCode, SourceInputError, SourceKind,
    SourceLocator,
};
