use serde::{Deserialize, Serialize};

use super::{SourceDescriptor, SourceKind, SourceLocator};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceSearchQuery {
    pub query: String,
    pub limit: u16,
    pub owner: Option<String>,
}

impl SourceSearchQuery {
    pub fn new(query: impl Into<String>) -> Self {
        Self {
            query: query.into(),
            limit: 50,
            owner: None,
        }
    }

    pub fn with_limit(mut self, limit: u16) -> Self {
        self.limit = limit.clamp(1, 200);
        self
    }

    pub fn with_owner(mut self, owner: impl Into<String>) -> Self {
        self.owner = Some(owner.into());
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceSearchHit {
    pub source_id: String,
    pub name: String,
    pub source: SourceDescriptor,
    pub install_url: Option<String>,
    pub page_url: String,
    pub installs: u32,
    pub is_duplicate: bool,
}

impl SourceSearchHit {
    #[allow(clippy::too_many_arguments)]
    pub fn from_api(
        source_id: String,
        name: String,
        source: String,
        source_type: &str,
        install_url: Option<String>,
        page_url: String,
        installs: u32,
        is_duplicate: bool,
    ) -> Self {
        let kind = if source_type == "github" {
            SourceKind::Git
        } else {
            SourceKind::Https
        };
        let locator = match kind {
            SourceKind::Git => SourceLocator::git_url(
                install_url
                    .clone()
                    .unwrap_or_else(|| format!("https://github.com/{source}")),
            ),
            SourceKind::Https => SourceLocator::https_url(
                install_url
                    .clone()
                    .unwrap_or_else(|| format!("https://{source}")),
            ),
            SourceKind::Local => unreachable!(),
        };
        Self {
            source_id,
            name,
            source: SourceDescriptor::new(kind, locator),
            install_url,
            page_url,
            installs,
            is_duplicate,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceSearchPage {
    pub items: Vec<SourceSearchHit>,
    pub query: String,
    pub count: u32,
    pub search_type: Option<String>,
    pub duration_ms: Option<u32>,
    pub cache_max_age_seconds: Option<u32>,
}
