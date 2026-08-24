use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::scan::ScanResult;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

const SCAN_KEY: &str = "scan_snapshot";

/// Persists the last confirmed scan facts. Watcher hints are deliberately not
/// stored here; callers replace this snapshot only after a scan completes.
pub struct ScanRepository<'a> {
    database: &'a Database,
}

impl<'a> ScanRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn load(&self) -> AppResult<Option<ScanResult>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [SCAN_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_snapshot()))
            .transpose()
    }

    pub fn replace(&self, snapshot: &ScanResult) -> AppResult<ScanResult> {
        let json = serde_json::to_string(snapshot).map_err(|_| invalid_snapshot())?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                params![SCAN_KEY, json, now()],
            )
            .map_err(database_error)?;
        Ok(snapshot.clone())
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_snapshot() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
