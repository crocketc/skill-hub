use super::source_repository::{decode_source, encode_source};
use super::Database;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use skillhub_core::source::{
    SearchCandidateRecord, SearchCandidateStatus, SearchHitOrigin, SourceDescriptor,
    SourceSearchHit, SourceSearchPage,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};

/// Persistence boundary for P1-05 search candidates.
///
/// 候选是"待确认"实体：本仓库只读写 `search_candidates` 表，绝不触碰
/// sources/skill_sources/catalog。重复保存按 provider_source_id 幂等，
/// 且不改变既有状态（dismissed/confirmed 不会因再次搜索被重置）。
pub struct SearchCandidateRepository<'a> {
    database: &'a Database,
}

/// 候选行携带的提供方标识。当前唯一的搜索提供方是 skills.sh；
/// 来源页本身不携带 provider 字段，这里保持常量而不是臆造数据。
pub const SEARCH_PROVIDER: &str = "skills_sh";

impl<'a> SearchCandidateRepository<'a> {
    pub fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 把一次搜索结果页落为候选（status=pending，已存在的除外）。
    /// 返回本次涉及的全部候选行（含已存在的既有状态）。
    pub fn save_page(
        &self,
        page: &SourceSearchPage,
        now: i64,
    ) -> AppResult<Vec<SearchCandidateRecord>> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        for hit in &page.items {
            let record = candidate_record(hit, now);
            let (kind, locator) = encode_source(&record.source)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO search_candidates (id, provider, provider_source_id, name, kind, locator, page_url, installs, via, status, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)",
                    rusqlite::params![
                        record.id,
                        record.provider,
                        record.provider_source_id,
                        record.name,
                        kind,
                        locator,
                        record.page_url,
                        record.installs,
                        via_to_str(record.via),
                        record.first_seen_at,
                    ],
                )
                .map_err(error)?;
        }
        transaction.commit().map_err(error)?;
        self.list()
    }

    /// 待确认候选列表（按首次发现时间稳定排序）。
    pub fn list(&self) -> AppResult<Vec<SearchCandidateRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT id, provider, provider_source_id, name, kind, locator, page_url, installs, via, status, first_seen_at FROM search_candidates ORDER BY first_seen_at ASC, id ASC",
            )
            .map_err(error)?;
        let rows = statement.query_map([], row_to_record).map_err(error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(error)
    }

    /// 显式状态转换。规则：
    /// - pending → confirmed / dismissed；
    /// - confirmed → dismissed（用户可以反悔）；
    /// - confirmed → confirmed、dismissed → dismissed 幂等成功；
    /// - dismissed → confirmed 拒绝（已拒绝的候选不能再次确认）；
    /// - 未知 id 返回 ObjectNotFound。
    pub fn set_status(
        &self,
        candidate_id: &str,
        status: SearchCandidateStatus,
    ) -> AppResult<SearchCandidateRecord> {
        let current = self
            .get(candidate_id)?
            .ok_or_else(|| object_not_found("search candidate"))?;
        // 已拒绝的候选不能再次确认；其余转换（含幂等重放）都放行。
        if current.status == SearchCandidateStatus::Dismissed
            && status == SearchCandidateStatus::Confirmed
        {
            return Err(
                AppError::new(ErrorCode::OperationConflict, Severity::Warning)
                    .with_param("reason", "candidate_dismissed")
                    .with_param("candidate_id", candidate_id.to_string())
                    .with_action(skillhub_core::RecoveryAction::Acknowledge),
            );
        }
        if current.status != status {
            self.database
                .connection
                .execute(
                    "UPDATE search_candidates SET status=?1 WHERE id=?2",
                    rusqlite::params![status_to_str(status), candidate_id],
                )
                .map_err(error)?;
        }
        self.get(candidate_id)?
            .ok_or_else(|| object_not_found("search candidate"))
    }

    fn get(&self, candidate_id: &str) -> AppResult<Option<SearchCandidateRecord>> {
        self.database
            .connection
            .query_row(
                "SELECT id, provider, provider_source_id, name, kind, locator, page_url, installs, via, status, first_seen_at FROM search_candidates WHERE id=?1",
                [candidate_id],
                row_to_record,
            )
            .optional()
            .map_err(error)
    }
}

fn candidate_record(hit: &SourceSearchHit, now: i64) -> SearchCandidateRecord {
    SearchCandidateRecord {
        id: candidate_id(SEARCH_PROVIDER, &hit.source_id),
        provider: SEARCH_PROVIDER.to_string(),
        provider_source_id: hit.source_id.clone(),
        name: hit.name.clone(),
        source: hit.source.clone(),
        page_url: hit.page_url.clone(),
        installs: hit.installs,
        via: hit.via,
        first_seen_at: now.to_string(),
        status: SearchCandidateStatus::Pending,
    }
}

/// 候选 id 由 provider + provider_source_id 决定（稳定、幂等）。
fn candidate_id(provider: &str, provider_source_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider.as_bytes());
    hasher.update([0]);
    hasher.update(provider_source_id.as_bytes());
    format!("candidate:{:x}", hasher.finalize())
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchCandidateRecord> {
    let kind: String = row.get(4)?;
    let locator: String = row.get(5)?;
    let source: SourceDescriptor = decode_source(&kind, &locator).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(error.to_string())),
        )
    })?;
    let via: String = row.get(8)?;
    let status: String = row.get(9)?;
    let first_seen_at: i64 = row.get(10)?;
    Ok(SearchCandidateRecord {
        id: row.get(0)?,
        provider: row.get(1)?,
        provider_source_id: row.get(2)?,
        name: row.get(3)?,
        source,
        page_url: row.get(6)?,
        installs: row.get(7)?,
        via: str_to_via(&via),
        first_seen_at: first_seen_at.to_string(),
        status: str_to_status(&status),
    })
}

fn via_to_str(via: SearchHitOrigin) -> &'static str {
    match via {
        SearchHitOrigin::OriginalQuery => "original_query",
        SearchHitOrigin::ExpandedQuery => "expanded_query",
    }
}

fn str_to_via(value: &str) -> SearchHitOrigin {
    match value {
        "expanded_query" => SearchHitOrigin::ExpandedQuery,
        _ => SearchHitOrigin::OriginalQuery,
    }
}

fn status_to_str(status: SearchCandidateStatus) -> &'static str {
    match status {
        SearchCandidateStatus::Pending => "pending",
        SearchCandidateStatus::Confirmed => "confirmed",
        SearchCandidateStatus::Dismissed => "dismissed",
    }
}

fn str_to_status(value: &str) -> SearchCandidateStatus {
    match value {
        "confirmed" => SearchCandidateStatus::Confirmed,
        "dismissed" => SearchCandidateStatus::Dismissed,
        _ => SearchCandidateStatus::Pending,
    }
}

fn object_not_found(kind: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Warning)
        .with_param("kind", kind.to_string())
        .with_action(skillhub_core::RecoveryAction::ChooseAnotherName)
}

fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
