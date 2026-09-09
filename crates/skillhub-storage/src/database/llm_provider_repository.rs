use rusqlite::OptionalExtension;

use super::Database;
use skillhub_core::llm::LlmProviderConfig;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

/// Persistence for user-managed LLM provider configurations. Rows carry the
/// serialized [`LlmProviderConfig`], which structurally cannot contain secret
/// material: sensitive values live in the OS credential store behind
/// `CredentialRef` identifiers.
pub struct LlmProviderRepository<'a> {
    database: &'a Database,
}

impl<'a> LlmProviderRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn save(&self, config: &LlmProviderConfig) -> AppResult<LlmProviderConfig> {
        config.validate()?;
        let json = serde_json::to_string(config).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO llm_provider_configs(id,config_json,created_at,updated_at) VALUES(?1,?2,?3,?3)
                 ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at",
                rusqlite::params![config.id, json, now()],
            )
            .map_err(database_error)?;
        Ok(config.clone())
    }

    pub fn get(&self, id: &str) -> AppResult<Option<LlmProviderConfig>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT config_json FROM llm_provider_configs WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_record()))
            .transpose()
    }

    pub fn list(&self) -> AppResult<Vec<LlmProviderConfig>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT config_json FROM llm_provider_configs ORDER BY id")
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

    /// Deleting an absent configuration stays idempotent so the caller can
    /// always clean up provider + credential together.
    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "DELETE FROM llm_provider_configs WHERE id=?1",
                [id],
            )
            .map_err(database_error)?;
        Ok(())
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
