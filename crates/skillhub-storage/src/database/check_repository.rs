use super::Database;
use async_trait::async_trait;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use skillhub_core::check::{
    derive_check_state, CheckKind, CheckRepository as CheckRepositoryPort, CheckRun, CheckRunPhase,
    Finding, FindingDisposition,
};
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId, VersionId};
use std::collections::BTreeMap;

/// SQLite persistence for check runs and their findings.
pub struct CheckRepositorySqlite<'a> {
    database: &'a Database,
}

impl<'a> CheckRepositorySqlite<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }
}

#[async_trait(?Send)]
impl CheckRepositoryPort for CheckRepositorySqlite<'_> {
    async fn insert(&self, run: &CheckRun) -> AppResult<()> {
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        tx.execute(
            "INSERT INTO check_runs(id,skill_id,version_id,kind,generation,state,ruleset_id,model_id,started_at,ended_at,coverage_json,failure_code) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                run.id,
                run.skill_id.to_string(),
                run.version_id.to_string(),
                kind_code(run.kind),
                i64::try_from(run.generation).map_err(|_| invalid_record())?,
                state_code(run),
                run.ruleset_id,
                run.model_id,
                run.started_at,
                run.ended_at,
                serde_json::to_string(&run.coverage_inputs).map_err(|_| invalid_record())?,
                run.failure_code,
            ],
        )
        .map_err(error)?;
        insert_findings(&tx, run)?;
        tx.commit().map_err(error)
    }

    async fn get(&self, id: &str) -> AppResult<Option<CheckRun>> {
        let row = self
            .database
            .connection
            .query_row(
                "SELECT skill_id,version_id,kind,generation,state,ruleset_id,model_id,started_at,ended_at,coverage_json,failure_code FROM check_runs WHERE id=?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, Option<String>>(10)?,
                    ))
                },
            )
            .optional()
            .map_err(error)?;
        row.map(
            |(
                skill,
                version,
                kind,
                generation,
                state,
                ruleset,
                model,
                started,
                ended,
                coverage,
                failure,
            )| {
                let skill_id = skill.parse().map_err(|_| invalid_record())?;
                let version_id = version.parse().map_err(|_| invalid_record())?;
                let kind = parse_kind(&kind)?;
                let phase = parse_phase(&state, failure.is_some())?;
                let coverage_inputs =
                    serde_json::from_str(&coverage).map_err(|_| invalid_record())?;
                let mut run = CheckRun {
                    id: id.to_owned(),
                    skill_id,
                    version_id,
                    kind,
                    generation: u64::try_from(generation).map_err(|_| invalid_record())?,
                    phase,
                    ruleset_id: ruleset,
                    model_id: model,
                    started_at: started,
                    ended_at: ended,
                    coverage_inputs,
                    failure_code: failure,
                    findings: Vec::new(),
                };
                run.findings = load_findings(&self.database.connection, id)?;
                Ok(run)
            },
        )
        .transpose()
    }

    async fn update(&self, run: &CheckRun) -> AppResult<()> {
        let tx = self
            .database
            .connection
            .unchecked_transaction()
            .map_err(error)?;
        let changed = tx
            .execute(
                "UPDATE check_runs SET skill_id=?2,version_id=?3,kind=?4,generation=?5,state=?6,ruleset_id=?7,model_id=?8,started_at=?9,ended_at=?10,coverage_json=?11,failure_code=?12 WHERE id=?1",
                params![
                    run.id,
                    run.skill_id.to_string(),
                    run.version_id.to_string(),
                    kind_code(run.kind),
                    i64::try_from(run.generation).map_err(|_| invalid_record())?,
                    state_code(run),
                    run.ruleset_id,
                    run.model_id,
                    run.started_at,
                    run.ended_at,
                    serde_json::to_string(&run.coverage_inputs).map_err(|_| invalid_record())?,
                    run.failure_code,
                ],
            )
            .map_err(error)?;
        if changed == 0 {
            return Err(AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                .with_param("check_run_id", run.id.clone())
                .with_action(RecoveryAction::Retry));
        }
        tx.execute(
            "DELETE FROM check_findings WHERE run_id=?1",
            [run.id.as_str()],
        )
        .map_err(error)?;
        insert_findings(&tx, run)?;
        tx.commit().map_err(error)
    }

    async fn list_for_version(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        kind: CheckKind,
    ) -> AppResult<Vec<CheckRun>> {
        let mut statement = self.database.connection.prepare(
            "SELECT id FROM check_runs WHERE skill_id=?1 AND version_id=?2 AND kind=?3 ORDER BY started_at,id",
        ).map_err(error)?;
        let ids = statement
            .query_map(
                params![
                    skill_id.to_string(),
                    version_id.to_string(),
                    kind_code(kind)
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(error)?;
        let mut runs = Vec::new();
        for id in ids {
            let id = id.map_err(error)?;
            if let Some(run) = self.get(&id).await? {
                runs.push(run);
            }
        }
        Ok(runs)
    }

    async fn current_for_version(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        kind: CheckKind,
    ) -> AppResult<Option<CheckRun>> {
        let id = self
            .database
            .connection
            .query_row(
                "SELECT id FROM check_runs WHERE skill_id=?1 AND version_id=?2 AND kind=?3 ORDER BY generation DESC,started_at DESC,COALESCE(ended_at,-1) DESC,id DESC LIMIT 1",
                params![skill_id.to_string(), version_id.to_string(), kind_code(kind)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?;
        match id {
            Some(id) => self.get(&id).await,
            None => Ok(None),
        }
    }
}

fn insert_findings(tx: &rusqlite::Transaction<'_>, run: &CheckRun) -> AppResult<()> {
    for finding in &run.findings {
        tx.execute(
            "INSERT INTO check_findings(id,run_id,code,severity,file_path,line_start,line_end,evidence_hash,message_params_json,disposition,allowed_dispositions_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                finding.id,
                run.id,
                finding.code,
                severity_code(finding.severity),
                finding.file,
                finding.line_start.map(i64::from),
                finding.line_end.map(i64::from),
                finding.evidence_hash,
                serde_json::to_string(&finding.message_params).map_err(|_| invalid_record())?,
                disposition_code(finding.disposition),
                serde_json::to_string(&finding.allowed_dispositions).map_err(|_| invalid_record())?,
            ],
        )
        .map_err(error)?;
    }
    Ok(())
}

fn load_findings(connection: &rusqlite::Connection, run_id: &str) -> AppResult<Vec<Finding>> {
    let mut statement = connection
        .prepare("SELECT id,code,severity,file_path,line_start,line_end,evidence_hash,message_params_json,disposition,allowed_dispositions_json FROM check_findings WHERE run_id=?1 ORDER BY id")
        .map_err(error)?;
    let rows = statement
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
            ))
        })
        .map_err(error)?;
    rows.map(|row| {
        let (id, code, severity, file, start, end, evidence, params, disposition, allowed) =
            row.map_err(error)?;
        let message_params = serde_json::from_str::<BTreeMap<String, Value>>(&params)
            .map_err(|_| invalid_record())?;
        Ok(Finding {
            id,
            code,
            severity: parse_severity(&severity)?,
            file,
            line_start: start.map(to_u32).transpose()?,
            line_end: end.map(to_u32).transpose()?,
            evidence_hash: evidence,
            message_params,
            disposition: parse_disposition(&disposition)?,
            allowed_dispositions: allowed
                .map(|value| serde_json::from_str(&value).map_err(|_| invalid_record()))
                .transpose()?
                .unwrap_or_else(default_allowed_dispositions),
        })
    })
    .collect()
}

