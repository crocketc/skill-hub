use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use async_trait::async_trait;
use reqwest::Client;
use sha2::{Digest, Sha256};
use skillhub_core::{
    validate_official_artifact_url, AppError, AppResult, ErrorCode, RecoveryAction, Severity,
    UpdateArtifact, UpdateManifest, UpdatePlatform,
};
use tempfile::Builder;
use url::Url;

pub const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DownloadedUpdate {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

#[async_trait]
pub trait UpdateDownloadProvider {
    async fn fetch_manifest(
        &self,
        repository: &str,
        platform: &UpdatePlatform,
    ) -> AppResult<UpdateManifest>;

    async fn download<P>(
        &self,
        artifact: &UpdateArtifact,
        destination: &Path,
        progress: P,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<DownloadedUpdate>
    where
        P: FnMut(u64) + Send;
}

pub async fn download_artifact<P>(
    client: &Client,
    artifact: &UpdateArtifact,
    destination: &Path,
    progress: P,
    cancel: Arc<AtomicBool>,
) -> AppResult<DownloadedUpdate>
where
    P: FnMut(u64) + Send,
{
    download_artifact_with_policy(
        client,
        artifact,
        destination,
        progress,
        cancel,
        DEFAULT_MAX_DOWNLOAD_BYTES,
        false,
    )
    .await
}

pub async fn download_artifact_for_tests<P>(
    client: &Client,
    artifact: &UpdateArtifact,
    destination: &Path,
    progress: P,
    cancel: Arc<AtomicBool>,
) -> AppResult<DownloadedUpdate>
where
    P: FnMut(u64) + Send,
{
    download_artifact_with_policy(
        client,
        artifact,
        destination,
        progress,
        cancel,
        DEFAULT_MAX_DOWNLOAD_BYTES,
        true,
    )
    .await
}

async fn download_artifact_with_policy<P>(
    client: &Client,
    artifact: &UpdateArtifact,
    destination: &Path,
    mut progress: P,
    cancel: Arc<AtomicBool>,
    max_bytes: u64,
    allow_localhost_downloads: bool,
) -> AppResult<DownloadedUpdate>
where
    P: FnMut(u64) + Send,
{
    validate_download_metadata(artifact)?;
    validate_download_url(&artifact.url, allow_localhost_downloads)?;
    if artifact.size > max_bytes {
        return Err(integrity_error());
    }

    let parent = destination
        .parent()
        .ok_or_else(|| unavailable("download destination must have a parent directory"))?;
    fs::create_dir_all(parent).map_err(|_| unavailable("cannot create update directory"))?;
    let mut temp_file = Builder::new()
        .prefix(".skillhub-update-")
        .tempfile_in(parent)
        .map_err(|_| unavailable("cannot create temporary update package"))?;
    let temp_path = temp_file.path().to_owned();

    let result = async {
        let mut response = client
            .get(&artifact.url)
            .send()
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        if response.status().as_u16() == 429 {
            return Err(
                AppError::new(ErrorCode::SourceSearchRateLimited, Severity::Warning)
                    .with_action(RecoveryAction::Retry),
            );
        }
        if !response.status().is_success() {
            return Err(unavailable(format!(
                "download returned {}",
                response.status()
            )));
        }
        if response.content_length().is_some_and(|content_length| {
            content_length > artifact.size || content_length > max_bytes
        }) {
            return Err(integrity_error());
        }

        let mut bytes = 0_u64;
        let mut hasher = Sha256::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| unavailable(error.to_string()))?
        {
            if cancel.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
            bytes = bytes
                .checked_add(chunk.len() as u64)
                .ok_or_else(integrity_error)?;
            if bytes > artifact.size || bytes > max_bytes {
                return Err(integrity_error());
            }
            temp_file
                .write_all(&chunk)
                .map_err(|_| unavailable("cannot write temporary update package"))?;
            hasher.update(&chunk);
            progress(bytes);
            if cancel.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
        }
        temp_file
            .flush()
            .map_err(|_| unavailable("cannot flush temporary update package"))?;

        let sha256 = format!("{:x}", hasher.finalize());
        if bytes != artifact.size || sha256 != artifact.sha256 {
            return Err(integrity_error());
        }

        Ok(DownloadedUpdate {
            path: destination.to_owned(),
            bytes,
            sha256,
        })
    }
    .await;

    match result {
        Ok(downloaded) => {
            temp_file
                .persist(destination)
                .map_err(|_| unavailable("cannot persist update package"))?;
            Ok(downloaded)
        }
        Err(error) => {
            drop(temp_file);
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

pub fn validate_download_metadata(artifact: &UpdateArtifact) -> AppResult<()> {
    if !is_lower_hex_sha256(&artifact.sha256) {
        return Err(integrity_error());
    }
    if artifact.signature.is_empty() {
        return Err(AppError::new(
            ErrorCode::ApplicationUpdateSignatureMissing,
            Severity::Error,
        ));
    }
    Ok(())
}

pub fn validate_download_url(value: &str, allow_localhost_downloads: bool) -> AppResult<()> {
    if validate_official_artifact_url(value).is_ok() {
        return Ok(());
    }
    if allow_localhost_downloads && is_localhost_http(value) {
        return Ok(());
    }
    Err(invalid_url())
}

pub fn is_localhost_http(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "http"
        && url
            .host_str()
            .is_some_and(|host| host == "127.0.0.1" || host == "localhost")
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid_url() -> AppError {
    AppError::new(
        ErrorCode::ApplicationUpdateInvalidArtifactUrl,
        Severity::Error,
    )
}

fn integrity_error() -> AppError {
    AppError::new(ErrorCode::ApplicationUpdateIntegrityFailed, Severity::Error)
}

fn cancelled() -> AppError {
    AppError::new(
        ErrorCode::ApplicationUpdateDownloadCancelled,
        Severity::Info,
    )
    .with_action(RecoveryAction::Acknowledge)
}

fn unavailable(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Retry)
}
