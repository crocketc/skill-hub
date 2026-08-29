use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::llm::{LlmTaskKind, LlmTaskRequest};
use crate::{AppError, AppResult, ErrorCode, Severity, SkillId};

const DUPLICATE_SCHEMA: &str = include_str!("../../schemas/duplicate-analysis-v1.json");

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CoverageRelation {
    AContainsB,
    BContainsA,
    Overlap,
    Independent,
    Uncertain,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RetentionRecommendation {
    KeepA,
    KeepB,
    KeepBoth,
    ArchiveA,
    ArchiveB,
    ManualDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DuplicateCandidate {
    pub skill_id: SkillId,
    pub name: String,
    pub description: String,
    pub trigger: String,
    pub permissions: Vec<String>,
    pub source: String,
    pub basic_check_state: String,
    pub locally_modified: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DuplicateRelation {
    pub skill_a: SkillId,
    pub skill_b: SkillId,
    pub coverage: CoverageRelation,
    pub shared_abilities: Vec<String>,
    pub unique_a: Vec<String>,
    pub unique_b: Vec<String>,
    pub evidence: Vec<String>,
    pub recommendation: RetentionRecommendation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DuplicateAnalysis {
    pub anchor_skill_id: SkillId,
    pub candidate_count: u32,
    pub relations: Vec<DuplicateRelation>,
    pub applied_automatically: bool,
}

pub fn build_duplicate_request(candidates: &[DuplicateCandidate]) -> AppResult<LlmTaskRequest> {
    let schema: Value = serde_json::from_str(DUPLICATE_SCHEMA)
        .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
    let facts = serde_json::to_string(candidates)
        .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
    LlmTaskRequest::new(
        LlmTaskKind::DuplicateAnalysis,
        format!(
            "Compare only these candidate facts. Do not modify or delete any Skill.\n<CANDIDATE_FACTS>\n{facts}\n</CANDIDATE_FACTS>"
        ),
        schema,
    )
}

pub fn parse_duplicate_response(
    anchor_skill_id: SkillId,
    candidate_count: usize,
    response: Value,
) -> AppResult<DuplicateAnalysis> {
    let parsed: DuplicateResponse =
        serde_json::from_value(response).map_err(|_| invalid_response())?;
    Ok(DuplicateAnalysis {
        anchor_skill_id,
        candidate_count: u32::try_from(candidate_count).unwrap_or(u32::MAX),
        relations: parsed.relations,
        applied_automatically: false,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateResponse {
    relations: Vec<DuplicateRelation>,
}

fn invalid_response() -> AppError {
    AppError::new(ErrorCode::LlmInvalidStructuredResponse, Severity::Error)
}
