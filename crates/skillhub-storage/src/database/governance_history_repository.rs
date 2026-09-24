use super::Database;
use rusqlite::{params, Transaction};
use serde_json::Value;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

/// One immutable governance history row. Everything a renderer needs is
/// snapshotted at write time — user-facing Skill name, Agent presentation,
/// path, action, result, and reason — so history stays renderable after the
/// Skill, the relation, or the directory it refers to has been deleted.
/// Identifiers are opaque strings on purpose: they may reference entities
/// that no longer exist.
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceHistoryEvent {
    pub event_id: String,
    pub relation_id: String,
    pub skill_id: Option<String>,
    pub skill_display_name: String,
    pub agent_presentation: Value,
    pub path: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub action: String,
    pub result: String,
    pub reason: Option<String>,
    pub operation_id: Option<String>,
    pub occurred_at: i64,
}

/// Append-only persistence for relationship governance history
/// (migration 0019 `relation_history_events`). Rows are immutable at the
/// schema level; this repository can only append and read.
pub struct GovernanceHistoryRepository<'a> {
    database: &'a Database,
}

impl<'a> GovernanceHistoryRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn append(&self, event: &GovernanceHistoryEvent) -> AppResult<()> {
        let transaction = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(database_error)?;
        Self::append_tx(&transaction, event)?;
        transaction.commit().map_err(database_error)
    }

    /// Caller-transaction seam: appends history inside the caller's
    /// transaction so relation archive/restore and its history entry commit
    /// or roll back together. History appends never bump the relationship
    /// projection revision: they are audit evidence, not graph facts.
    pub fn append_tx(
        transaction: &Transaction<'_>,
        event: &GovernanceHistoryEvent,
    ) -> AppResult<()> {
        for field in [
            ("event_id", event.event_id.as_str()),
            ("relation_id", event.relation_id.as_str()),
            ("skill_display_name", event.skill_display_name.as_str()),
            ("path", event.path.as_str()),
            ("scope", event.scope.as_str()),
            ("action", event.action.as_str()),
            ("result", event.result.as_str()),
        ] {
            if field.1.trim().is_empty() {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", field.0)
                    .with_action(RecoveryAction::Retry));
            }
        }
        let agent_presentation =
            serde_json::to_string(&event.agent_presentation).map_err(|error| {
                AppError::new(ErrorCode::InvalidInput, Severity::Error)
                    .with_param("field", "agent_presentation")
                    .with_param("source", error.to_string())
                    .with_action(RecoveryAction::Retry)
            })?;
        transaction
            .execute(
                "INSERT INTO relation_history_events
                 (event_id, relation_id, skill_id, skill_display_name,
                  agent_presentation_json, path, scope, project_id, action, result,
                  reason, operation_id, occurred_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    event.event_id,
                    event.relation_id,
                    event.skill_id,
                    event.skill_display_name,
                    agent_presentation,
                    event.path,
                    event.scope,
                    event.project_id,
                    event.action,
                    event.result,
                    event.reason,
                    event.operation_id,
                    event.occurred_at,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    /// Newest first, so renderers can show the latest outcome directly.
    pub fn list_for_relation(&self, relation_id: &str) -> AppResult<Vec<GovernanceHistoryEvent>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT event_id, relation_id, skill_id, skill_display_name,
                        agent_presentation_json, path, scope, project_id, action, result,
                        reason, operation_id, occurred_at
                 FROM relation_history_events WHERE relation_id=?1
                 ORDER BY occurred_at DESC, event_id DESC",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([relation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, i64>(12)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| decode_history(row.map_err(database_error)?).ok_or_else(invalid_record))
            .collect()
    }
}

type HistoryRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
);

#[allow(clippy::type_complexity)]
fn decode_history(value: HistoryRow) -> Option<GovernanceHistoryEvent> {
    let agent_presentation = serde_json::from_str(&value.4).ok()?;
    Some(GovernanceHistoryEvent {
        event_id: value.0,
        relation_id: value.1,
        skill_id: value.2,
        skill_display_name: value.3,
        agent_presentation,
        path: value.5,
        scope: value.6,
        project_id: value.7,
        action: value.8,
        result: value.9,
        reason: value.10,
        operation_id: value.11,
        occurred_at: value.12,
    })
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "governance_history_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
