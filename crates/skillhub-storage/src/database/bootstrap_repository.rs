use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::bootstrap::{
    BootstrapSnapshot, DeploymentChartCategory, DeploymentDimension, PendingSummary,
    RecentOperationSummary, StartupRecoveryState,
};
use skillhub_core::pending::{PendingItem, PendingKind};
use skillhub_core::OperationPhase;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId};

const SNAPSHOT_KEY: &str = "bootstrap_snapshot";

pub struct BootstrapRepository<'a> {
    database: &'a Database,
}

impl<'a> BootstrapRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn load(&self) -> AppResult<Option<BootstrapSnapshot>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [SNAPSHOT_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_snapshot()))
            .transpose()
    }

    pub fn save(&self, snapshot: &BootstrapSnapshot) -> AppResult<()> {
        let json = serde_json::to_string(snapshot).map_err(|_| invalid_snapshot())?;
        self.database.connection.execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![SNAPSHOT_KEY, json, now()],
        ).map_err(error)?;
        Ok(())
    }

    pub fn list_pending(&self, today: (i32, u8, u8)) -> AppResult<Vec<PendingItem>> {
        let date = format_date(today);
        let mut result = Vec::new();
        let mut trials = self.database.connection.prepare(
            "SELECT skill_id FROM catalog_skill_metadata WHERE trial_due IS NOT NULL AND trial_due <= ?1 ORDER BY skill_id",
        ).map_err(error)?;
        for row in trials
            .query_map([date], |row| row.get::<_, String>(0))
            .map_err(error)?
        {
            result.push(PendingItem {
                subject: parse_skill(row.map_err(error)?)?,
                kind: PendingKind::TrialDue,
                code: "trial.due".into(),
                message_code: Some("pending.trial_due".into()),
            });
        }
        let mut findings = self.database.connection.prepare(
            "SELECT r.skill_id, f.code FROM check_findings f JOIN check_runs r ON r.id=f.run_id WHERE f.disposition NOT IN ('resolved','dismissed') ORDER BY r.skill_id, f.code, f.id",
        ).map_err(error)?;
        for row in findings
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?
        {
            let (subject, code) = row.map_err(error)?;
            result.push(PendingItem {
                subject: parse_skill(subject)?,
                kind: PendingKind::SecurityFinding,
                code,
                message_code: Some("pending.security_finding".into()),
            });
        }
        result.sort();
        result.dedup();
        Ok(result)
    }

    /// Returns deployment counts for one chart dimension. The key is a stable
    /// Agent id or Project id and the label is an i18n code, never a sentence.
    pub fn deployment_chart(
        &self,
        dimension: DeploymentDimension,
    ) -> AppResult<Vec<DeploymentChartCategory>> {
        let (column, label_code) = match dimension {
            DeploymentDimension::Agent => ("t.agent_id", "deployment.dimension.agent"),
            DeploymentDimension::Project => (
                "COALESCE(t.project_id, 'project:none')",
                "deployment.dimension.project",
            ),
        };
        let sql = format!(
            "SELECT {column}, COUNT(*) FROM deployments d JOIN targets t ON t.id=d.target_id GROUP BY {column} ORDER BY {column}"
        );
        let mut statement = self.database.connection.prepare(&sql).map_err(error)?;
        let mut result = Vec::new();
        for row in statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(error)?
        {
            let (key, count) = row.map_err(error)?;
            result.push(DeploymentChartCategory {
                dimension,
                key,
                label_code: label_code.to_owned(),
                count: count as u32,
            });
        }
        Ok(result)
    }

    pub fn build_snapshot(&self, today: (i32, u8, u8)) -> AppResult<BootstrapSnapshot> {
        let pending = self.list_pending(today)?;
        let skill_count = self.count("SELECT COUNT(*) FROM skills")?;
        let project_count = self.count("SELECT COUNT(*) FROM projects")?;
        let agent_count = self
            .database
            .connection
            .query_row("SELECT COUNT(DISTINCT agent_id) FROM targets", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(error)? as u32;
        let deployed_count =
            self.count("SELECT COUNT(*) FROM deployments WHERE state IN ('deployed','active')")?;
        let mut deployment_categories = self.deployment_chart(DeploymentDimension::Agent)?;
        deployment_categories.extend(self.deployment_chart(DeploymentDimension::Project)?);
        let mut recent_operations = Vec::new();
        let mut ops = self.database.connection.prepare("SELECT operation_id,kind,state,phase,error_code,created_at FROM operations ORDER BY created_at DESC,operation_id DESC LIMIT 10").map_err(error)?;
        for row in ops
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(error)?
        {
            let (id, kind, state, phase, error_code, created_at) = row.map_err(error)?;
            recent_operations.push(RecentOperationSummary {
                operation_id: id.parse().map_err(|_| invalid_snapshot())?,
                kind,
                state,
                phase: parse_phase(&phase)?,
                error_code,
                created_at: created_at.to_string(),
            });
        }
        let last_scan_at = self
            .database
            .connection
            .query_row(
                "SELECT MAX(ended_at) FROM check_runs WHERE ended_at IS NOT NULL",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(error)?
            .map(|value| value.to_string());
        let recovery_state = if self.database.connection.query_row::<i64, _, _>("SELECT EXISTS(SELECT 1 FROM operations WHERE state='needs_recovery' OR phase='needs_recovery')", [], |row| row.get(0)).map_err(error)? != 0 {
            StartupRecoveryState::NeedsRecovery
        } else if self.database.connection.query_row::<i64, _, _>("SELECT EXISTS(SELECT 1 FROM operations WHERE state NOT IN ('completed','failed','rolled_back') AND phase NOT IN ('committed','rolled_back','needs_recovery'))", [], |row| row.get(0)).map_err(error)? != 0 {
            StartupRecoveryState::InProgress
        } else {
            StartupRecoveryState::Clean
        };
        Ok(BootstrapSnapshot {
            skill_count,
            project_count,
            agent_count,
            deployed_count,
            deployment_categories,
            recent_operations,
            pending: PendingSummary::from_items(&pending),
            last_scan_at,
            recovery_state,
        })
    }

    fn count(&self, sql: &str) -> AppResult<u32> {
        Ok(self
            .database
            .connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .map_err(error)? as u32)
    }
}

fn format_date((year, month, day): (i32, u8, u8)) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}
fn parse_skill(value: String) -> AppResult<SkillId> {
    value.parse().map_err(|_| invalid_snapshot())
}
fn parse_phase(value: &str) -> AppResult<OperationPhase> {
    match value {
        "planned" => Ok(OperationPhase::Planned),
        "prepared" => Ok(OperationPhase::Prepared),
        "applying" => Ok(OperationPhase::Applying),
        "verifying" => Ok(OperationPhase::Verifying),
        "committed" => Ok(OperationPhase::Committed),
        "needs_recovery" => Ok(OperationPhase::NeedsRecovery),
        "rolled_back" => Ok(OperationPhase::RolledBack),
        _ => Err(invalid_snapshot()),
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
fn error(e: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", e.to_string())
        .with_action(RecoveryAction::Retry)
}
