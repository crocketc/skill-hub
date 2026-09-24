//! Relationship probe surface (plan Task 5A).

pub mod filesystem_probe;

pub use filesystem_probe::{categorize_io_error, FilesystemRelationshipProbe};