fn kind_code(kind: CheckKind) -> &'static str {
    match kind {
        CheckKind::Basic => "basic",
        CheckKind::Llm => "llm",
    }
}

fn parse_kind(value: &str) -> AppResult<CheckKind> {
    match value {
        "basic" => Ok(CheckKind::Basic),
        "llm" | "llm_safety" => Ok(CheckKind::Llm),
        _ => Err(invalid_record()),
    }
}

fn state_code(run: &CheckRun) -> &'static str {
    match derive_check_state(run) {
        skillhub_core::check::CheckState::NotChecked => "not_checked",
        skillhub_core::check::CheckState::Running => "running",
        skillhub_core::check::CheckState::Passed => "passed",
        skillhub_core::check::CheckState::Failed => "failed",
    }
}

fn parse_phase(value: &str, has_failure_code: bool) -> AppResult<CheckRunPhase> {
    match value {
        "not_checked" => Ok(CheckRunPhase::NotChecked),
        "running" => Ok(CheckRunPhase::Running),
        "completed" | "passed" => Ok(CheckRunPhase::Completed),
        "failed" if has_failure_code => Ok(CheckRunPhase::Failed),
        "failed" => Ok(CheckRunPhase::Completed),
        _ => Err(invalid_record()),
    }
}

fn default_allowed_dispositions() -> std::collections::BTreeSet<FindingDisposition> {
    [
        FindingDisposition::Acknowledged,
        FindingDisposition::Dismissed,
    ]
    .into_iter()
    .collect()
}

fn severity_code(value: Severity) -> &'static str {
    match value {
        Severity::Info => "info",
        Severity::Warning => "warning",
        Severity::Error => "error",
        Severity::Critical => "critical",
    }
}

fn parse_severity(value: &str) -> AppResult<Severity> {
    match value {
        "info" => Ok(Severity::Info),
        "warning" => Ok(Severity::Warning),
        "error" => Ok(Severity::Error),
        "critical" => Ok(Severity::Critical),
        _ => Err(invalid_record()),
    }
}

fn disposition_code(value: FindingDisposition) -> &'static str {
    match value {
        FindingDisposition::Actionable => "actionable",
        FindingDisposition::Acknowledged => "resolved",
        FindingDisposition::Dismissed => "dismissed",
    }
}

fn parse_disposition(value: &str) -> AppResult<FindingDisposition> {
    match value {
        "actionable" => Ok(FindingDisposition::Actionable),
        "acknowledged" | "resolved" => Ok(FindingDisposition::Acknowledged),
        "dismissed" => Ok(FindingDisposition::Dismissed),
        _ => Err(invalid_record()),
    }
}

fn to_u32(value: i64) -> AppResult<u32> {
    u32::try_from(value).map_err(|_| invalid_record())
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("reason", "check_record_corrupt")
        .with_action(RecoveryAction::Retry)
}

fn error(value: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", value.to_string())
        .with_action(RecoveryAction::Retry)
}
