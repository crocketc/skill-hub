use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::{
    AppError, AppResult, ApplicationUpdatePolicy, ErrorCode, RecoveryAction, Severity,
};

const POLICY_KEY: &str = "application_update_policy";

pub struct ApplicationUpdateRepository<'a> {
    database: &'a Database,
}

impl<'a> ApplicationUpdateRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn get_policy(&self) -> AppResult<ApplicationUpdatePolicy> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [POLICY_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_record()))
            .transpose()
            .map(|policy| policy.unwrap_or_default())
    }

    pub fn save_policy(
        &self,
        policy: &ApplicationUpdatePolicy,
    ) -> AppResult<ApplicationUpdatePolicy> {
        let json = serde_json::to_string(policy).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![POLICY_KEY, json, now()],
            )
            .map_err(database_error)?;
        Ok(policy.clone())
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

#[cfg(test)]
mod tests {
    use crate::Database;
    use skillhub_core::ApplicationUpdatePolicy;

    #[test]
    fn policy_defaults_and_round_trips_through_settings() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.application_update_repository();
        assert_eq!(
            repository.get_policy().unwrap(),
            ApplicationUpdatePolicy::default()
        );
        let policy = ApplicationUpdatePolicy {
            enabled: false,
            check_on_startup: true,
        };
        assert_eq!(repository.save_policy(&policy).unwrap(), policy);
        assert_eq!(repository.get_policy().unwrap(), policy);
    }
}
