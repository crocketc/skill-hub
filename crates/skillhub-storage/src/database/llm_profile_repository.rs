use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::llm::LlmProfile;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

pub struct LlmProfileRepository<'a> {
    database: &'a Database,
}

impl<'a> LlmProfileRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn save(&self, profile: &LlmProfile) -> AppResult<LlmProfile> {
        let json = serde_json::to_string(profile).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO llm_profiles(id,profile_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at",
                rusqlite::params![profile.id, json, now()],
            )
            .map_err(database_error)?;
        Ok(profile.clone())
    }

    pub fn get(&self, id: &str) -> AppResult<Option<LlmProfile>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT profile_json FROM llm_profiles WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_record()))
            .transpose()
    }

    pub fn list(&self) -> AppResult<Vec<LlmProfile>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT profile_json FROM llm_profiles ORDER BY id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(database_error)?;
        rows.map(|row| {
            let json = row.map_err(database_error)?;
            serde_json::from_str(&json).map_err(|_| invalid_record())
        })
        .collect()
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
