use reqwest::Client;
use serde::Deserialize;
use skillhub_core::app_update::{
    install_action_for, validate_official_release_url, version_is_newer, ApplicationUpdate,
    BuildTrust, UpdateArtifact, UpdateManifest, UpdatePlatform,
};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use std::path::Path;
use std::sync::{atomic::AtomicBool, Arc};
use url::Url;

use super::download::{
    download_artifact, download_artifact_for_tests, is_localhost_http, validate_download_metadata,
    validate_download_url, DownloadedUpdate, UpdateDownloadProvider,
};

const DEFAULT_API_BASE: &str = "https://api.github.com/";
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;

pub struct GithubReleaseProvider {
    client: Client,
    api_base: Url,
    network_enabled: bool,
    allow_localhost_downloads: bool,
}

impl GithubReleaseProvider {
    pub fn new() -> Self {
        Self::with_api_base(DEFAULT_API_BASE).expect("default GitHub API URL is valid")
    }

    pub fn with_api_base(value: &str) -> AppResult<Self> {
        let api_base = Url::parse(value).map_err(|_| unavailable("invalid API base URL"))?;
        let local_test_base = api_base.scheme() == "http"
            && api_base
                .host_str()
                .is_some_and(|host| host == "127.0.0.1" || host == "localhost");
        if api_base.scheme() != "https" && !local_test_base {
            return Err(unavailable("GitHub API requires HTTPS"));
        }
        Ok(Self {
            client: Client::builder()
                .user_agent("SkillHub application update checker")
                .build()
                .map_err(|_| unavailable("cannot create HTTP client"))?,
            api_base,
            network_enabled: true,
            allow_localhost_downloads: false,
        })
    }

    pub fn with_download_base_for_tests(api_base: &str, download_base: &str) -> AppResult<Self> {
        let download_base =
            Url::parse(download_base).map_err(|_| unavailable("invalid download base URL"))?;
        if !is_localhost_http(download_base.as_str()) {
            return Err(unavailable("test download base must be localhost HTTP"));
        }
        Ok(Self {
            allow_localhost_downloads: true,
            ..Self::with_api_base(api_base)?
        })
    }

    pub fn with_network_enabled(mut self, enabled: bool) -> Self {
        self.network_enabled = enabled;
        self
    }

    pub async fn latest(
        &self,
        repository: &str,
        current_version: &str,
        trust: BuildTrust,
    ) -> AppResult<ApplicationUpdate> {
        if !self.network_enabled {
            return Err(AppError::new(ErrorCode::NetworkDisabled, Severity::Info)
                .with_action(RecoveryAction::Acknowledge));
        }
        validate_repository(repository)?;
        let endpoint = self
            .api_base
            .join(&format!("repos/{repository}/releases/latest"))
            .map_err(|_| unavailable("invalid GitHub repository"))?;
        let response = self
            .client
            .get(endpoint)
            .send()
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        if response.status().as_u16() == 404 {
            return Err(unavailable("official release was not found"));
        }
        if !response.status().is_success() {
            return Err(unavailable(format!(
                "GitHub returned {}",
                response.status()
            )));
        }
        let release: GithubRelease = response
            .json()
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        let latest_version = release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name)
            .to_owned();
        let Some(is_newer) = version_is_newer(current_version, &latest_version) else {
            return Err(unavailable("release tag is not semantic versioning"));
        };
        if !validate_official_release_url(&release.html_url) {
            return Err(unavailable("release URL is not an official GitHub page"));
        }
        Ok(ApplicationUpdate {
            available: is_newer,
            current_version: current_version.to_owned(),
            latest_version,
            release_url: release.html_url,
            asset_name: release.assets.into_iter().next().map(|asset| asset.name),
            published_at: release.published_at,
            install_action: install_action_for(trust),
        })
    }
}

#[async_trait::async_trait]
impl UpdateDownloadProvider for GithubReleaseProvider {
    async fn fetch_manifest(
        &self,
        repository: &str,
        platform: &UpdatePlatform,
    ) -> AppResult<UpdateManifest> {
        if !self.network_enabled {
            return Err(AppError::new(ErrorCode::NetworkDisabled, Severity::Info)
                .with_action(RecoveryAction::Acknowledge));
        }
        validate_repository(repository)?;
        let endpoint = self
            .api_base
            .join(&format!("repos/{repository}/releases/latest"))
            .map_err(|_| unavailable("invalid GitHub repository"))?;
        let response = self
            .client
            .get(endpoint)
            .send()
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        if response.status().as_u16() == 404 {
            return Err(unavailable("official release was not found"));
        }
        if response.status().as_u16() == 429 {
            return Err(
                AppError::new(ErrorCode::SourceSearchRateLimited, Severity::Warning)
                    .with_action(RecoveryAction::Retry),
            );
        }
        if !response.status().is_success() {
            return Err(unavailable(format!(
                "GitHub returned {}",
                response.status()
            )));
        }
        let release: GithubManifestRelease = response
            .json()
            .await
            .map_err(|error| unavailable(error.to_string()))?;
        let artifacts = manifest_artifacts(
            &self.client,
            release.assets,
            platform,
            self.allow_localhost_downloads,
        )
        .await?;
        let manifest = UpdateManifest {
            version: release
                .tag_name
                .strip_prefix('v')
                .unwrap_or(&release.tag_name)
                .to_owned(),
            notes: release.body.unwrap_or_default(),
            published_at: release.published_at,
            artifacts,
        };
        skillhub_core::select_artifact(&manifest, platform)?;
        Ok(manifest)
    }

