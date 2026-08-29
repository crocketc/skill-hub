use reqwest::Client;
use serde::Deserialize;
use skillhub_core::source::{SourceSearchHit, SourceSearchPage, SourceSearchQuery};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use url::Url;

const SEARCH_PATH: &str = "/api/v1/skills/search";

pub struct SkillsShProvider {
    client: Client,
    base_url: Url,
    network_enabled: bool,
}

impl SkillsShProvider {
    pub fn new(base_url: impl AsRef<str>) -> Self {
        let base_url = Url::parse(base_url.as_ref()).expect("skills.sh base URL must be valid");
        Self {
            client: Client::new(),
            base_url,
            network_enabled: true,
        }
    }

    pub fn with_network_enabled(mut self, enabled: bool) -> Self {
        self.network_enabled = enabled;
        self
    }

    pub async fn search(&self, query: SourceSearchQuery) -> AppResult<SourceSearchPage> {
        if !self.network_enabled {
            return Err(AppError::new(ErrorCode::NetworkDisabled, Severity::Info)
                .with_action(RecoveryAction::Acknowledge));
        }
        if query.query.trim().chars().count() < 2 {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "query"));
        }
        let mut url = self.base_url.join(SEARCH_PATH).map_err(|_| invalid_url())?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("q", query.query.trim());
            pairs.append_pair("limit", &query.limit.to_string());
            if let Some(owner) = query.owner.as_deref() {
                pairs.append_pair("owner", owner);
            }
        }
        let response = self.client.get(url).send().await.map_err(request_error)?;
        let headers = response.headers().clone();
        let status = response.status();
        if status.as_u16() == 429 {
            let retry_after_seconds = headers
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            return Err(
                AppError::new(ErrorCode::SourceSearchRateLimited, Severity::Warning)
                    .with_param("retry_after_seconds", retry_after_seconds)
                    .with_action(RecoveryAction::Retry),
            );
        }
        if status.as_u16() == 401 {
            return Err(AppError::new(
                ErrorCode::SourceProviderAuthenticationUnavailable,
                Severity::Warning,
            )
            .with_action(RecoveryAction::ConfigureCredential));
        }
        if !status.is_success() {
            return Err(
                AppError::new(ErrorCode::SourceSearchUnavailable, Severity::Error)
                    .with_param("status", status.as_u16())
                    .with_action(RecoveryAction::Retry),
            );
        }
        let cache_max_age_seconds = parse_cache_max_age(&headers);
        let payload: ApiResponse = response.json().await.map_err(request_error)?;
        Ok(SourceSearchPage {
            items: payload
                .data
                .into_iter()
                .map(|item| {
                    SourceSearchHit::from_api(
                        item.id,
                        item.name,
                        item.source,
                        &item.source_type,
                        item.install_url,
                        item.url,
                        item.installs,
                        item.is_duplicate,
                    )
                })
                .collect(),
            query: payload.query,
            count: payload.count,
            search_type: payload.search_type,
            duration_ms: payload.duration_ms,
            cache_max_age_seconds,
        })
    }
}

#[derive(Deserialize)]
struct ApiResponse {
    data: Vec<ApiItem>,
    query: String,
    #[serde(default)]
    count: u32,
    #[serde(rename = "searchType")]
    search_type: Option<String>,
    #[serde(rename = "durationMs")]
    duration_ms: Option<u32>,
}

#[derive(Deserialize)]
struct ApiItem {
    id: String,
    name: String,
    source: String,
    #[serde(rename = "sourceType")]
    source_type: String,
    #[serde(rename = "installUrl")]
    install_url: Option<String>,
    url: String,
    installs: u32,
    #[serde(default, rename = "isDuplicate")]
    is_duplicate: bool,
}

fn parse_cache_max_age(headers: &reqwest::header::HeaderMap) -> Option<u32> {
    headers
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value.split(',').find_map(|directive| {
                directive
                    .trim()
                    .strip_prefix("max-age=")
                    .and_then(|age| age.parse::<u32>().ok())
            })
        })
}

fn invalid_url() -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error).with_param("field", "base_url")
}

fn request_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::SourceSearchUnavailable, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
