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

/// Where the analysis relations came from. `DeterministicOnly` means the
/// FTS/BM25 candidate layer is still shown, but the LLM layer failed or was
/// unnecessary — the deterministic result is never lost behind an LLM error.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateAnalysisSource {
    #[default]
    DeterministicOnly,
    Llm,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DuplicateAnalysis {
    pub anchor_skill_id: SkillId,
    pub candidate_count: u32,
    pub relations: Vec<DuplicateRelation>,
    pub applied_automatically: bool,
    /// The deterministic candidate layer, always carried back to the UI.
    #[serde(default)]
    pub candidates: Vec<DuplicateCandidate>,
    #[serde(default)]
    pub source: DuplicateAnalysisSource,
    /// Set when the LLM layer failed; the code is safe for display.
    #[serde(default)]
    pub failure_code: Option<String>,
}

impl DuplicateAnalysis {
    /// The always-available deterministic view: candidates from the local
    /// FTS/BM25 prefilter without any LLM relations.
    pub fn deterministic_only(
        anchor_skill_id: SkillId,
        candidates: Vec<DuplicateCandidate>,
        failure_code: Option<String>,
    ) -> Self {
        let candidate_count = u32::try_from(candidates.len()).unwrap_or(u32::MAX);
        Self {
            anchor_skill_id,
            candidate_count,
            relations: Vec::new(),
            applied_automatically: false,
            candidates,
            source: DuplicateAnalysisSource::DeterministicOnly,
            failure_code,
        }
    }
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
        candidates: Vec::new(),
        source: DuplicateAnalysisSource::Llm,
        failure_code: None,
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

const CONFLICT_SCHEMA: &str = include_str!("../../schemas/conflict-analysis-v1.json");

/// 分析输入规模上限：一次可选分析最多携带的冲突组数量，防止单次请求无界。
pub const CONFLICT_ANALYSIS_MAX_CASES: usize = 16;

/// 短结论上限：AI 只提供短的决策建议，超出部分在解析层被截断，
/// 绝不让长文进入界面或持久化记录。
const MAX_SUMMARY_CHARS: usize = 200;
const MAX_EVIDENCE_ITEMS: usize = 4;
const MAX_EVIDENCE_CHARS: usize = 160;
const MAX_UNCERTAINTY_ITEMS: usize = 4;

/// Optional AI conflict analysis scope (design §3.4: 全部/分类/冲突组/单 Skill).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case", tag = "type", content = "value")]
pub enum AnalyzeConflictScope {
    All,
    Category {
        classification: crate::relationship::ConflictClassification,
    },
    Case {
        conflict_id: String,
    },
    Skill {
        skill_id: SkillId,
    },
}

/// Advisory action suggested by the AI layer. It mirrors the deterministic
/// classification vocabulary, never executes anything and never writes
/// `ConflictCase.user_decision`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ConflictAnalysisAction {
    SameSkillVersion,
    DistinctSkill,
    KeepUncertain,
}

/// One conflict case's short conclusion. The deterministic baseline rides
/// along in every conclusion so it is always shown before the AI opinion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictCaseAnalysis {
    pub conflict_id: String,
    pub baseline_classification: crate::relationship::ConflictClassification,
    /// 短结论（不是长文）。
    pub summary: String,
    pub recommended_action: ConflictAnalysisAction,
    /// 推荐保留版本：引用冲突组成员的路径或指纹；无法对应到成员时为 None。
    pub recommended_keep_member: Option<String>,
    pub key_evidence: Vec<String>,
    pub uncertainties: Vec<String>,
    /// 0..=100。
    pub confidence: u32,
}

/// Result of one optional analysis run. `DeterministicOnly` means the LLM
/// layer failed or was unavailable — the deterministic baselines are never
/// lost behind an LLM error, and the failure code is safe to display.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictAnalysis {
    pub scope: AnalyzeConflictScope,
    /// 输入内容指纹：本次分析对应的事实状态，用于追溯。
    pub input_fingerprint: String,
    pub cases: Vec<ConflictCaseAnalysis>,
    /// 已有用户裁决、因此不再送 AI 的冲突组数量。
    pub skipped_decided_cases: u32,
    pub source: DuplicateAnalysisSource,
    pub failure_code: Option<String>,
}

/// The minimal fact slice of a conflict case that is sent to the LLM.
/// Derived from `ConflictCaseFact`; no prose and no filesystem access.
#[derive(Clone, Debug, Serialize)]
struct ConflictCaseFacts<'a> {
    conflict_id: &'a str,
    kind: crate::relationship::ConflictKind,
    baseline: crate::relationship::ConflictClassification,
    user_decided: bool,
    evidence: &'a crate::relationship::ConflictEvidence,
    members: Vec<ConflictMemberFacts<'a>>,
}

#[derive(Clone, Debug, Serialize)]
struct ConflictMemberFacts<'a> {
    skill_id: Option<SkillId>,
    path: Option<&'a str>,
    fingerprint: Option<&'a str>,
}

/// Everything one analysis run needs: the echoable scope, the request for the
/// LLM and the content fingerprint of the facts that produced it.
#[derive(Clone, Debug)]
pub struct ConflictAnalysisInput {
    pub scope: AnalyzeConflictScope,
    pub request: LlmTaskRequest,
    pub fingerprint: String,
}

