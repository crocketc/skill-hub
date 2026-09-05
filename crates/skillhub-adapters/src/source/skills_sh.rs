use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use skillhub_core::source::{SourceSearchHit, SourceSearchPage, SourceSearchQuery};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use url::Url;

use super::repo_ref::validate_repo_ref;

const SEARCH_PATH: &str = "/api/search";
const SEARCH_TIMEOUT_SECONDS: u64 = 10;

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
        let response = self
            .client
            .get(url)
            .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECONDS))
            .send()
            .await
            .map_err(request_error)?;
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
                .skills
                .into_iter()
                .filter_map(|item| map_api_skill(item))
                .collect(),
            query: payload.query,
            count: payload.count,
            search_type: payload.search_type,
            duration_ms: payload.duration_ms,
            cache_max_age_seconds,
        })
    }
}

/// skills.sh 的 `source` 形如 "owner/repo"，也可能含额外路径段；
/// `splitn(2, '/')` 保证 repo 内即使含 '/' 也只拆一段。
/// 只认合法 GitHub 坐标：1) 防注入；2) 顺带过滤非 GitHub 来源。
fn map_api_skill(item: ApiSkill) -> Option<SourceSearchHit> {
    let parts: Vec<&str> = item.source.splitn(2, '/').collect();
    if parts.len() != 2 {
        return None;
    }
    let (owner, repo) = (parts[0], parts[1]);
    if validate_repo_ref(owner, repo, "main").is_err() {
        return None;
    }
    let page_url = format!("https://skills.sh/{}/{}", item.source, item.skill_id);
    Some(SourceSearchHit::from_api(
        item.id,
        item.name,
        item.source,
        "github",
        None,
        page_url,
        item.installs,
        false,
    ))
}

/// 注意：API 命名不一致（searchType 是 camelCase，duration_ms 是 snake_case），
/// 必须逐字段指定 rename，不能整体用 rename_all。
#[derive(Deserialize)]
struct ApiResponse {
    #[serde(default)]
    query: String,
    #[serde(rename = "searchType", default)]
    search_type: Option<String>,
    #[serde(default)]
    skills: Vec<ApiSkill>,
    #[serde(default)]
    count: u32,
    #[serde(default, rename = "duration_ms")]
    duration_ms: Option<u32>,
}

#[derive(Deserialize)]
struct ApiSkill {
    id: String,
    #[serde(rename = "skillId")]
    skill_id: String,
    name: String,
    #[serde(default)]
    installs: u32,
    source: String,
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
