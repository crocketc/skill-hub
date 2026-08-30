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
                |row| row.get(0),
            )
            .optional()
            .map_err(error)
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
