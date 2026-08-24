use std::path::{Component, Path};
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use gix::bstr::ByteSlice;
use skillhub_core::source::{AcquiredSource, AcquisitionLimits, AcquisitionWorkspace};
use tempfile::tempdir;
use tokio::task::spawn_blocking;
use tokio::time::{timeout, Duration};
use url::Url;

use super::http::{
    cleanup_fetch_error, SourceFetchError, SourceFetchErrorCode, SourceFetchResult, SourceFetcher,
};

/// Acquires a Git source with gix and materializes only the selected HEAD tree.
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
        let fetcher = self.clone();
        timeout(
            Duration::from_secs(30),
            spawn_blocking(move || fetcher.fetch_sync(&value)),
        )
        .await
        .map_err(|_| SourceFetchError::new(SourceFetchErrorCode::Timeout, "Git fetch timed out"))?
        .map_err(|error| {
            SourceFetchError::new(SourceFetchErrorCode::GitFetchFailed, error.to_string())
        })?
    }

    fn fetch_sync(&self, value: &str) -> SourceFetchResult<AcquiredSource> {
        if Path::new(value).is_dir() {
            return self.fetch_repository(Path::new(value));
        }

        let url = Url::parse(value).map_err(git_error)?;
        self.fetch_remote(&url)
    }

    fn fetch_repository(&self, repository: &Path) -> SourceFetchResult<AcquiredSource> {
        let repo = gix::discover(repository).map_err(git_error)?;
        self.materialize(repo)
    }

    fn fetch_remote(&self, url: &Url) -> SourceFetchResult<AcquiredSource> {
        if !matches!(url.scheme(), "file" | "https" | "ssh" | "git") {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git source URL uses an unsupported scheme",
            ));
        }
        let clone_workspace = tempdir().map_err(|error| git_error(error.to_string()))?;
        let mut prepare = gix::clone::PrepareFetch::new(
            url.as_str(),
            clone_workspace.path(),
            gix::create::Kind::WithWorktree,
            Default::default(),
            Default::default(),
        )
        .map_err(git_error)?;
        prepare = prepare.with_shallow(gix::remote::fetch::Shallow::DepthAtRemote(
            std::num::NonZeroU32::new(1).expect("one is non-zero"),
        ));
        let stop = AtomicBool::new(false);
        let (repo, _) = prepare
            .fetch_only(gix::progress::Discard, &stop)
            .map_err(git_error)?;
        self.materialize(repo)
    }

    fn materialize(&self, repo: gix::Repository) -> SourceFetchResult<AcquiredSource> {
        let workspace = AcquisitionWorkspace::new().map_err(SourceFetchError::from)?;
        workspace.begin().map_err(SourceFetchError::from)?;
        let result = repo
            .head_tree()
            .map_err(git_error)
            .and_then(|tree| materialize_tree(&tree, workspace.root(), &self.limits));
        match result {
            Ok((entries, bytes)) => Ok(AcquiredSource::new(workspace, entries, bytes)),
            Err(error) => Err(cleanup_fetch_error(workspace, error)),
        }
    }
}

#[async_trait]
impl SourceFetcher for GixSourceFetcher {
    async fn fetch(&self, url: &str) -> SourceFetchResult<AcquiredSource> {
        GixSourceFetcher::fetch(self, url).await
    }
}

fn materialize_tree(
    tree: &gix::Tree<'_>,
    destination: &Path,
    limits: &AcquisitionLimits,
) -> SourceFetchResult<(u64, u64)> {
    std::fs::create_dir_all(destination).map_err(io_error)?;
    let mut entries = 0_u64;
    let mut bytes = 0_u64;
    for entry in tree.iter() {
        let entry = entry.map_err(git_error)?;
        let name = entry
            .filename()
            .to_str()
            .map_err(|error| git_error(error.to_string()))?;
        validate_tree_name(name)?;
        let target = destination.join(name);
        let mode = entry.mode();
        if mode.is_tree() {
            let child = entry.object().map_err(git_error)?.into_tree();
            let (child_entries, child_bytes) = materialize_tree(&child, &target, limits)?;
            entries = entries.checked_add(child_entries).ok_or_else(|| {
                SourceFetchError::new(
                    SourceFetchErrorCode::GitFetchFailed,
                    "Git entry count overflowed",
                )
            })?;
            bytes = bytes.checked_add(child_bytes).ok_or_else(|| {
                SourceFetchError::new(
                    SourceFetchErrorCode::DownloadSizeLimit,
                    "Git source size overflowed",
                )
            })?;
            continue;
        }
        if mode.is_link() || mode.is_commit() || !mode.is_blob() {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git tree contains a symbolic link or submodule",
            ));
        }
        let blob = entry.object().map_err(git_error)?.into_blob();
        let data = &blob.data;
        let length = data.len() as u64;
        if length > limits.max_file_bytes {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::DownloadSizeLimit,
                "Git blob exceeds the configured size limit",
            ));
        }
        entries = entries.checked_add(1).ok_or_else(|| {
            SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git entry count overflowed",
            )
        })?;
        if entries > limits.max_entries {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "Git source contains too many files",
            ));
        }
        bytes = bytes.checked_add(length).ok_or_else(|| {
            SourceFetchError::new(
                SourceFetchErrorCode::DownloadSizeLimit,
                "Git source size overflowed",
            )
        })?;
        if bytes > limits.max_expanded_bytes {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::DownloadSizeLimit,
                "Git source exceeds the configured size limit",
            ));
        }
        std::fs::write(target, data).map_err(io_error)?;
    }
    Ok((entries, bytes))
}

fn validate_tree_name(name: &str) -> SourceFetchResult<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0', ':'])
        || name.ends_with([' ', '.'])
        || matches!(
            name.to_ascii_uppercase().as_str(),
            "CON" | "PRN" | "AUX" | "NUL"
        )
    {
        return Err(SourceFetchError::new(
            SourceFetchErrorCode::GitFetchFailed,
            "Git tree contains an unsafe path",
        ));
    }
    let path = Path::new(name);
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(SourceFetchError::new(
            SourceFetchErrorCode::GitFetchFailed,
            "Git tree contains an unsafe path",
        ));
    }
    Ok(())
}

fn git_error(error: impl std::fmt::Display) -> SourceFetchError {
    SourceFetchError::new(SourceFetchErrorCode::GitFetchFailed, error.to_string())
}

fn io_error(error: impl std::fmt::Display) -> SourceFetchError {
    git_error(error)
}
