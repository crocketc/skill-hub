use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use gix::bstr::ByteSlice;
use skillhub_core::source::{AcquiredSource, AcquisitionLimits, AcquisitionWorkspace};
use tempfile::tempdir;
use tokio::task::spawn_blocking;
use tokio::time::{sleep, timeout, Duration, Instant};
use url::Url;

use super::archive::ArchiveExtractor;
use super::http::{
    cleanup_fetch_error, HttpsSourceFetcher, SourceFetchError, SourceFetchErrorCode,
    SourceFetchResult, SourceFetcher,
};
use super::redirect_policy::RedirectPolicy;

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
        if let Ok(url) = Url::parse(&value) {
            if url.scheme() == "https" {
                let policy = RedirectPolicy::default();
                policy
                    .validate(&url)
                    .map_err(|code| SourceFetchError::new(code, "Git source URL is not allowed"))?;
                policy.validate_resolved(&url).await.map_err(|code| {
                    SourceFetchError::new(code, "Git source destination is not allowed")
                })?;
                let archive_url = repository_archive_url(&url).ok_or_else(|| {
                    SourceFetchError::new(
                        SourceFetchErrorCode::GitFetchFailed,
                        "HTTPS Git is supported only for canonical GitHub/GitLab repositories",
                    )
                })?;
                return self.fetch_https_archive(archive_url).await;
            }
        }
        let clone_workspace = if Path::new(&value).is_dir() {
            None
        } else {
            Some(tempdir().map_err(|error| git_error(error.to_string()))?)
        };
        let clone_path = clone_workspace
            .as_ref()
            .map(|workspace| workspace.path().to_path_buf());
        let stop = Arc::new(AtomicBool::new(false));
        let task_stop = Arc::clone(&stop);
        let fetcher = self.clone();
        let mut task =
            spawn_blocking(move || fetcher.fetch_sync(&value, &task_stop, clone_path.as_deref()));
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            tokio::select! {
                result = &mut task => {
                    return result.map_err(|error| SourceFetchError::new(SourceFetchErrorCode::GitFetchFailed, error.to_string()))?;
                }
                _ = sleep(Duration::from_millis(50)) => {
                    if let Some(clone_path) = clone_workspace.as_ref().map(|workspace| workspace.path()) {
                        if directory_size(clone_path) > self.limits.max_expanded_bytes {
                            cancel_git_task(&mut task, &stop).await;
                            return Err(SourceFetchError::new(SourceFetchErrorCode::DownloadSizeLimit, "Git download exceeds the configured size limit"));
                        }
                    }
                    if Instant::now() >= deadline {
                        cancel_git_task(&mut task, &stop).await;
                        return Err(SourceFetchError::new(SourceFetchErrorCode::Timeout, "Git fetch timed out"));
                    }
                }
            }
        }
    }

    async fn fetch_https_archive(&self, archive_url: Url) -> SourceFetchResult<AcquiredSource> {
        let downloaded = HttpsSourceFetcher::new(self.limits.clone())
            .fetch(archive_url)
            .await?;
        let archive_path = downloaded.root().join("source.zip");
        std::fs::rename(downloaded.root().join("source"), &archive_path).map_err(|error| {
            SourceFetchError::new(SourceFetchErrorCode::AcquisitionFailed, error.to_string())
        })?;
        ArchiveExtractor::new(self.limits.clone())
            .extract(archive_path)
            .map_err(SourceFetchError::from)
    }

    fn fetch_sync(
        &self,
        value: &str,
        stop: &AtomicBool,
        clone_path: Option<&Path>,
    ) -> SourceFetchResult<AcquiredSource> {
        if Path::new(value).is_dir() {
            return self.fetch_repository(Path::new(value), stop);
        }

        let url = Url::parse(value).map_err(git_error)?;
        self.fetch_remote(
            &url,
            stop,
            clone_path.ok_or_else(|| git_error("missing clone workspace"))?,
        )
    }

    fn fetch_repository(
        &self,
        repository: &Path,
        stop: &AtomicBool,
    ) -> SourceFetchResult<AcquiredSource> {
        let repo = gix::discover(repository).map_err(git_error)?;
        self.materialize(repo, stop)
    }

    fn fetch_remote(
        &self,
        url: &Url,
        stop: &AtomicBool,
        clone_path: &Path,
    ) -> SourceFetchResult<AcquiredSource> {
        if url.scheme() != "file" {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::GitFetchFailed,
                "SSH and git:// remotes are disabled; use a local path, file:// URL, or GitHub/GitLab HTTPS repository",
            ));
        }
        let mut prepare = gix::clone::PrepareFetch::new(
            url.as_str(),
            clone_path,
            gix::create::Kind::WithWorktree,
            Default::default(),
            Default::default(),
        )
        .map_err(git_error)?;
        prepare = prepare.with_shallow(gix::remote::fetch::Shallow::DepthAtRemote(
            std::num::NonZeroU32::new(1).expect("one is non-zero"),
        ));
        // Git's normal global configuration is untrusted input here.  Do not allow it to
        // route the clone through a user-controlled proxy. HTTPS Git is rejected above because
        // gix cannot pin the address checked by RedirectPolicy; file/SSH/git transports do not
        // use the HTTP redirect setting.
        prepare = prepare.with_in_memory_config_overrides([
            "http.proxy=",
            "gitoxide.http.proxy=",
            "gitoxide.http.allProxy=",
            "gitoxide.http.noProxy=*",
            "http.followRedirects=false",
        ]);
        let (repo, _) = prepare
            .fetch_only(gix::progress::Discard, stop)
            .map_err(git_error)?;
        self.materialize(repo, stop)
    }

    fn materialize(
        &self,
        repo: gix::Repository,
        stop: &AtomicBool,
    ) -> SourceFetchResult<AcquiredSource> {
        let workspace = AcquisitionWorkspace::new().map_err(SourceFetchError::from)?;
        workspace.begin().map_err(SourceFetchError::from)?;
        let result = repo
            .head_tree()
            .map_err(git_error)
            .and_then(|tree| materialize_tree(&tree, workspace.root(), &self.limits, stop));
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
    stop: &AtomicBool,
) -> SourceFetchResult<(u64, u64)> {
    std::fs::create_dir_all(destination).map_err(io_error)?;
    let mut entries = 0_u64;
    let mut bytes = 0_u64;
    for entry in tree.iter() {
        if stop.load(Ordering::Relaxed) {
            return Err(SourceFetchError::new(
                SourceFetchErrorCode::Timeout,
                "Git fetch was cancelled",
            ));
        }
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
            let (child_entries, child_bytes) = materialize_tree(&child, &target, limits, stop)?;
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
            if entries > limits.max_entries {
                return Err(SourceFetchError::new(
                    SourceFetchErrorCode::GitFetchFailed,
                    "Git source contains too many files",
                ));
            }
            if bytes > limits.max_expanded_bytes {
                return Err(SourceFetchError::new(
                    SourceFetchErrorCode::DownloadSizeLimit,
                    "Git source exceeds the configured size limit",
                ));
            }
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
        || is_windows_device_name(name)
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

fn is_windows_device_name(name: &str) -> bool {
    let stem = name
        .trim_end_matches([' ', '.'])
        .split_once('.')
        .map_or(name, |(stem, _)| stem)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(bytes[3], b'1'..=b'9')
}

fn git_error(error: impl std::fmt::Display) -> SourceFetchError {
    SourceFetchError::new(SourceFetchErrorCode::GitFetchFailed, error.to_string())
}

fn io_error(error: impl std::fmt::Display) -> SourceFetchError {
    git_error(error)
}

async fn cancel_git_task(
    task: &mut tokio::task::JoinHandle<SourceFetchResult<AcquiredSource>>,
    stop: &AtomicBool,
) {
    stop.store(true, Ordering::SeqCst);
    // gix checks this flag while receiving and indexing.  Wait for it to unwind instead of
    // dropping the JoinHandle and leaving a clone writing into a soon-to-be-deleted tempdir.
    if timeout(Duration::from_secs(1), &mut *task).await.is_err() {
        // A blocking task cannot be force-killed, but abort prevents any not-yet-started task
        // from running and the interrupt flag remains set for an already-running gix fetch.
        task.abort();
    }
}

fn directory_size(root: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                return 0;
            };
            if metadata.is_dir() {
                directory_size(&path)
            } else {
                metadata.len()
            }
        })
        .fold(0_u64, u64::saturating_add)
}

