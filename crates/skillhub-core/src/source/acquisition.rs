use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::fmt;
use std::path::{Path, PathBuf};
use tempfile::{tempdir, TempDir};

/// Bounds applied while acquiring untrusted source content.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcquisitionLimits {
    pub max_entries: u64,
    pub max_expanded_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for AcquisitionLimits {
    fn default() -> Self {
        Self {
            max_entries: 10_000,
            max_expanded_bytes: 256 * 1024 * 1024,
            max_file_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum AcquisitionErrorCode {
    #[serde(rename = "source.archive_path_escape")]
    ArchivePathEscape,
    #[serde(rename = "source.archive_entry_limit")]
    ArchiveEntryLimit,
    #[serde(rename = "source.expanded_size_limit")]
    ExpandedSizeLimit,
    #[serde(rename = "source.archive_file_size_limit")]
    ArchiveFileSizeLimit,
    #[serde(rename = "source.archive_format_invalid")]
    ArchiveFormatInvalid,
    #[serde(rename = "source.acquisition_io")]
    AcquisitionIo,
    #[serde(rename = "source.workspace_unavailable")]
    WorkspaceUnavailable,
}

impl AcquisitionErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ArchivePathEscape => "source.archive_path_escape",
            Self::ArchiveEntryLimit => "source.archive_entry_limit",
            Self::ExpandedSizeLimit => "source.expanded_size_limit",
            Self::ArchiveFileSizeLimit => "source.archive_file_size_limit",
            Self::ArchiveFormatInvalid => "source.archive_format_invalid",
            Self::AcquisitionIo => "source.acquisition_io",
            Self::WorkspaceUnavailable => "source.workspace_unavailable",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AcquisitionError {
    pub code: AcquisitionErrorCode,
    pub message: String,
    pub cleanup_failure: Option<CleanupFailure>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CleanupFailure {
    pub code: AcquisitionErrorCode,
    pub message: String,
}

impl AcquisitionError {
    pub fn new(code: AcquisitionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cleanup_failure: None,
        }
    }

    pub fn with_cleanup_failure(mut self, cleanup: &Self) -> Self {
        self.cleanup_failure = Some(CleanupFailure {
            code: cleanup.code,
            message: cleanup.message.clone(),
        });
        self
    }
}

impl fmt::Display for AcquisitionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)?;
        if let Some(cleanup) = &self.cleanup_failure {
            write!(
                f,
                " (cleanup {}: {})",
                cleanup.code.as_str(),
                cleanup.message
            )?;
        }
        Ok(())
    }
}

impl std::error::Error for AcquisitionError {}

pub type AcquisitionResult<T> = Result<T, AcquisitionError>;

/// A single-use temporary root for one acquisition operation.
pub struct AcquisitionWorkspace {
    tempdir: Option<TempDir>,
    root: PathBuf,
    used: Cell<bool>,
}

impl AcquisitionWorkspace {
    pub fn new() -> AcquisitionResult<Self> {
        let tempdir = tempdir().map_err(|error| {
            AcquisitionError::new(AcquisitionErrorCode::AcquisitionIo, error.to_string())
        })?;
        let root = tempdir.path().to_path_buf();
        Ok(Self {
            tempdir: Some(tempdir),
            root,
            used: Cell::new(false),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_available(&self) -> bool {
        self.tempdir.is_some() && self.root.is_dir()
    }

    pub fn begin(&self) -> AcquisitionResult<()> {
        if self.used.replace(true) || !self.is_available() {
            return Err(AcquisitionError::new(
                AcquisitionErrorCode::WorkspaceUnavailable,
                "acquisition workspace has already been consumed",
            ));
        }
        Ok(())
    }

    /// Removes the workspace immediately. A workspace is deliberately not reusable.
    pub fn cleanup(&mut self) -> AcquisitionResult<()> {
        let Some(tempdir) = self.tempdir.take() else {
            return Err(AcquisitionError::new(
                AcquisitionErrorCode::WorkspaceUnavailable,
                "acquisition workspace has already been consumed",
            ));
        };
        self.used.set(true);
        tempdir.close().map_err(|error| {
            AcquisitionError::new(AcquisitionErrorCode::AcquisitionIo, error.to_string())
        })
    }

    pub fn cleanup_root(&self) -> AcquisitionResult<()> {
        std::fs::remove_dir_all(&self.root).map_err(|error| {
            AcquisitionError::new(AcquisitionErrorCode::AcquisitionIo, error.to_string())
        })
    }
}

impl fmt::Debug for AcquisitionWorkspace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AcquisitionWorkspace")
            .field("root", &self.root)
            .field("available", &self.is_available())
            .finish()
    }
}

/// Content acquired into a workspace. Keeping the workspace here prevents a
/// successful extraction from being deleted when the extractor returns.
pub struct AcquiredSource {
    workspace: AcquisitionWorkspace,
    pub root: PathBuf,
    entry_count: u64,
    expanded_bytes: u64,
}

impl AcquiredSource {
    pub fn new(workspace: AcquisitionWorkspace, entry_count: u64, expanded_bytes: u64) -> Self {
        Self {
            root: workspace.root().to_path_buf(),
            workspace,
            entry_count,
            expanded_bytes,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn entry_count(&self) -> u64 {
        self.entry_count
    }

    pub fn expanded_bytes(&self) -> u64 {
        self.expanded_bytes
    }

    pub fn workspace(&self) -> &AcquisitionWorkspace {
        &self.workspace
    }
}

impl fmt::Debug for AcquiredSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AcquiredSource")
            .field("root", &self.root())
            .field("entry_count", &self.entry_count)
            .field("expanded_bytes", &self.expanded_bytes)
            .finish()
    }
}
