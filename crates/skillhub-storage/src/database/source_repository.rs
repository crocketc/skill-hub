use super::Database;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};

/// Persistence boundary for a Skill's active source relation.
pub struct SourceRepository<'a> {
    database: &'a Database,
}

impl<'a> SourceRepository<'a> {
    pub fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn relink(&self, skill_id: SkillId, source: SourceDescriptor) -> AppResult<()> {
        let source_id = source_id(&source)?;
        let (kind, locator) = encode_source(&source)?;
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO sources (id, kind, locator, created_at) VALUES (?1, ?2, ?3, strftime('%s','now'))",
                rusqlite::params![source_id, kind, locator],
            )
            .map_err(error)?;
        transaction
            .execute(
                "DELETE FROM skill_sources WHERE skill_id=?1",
                [skill_id.to_string()],
            )
            .map_err(error)?;
        transaction
            .execute(
                "INSERT INTO skill_sources (skill_id, source_id, relation) VALUES (?1, ?2, 'origin')",
                rusqlite::params![skill_id.to_string(), source_id],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)
    }

    /// 将仓库导入的长期上游坐标写入 sources（kind=git，metadata_json 记 branch/directory）
    /// 并挂到 skill_sources（relation=origin）。幂等：重复导入同一来源不会产生重复行，
    /// 已存在的行只补写坐标元数据。与 relink 不同，这里不删除既有来源行。
    pub fn record_upstream(
        &self,
        skill_id: SkillId,
        upstream: &skillhub_core::UpstreamOrigin,
    ) -> AppResult<()> {
        let descriptor = SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url(upstream.url.clone()),
        );
        let source_id = source_id(&descriptor)?;
        let metadata = serde_json::json!({
            "branch": upstream.branch,
            "directory": upstream.directory,
        });
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        transaction
            .execute(
                // 行可能已由 relink 建好（metadata='{}'）：冲突时补写坐标元数据。
                "INSERT INTO sources (id, kind, locator, metadata_json, created_at) VALUES (?1, 'git', ?2, ?3, strftime('%s','now')) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json",
                rusqlite::params![source_id, upstream.url, metadata.to_string()],
            )
            .map_err(error)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO skill_sources (skill_id, source_id, relation) VALUES (?1, ?2, 'origin')",
                rusqlite::params![skill_id.to_string(), source_id],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)
    }

    /// 读取 Skill 的长期上游坐标；无记录返回 None（本地导入）。
    pub fn upstream_for_skill(
        &self,
        skill_id: SkillId,
    ) -> AppResult<Option<skillhub_core::UpstreamOrigin>> {
        let row: Option<(String, String)> = self
            .database
            .connection
            .query_row(
                "SELECT s.locator, s.metadata_json FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 AND s.kind='git' ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        let Some((locator, metadata_json)) = row else {
            return Ok(None);
        };
        let metadata: serde_json::Value = serde_json::from_str(&metadata_json).map_err(|err| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("source", err.to_string())
        })?;
        let branch = metadata["branch"].as_str().unwrap_or_default().to_string();
        let directory = metadata["directory"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if branch.is_empty() || directory.is_empty() {
            // 只有 URL 没有 branch/directory 坐标（如手动 relink 的 git 来源）
            // 无法在远端定位 Skill 目录，视为无上游记录。
            return Ok(None);
        }
        Ok(Some(skillhub_core::UpstreamOrigin {
            url: locator,
            branch,
            directory,
        }))
    }

    pub fn for_skill(&self, skill_id: SkillId) -> AppResult<Option<SourceDescriptor>> {
        let row: Option<(String, String)> = self
            .database
            .connection
            .query_row(
                "SELECT s.kind, s.locator FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        row.map(|(kind, locator)| decode_source(&kind, &locator))
            .transpose()
    }

    pub fn revision_for_skill(&self, skill_id: SkillId) -> AppResult<Option<String>> {
        self.database
            .connection
            .query_row(
                "SELECT s.revision FROM sources s JOIN skill_sources ss ON ss.source_id=s.id WHERE ss.skill_id=?1 ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                // revision 列可为 NULL（git 来源无 revision），必须按 Option 读取。
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(error)
            .map(|row| row.flatten())
    }

    pub fn set_revision(&self, skill_id: SkillId, revision: Option<&str>) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "UPDATE sources SET revision=?1 WHERE id=(SELECT source_id FROM skill_sources WHERE skill_id=?2 ORDER BY source_id ASC LIMIT 1)",
                rusqlite::params![revision, skill_id.to_string()],
            )
            .map(|_| ())
            .map_err(error)
    }
}

fn source_id(source: &SourceDescriptor) -> AppResult<String> {
    let (kind, locator) = encode_source(source)?;
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(locator.as_bytes());
    Ok(format!("source:{:x}", hasher.finalize()))
}

fn encode_source(source: &SourceDescriptor) -> AppResult<(&'static str, String)> {
    match (&source.kind, &source.locator) {
        (SourceKind::Local, SourceLocator::LocalPath(path)) => {
            Ok(("local", path.to_string_lossy().into_owned()))
        }
        (SourceKind::Https, SourceLocator::HttpsUrl(url)) => Ok(("https", url.clone())),
        (SourceKind::Git, SourceLocator::GitUrl(url)) => Ok(("git", url.clone())),
        _ => Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)),
    }
}

fn decode_source(kind: &str, locator: &str) -> AppResult<SourceDescriptor> {
    let (kind, locator) = match kind {
        "local" => (SourceKind::Local, SourceLocator::local_path(locator)),
        "https" => (SourceKind::Https, SourceLocator::https_url(locator)),
        "git" => (SourceKind::Git, SourceLocator::git_url(locator)),
        _ => return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)),
    };
    Ok(SourceDescriptor::new(kind, locator))
}

fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
