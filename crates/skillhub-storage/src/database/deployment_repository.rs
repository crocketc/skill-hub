use super::Database;
use async_trait::async_trait;
use rusqlite::{params, OptionalExtension};
use skillhub_core::deployment::{
    DeploymentMode, DeploymentRecord, DeploymentRepository as DeploymentRepositoryPort,
    DeploymentState,
};
use skillhub_core::{AppError, AppResult, DeploymentId, ErrorCode, RecoveryAction, Severity};

/// SQLite persistence for deployment facts.  The planner itself remains in
/// skillhub-core and does not depend on this repository.
pub struct DeploymentRepositorySqlite<'a> {
    pub(crate) database: &'a Database,
}

pub type DeploymentRepository<'a> = DeploymentRepositorySqlite<'a>;

impl<'a> DeploymentRepositorySqlite<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }
}

#[async_trait(?Send)]
impl DeploymentRepositoryPort for DeploymentRepositorySqlite<'_> {
    async fn insert(&self, deployment: &DeploymentRecord) -> AppResult<()> {
        self.database
            .connection
            .execute(
                "INSERT INTO deployments (id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",
                params![
                    deployment.id.to_string(),
                    deployment.skill_id.to_string(),
                    deployment.version_id.to_string(),
                    deployment.target_id,
                    state_code(deployment.state),
                    mode_code(deployment.mode),
                    i64::from(deployment.managed),
                    deployment.runtime_name,
                    deployment.expected_hash,
                    deployment.observed_hash,
                    now(),
                ],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    async fn get(&self, id: DeploymentId) -> AppResult<Option<DeploymentRecord>> {
        self.database
            .connection
            .query_row(
                "SELECT skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash FROM deployments WHERE id=?1",
                [id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?
            .map(|row| decode_record(id, row))
            .transpose()
    }

    async fn list(&self) -> AppResult<Vec<DeploymentRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash FROM deployments ORDER BY created_at,id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            let id = row.0.parse().map_err(|_| invalid_record())?;
            decode_record(
                id,
                (
                    row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9,
                ),
            )
        })
        .collect()
    }

    async fn list_for_target(&self, target_id: &str) -> AppResult<Vec<DeploymentRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare("SELECT id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,observed_hash FROM deployments WHERE target_id=?1 ORDER BY created_at,id")
            .map_err(database_error)?;
        let rows = statement
            .query_map([target_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(database_error)?;
        rows.map(|row| {
            let row = row.map_err(database_error)?;
            let id = row.0.parse().map_err(|_| invalid_record())?;
            decode_record(
                id,
                (
                    row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9,
                ),
            )
        })
        .collect()
    }
}

type StoredRecord = (
    String,
    String,
    String,
    String,
    String,
    i64,
    String,
    String,
    Option<String>,
);

fn decode_record(id: DeploymentId, row: StoredRecord) -> AppResult<DeploymentRecord> {
    Ok(DeploymentRecord {
        id,
        skill_id: row.0.parse().map_err(|_| invalid_record())?,
        version_id: row.1.parse().map_err(|_| invalid_record())?,
        target_id: row.2,
        state: parse_state(&row.3)?,
        mode: parse_mode(&row.4)?,
        managed: row.5 != 0,
        runtime_name: row.6,
        expected_hash: row.7,
        observed_hash: row.8,
    })
}

fn state_code(value: DeploymentState) -> &'static str {
    match value {
        DeploymentState::Planned => "planned",
        DeploymentState::Deployed => "deployed",
        DeploymentState::Removed => "removed",
        DeploymentState::NeedsRecovery => "needs_recovery",
    }
}

fn parse_state(value: &str) -> AppResult<DeploymentState> {
    match value {
        "planned" => Ok(DeploymentState::Planned),
        "deployed" | "active" => Ok(DeploymentState::Deployed),
        "removed" => Ok(DeploymentState::Removed),
        "needs_recovery" => Ok(DeploymentState::NeedsRecovery),
        _ => Err(invalid_record()),
    }
}

fn mode_code(value: DeploymentMode) -> &'static str {
    match value {
        DeploymentMode::SymbolicLink => "symbolic_link",
        DeploymentMode::DirectoryJunction => "directory_junction",
        DeploymentMode::ManagedCopy => "managed_copy",
    }
}

fn parse_mode(value: &str) -> AppResult<DeploymentMode> {
    match value {
        "symbolic_link" => Ok(DeploymentMode::SymbolicLink),
        "directory_junction" => Ok(DeploymentMode::DirectoryJunction),
        "managed_copy" => Ok(DeploymentMode::ManagedCopy),
        _ => Err(invalid_record()),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "deployment_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    let code = match error {
        rusqlite::Error::SqliteFailure(ref failure, _) if failure.extended_code == 2067 => {
            ErrorCode::TargetExists
        }
        _ => ErrorCode::InternalError,
    };
    AppError::new(code, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(if code == ErrorCode::TargetExists {
            RecoveryAction::ChooseAnotherName
        } else {
            RecoveryAction::Retry
        })
}
