use std::collections::BTreeMap;

use rusqlite::Connection;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

pub const CURRENT_SCHEMA_VERSION: u32 = 2;

struct Migration {
    version: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("../../migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        sql: include_str!("../../migrations/0002_fts.sql"),
    },
];

/// The result of applying zero or more schema migrations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationReport {
    pub from_version: u32,
    pub to_version: u32,
    pub applied_versions: Vec<u32>,
}

pub fn run(connection: &mut Connection) -> AppResult<MigrationReport> {
    let from_version = read_schema_version(connection)?;
    if from_version > CURRENT_SCHEMA_VERSION {
        return Err(
            AppError::new(ErrorCode::DatabaseNewerSchema, Severity::Error)
                .with_param("database_version", from_version)
                .with_param("application_version", CURRENT_SCHEMA_VERSION)
                .with_action(RecoveryAction::OpenReadOnly),
        );
    }

    let mut applied_versions = Vec::new();
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > from_version)
    {
        let transaction = connection.transaction().map_err(database_error)?;
        transaction
            .execute_batch(migration.sql)
            .map_err(database_error)?;
        transaction
            .pragma_update(None, "user_version", migration.version)
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        applied_versions.push(migration.version);
    }

    let to_version = read_schema_version(connection)?;
    Ok(MigrationReport {
        from_version,
        to_version,
        applied_versions,
    })
}

fn read_schema_version(connection: &Connection) -> AppResult<u32> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
        .map_err(database_error)
}

fn database_error(error: rusqlite::Error) -> AppError {
    let mut params = BTreeMap::new();
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
