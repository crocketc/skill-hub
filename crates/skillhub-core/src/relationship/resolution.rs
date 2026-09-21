//! 「冲突处理」工作台的领域契约。
//!
//! Only a pending `uncertain` conflict enters the workspace.  Every explicit
//! user action either writes a relationship conclusion (keep as independent
//! Skill / confirm the same Skill), or produces a governance preview intent
//! (纳入集中库管理) that cannot touch files here, or changes nothing at all
//! (暂不处理 — it is deliberately not a decision).
//!
//! The AI layer stays advisory: a recommendation only ever maps onto one of
//! those explicit actions, and never onto a silent "adopted" state.

use serde::{Deserialize, Serialize};

use crate::duplicate::{
    build_conflict_analysis_input, conflict_case_matches_scope, ConflictAnalysisAction,
    ConflictAnalysisRecord,
};
use crate::relationship::{ConflictCaseFact, ConflictClassification};
use crate::{AppError, AppResult, ErrorCode, Severity};

/// 用户在冲突处理页面做出的明确决定。
///
/// 「暂不处理」不是决定：它只让界面离开当前焦点，不写结论、不写伪历史。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ConflictDecision {
    /// 保留为独立 Skill：写关系结论，立即完成，不改文件。
    KeepDistinct,
    /// 确认同一 Skill：写关系结论，立即完成，不改文件。
    ConfirmSameSkill,
    /// 纳入集中库管理：涉及文件变更，只产出治理预览意图。
    CentralizeManagement,
}

impl ConflictDecision {
    /// 只写关系结论、不改文件的决定。
    pub const fn writes_conclusion(self) -> bool {
        match self {
            Self::KeepDistinct | Self::ConfirmSameSkill => true,
            Self::CentralizeManagement => false,
        }
    }

    /// 决定写入 `ConflictCaseFact` 的结论；文件类决定不写结论。
    pub const fn conclusion(self) -> Option<ConflictClassification> {
        match self {
            Self::KeepDistinct => Some(ConflictClassification::DistinctSkill),
            Self::ConfirmSameSkill => Some(ConflictClassification::SameSkillVersion),
            Self::CentralizeManagement => None,
        }
    }
}

/// AI 建议到明确动作的映射。`keep_uncertain` 不映射到任何决定：模型无法
/// 可靠判断时，界面只提供手动处理或暂不处理，不显示伪造的采纳按钮。
pub const fn decision_for_analysis_action(
    action: ConflictAnalysisAction,
) -> Option<ConflictDecision> {
    match action {
        ConflictAnalysisAction::SameSkillVersion => Some(ConflictDecision::ConfirmSameSkill),
        ConflictAnalysisAction::DistinctSkill => Some(ConflictDecision::KeepDistinct),
        ConflictAnalysisAction::KeepUncertain => None,
    }
}

/// 一条已明确处理完成的冲突。只由写关系结论的决定产生；部署、解除部署与
/// 纳入集中库管理不计入累计处理数。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictResolutionRecord {
    pub conflict_id: String,
    pub decision: ConflictDecision,
    pub conclusion: ConflictClassification,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub decided_at: i64,
}

/// 「纳入集中库管理」的预览意图：只把冲突与关系 id 交给关系治理页的影响
/// 预览、确认与执行链路，绝不在这里变更文件，也不写冲突结论。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictGovernanceHandoff {
    pub conflict_id: String,
    /// 需要治理的关系边。冲突没有可治理关系边时为 `None`：界面不得伪造
    /// 一个关系 id，只能引导用户到关系治理页自行选择。
    pub relation_id: Option<String>,
    pub intent: ConflictGovernanceIntent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ConflictGovernanceIntent {
    CentralizeManagement,
}

/// 决定后的结果。写结论与转治理互斥：两者不会同时出现。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictResolutionOutcome {
    pub conflict_id: String,
    pub decision: ConflictDecision,
    /// 已写结论时为决定时间与结论；文件类决定两者都为 `None`。
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub decided_at: Option<i64>,
    pub conclusion: Option<ConflictClassification>,
    pub governance: Option<ConflictGovernanceHandoff>,
    /// 决定后的关系事实版本。
    pub relationship_revision: String,
}

