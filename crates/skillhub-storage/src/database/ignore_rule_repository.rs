use super::Database;
use rusqlite::{OptionalExtension, Transaction};
use skillhub_core::{
    AppError, AppResult, ErrorCode, IgnoreRule, IgnoreSubject, OperationId, OperationPhase,
    OperationRecord, RecoveryAction, Severity,
};

const KEY: &str = "ignore_rules";

pub struct IgnoreRuleRepository<'a> {
    database: &'a Database,
}

impl<'a> IgnoreRuleRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn list(&self) -> AppResult<Vec<IgnoreRule>> {
        list_from(&self.database.connection)
    }

    /// Returns only persisted exact-path exclusions. Other ignore subjects have
    /// different lifecycle semantics and must not suppress path candidates.
    pub fn list_exact_paths(&self) -> AppResult<Vec<String>> {
        Ok(self
            .list()?
            .into_iter()
            .filter_map(|rule| match rule.subject {
                IgnoreSubject::ExactPath(path) => Some(path),
                IgnoreSubject::ExactSkill(_) | IgnoreSubject::ExactPending(_) => None,
            })
            .collect())
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
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        remove_from_transaction(&transaction, rule_id)?;
        transaction.commit().map_err(database_error)
    }

    pub fn remove_with_operation(
        &self,
        rule_id: &str,
        operation_id: OperationId,
    ) -> AppResult<OperationRecord> {
        let mut operation = self
            .database
            .operation_repository()
            .get_sync(operation_id)?
            .ok_or_else(|| operation_conflict(operation_id))?;
        if operation.kind != "remove_ignore_rule" || operation.phase != OperationPhase::Planned {
            return Err(operation_conflict(operation_id));
        }
        operation.phase = OperationPhase::Committed;
        operation.progress.phase = OperationPhase::Committed;
        operation.progress.message_code = "operation.remove_ignore_rule.committed".to_owned();
        operation.error_code = None;

        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        remove_from_transaction(&transaction, rule_id)?;
        super::operation_repository::OperationRepositorySqlite::commit_planned_tx(
            &transaction,
            &operation,
        )?;
        transaction.commit().map_err(database_error)?;
        Ok(operation)
    }

    fn save(&self, rules: &[IgnoreRule]) -> AppResult<()> {
        save_to_connection(&self.database.connection, rules)
    }
}

fn list_from(connection: &rusqlite::Connection) -> AppResult<Vec<IgnoreRule>> {
    let value: Option<String> = connection
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

fn save_to_connection(connection: &rusqlite::Connection, rules: &[IgnoreRule]) -> AppResult<()> {
    let json = serde_json::to_string(rules).map_err(|_| invalid_record())?;
    connection.execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            rusqlite::params![KEY, json],
        ).map_err(database_error)?;
    Ok(())
}

fn remove_from_transaction(transaction: &Transaction<'_>, rule_id: &str) -> AppResult<()> {
    let mut rules = list_from(transaction)?;
    let Some(index) = rules.iter().position(|rule| rule.id == rule_id) else {
        return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
            .with_param("field", "ignore_rule")
            .with_action(RecoveryAction::Retry));
    };
    rules.remove(index);
    save_to_connection(transaction, &rules)
}

fn operation_conflict(operation_id: OperationId) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("operation_id", operation_id.to_string())
        .with_action(RecoveryAction::Retry)
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
    super::classify_database_error(error)
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

    #[test]
    fn list_exact_paths_returns_only_exact_path_subjects() {
        let database = Database::open_in_memory().expect("database");
        let repository = database.ignore_rule_repository();
        repository
            .create(skillhub_core::IgnoreRule {
                id: OperationId::new().to_string(),
                subject: IgnoreSubject::exact_path("C:/agent/skills/alpha").expect("exact path"),
                reason: "discovery-exclude".into(),
                created_at: String::new(),
                defer_until: None,
            })
            .expect("create path rule");
        repository
            .create(skillhub_core::IgnoreRule {
                id: OperationId::new().to_string(),
                subject: IgnoreSubject::exact_pending("trial_due:skill:trial.due"),
                reason: "later".into(),
                created_at: String::new(),
                defer_until: None,
            })
            .expect("create pending rule");

        assert_eq!(
            repository.list_exact_paths().expect("list exact paths"),
            vec!["C:/agent/skills/alpha".to_owned()]
        );
    }
}
