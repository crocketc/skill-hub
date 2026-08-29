use super::Database;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use skillhub_core::source::{SourceSearchPage, SourceSearchQuery};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};

/// Small persistent cache for provider search responses. Cache freshness is
/// explicit and never changes the meaning of a provider result.
pub struct SourceSearchCache<'a> {
    database: &'a Database,
}

impl<'a> SourceSearchCache<'a> {
    pub fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn put(
        &self,
        query: &SourceSearchQuery,
        page: &SourceSearchPage,
        fetched_at: i64,
    ) -> AppResult<()> {
        let value = serde_json::to_string(&CacheRecord {
            fetched_at,
            page: page.clone(),
        })
        .map_err(|_| invalid_cache())?;
        self.database.connection.execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            rusqlite::params![cache_key(query), value, fetched_at],
        ).map_err(error)?;
        Ok(())
    }

    pub fn get(&self, query: &SourceSearchQuery, now: i64) -> AppResult<Option<SourceSearchPage>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [cache_key(query)],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        let Some(value) = value else {
            return Ok(None);
        };
        let record: CacheRecord = serde_json::from_str(&value).map_err(|_| invalid_cache())?;
        let ttl = i64::from(record.page.cache_max_age_seconds.unwrap_or(60));
        if now >= record.fetched_at.saturating_add(ttl) {
            return Ok(None);
        }
        Ok(Some(record.page))
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
struct CacheRecord {
    fetched_at: i64,
    page: SourceSearchPage,
}

fn cache_key(query: &SourceSearchQuery) -> String {
    let bytes = serde_json::to_vec(query).expect("search query is serializable");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("source_search:{:x}", hasher.finalize())
}

fn invalid_cache() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
}

fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
