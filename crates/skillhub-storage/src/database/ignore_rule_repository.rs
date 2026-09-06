use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::{AppError, AppResult, ErrorCode, IgnoreRule, RecoveryAction, Severity};

const KEY: &str = "ignore_rules";

pub struct IgnoreRuleRepository<'a> {
    database: &'a Database,
}

impl<'a> IgnoreRuleRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn list(&self) -> AppResult<Vec<IgnoreRule>> {
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
            .map(|rules| rules.unwrap_or_default())
    }

    pub fn create(&self, mut rule: IgnoreRule) -> AppResult<IgnoreRule> {
        let mut rules = self.list()?;
        if rules
            .iter()
            .any(|existing| existing.subject == rule.subject)
        {
            return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
                .with_param("reason", "ignore_rule_exists")
                .with_action(RecoveryAction::Acknowledge));
        }
        rule.created_at = now().to_string();
        rules.push(rule.clone());
        self.save(&rules)?;
        Ok(rule)
    }

    pub fn remove(&self, rule_id: &str) -> AppResult<()> {
        let mut rules = self.list()?;
        let Some(index) = rules.iter().position(|rule| rule.id == rule_id) else {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("field", "ignore_rule")
                .with_action(RecoveryAction::Retry));
        };
        rules.remove(index);
        self.save(&rules)
    }

    fn save(&self, rules: &[IgnoreRule]) -> AppResult<()> {
        let json = serde_json::to_string(rules).map_err(|_| invalid_record())?;
        self.database.connection.execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            rusqlite::params![KEY, json],
        ).map_err(database_error)?;
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

#[cfg(test)]
mod tests {
    use crate::Database;
    use skillhub_core::{IgnoreSubject, OperationId};

    #[test]
    fn rules_round_trip_and_remove_from_sqlite() {
        let database = Database::open_in_memory().expect("database");
        let repository = database.ignore_rule_repository();
        let created = repository
            .create(skillhub_core::IgnoreRule {
                id: OperationId::new().to_string(),
                subject: IgnoreSubject::exact_pending("trial_due:skill:trial.due"),
                reason: "later".into(),
                created_at: String::new(),
                defer_until: Some("2026-09-10".into()),
            })
            .expect("create rule");
        assert!(!created.created_at.is_empty());
        assert_eq!(
            repository.list().expect("list rules"),
            vec![created.clone()]
        );
        repository.remove(&created.id).expect("remove rule");
        assert!(repository.list().expect("list removed rules").is_empty());
    }
}