fn repository_archive_url(url: &Url) -> Option<Url> {
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let is_github = host.eq_ignore_ascii_case("github.com");
    let is_gitlab = host.eq_ignore_ascii_case("gitlab.com");
    if !is_github && !is_gitlab {
        return None;
    }
    let mut segments = url.path_segments()?.filter(|segment| !segment.is_empty());
    let mut path = Vec::new();
    for segment in segments.by_ref() {
        path.push(segment.trim_end_matches(".git"));
    }
    if (is_github && path.len() != 2) || (is_gitlab && path.len() < 2) {
        return None;
    }
    if path.iter().any(|segment| {
        segment.is_empty()
            || matches!(*segment, "." | "..")
            || !segment.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'@' | b'.')
            })
    }) {
        return None;
    }
    let repository = path.last()?;
    let archive_path = if is_github {
        format!("/{}/archive/HEAD.zip", path.join("/"))
    } else {
        format!("/{}/-/archive/HEAD/{}-HEAD.zip", path.join("/"), repository)
    };
    let mut archive_url = Url::parse(&format!("https://{host}{archive_path}")).ok()?;
    archive_url.set_query(None);
    archive_url.set_fragment(None);
    Some(archive_url)
}

#[cfg(test)]
mod tests {
    use super::{is_windows_device_name, repository_archive_url};
    use url::Url;

    #[test]
    fn rejects_windows_reserved_device_names_with_extensions() {
        for name in [
            "CON", "PRN.txt", "AUX.", "NUL ", "COM1", "COM9.md", "LPT1", "LPT9.log",
        ] {
            assert!(is_windows_device_name(name), "{name} must be rejected");
        }
        for name in ["COM0", "LPT0", "COM10", "LPT10", "content.txt"] {
            assert!(!is_windows_device_name(name), "{name} is not reserved");
        }
    }

    #[test]
    fn gix_http_redirect_override_uses_a_valid_boolean_value() {
        let parsed = gix::config::tree::Http::FOLLOW_REDIRECTS
            .try_into_follow_redirects(b"false", || Ok(Some(false)));
        assert!(parsed.is_ok());
    }

    #[test]
    fn canonical_repositories_use_controlled_archive_urls() {
        let github =
            repository_archive_url(&Url::parse("https://github.com/owner/repo.git").unwrap());
        assert_eq!(
            github.unwrap().as_str(),
            "https://github.com/owner/repo/archive/HEAD.zip"
        );
        let gitlab =
            repository_archive_url(&Url::parse("https://gitlab.com/group/sub/repo").unwrap());
        assert_eq!(
            gitlab.unwrap().as_str(),
            "https://gitlab.com/group/sub/repo/-/archive/HEAD/repo-HEAD.zip"
        );
        assert!(repository_archive_url(
            &Url::parse("https://github.com/owner.name/repo.name").unwrap()
        )
        .is_some());
        assert!(
            repository_archive_url(&Url::parse("https://example.com/owner/repo").unwrap())
                .is_none()
        );
    }
}