/// 写入后的冲突事实与它产生的处理记录。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PlannedConflictResolution {
    pub case: ConflictCaseFact,
    pub record: ConflictResolutionRecord,
}

/// 工作台上的一条待确认冲突。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictWorkspaceCase {
    pub case: ConflictCaseFact,
    /// 该组最近一次分析记录（可能已经过期）。
    pub latest_analysis: Option<ConflictAnalysisRecord>,
    /// 输入指纹已变化：旧分析不再对应当前事实，界面必须标注过期，
    /// 且不能把它当作可执行建议。
    pub analysis_stale: bool,
    /// AI 建议映射出的明确动作。没有建议、建议为 `keep_uncertain`
    /// 或分析已过期时为 `None`。
    pub recommended_decision: Option<ConflictDecision>,
}

/// 冲突处理工作台投影。默认只含待确认的 `uncertain` 冲突；已确定与已处理
/// 项进入历史，不回流当前队列。只读：不扫描、不调用 AI、不写任何事实。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictWorkspace {
    pub cases: Vec<ConflictWorkspaceCase>,
    /// 累计已明确处理完成的冲突数。
    pub handled_count: u32,
    /// 已处理历史，最近优先。
    pub handled: Vec<ConflictResolutionRecord>,
    /// 已由确定性证据识别并处理的完全重复事实。它们不需要用户再次裁决，
    /// 但必须保留在工作台历史中，解释为何允许复制/复用后继续存在两个实体。
    #[serde(default)]
    #[specta(optional)]
    pub deterministic_history: Vec<ConflictWorkspaceCase>,
    pub relationship_revision: String,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
}

/// 分析记录是否已经过期：按记录自身的作用范围与「未裁决」口径重建输入
/// 指纹，与记录保存的指纹比较。一致说明事实没变，旧分析仍然对应当前冲突。
pub fn conflict_analysis_is_stale(
    record: &ConflictAnalysisRecord,
    cases: &[ConflictCaseFact],
) -> AppResult<bool> {
    let scoped: Vec<ConflictCaseFact> = cases
        .iter()
        .filter(|case| case.user_decision.is_none())
        .filter(|case| conflict_case_matches_scope(case, &record.scope))
        .cloned()
        .collect();
    let fingerprint = build_conflict_analysis_input(&record.scope, &scoped)?.fingerprint;
    Ok(record.input_fingerprint != fingerprint)
}

