use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::bootstrap::{
    BootstrapSnapshot, DeploymentChartCategory, DeploymentDimension, InitializationStatus,
    PendingSummary, RecentOperationSummary, StartupRecoveryState, TagChartCategory,
};
use skillhub_core::pending::{PendingItem, PendingKind};
use skillhub_core::OperationPhase;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId};

const SNAPSHOT_KEY: &str = "bootstrap_snapshot";
const INITIALIZATION_KEY: &str = "bootstrap_initialization";
const LIBRARY_ROOT_KEY: &str = "bootstrap_library_root";

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

    pub fn load_initialization(&self) -> AppResult<Option<InitializationStatus>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [INITIALIZATION_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        value
            .map(|json| serde_json::from_str(&json).map_err(|_| invalid_snapshot()))
            .transpose()
    }

    pub fn save_initialization(&self, status: &InitializationStatus) -> AppResult<()> {
        let json = serde_json::to_string(status).map_err(|_| invalid_snapshot())?;
        self.database.connection.execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![INITIALIZATION_KEY, json, now()],
        ).map_err(error)?;
        Ok(())
    }

    /// The persisted central library root chosen during onboarding, if any.
    pub fn load_library_root(&self) -> AppResult<Option<String>> {
        self.database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [LIBRARY_ROOT_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?
            .map(|json| serde_json::from_str::<String>(&json))
            .transpose()
            .map_err(|_| invalid_snapshot())
    }

    pub fn save_library_root(&self, path: &str) -> AppResult<()> {
        let json = serde_json::to_string(path).map_err(|_| invalid_snapshot())?;
        self.database.connection.execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![LIBRARY_ROOT_KEY, json, now()],
        ).map_err(error)?;
        Ok(())
    }

    /// AR-021：为版本写入或替换用户可读名称。同一版本重复命名即替换，
    /// 内容哈希（version_id）本身不变。
    pub fn set_version_label(
        &self,
        skill_id: &str,
        version_id: &str,
        label: &str,
    ) -> AppResult<()> {
        self.database.connection.execute(
            "INSERT INTO version_labels(version_id,skill_id,label,created_at,updated_at) VALUES(?1,?2,?3,?4,?4) ON CONFLICT(version_id) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at",
            params![version_id, skill_id, label, now()],
        ).map_err(error)?;
        Ok(())
    }

    /// 读取一批版本的用户名称（未命名的版本不在结果中）。
    pub fn version_labels(
        &self,
        version_ids: &[String],
    ) -> AppResult<std::collections::HashMap<String, String>> {
        let mut map = std::collections::HashMap::new();
        for version_id in version_ids {
            let mut statement = self
                .database
                .connection
                .prepare("SELECT label FROM version_labels WHERE version_id=?1")
                .map_err(error)?;
            let mut rows = statement
                .query_map([version_id], |row| row.get::<_, String>(0))
                .map_err(error)?;
            if let Some(Ok(label)) = rows.next() {
                map.insert(version_id.clone(), label);
            }
        }
        Ok(map)
    }

    pub fn list_pending(&self, today: (i32, u8, u8)) -> AppResult<Vec<PendingItem>> {
        let date = format_date(today);
        let mut result = Vec::new();
        // N9：影响面——每个 Skill 当前生效的部署关系数量，一次聚合查询。
        let mut deployment_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        {
            let mut counts = self.database.connection.prepare(
                "SELECT skill_id, COUNT(*) FROM deployments WHERE state IN ('deployed','active') GROUP BY skill_id",
            ).map_err(error)?;
            let rows = counts
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(error)?;
            for row in rows {
                let (skill_id, count) = row.map_err(error)?;
                deployment_counts.insert(skill_id, count.max(0) as u32);
            }
        }
        let mut trials = self.database.connection.prepare(
            "SELECT skill_id, trial_due FROM catalog_skill_metadata WHERE trial_due IS NOT NULL AND trial_due <= ?1 ORDER BY skill_id",
        ).map_err(error)?;
        for row in trials
            .query_map([date], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error)?
        {
            let (skill_id, trial_due) = row.map_err(error)?;
            let subject = parse_skill(skill_id.clone())?;
            result.push(PendingItem {
                affected_deployments: Some(deployment_counts.get(&skill_id).copied().unwrap_or(0)),
                due_date: Some(trial_due),
                risk: None,
                subject,
                kind: PendingKind::TrialDue,
                code: "trial.due".into(),
                message_code: Some("pending.trial_due".into()),
            });
        }
        let ordering = if has_column(&self.database.connection, "check_runs", "generation")? {
            "current.generation DESC,current.started_at DESC,COALESCE(current.ended_at,-1) DESC,current.id DESC"
        } else {
            "current.started_at DESC,COALESCE(current.ended_at,-1) DESC,current.id DESC"
        };
        let findings_sql = format!(
            "SELECT r.skill_id, f.code, f.severity FROM check_findings f JOIN check_runs r ON r.id=f.run_id WHERE f.disposition NOT IN ('resolved','dismissed') AND r.version_id = (SELECT pointer.version_id FROM current_pointers pointer WHERE pointer.skill_id=r.skill_id) AND r.id = (SELECT current.id FROM check_runs current WHERE current.skill_id=r.skill_id AND current.version_id=r.version_id AND current.kind=r.kind ORDER BY {ordering} LIMIT 1) ORDER BY r.skill_id, f.code, f.id"
        );
        let mut findings = self
            .database
            .connection
            .prepare(&findings_sql)
            .map_err(error)?;
        for row in findings
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(error)?
        {
            let (subject, code, severity) = row.map_err(error)?;
            let risk = match severity.as_deref() {
                Some("critical") | Some("error") => Some(skillhub_core::pending::PendingRisk::High),
                Some("warning") => Some(skillhub_core::pending::PendingRisk::Medium),
                Some("info") => Some(skillhub_core::pending::PendingRisk::Low),
                _ => None,
            };
            result.push(PendingItem {
                affected_deployments: Some(deployment_counts.get(&subject).copied().unwrap_or(0)),
                due_date: None,
                risk,
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

    /// N12：确定性重复——当前版本内容哈希与目标 Skill 完全相同的其他
    /// Skill（含显示名与哈希）。目标自身不在结果中。
    pub fn list_deterministic_duplicates(
        &self,
        skill_id: &str,
    ) -> AppResult<Vec<(String, String, String)>> {
        let mut statement = self.database.connection.prepare(
            "SELECT cp.skill_id, s.display_name, v.content_hash
             FROM current_pointers cp
             JOIN versions v ON v.id = cp.version_id
             JOIN skills s ON s.id = cp.skill_id
             WHERE v.content_hash = (SELECT v2.content_hash FROM current_pointers cp2 JOIN versions v2 ON v2.id = cp2.version_id WHERE cp2.skill_id = ?1)
               AND cp.skill_id != ?1
             ORDER BY cp.skill_id",
        ).map_err(error)?;
        let rows = statement
            .query_map([skill_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(error)?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(error)?);
        }
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
            "SELECT {column}, COUNT(*) FROM deployments d JOIN targets t ON t.id=d.target_id WHERE d.state IN ('deployed','active') AND d.managed=1 GROUP BY {column} ORDER BY {column}"
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

    /// Aggregates skill counts per tag for the overview tag drill-down.
    /// Tags without any skill are omitted; the library page remains the source
    /// of truth for the full facet list.
    pub fn tag_chart(&self) -> AppResult<Vec<TagChartCategory>> {
        let sql = "SELECT t.name, COUNT(st.skill_id) FROM tags t JOIN skill_tags st ON st.tag_id=t.id GROUP BY t.name ORDER BY t.name";
        let mut statement = self.database.connection.prepare(sql).map_err(error)?;
        let mut result = Vec::new();
        for row in statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(error)?
        {
            let (key, count) = row.map_err(error)?;
            result.push(TagChartCategory {
                key,
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
        let tag_categories = self.tag_chart()?;
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
            initialization_state: Default::default(),
            library_path: String::new(),
            onboarding_skipped: false,
            skill_count,
            project_count,
            agent_count,
            deployed_count,
            deployment_categories,
            tag_categories,
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

fn has_column(connection: &rusqlite::Connection, table: &str, column: &str) -> AppResult<bool> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(error)?;
    for row in statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(error)?
    {
        if row.map_err(error)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
fn invalid_snapshot() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}
fn error(e: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", e.to_string())
        .with_action(RecoveryAction::Retry)
}
