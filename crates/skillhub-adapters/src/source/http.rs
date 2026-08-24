use std::fmt;
use std::fs::File;
use std::io::Write;
use std::net::SocketAddr;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;
use skillhub_core::source::{
    AcquiredSource, AcquisitionError, AcquisitionLimits, AcquisitionWorkspace,
};
use url::Url;

use super::redirect_policy::RedirectPolicy;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceFetchErrorCode {
    HttpsRequired,
    RedirectBlocked,
    RedirectLimit,
    DownloadSizeLimit,
    Timeout,
    HttpStatus,
    HttpTransport,
    GitFetchFailed,
    AcquisitionFailed,
}

impl SourceFetchErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HttpsRequired => "source.https_required",
            Self::RedirectBlocked => "source.redirect_blocked",
            Self::RedirectLimit => "source.redirect_limit",
            Self::DownloadSizeLimit => "source.download_size_limit",
            Self::Timeout => "source.fetch_timeout",
            Self::HttpStatus => "source.http_status",
            Self::HttpTransport => "source.http_transport",
            Self::GitFetchFailed => "source.git_fetch_failed",
            Self::AcquisitionFailed => "source.acquisition_failed",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceFetchError {
    pub code: SourceFetchErrorCode,
    pub message: String,
    pub cleanup_failure: Option<SourceCleanupFailure>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceCleanupFailure {
    pub code: SourceFetchErrorCode,
    pub message: String,
}

impl SourceFetchError {
    pub fn new(code: SourceFetchErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cleanup_failure: None,
        }
    }
}

impl fmt::Display for SourceFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SourceFetchError {}

impl From<AcquisitionError> for SourceFetchError {
    fn from(error: AcquisitionError) -> Self {
        Self::new(SourceFetchErrorCode::AcquisitionFailed, error.to_string())
    }
}

pub(crate) fn cleanup_fetch_error(
    mut workspace: AcquisitionWorkspace,
    mut error: SourceFetchError,
) -> SourceFetchError {
    if let Err(cleanup) = workspace.cleanup() {
        error.cleanup_failure = Some(SourceCleanupFailure {
            code: SourceFetchErrorCode::AcquisitionFailed,
            message: cleanup.to_string(),
        });
    }
    error
}

pub type SourceFetchResult<T> = Result<T, SourceFetchError>;

#[async_trait]
pub trait SourceFetcher {
    async fn fetch(&self, url: &str) -> SourceFetchResult<AcquiredSource>;
}

#[derive(Clone, Debug)]
pub struct HttpsSourceFetcher {
    limits: AcquisitionLimits,
    timeout: Duration,
    max_redirects: usize,
    redirect_policy: RedirectPolicy,
}

impl Default for HttpsSourceFetcher {
    fn default() -> Self {
        Self::new(AcquisitionLimits::default())
    }
}

impl HttpsSourceFetcher {
    pub fn new(limits: AcquisitionLimits) -> Self {
        Self::with_options(
            limits,
            Duration::from_secs(30),
            5,
            RedirectPolicy::default(),
        )
    }

    pub fn with_options(
        limits: AcquisitionLimits,
        timeout: Duration,
        max_redirects: usize,
        redirect_policy: RedirectPolicy,
    ) -> Self {
        Self {
            limits,
            timeout,
            max_redirects,
            redirect_policy,
        }
    }

    pub fn limits(&self) -> &AcquisitionLimits {
        &self.limits
    }

    pub async fn fetch<U: AsRef<str>>(&self, source: U) -> SourceFetchResult<AcquiredSource> {
        let mut current = Url::parse(source.as_ref()).map_err(|error| {
            SourceFetchError::new(SourceFetchErrorCode::HttpsRequired, error.to_string())
        })?;
        self.redirect_policy
            .validate(&current)
            .map_err(|code| SourceFetchError::new(code, "HTTPS source URL is not allowed"))?;
        self.redirect_policy
            .validate_resolved(&current)
            .await
            .map_err(|code| {
                SourceFetchError::new(code, "HTTPS source destination is not allowed")
            })?;

        let mut workspace = AcquisitionWorkspace::new().map_err(SourceFetchError::from)?;
        workspace.begin().map_err(SourceFetchError::from)?;
        let result = self.fetch_into(&mut current, &mut workspace).await;
        match result {
            Ok((bytes, entries)) => Ok(AcquiredSource::new(workspace, entries, bytes)),
            Err(error) => Err(cleanup_fetch_error(workspace, error)),
        }
    }

