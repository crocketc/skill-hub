mod migrations;

use std::fmt;
use std::path::Path;

use rusqlite::Connection;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

pub use migrations::MigrationReport;

/// An application database backed by SQLite.
pub struct Database {
    connection: Connection,
}

impl fmt::Debug for Database {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Database")
            .field("connection", &"<sqlite connection>")
            .finish()
    }
}

impl Database {
    /// Opens a database file and applies all migrations required by this build.
    pub fn open(path: impl AsRef<Path>) -> AppResult<Self> {
        let mut connection = Connection::open(path).map_err(database_error)?;
        migrations::run(&mut connection)?;
        Ok(Self { connection })
    }

    /// Opens an isolated in-memory database and applies all migrations.
    pub fn open_in_memory() -> AppResult<Self> {
        let mut connection = Connection::open_in_memory().map_err(database_error)?;
        migrations::run(&mut connection)?;
        Ok(Self { connection })
    }

    /// Returns the SQLite schema version stored in `PRAGMA user_version`.
    pub fn schema_version(&self) -> AppResult<u32> {
        self.connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .map_err(database_error)
    }

    /// Reports whether a table or virtual table exists in this database.
    pub fn has_table(&self, name: &str) -> AppResult<bool> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1)",
                [name],
                |row| row.get(0),
            )
            .map_err(database_error)
    }
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
