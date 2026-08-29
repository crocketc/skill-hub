use serde_json::json;

use crate::check::{CheckKind, CheckRepository, CheckResult, CheckRun, CheckRunPhase};
use crate::llm::safety::{build_safety_request, parse_safety_response};
use crate::llm::{LlmProfile, LlmTaskRunner};
use crate::{AppResult, SkillId, VersionId};

pub struct LlmSafetyService<R, T> {
    repository: R,
    runner: T,
}

impl<R, T> LlmSafetyService<R, T>
where
    R: CheckRepository,
    T: LlmTaskRunner,
{
    pub fn new(repository: R, runner: T) -> Self {
        Self { repository, runner }
    }

    pub async fn run_safety_check(
        &self,
        skill_id: SkillId,
        version_id: VersionId,
        profile: &LlmProfile,
        evidence: &str,
        allowed_files: &[String],
    ) -> AppResult<CheckResult> {
        let generation = self
            .repository
            .current_for_version(skill_id, &version_id, CheckKind::Llm)
            .await?
            .map(|run| run.generation + 1)
            .unwrap_or(0);
        let run_id = format!("llm-safety-{}-{generation}", version_id.as_str());
        let started_at = now_millis();
        let request = build_safety_request(evidence)?;
        let response = match self.runner.run(profile, request).await {
            Ok(response) => response,
            Err(error) => {
                return self
                    .persist_failure(skill_id, version_id, run_id, generation, started_at, error)
                    .await
            }
        };
        let findings = match parse_safety_response(response.output, allowed_files) {
            Ok(findings) => findings,
            Err(error) => {
                return self
                    .persist_failure(skill_id, version_id, run_id, generation, started_at, error)
                    .await
            }
        };
        let mut run = CheckRun::completed(run_id, skill_id, version_id, CheckKind::Llm, findings);
        run.generation = generation;
        run.model_id = Some(profile.model.clone());
        run.coverage_inputs = json!({ "files": allowed_files, "evidence_bytes": evidence.len() });
        run.started_at = started_at;
        run.ended_at = Some(now_millis());
        self.repository.insert(&run).await?;
        Ok(CheckResult::from(run))
    }

    pub async fn recheck_safety(
        &self,
        skill_id: SkillId,
        version_id: VersionId,
        profile: &LlmProfile,
        evidence: &str,
        allowed_files: &[String],
    ) -> AppResult<CheckResult> {
        self.run_safety_check(skill_id, version_id, profile, evidence, allowed_files)
            .await
    }

    pub async fn get_result(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
    ) -> AppResult<CheckResult> {
        Ok(self
            .repository
            .current_for_version(skill_id, version_id, CheckKind::Llm)
            .await?
            .map(CheckResult::from)
            .unwrap_or_default())
    }

    async fn persist_failure(
        &self,
        skill_id: SkillId,
        version_id: VersionId,
        run_id: String,
        generation: u64,
        started_at: i64,
        error: crate::AppError,
    ) -> AppResult<CheckResult> {
        let mut run = CheckRun::running(run_id, skill_id, version_id, CheckKind::Llm);
        run.generation = generation;
        run.phase = CheckRunPhase::Failed;
        run.started_at = started_at;
        run.ended_at = Some(now_millis());
        run.failure_code = Some(error.code.as_str().to_owned());
        self.repository.insert(&run).await?;
        Ok(CheckResult::from(run))
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
