use super::Database;
use rusqlite::params;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

/// Registration row for one physical deployment target.  The columns mirror
/// the legacy `targets` table that `deployments.target_id` references;
/// discovery facts themselves live in the agent snapshot, so this repository
/// only maintains the deployment-facing registration that removal and
/// ownership proofs read back.
pub struct TargetRepository<'a> {
    database: &'a Database,
}

pub struct PhysicalTargetRegistration<'a> {
    pub id: &'a str,
    pub agent_id: &'a str,
    pub project_id: Option<&'a str>,
    pub scope: &'a str,
    pub path: &'a str,
}

impl<'a> TargetRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// Registers or refreshes one physical target.  Existing rows keep their
    /// owning agent/project so re-committing the same physical target never
    /// rewrites ownership.
    pub fn upsert_physical_target(
        &self,
        registration: &PhysicalTargetRegistration<'_>,
    ) -> AppResult<()> {
        let connection = &self.database.connection;
        let updated = connection
            .execute(
                "UPDATE targets SET path=?2 WHERE id=?1",
                params![registration.id, registration.path],
            )
            .map_err(|error| target_error("update", error))?;
        if updated > 0 {
            return Ok(());
        }
        connection
            .execute(
                "INSERT INTO targets (id, agent_id, project_id, scope, path, metadata_json, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, '{}', strftime('%s','now'))",
                params![
                    registration.id,
                    registration.agent_id,
                    registration.project_id,
                    registration.scope,
                    registration.path
                ],
            )
            .map_err(|error| target_error("insert", error))?;
        Ok(())
    }
}

fn target_error(stage: &str, error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::OperationConflict, Severity::Error)
        .with_param("operation", format!("deployment.targets_row.{stage}"))
        .with_param("detail", error.to_string())
        .with_action(RecoveryAction::Retry)
}