    async fn fetch_into(
        &self,
        current: &mut Url,
        workspace: &mut AcquisitionWorkspace,
    ) -> SourceFetchResult<(u64, u64)> {
        for redirects in 0..=self.max_redirects {
            let destination = self
                .redirect_policy
                .resolve_destination(current)
                .await
                .map_err(|code| {
                    SourceFetchError::new(code, "HTTPS source destination is not allowed")
                })?;
            let client = self.client_for(current, destination)?;
            let response = client
                .get(current.clone())
                .send()
                .await
                .map_err(map_reqwest_error)?;
            if response.status().is_redirection() {
                if redirects == self.max_redirects {
                    return Err(SourceFetchError::new(
                        SourceFetchErrorCode::RedirectLimit,
                        "too many HTTP redirects",
                    ));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        SourceFetchError::new(
                            SourceFetchErrorCode::RedirectBlocked,
                            "redirect has no valid Location header",
                        )
                    })?;
                *current = self
                    .redirect_policy
                    .resolve(current, location)
                    .map_err(|code| {
                        SourceFetchError::new(code, "redirect destination is not allowed")
                    })?;
                self.redirect_policy
                    .validate_resolved(current)
                    .await
                    .map_err(|code| {
                        SourceFetchError::new(code, "redirect destination is not allowed")
                    })?;
                continue;
            }
            if !response.status().is_success() {
                return Err(SourceFetchError::new(
                    SourceFetchErrorCode::HttpStatus,
                    format!("HTTP status {}", response.status()),
                ));
            }
            if response
                .content_length()
                .is_some_and(|length| length > self.limits.max_file_bytes)
            {
                return Err(SourceFetchError::new(
                    SourceFetchErrorCode::DownloadSizeLimit,
                    "HTTP response exceeds the configured size limit",
                ));
            }
            let destination = workspace.root().join("source");
            let mut output = File::create(destination).map_err(|error| {
                SourceFetchError::new(SourceFetchErrorCode::AcquisitionFailed, error.to_string())
            })?;
            let mut total = 0_u64;
            let mut response = response;
            while let Some(chunk) = response.chunk().await.map_err(map_reqwest_error)? {
                total = total.checked_add(chunk.len() as u64).ok_or_else(|| {
                    SourceFetchError::new(
                        SourceFetchErrorCode::DownloadSizeLimit,
                        "HTTP response size overflowed",
                    )
                })?;
                if total > self.limits.max_file_bytes {
                    return Err(SourceFetchError::new(
                        SourceFetchErrorCode::DownloadSizeLimit,
                        "HTTP response exceeds the configured size limit",
                    ));
                }
                output.write_all(&chunk).map_err(|error| {
                    SourceFetchError::new(
                        SourceFetchErrorCode::AcquisitionFailed,
                        error.to_string(),
                    )
                })?;
            }
            output.flush().map_err(|error| {
                SourceFetchError::new(SourceFetchErrorCode::AcquisitionFailed, error.to_string())
            })?;
            return Ok((total, 1));
        }
        Err(SourceFetchError::new(
            SourceFetchErrorCode::RedirectLimit,
            "too many HTTP redirects",
        ))
    }

    fn client_for(&self, url: &Url, destination: Option<SocketAddr>) -> SourceFetchResult<Client> {
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .no_proxy();
        if let (Some(host), Some(destination)) = (url.host_str(), destination) {
            builder = builder.resolve(host, destination);
        }
        builder.build().map_err(|error| {
            SourceFetchError::new(SourceFetchErrorCode::HttpTransport, error.to_string())
        })
    }
}

#[async_trait]
impl SourceFetcher for HttpsSourceFetcher {
    async fn fetch(&self, url: &str) -> SourceFetchResult<AcquiredSource> {
        HttpsSourceFetcher::fetch(self, url).await
    }
}

fn map_reqwest_error(error: reqwest::Error) -> SourceFetchError {
    let code = if error.is_timeout() {
        SourceFetchErrorCode::Timeout
    } else {
        SourceFetchErrorCode::HttpTransport
    };
    SourceFetchError::new(code, error.to_string())
}