fn conflict_case_facts(case: &crate::relationship::ConflictCaseFact) -> ConflictCaseFacts<'_> {
    ConflictCaseFacts {
        conflict_id: &case.conflict_id,
        kind: case.kind,
        baseline: case.classification,
        user_decided: case.user_decision.is_some(),
        evidence: &case.evidence,
        members: case
            .members
            .iter()
            .map(|member| ConflictMemberFacts {
                skill_id: member.skill_id,
                path: member.path.as_deref(),
                fingerprint: member.fingerprint.as_deref(),
            })
            .collect(),
    }
}

/// Builds the LLM request plus the input content fingerprint for the given
/// scope and cases. Cases beyond [`CONFLICT_ANALYSIS_MAX_CASES`] are truncated
/// so a single request stays bounded; the fingerprint covers what is sent.
pub fn build_conflict_analysis_input(
    scope: &AnalyzeConflictScope,
    cases: &[crate::relationship::ConflictCaseFact],
) -> AppResult<ConflictAnalysisInput> {
    use sha2::{Digest, Sha256};

    let facts: Vec<ConflictCaseFacts<'_>> = cases
        .iter()
        .take(CONFLICT_ANALYSIS_MAX_CASES)
        .map(conflict_case_facts)
        .collect();
    let serialized = serde_json::to_vec(&facts)
        .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
    let fingerprint = format!("sha256:{:x}", Sha256::digest(&serialized));

    let schema: Value = serde_json::from_str(CONFLICT_SCHEMA)
        .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
    let scope_label = match scope {
        AnalyzeConflictScope::All => "all undecided conflict cases".to_owned(),
        AnalyzeConflictScope::Category { classification } => {
            format!("conflict cases classified {classification:?}")
        }
        AnalyzeConflictScope::Case { conflict_id } => format!("conflict case {conflict_id}"),
        AnalyzeConflictScope::Skill { skill_id } => {
            format!("conflict cases involving skill {skill_id}")
        }
    };
    let request = LlmTaskRequest::new(
        LlmTaskKind::ConflictAnalysis,
        format!(
            "Compare only these conflict facts against their deterministic baseline. \
Give a SHORT conclusion and keep it short: one sentence, plus key evidence and uncertainties. \
Do not modify, merge, delete or decide anything; your output is advisory only.\n\
<SCOPE>{scope_label}</SCOPE>\n\
<CONFLICT_FACTS>\n{}\n</CONFLICT_FACTS>",
            String::from_utf8(serialized)
                .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?,
        ),
        schema,
    )?;
    Ok(ConflictAnalysisInput {
        scope: scope.clone(),
        request,
        fingerprint,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConflictCaseResponse {
    conflict_id: String,
    summary: String,
    recommended_action: ConflictAnalysisAction,
    recommended_keep_member: Option<String>,
    key_evidence: Vec<String>,
    uncertainties: Vec<String>,
    confidence: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConflictAnalysisResponse {
    cases: Vec<ConflictCaseResponse>,
}

fn cap_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn member_reference_targets(case: &crate::relationship::ConflictCaseFact) -> Vec<&str> {
    case.members
        .iter()
        .flat_map(|member| {
            member
                .path
                .as_deref()
                .into_iter()
                .chain(member.fingerprint.as_deref())
        })
        .collect()
}

/// Parses and bounds the LLM response against the exact input cases:
/// out-of-scope conclusions are dropped, long text is capped, confidence is
/// clamped and a keep-member must reference one of the case members.
pub fn parse_conflict_analysis_response(
    scope: &AnalyzeConflictScope,
    fingerprint: &str,
    skipped_decided_cases: u32,
    cases: &[crate::relationship::ConflictCaseFact],
    response: Value,
) -> AppResult<ConflictAnalysis> {
    let parsed: ConflictAnalysisResponse =
        serde_json::from_value(response).map_err(|_| invalid_response())?;
    let mut conclusions = Vec::with_capacity(cases.len());
    for conclusion in parsed.cases {
        let Some(case) = cases
            .iter()
            .find(|case| case.conflict_id == conclusion.conflict_id)
        else {
            // 不在本次输入范围内的结论一律丢弃，绝不让模型引入新冲突组。
            continue;
        };
        let keep_member = conclusion
            .recommended_keep_member
            .filter(|reference| member_reference_targets(case).contains(&reference.as_str()));
        conclusions.push(ConflictCaseAnalysis {
            conflict_id: conclusion.conflict_id,
            baseline_classification: case.classification,
            summary: cap_text(&conclusion.summary, MAX_SUMMARY_CHARS),
            recommended_action: conclusion.recommended_action,
            recommended_keep_member: keep_member,
            key_evidence: conclusion
                .key_evidence
                .into_iter()
                .take(MAX_EVIDENCE_ITEMS)
                .map(|entry| cap_text(&entry, MAX_EVIDENCE_CHARS))
                .collect(),
            uncertainties: conclusion
                .uncertainties
                .into_iter()
                .take(MAX_UNCERTAINTY_ITEMS)
                .map(|entry| cap_text(&entry, MAX_EVIDENCE_CHARS))
                .collect(),
            confidence: conclusion.confidence.min(100),
        });
    }
    Ok(ConflictAnalysis {
        scope: scope.clone(),
        input_fingerprint: fingerprint.to_owned(),
        cases: conclusions,
        skipped_decided_cases,
        source: DuplicateAnalysisSource::Llm,
        failure_code: None,
    })
}
