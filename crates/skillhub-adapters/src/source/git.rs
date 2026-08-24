use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use gix as _;
use skillhub_core::source::{AcquiredSource, AcquisitionLimits, AcquisitionWorkspace};
use url::Url;

use super::http::{SourceFetchError, SourceFetchErrorCode, SourceFetchResult, SourceFetcher};

#[derive(Clone, Debug, Default)]
pub struct GixSourceFetcher {
    limits: AcquisitionLimits,
}

impl GixSourceFetcher {
    pub fn new(limits: AcquisitionLimits) -> Self {
        Self { limits }
    }

    pub async fn fetch<U: AsRef<str>>(&self, source: U) -> SourceFetchResult<AcquiredSource> {
        let value = source.as_ref().to_owned();
        let path = local_path(&value).ok_or_else(|| {
            SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "only explicitly selected local Git repositories are supported by this fetcher",
            )
        })?;
        self.fetch_local(path)
    }

    fn fetch_local(&self, repository: PathBuf) -> SourceFetchResult<AcquiredSource> {
        if !repository.is_dir() {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git source is not a directory",
            ));
        }
        gix::discover(&repository).map_err(|error| {
            SourceFetchError::new(SourceFetchErrorCode::GitFetchFailed, error.to_string())
        })?;
        let mut workspace = AcquisitionWorkspace::new().map_err(map_acquisition_error)?;
        workspace.begin().map_err(map_acquisition_error)?;
        let result = copy_worktree(&repository, workspace.root(), &self.limits);
        match result {
            Ok((entries, bytes)) => Ok(AcquiredSource::new(workspace, entries, bytes)),
            Err(error) => {
                let _ = workspace.cleanup();
                Err(error)
            }
        }
    }
}

#[async_trait]
impl SourceFetcher for GixSourceFetcher {
    async fn fetch(&self, url: &str) -> SourceFetchResult<AcquiredSource> {
        GixSourceFetcher::fetch(self, url).await
    }
}

fn local_path(value: &str) -> Option<PathBuf> {
    if Path::new(value).exists() {
        return Some(PathBuf::from(value));
    }
    if let Ok(url) = Url::parse(value) {
        if url.scheme() != "file" {
            return None;
        }
        return url.to_file_path().ok();
    }
    Some(PathBuf::from(value))
}

fn copy_worktree(
    repository: &Path,
    destination: &Path,
    limits: &AcquisitionLimits,
) -> SourceFetchResult<(u64, u64)> {
    let mut entries = 0_u64;
    let mut bytes = 0_u64;
    copy_directory(repository, destination, limits, &mut entries, &mut bytes)?;
    Ok((entries, bytes))
}

fn copy_directory(
    source: &Path,
    destination: &Path,
    limits: &AcquisitionLimits,
    entries: &mut u64,
    bytes: &mut u64,
) -> SourceFetchResult<()> {
    fs::create_dir_all(destination).map_err(io_error)?;
    for item in fs::read_dir(source).map_err(io_error)? {
        let item = item.map_err(io_error)?;
        let name = item.file_name();
        if name == ".git" {
            continue;
        }
        let source_path = item.path();
        let destination_path = destination.join(&name);
        let metadata = fs::symlink_metadata(&source_path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git worktree contains an unsupported symbolic link",
            ));
        }
        if metadata.is_dir() {
            copy_directory(&source_path, &destination_path, limits, entries, bytes)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git worktree contains a special file",
            ));
        }
        *entries = entries.checked_add(1).ok_or_else(|| {
            SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git entry count overflowed",
            )
        })?;
        if *entries > limits.max_entries {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git source contains too many files",
            ));
        }
        let length = metadata.len();
        if length > limits.max_file_bytes {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::DownloadSizeLimit,
                "Git file exceeds the configured size limit",
            ));
        }
        *bytes = bytes.checked_add(length).ok_or_else(|| {
            SourceFetchError::new(
                SourceFetchErrorCode::DownloadSizeLimit,
                "Git source size overflowed",
            )
        })?;
        if *bytes > limits.max_expanded_bytes {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::DownloadSizeLimit,
                "Git source exceeds the configured size limit",
            ));
        }
        fs::copy(source_path, destination_path).map_err(io_error)?;
    }
    Ok(())
}

fn io_error(error: impl fmt::Display) -> SourceFetchError {
    SourceFetchError::new(SourceFetchErrorCode::GitFetchFailed, error.to_string())
}

fn map_acquisition_error(error: skillhub_core::source::AcquisitionError) -> SourceFetchError {
    SourceFetchError::new(SourceFetchErrorCode::AcquisitionFailed, error.to_string())
}