/// 组装工作台投影。纯函数：不读磁盘、不调用 AI、不写事实。
pub fn build_conflict_workspace(
    cases: &[ConflictCaseFact],
    records: &[ConflictAnalysisRecord],
    relationship_revision: i64,
    last_verified_at: Option<i64>,
) -> AppResult<ConflictWorkspace> {
    let mut pending: Vec<&ConflictCaseFact> = cases
        .iter()
        .filter(|case| case.classification == ConflictClassification::Uncertain)
        .filter(|case| case.user_decision.is_none())
        .collect();
    pending.sort_by(|left, right| left.conflict_id.cmp(&right.conflict_id));

    let mut workspace_cases = Vec::with_capacity(pending.len());
    for case in pending {
        let latest_analysis = records
            .iter()
            .filter(|record| record.conflict_id == case.conflict_id)
            .max_by(|left, right| {
                left.analyzed_at
                    .cmp(&right.analyzed_at)
                    .then_with(|| left.record_id.cmp(&right.record_id))
            })
            .cloned();
        let (analysis_stale, recommended_decision) = match &latest_analysis {
            None => (false, None),
            Some(record) => {
                let stale = conflict_analysis_is_stale(record, cases)?;
                let recommended = if stale {
                    None
                } else {
                    record.conclusion.as_ref().and_then(|conclusion| {
                        decision_for_analysis_action(conclusion.recommended_action)
                    })
                };
                (stale, recommended)
            }
        };
        workspace_cases.push(ConflictWorkspaceCase {
            case: case.clone(),
            latest_analysis,
            analysis_stale,
            recommended_decision,
        });
    }

    let mut handled: Vec<ConflictResolutionRecord> = cases
        .iter()
        .filter_map(|case| {
            let decision = match case.user_decision? {
                ConflictClassification::DistinctSkill => ConflictDecision::KeepDistinct,
                ConflictClassification::SameSkillVersion => ConflictDecision::ConfirmSameSkill,
                // 未确认从来不是「已处理完成」的结论。
                ConflictClassification::Uncertain => return None,
            };
            Some(ConflictResolutionRecord {
                conflict_id: case.conflict_id.clone(),
                decision,
                conclusion: case.user_decision?,
                decided_at: case.decided_at.unwrap_or_default(),
            })
        })
        .collect();
    handled.sort_by(|left, right| {
        right
            .decided_at
            .cmp(&left.decided_at)
            .then_with(|| left.conflict_id.cmp(&right.conflict_id))
    });

    let mut deterministic_history: Vec<ConflictWorkspaceCase> = cases
        .iter()
        .filter(|case| {
            case.kind == crate::relationship::ConflictKind::DuplicateSameContent
                && case.classification == ConflictClassification::SameSkillVersion
                && case.user_decision.is_none()
        })
        .map(|case| ConflictWorkspaceCase {
            case: case.clone(),
            latest_analysis: None,
            analysis_stale: false,
            recommended_decision: None,
        })
        .collect();
    deterministic_history.sort_by(|left, right| {
        left.case
            .conflict_id
            .cmp(&right.case.conflict_id)
    });

    Ok(ConflictWorkspace {
        cases: workspace_cases,
        handled_count: u32::try_from(handled.len()).unwrap_or(u32::MAX),
        handled,
        deterministic_history,
        relationship_revision: relationship_revision.to_string(),
        last_verified_at,
    })
}

/// 仅写关系结论的决定。返回值 `None` 表示该冲突已经用同一决定处理过，
/// 无需重复写入（幂等重放）。
///
/// `CentralizeManagement` 涉及文件变更，必须走
/// [`plan_conflict_governance_handoff`]。
pub fn plan_conflict_decision(
    case: &ConflictCaseFact,
    decision: ConflictDecision,
    decided_at: i64,
) -> AppResult<Option<PlannedConflictResolution>> {
    let Some(conclusion) = decision.conclusion() else {
        return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
            .with_param("reason", "conflict_decision_requires_governance"));
    };
    if let Some(existing) = case.user_decision {
        if existing == conclusion {
            return Ok(None);
        }
        return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("reason", "conflict_case_already_decided"));
    }
    if case.classification != ConflictClassification::Uncertain {
        return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("reason", "conflict_case_not_uncertain"));
    }
    let mut updated = case.clone();
    updated.classification = conclusion;
    updated.user_decision = Some(conclusion);
    updated.decided_at = Some(decided_at);
    Ok(Some(PlannedConflictResolution {
        case: updated,
        record: ConflictResolutionRecord {
            conflict_id: case.conflict_id.clone(),
            decision,
            conclusion,
            decided_at,
        },
    }))
}

/// 「纳入集中库管理」：只产出治理预览意图，不写冲突结论、不变更文件。
pub fn plan_conflict_governance_handoff(
    case: &ConflictCaseFact,
    relation_id: Option<String>,
) -> AppResult<ConflictGovernanceHandoff> {
    if case.user_decision.is_some() {
        return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("reason", "conflict_case_already_decided"));
    }
    if case.classification != ConflictClassification::Uncertain {
        return Err(AppError::new(ErrorCode::OperationConflict, Severity::Error)
            .with_param("reason", "conflict_case_not_uncertain"));
    }
    Ok(ConflictGovernanceHandoff {
        conflict_id: case.conflict_id.clone(),
        relation_id,
        intent: ConflictGovernanceIntent::CentralizeManagement,
    })
}
