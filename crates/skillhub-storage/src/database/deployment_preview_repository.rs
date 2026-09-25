use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

fn database_error(error: rusqlite::Error) -> AppError {
    let mut params = std::collections::BTreeMap::new();
    params.insert(
        "source".to_owned(),
        serde_json::Value::String(error.to_string()),
    );
    AppError {
        code: ErrorCode::InternalError,
        severity: Severity::Error,
        params,
        actions: vec![RecoveryAction::Retry],
    }
}

/// One stored deployment preview snapshot.  `payload_json` carries the full
/// pair list the backend minted; `status` is `active` until a commit consumes
/// it, and `expires_at` (unix seconds) bounds its reuse after a restart.
#[derive(Clone, Debug, PartialEq)]
pub struct DeploymentPreviewSnapshot {
    pub preview_id: String,
    pub payload_json: String,
    pub status: String,
    pub created_at: i64,
    pub expires_at: i64,
}

/// Persistence for server-owned deployment preview snapshots and their
/// idempotent commit results (migration 0021).
pub struct DeploymentPreviewRepository<'a> {
    database: &'a Database,
}

impl<'a> DeploymentPreviewRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// Stores a new snapshot.  Preview ids are single-use: re-inserting the
    /// same id is refused instead of silently replacing the held facts.
    pub fn insert(&self, snapshot: &DeploymentPreviewSnapshot) -> AppResult<()> {
        if snapshot.preview_id.trim().is_empty() || snapshot.payload_json.trim().is_empty() {
            return Err(skillhub_core::AppError::new(
                skillhub_core::ErrorCode::InvalidInput,
                skillhub_core::Severity::Error,
            )
            .with_param("field", "preview_id")
            .with_action(skillhub_core::RecoveryAction::Retry));
        }
        let inserted = self
            .database
            .connection
            .execute(
                "INSERT INTO deployment_preview_snapshots
                 (preview_id, payload_json, status, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(preview_id) DO NOTHING",
                params![
                    snapshot.preview_id,
                    snapshot.payload_json,
                    snapshot.status,
                    snapshot.created_at,
                    snapshot.expires_at
                ],
            )
            .map_err(database_error)?;
        if inserted == 0 {
            return Err(skillhub_core::AppError::new(
                skillhub_core::ErrorCode::OperationConflict,
                skillhub_core::Severity::Error,
            )
            .with_param("field", "preview_id")
            .with_action(skillhub_core::RecoveryAction::Retry));
        }
        Ok(())
    }

    /// Reads a snapshot in any status, for diagnostics and consumed-snapshot
    /// rejection messages.
    pub fn get(&self, preview_id: &str) -> AppResult<Option<DeploymentPreviewSnapshot>> {
        self.database
            .connection
            .query_row(
                "SELECT preview_id, payload_json, status, created_at, expires_at
                 FROM deployment_preview_snapshots WHERE preview_id = ?1",
                [preview_id],
                |row| {
                    Ok(DeploymentPreviewSnapshot {
                        preview_id: row.get(0)?,
                        payload_json: row.get(1)?,
                        status: row.get(2)?,
                        created_at: row.get(3)?,
                        expires_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(database_error)
    }

    /// Returns the snapshot only while it is active and unexpired; exactly at
    /// `expires_at` it is already unusable.
    pub fn get_active(
        &self,
        preview_id: &str,
        now: i64,
    ) -> AppResult<Option<DeploymentPreviewSnapshot>> {
        Ok(self
            .get(preview_id)?
            .filter(|snapshot| snapshot.status == "active" && snapshot.expires_at > now))
    }

    /// Marks an active snapshot consumed.  A missing id or a second consume
    /// is refused: replay goes through the recorded commit result instead.
    pub fn consume(&self, preview_id: &str) -> AppResult<()> {
        let changed = self
            .database
            .connection
            .execute(
                "UPDATE deployment_preview_snapshots SET status = 'consumed'
                 WHERE preview_id = ?1 AND status = 'active'",
                [preview_id],
            )
            .map_err(database_error)?;
        if changed == 0 {
            return Err(self.unknown_or_consumed(preview_id));
        }
        Ok(())
    }

    fn unknown_or_consumed(&self, preview_id: &str) -> skillhub_core::AppError {
        let known = self.get(preview_id).ok().flatten().is_some();
        skillhub_core::AppError::new(
            if known {
                skillhub_core::ErrorCode::OperationConflict
            } else {
                skillhub_core::ErrorCode::ObjectNotFound
            },
            skillhub_core::Severity::Error,
        )
        .with_param("field", "preview_id")
        .with_action(skillhub_core::RecoveryAction::Retry)
    }

    /// Returns the recorded result of an identical earlier commit, if any.
    pub fn find_commit_result(&self, idempotency_key: &str) -> AppResult<Option<String>> {
        self.database
            .connection
            .query_row(
                "SELECT result_json FROM deployment_preview_commits WHERE idempotency_key = ?1",
                [idempotency_key],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)
    }

    /// Records a commit result under its idempotency key.  The first result
    /// wins: the same key with a different payload is refused so a replay can
    /// never manufacture a different outcome.
    pub fn insert_commit_result(
        &self,
        idempotency_key: &str,
        preview_id: &str,
        result_json: &str,
        committed_at: i64,
    ) -> AppResult<()> {
        let existing = self.find_commit_result(idempotency_key)?;
        if let Some(recorded) = existing {
            if recorded != result_json {
                return Err(skillhub_core::AppError::new(
                    skillhub_core::ErrorCode::OperationIdReusedWithDifferentRequest,
                    skillhub_core::Severity::Error,
                )
                .with_param("field", "idempotency_key")
                .with_action(skillhub_core::RecoveryAction::Retry));
            }
            return Ok(());
        }
        let inserted = self
            .database
            .connection
            .execute(
                "INSERT INTO deployment_preview_commits
                 (idempotency_key, preview_id, result_json, committed_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![idempotency_key, preview_id, result_json, committed_at],
            )
            .map_err(database_error)?;
        if inserted == 0 {
            return Err(skillhub_core::AppError::new(
                skillhub_core::ErrorCode::OperationConflict,
                skillhub_core::Severity::Error,
            )
            .with_param("field", "idempotency_key")
            .with_action(skillhub_core::RecoveryAction::Retry));
        }
        Ok(())
    }
}
