mod filesystem;
mod junction_windows;
mod managed_copy;
mod symlink;

pub use filesystem::{AppliedTarget, DeploymentFilesystem, OwnershipProof, PreparedTarget};
