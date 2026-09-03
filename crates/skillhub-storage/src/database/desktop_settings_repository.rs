use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::{AppError, AppResult, DesktopPreferences, ErrorCode, RecoveryAction, Severity};

const KEY: &str = "desktop_preferences";

pub struct DesktopSettingsRepository<'a> {
    database: &'a Database,
}

impl<'a> DesktopSettingsRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn get(&self) -> AppResult<DesktopPreferences> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_record()))
            .transpose()
            .map(|value| value.unwrap_or_default())
    }

    pub fn save(&self, preferences: &DesktopPreferences) -> AppResult<DesktopPreferences> {
        preferences.validate().map_err(|message| {
            AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("reason", message)
                .with_action(RecoveryAction::Retry)
        })?;
        let json = serde_json::to_string(preferences).map_err(|_| invalid_record())?;
        self.database.connection.execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            rusqlite::params![KEY, json],
        ).map_err(database_error)?;
        Ok(preferences.clone())
    }
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use crate::Database;

    #[test]
    fn defaults_and_round_trips() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.desktop_settings_repository();
        let mut preferences = repository.get().unwrap();
        assert!(preferences.network_enabled);
        preferences.network_enabled = false;
        repository.save(&preferences).unwrap();
        assert_eq!(repository.get().unwrap(), preferences);

        preferences.language = "invalid".into();
        let error = repository.save(&preferences).unwrap_err();
        assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);
    }
}
