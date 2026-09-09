use rusqlite::OptionalExtension;

use super::Database;
use skillhub_core::llm::translation::{
    TranslationOrigin, TranslationProvenance, TranslationRecord,
};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId};

/// One persisted translation row: the domain record plus view metadata. The
/// source description hash drives the "needs update" state; `origin`
/// distinguishes generated translations from user revisions, which are never
/// overwritten without explicit confirmation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedTranslation {
    pub record: TranslationRecord,
    pub version_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Persistence for the latest description translation per (skill, language).
pub struct TranslationRecordRepository<'a> {
    database: &'a Database,
}

impl<'a> TranslationRecordRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn save(&self, translation: &PersistedTranslation) -> AppResult<()> {
        let record = &translation.record;
        self.database
            .connection
            .execute(
                "INSERT INTO translation_records(
                    skill_id,language,translated_text,source_description_hash,
                    provider,model,origin,version_id,created_at,updated_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(skill_id,language) DO UPDATE SET
                    translated_text=excluded.translated_text,
                    source_description_hash=excluded.source_description_hash,
                    provider=excluded.provider,
                    model=excluded.model,
                    origin=excluded.origin,
                    version_id=excluded.version_id,
                    updated_at=excluded.updated_at",
                rusqlite::params![
                    record.skill_id.to_string(),
                    record.language,
                    record.text,
                    record.provenance.source_description_hash,
                    record.provenance.provider,
                    record.provenance.model,
                    origin_text(record.origin),
                    translation.version_id,
                    translation.created_at,
                    translation.updated_at,
                ],
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn get(
        &self,
        skill_id: &SkillId,
        language: &str,
    ) -> AppResult<Option<PersistedTranslation>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT skill_id,language,translated_text,source_description_hash,
                        provider,model,origin,version_id,created_at,updated_at
                 FROM translation_records WHERE skill_id=?1 AND language=?2",
            )
            .map_err(database_error)?;
        statement
            .query_row(rusqlite::params![skill_id.to_string(), language], map_row)
            .optional()
            .map_err(database_error)
    }

    pub fn list_for_skill(&self, skill_id: &SkillId) -> AppResult<Vec<PersistedTranslation>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT skill_id,language,translated_text,source_description_hash,
                        provider,model,origin,version_id,created_at,updated_at
                 FROM translation_records WHERE skill_id=?1 ORDER BY language",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([skill_id.to_string()], map_row)
            .map_err(database_error)?;
        let mut translations = Vec::new();
        for row in rows {
            translations.push(row.map_err(database_error)?);
        }
        Ok(translations)
    }

    /// Deleting an absent translation stays idempotent so callers can clean
    /// up without pre-checks.
    pub fn delete(&self, skill_id: &SkillId, language: &str) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "DELETE FROM translation_records WHERE skill_id=?1 AND language=?2",
                rusqlite::params![skill_id.to_string(), language],
            )
            .map_err(database_error)?;
        Ok(())
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersistedTranslation> {
    let skill_id: String = row.get(0)?;
    let origin: String = row.get(6)?;
    Ok(PersistedTranslation {
        record: TranslationRecord {
            skill_id: skill_id.parse().map_err(|_| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    "invalid skill id".into(),
                )
            })?,
            language: row.get(1)?,
            text: row.get(2)?,
            provenance: TranslationProvenance {
                source_description_hash: row.get(3)?,
                provider: row.get(4)?,
                model: row.get(5)?,
                origin: origin_from_text(&origin).ok_or_else(|| {
                    rusqlite::Error::FromSqlConversionFailure(
                        6,
                        rusqlite::types::Type::Text,
                        "invalid translation origin".into(),
                    )
                })?,
            },
            origin: origin_from_text(&origin).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    "invalid translation origin".into(),
                )
            })?,
        },
        version_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn origin_text(origin: TranslationOrigin) -> &'static str {
    match origin {
        TranslationOrigin::Generated => "generated",
        TranslationOrigin::UserRevision => "user_revision",
    }
}

fn origin_from_text(text: &str) -> Option<TranslationOrigin> {
    match text {
        "generated" => Some(TranslationOrigin::Generated),
        "user_revision" => Some(TranslationOrigin::UserRevision),
        _ => None,
    }
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