    async fn download<P>(
        &self,
        artifact: &UpdateArtifact,
        destination: &Path,
        progress: P,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<DownloadedUpdate>
    where
        P: FnMut(u64) + Send,
    {
        if !self.network_enabled {
            return Err(AppError::new(ErrorCode::NetworkDisabled, Severity::Info)
                .with_action(RecoveryAction::Acknowledge));
        }
        if self.allow_localhost_downloads {
            download_artifact_for_tests(&self.client, artifact, destination, progress, cancel).await
        } else {
            download_artifact(&self.client, artifact, destination, progress, cancel).await
        }
    }
}

impl Default for GithubReleaseProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

#[derive(Deserialize)]
struct GithubManifestRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubManifestAsset>,
}

#[derive(Deserialize)]
struct GithubManifestAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
    label: Option<String>,
}

async fn manifest_artifacts(
    client: &Client,
    assets: Vec<GithubManifestAsset>,
    platform: &UpdatePlatform,
    allow_localhost_downloads: bool,
) -> AppResult<Vec<UpdateArtifact>> {
    let expected_target = format!("{}-{}", platform.target, platform.arch);
    let package_assets = assets
        .iter()
        .filter(|asset| !asset.name.ends_with(".sig"))
        .filter(|asset| {
            metadata_value(asset.label.as_deref(), "target").as_deref() == Some(&expected_target)
        })
        .collect::<Vec<_>>();
    if package_assets.is_empty() {
        return Err(AppError::new(
            ErrorCode::ApplicationUpdateUnavailable,
            Severity::Warning,
        ));
    }

    let mut artifacts = Vec::with_capacity(package_assets.len());
    for asset in package_assets {
        let signature = match metadata_value(asset.label.as_deref(), "signature") {
            Some(signature) => signature,
            None => {
                fetch_signature_sidecar(client, asset, &assets, allow_localhost_downloads).await?
            }
        };
        let artifact = UpdateArtifact {
            target: expected_target.clone(),
            url: asset.browser_download_url.clone(),
            size: asset.size,
            sha256: parse_sha256(asset.digest.as_deref())?,
            signature,
        };
        validate_download_url(&artifact.url, allow_localhost_downloads)?;
        validate_download_metadata(&artifact)?;
        artifacts.push(artifact);
    }
    Ok(artifacts)
}

async fn fetch_signature_sidecar(
    client: &Client,
    package: &GithubManifestAsset,
    assets: &[GithubManifestAsset],
    allow_localhost_downloads: bool,
) -> AppResult<String> {
    let sidecar_name = format!("{}.sig", package.name);
    let sidecar = assets
        .iter()
        .find(|asset| asset.name == sidecar_name)
        .ok_or_else(signature_missing)?;
    validate_download_url(&sidecar.browser_download_url, allow_localhost_downloads)?;
    if sidecar.size > MAX_SIGNATURE_BYTES {
        return Err(signature_missing());
    }
    let response = client
        .get(&sidecar.browser_download_url)
        .send()
        .await
        .map_err(|error| unavailable(error.to_string()))?;
    if !response.status().is_success() {
        return Err(signature_missing());
    }
    let content_length = response.content_length().unwrap_or(sidecar.size);
    if content_length > MAX_SIGNATURE_BYTES {
        return Err(signature_missing());
    }
    let signature = response
        .text()
        .await
        .map_err(|error| unavailable(error.to_string()))?;
    if signature.is_empty() || signature.len() as u64 > MAX_SIGNATURE_BYTES {
        return Err(signature_missing());
    }
    Ok(signature)
}

fn parse_sha256(value: Option<&str>) -> AppResult<String> {
    value
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(str::to_owned)
        .ok_or_else(|| AppError::new(ErrorCode::ApplicationUpdateIntegrityFailed, Severity::Error))
}

fn signature_missing() -> AppError {
    AppError::new(
        ErrorCode::ApplicationUpdateSignatureMissing,
        Severity::Error,
    )
}

fn metadata_value(metadata: Option<&str>, key: &str) -> Option<String> {
    metadata?
        .split(';')
        .filter_map(|part| part.split_once('='))
        .find_map(|(candidate, value)| (candidate.trim() == key).then(|| value.trim().to_owned()))
        .filter(|value| !value.is_empty())
}

fn validate_repository(value: &str) -> AppResult<()> {
    let mut parts = value.split('/');
    let valid = parts.next().is_some_and(valid_segment)
        && parts.next().is_some_and(valid_segment)
        && parts.next().is_none();
    if valid {
        Ok(())
    } else {
        Err(unavailable("repository must be owner/name"))
    }
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn unavailable(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::ApplicationUpdateUnavailable, Severity::Warning)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use skillhub_core::app_update::InstallAction;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn latest_release_validates_official_url_and_applies_manual_trust_gate() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await;
            let body = r#"{"tag_name":"v0.2.0","html_url":"https://github.com/crocketc/skill-hub/releases/tag/v0.2.0","published_at":"2026-08-29T00:00:00Z","assets":[{"name":"SkillHub_0.2.0_x64.exe"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let provider = GithubReleaseProvider::with_api_base(&format!("http://{address}/")).unwrap();
        let update = provider
            .latest("crocketc/skill-hub", "0.1.0", BuildTrust::WindowsUnsigned)
            .await
            .unwrap();
        assert!(update.available);
        assert_eq!(update.install_action, InstallAction::OpenOfficialRelease);
        assert_eq!(update.asset_name.as_deref(), Some("SkillHub_0.2.0_x64.exe"));
    }

    #[tokio::test]
    async fn network_disabled_does_not_attempt_a_request() {
        let provider = GithubReleaseProvider::new().with_network_enabled(false);
        let error = provider
            .latest("crocketc/skill-hub", "0.1.0", BuildTrust::Unknown)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NetworkDisabled);
    }
}
