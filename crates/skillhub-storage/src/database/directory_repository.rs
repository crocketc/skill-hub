use super::Database;
use rusqlite::params;
use skillhub_core::deployment::observed_path_key;
use skillhub_core::relationship::{DirectoryNodeFact, DirectoryRole};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

pub struct DirectoryRepository<'a> {
    database: &'a Database,
}

impl<'a> DirectoryRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn upsert_node(&self, node: &DirectoryNodeFact) -> AppResult<()> {
        let path_key = observed_path_key(&node.path);
        self.database
            .connection
            .execute(
                "INSERT INTO directory_nodes
                 (node_id, path, path_key, role, profile_id, agent_client_id, exists_flag, observed_at, scan_source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(node_id) DO UPDATE SET
                 path=excluded.path, path_key=excluded.path_key, role=excluded.role,
                 profile_id=excluded.profile_id, agent_client_id=excluded.agent_client_id,
                 exists_flag=excluded.exists_flag, observed_at=excluded.observed_at,
                 scan_source=excluded.scan_source",
                params![
                    node.node_id,
                    node.path,
                    path_key,
                    role_code(node.role),
                    node.profile_id,
                    node.agent_client_id,
                    i64::from(node.exists),
                    node.observed_at,
                    node.scan_source,
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn list_nodes(&self) -> AppResult<Vec<DirectoryNodeFact>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT node_id, path, path_key, role, profile_id, agent_client_id, exists_flag, observed_at, scan_source
                 FROM directory_nodes ORDER BY path_key, node_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            decode_node(row).ok_or_else(invalid_record)
        })
        .collect()
    }

    pub fn get_node(&self, node_id: &str) -> AppResult<Option<DirectoryNodeFact>> {
        self.database
            .connection
            .query_row(
                "SELECT node_id, path, path_key, role, profile_id, agent_client_id, exists_flag, observed_at, scan_source
                 FROM directory_nodes WHERE node_id=?1",
                [node_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
            .map(|row| decode_node(row).ok_or_else(invalid_record))
            .transpose()
    }
}

type StoredNode = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<String>,
);

fn decode_node(row: StoredNode) -> Option<DirectoryNodeFact> {
    Some(DirectoryNodeFact {
        node_id: row.0,
        path: row.1,
        path_key: row.2,
        role: parse_role(&row.3)?,
        profile_id: row.4,
        agent_client_id: row.5,
        exists: row.6 != 0,
        observed_at: row.7,
        scan_source: row.8,
    })
}

fn role_code(value: DirectoryRole) -> &'static str {
    match value {
        DirectoryRole::CentralLibrary => "central_library",
        DirectoryRole::AgentNative => "agent_native",
        DirectoryRole::SharedDirectory => "shared_directory",
        DirectoryRole::Project => "project",
    }
}

fn parse_role(value: &str) -> Option<DirectoryRole> {
    match value {
        "central_library" => Some(DirectoryRole::CentralLibrary),
        "agent_native" => Some(DirectoryRole::AgentNative),
        "shared_directory" => Some(DirectoryRole::SharedDirectory),
        "project" => Some(DirectoryRole::Project),
        _ => None,
    }
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "directory_node_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

use rusqlite::OptionalExtension;
