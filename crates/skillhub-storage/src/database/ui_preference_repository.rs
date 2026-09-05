use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

pub struct UiPreferenceRepository<'a> {
    database: &'a Database,
}

impl<'a> UiPreferenceRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 读取一个 UI 偏好键的原始 JSON 值；不存在返回 None。
    pub fn get(&self, key: &str) -> AppResult<Option<String>> {
        if key.trim().is_empty() {
            return Err(invalid_key());
        }
        self.database
            .connection
            .query_row(
                "SELECT value_json FROM ui_preferences WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
    }

    /// 写入一个 UI 偏好键（upsert）。
    pub fn set(&self, key: &str, value_json: &str) -> AppResult<()> {
        if key.trim().is_empty() {
            return Err(invalid_key());
        }
        // 值必须是合法 JSON 对象/数组/标量——至少保证可解析，防止坏数据进库。
        if serde_json::from_str::<serde_json::Value>(value_json).is_err() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                .with_param("field", "value_json")
                .with_action(RecoveryAction::Retry));
        }
        self.database
            .connection
            .execute(
                "INSERT INTO ui_preferences(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![key, value_json],
            )
            .map_err(database_error)?;
        Ok(())
    }
}

fn invalid_key() -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Warning)
        .with_param("field", "key")
        .with_action(RecoveryAction::Retry)
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
    fn missing_key_returns_none_and_round_trips() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.ui_preference_repository();

        assert_eq!(repository.get("table_preferences").unwrap(), None);
        repository
            .set("table_preferences", r#"{"density":"compact"}"#)
            .unwrap();
        assert_eq!(
            repository.get("table_preferences").unwrap(),
            Some(r#"{"density":"compact"}"#.to_string())
        );
        repository
            .set("table_preferences", r#"{"density":"comfortable"}"#)
            .unwrap();
        assert_eq!(
            repository.get("table_preferences").unwrap(),
            Some(r#"{"density":"comfortable"}"#.to_string())
        );
    }

    #[test]
    fn rejects_empty_keys_and_non_json_values() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.ui_preference_repository();
        assert!(repository.get(" ").unwrap_err().code == skillhub_core::ErrorCode::InvalidInput);
        assert!(repository.set("k", "not json").is_err());
    }
}
