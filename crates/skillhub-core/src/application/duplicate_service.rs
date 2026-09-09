use async_trait::async_trait;

use crate::duplicate::{
    build_duplicate_request, parse_duplicate_response, DuplicateAnalysis, DuplicateCandidate,
};
use crate::llm::{LlmProfile, LlmTaskRunner};
use crate::{AppResult, SkillId};

#[async_trait(?Send)]
pub trait DuplicateCandidateProvider: Send + Sync {
    async fn candidates(&self, skill_id: SkillId) -> AppResult<Vec<DuplicateCandidate>>;
}

pub struct DuplicateService<P, T> {
    provider: P,
    runner: T,
}

impl<P, T> DuplicateService<P, T>
where
    P: DuplicateCandidateProvider,
    T: LlmTaskRunner,
{
    pub fn new(provider: P, runner: T) -> Self {
        Self { provider, runner }
    }

    pub async fn analyze(
        &self,
        skill_id: SkillId,
        profile: &LlmProfile,
    ) -> AppResult<DuplicateAnalysis> {
        let mut candidates = self.provider.candidates(skill_id).await?;
        candidates.truncate(8);
        if candidates.is_empty() {
            // Nothing to compare: answer deterministically without an LLM call.
            return Ok(DuplicateAnalysis::deterministic_only(
                skill_id, candidates, None,
            ));
        }
        let count = candidates.len();
        let request = build_duplicate_request(&candidates)?;
        let response = match self.runner.run(profile, request).await {
            Ok(response) => response,
            Err(error) => {
                return Ok(DuplicateAnalysis::deterministic_only(
                    skill_id,
                    candidates,
                    Some(error.code.as_str().to_owned()),
                ))
            }
        };
        match parse_duplicate_response(skill_id, count, response.output) {
            Ok(mut analysis) => {
                analysis.candidates = candidates;
                Ok(analysis)
            }
            Err(error) => Ok(DuplicateAnalysis::deterministic_only(
                skill_id,
                candidates,
                Some(error.code.as_str().to_owned()),
            )),
        }
    }
}
