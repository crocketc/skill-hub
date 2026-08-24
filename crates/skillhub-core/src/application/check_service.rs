use serde_json::Value;
use std::path::Path;

use crate::check::{
    CheckKind, CheckRepository, CheckResult, CheckRun, CheckRunPhase, Finding, FindingDisposition,
};
use crate::{AppError, AppResult, ErrorCode, RecoveryAction, Severity, SkillId, VersionId};

pub struct BasicCheckOutput {
    pub ruleset_id: String,
    pub findings: Vec<Finding>,
    pub coverage_inputs: Value,
}

pub trait BasicCheckScanner {
    fn scan_version(&self, root: &Path) -> AppResult<BasicCheckOutput>;
}

pub trait VersionMaterializer {
    fn materialize_version(&self, version_id: &VersionId, output: &Path) -> AppResult<()>;
}

pub struct CheckService<R, S, M> {
    repository: R,
    scanner: S,
    materializer: M,
}

impl<R, S, M> CheckService<R, S, M>
where
    R: CheckRepository,
    S: BasicCheckScanner,
    M: VersionMaterializer,
{
    pub fn new(repository: R, scanner: S, materializer: M) -> Self {
        Self {
            repository,
            scanner,
            materializer,
        }
    }

    pub async fn run_basic_check(
        &self,
        skill_id: SkillId,
        version_id: VersionId,
    ) -> AppResult<CheckResult> {
        self.run_basic_check_with_generation(skill_id, version_id, None)
            .await
    }

    pub async fn recheck_basic(
        &self,
        skill_id: SkillId,
        version_id: VersionId,
    ) -> AppResult<CheckResult> {
        let next_generation = self
            .repository
            .current_for_version(skill_id, &version_id, CheckKind::Basic)
            .await?
            .map(|run| run.generation + 1)
            .unwrap_or(0);
        self.run_basic_check_with_generation(skill_id, version_id, Some(next_generation))
            .await
    }

    pub async fn get_basic_check_result(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
    ) -> AppResult<CheckResult> {
        Ok(self
            .repository
            .current_for_version(skill_id, version_id, CheckKind::Basic)
            .await?
            .map(CheckResult::from)
            .unwrap_or_default())
    }

    pub async fn list_findings(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        kind: CheckKind,
    ) -> AppResult<Vec<Finding>> {
        Ok(self
            .repository
            .current_for_version(skill_id, version_id, kind)
            .await?
            .map(|run| run.findings)
            .unwrap_or_default())
    }

    pub async fn set_finding_disposition(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        finding_id: &str,
        disposition: FindingDisposition,
        high_risk_confirmed: bool,
    ) -> AppResult<CheckResult> {
        let run = self
            .repository
            .current_for_version(skill_id, version_id, CheckKind::Basic)
            .await?
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("version_id", version_id.as_str().to_owned())
                    .with_action(RecoveryAction::ReviewSecurityFindings)
            })?;
        let finding = run
            .findings
            .iter()
            .find(|finding| finding.id == finding_id)
            .ok_or_else(|| {
                AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
                    .with_param("finding_id", finding_id.to_owned())
                    .with_action(RecoveryAction::ReviewSecurityFindings)
            })?;
        if disposition != FindingDisposition::Actionable
            && finding.is_high_risk()
            && !high_risk_confirmed
        {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("finding_id", finding_id.to_owned())
                .with_param("requires_high_risk_confirmation", true)
                .with_action(RecoveryAction::ReviewSecurityFindings));
        }
        let updated = run.set_disposition(finding_id, disposition)?;
        self.repository.update(&updated).await?;
        Ok(CheckResult::from(updated))
    }

    async fn run_basic_check_with_generation(
        &self,
        skill_id: SkillId,
        version_id: VersionId,
        generation: Option<u64>,
    ) -> AppResult<CheckResult> {
        let generation = match generation {
            Some(value) => value,
            None => self
                .repository
                .current_for_version(skill_id, &version_id, CheckKind::Basic)
                .await?
                .map(|run| run.generation + 1)
                .unwrap_or(0),
        };
        let run_id = format!("basic-{}-{generation}", version_id.as_str());
        let started_at = now_millis();
        let scan_result = (|| -> AppResult<BasicCheckOutput> {
            let scan_root = tempfile::tempdir().map_err(io_error)?;
            self.materializer
                .materialize_version(&version_id, scan_root.path())?;
            self.scanner.scan_version(scan_root.path())
        })();
        let output = match scan_result {
            Ok(output) => output,
            Err(error) => {
                let mut run = CheckRun::running(run_id, skill_id, version_id, CheckKind::Basic);
                run.generation = generation;
                run.phase = CheckRunPhase::Failed;
                run.started_at = started_at;
                run.ended_at = Some(started_at);
                run.failure_code = Some(error.code.as_str().to_owned());
                self.repository.insert(&run).await?;
                return Ok(CheckResult::from(run));
            }
        };
        let mut run = CheckRun::completed(
            run_id,
            skill_id,
            version_id,
            CheckKind::Basic,
            output.findings,
        );
        run.generation = generation;
        run.ruleset_id = Some(output.ruleset_id);
        run.coverage_inputs = output.coverage_inputs;
        run.started_at = started_at;
        run.ended_at = Some(started_at);
        self.repository.insert(&run).await?;
        Ok(CheckResult::from(run))
    }
}

impl From<CheckRun> for CheckResult {
    fn from(run: CheckRun) -> Self {
        Self {
            state: run.state(),
            run: Some(run),
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
