//! Task 2 conflict-resolution contract tests.
//!
//! The conflict surface is not a to-do list and not an AI adoption switch:
//! only a pending `uncertain` conflict enters the workspace, every explicit
//! action either writes a relationship conclusion or hands the file-change
//! case over to governance, and "暂不处理" writes nothing at all.

use serde_json::json;
use skillhub_core::duplicate::{
    build_conflict_analysis_input, AnalyzeConflictScope, ConflictAnalysisAction,
    ConflictAnalysisRecord, ConflictCaseAnalysis, DuplicateAnalysisSource,
};
use skillhub_core::relationship::{
    build_conflict_workspace, conflict_analysis_is_stale, decision_for_analysis_action,
    plan_conflict_decision, plan_conflict_governance_handoff, ConflictCaseFact,
    ConflictClassification, ConflictDecision, ConflictEvidence, ConflictGovernanceIntent,
    ConflictKind, ConflictMemberFact,
};
use skillhub_core::{ErrorCode, SkillId};

fn member(path: &str, fingerprint: &str) -> ConflictMemberFact {
    ConflictMemberFact {
        skill_id: None,
        version_id: None,
        provenance_id: None,
        directory_node_id: None,
        path: Some(path.to_owned()),
        fingerprint: Some(fingerprint.to_owned()),
    }
}

fn case(conflict_id: &str, classification: ConflictClassification) -> ConflictCaseFact {
    ConflictCaseFact {
        conflict_id: conflict_id.to_owned(),
        kind: ConflictKind::SameNameDifferentContent,
        classification,
        member_skill_ids: Vec::new(),
        members: vec![
            member(
                &format!("/lib/{conflict_id}-a"),
                &format!("fp-{conflict_id}-a"),
            ),
            member(
                &format!("/agent/{conflict_id}-b"),
                &format!("fp-{conflict_id}-b"),
            ),
        ],
        evidence: ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: Some(skillhub_core::relationship::IdentityDirection::Unknown),
            sufficient_identity_evidence: false,
        },
        user_decision: None,
        decided_at: None,
    }
}

fn decided(
    conflict_id: &str,
    classification: ConflictClassification,
    decision: ConflictClassification,
    decided_at: i64,
) -> ConflictCaseFact {
    let mut value = case(conflict_id, classification);
    value.user_decision = Some(decision);
    value.decided_at = Some(decided_at);
    value
}

fn analysis(
    conflict_id: &str,
    input_fingerprint: &str,
    action: ConflictAnalysisAction,
    analyzed_at: i64,
) -> ConflictAnalysisRecord {
    ConflictAnalysisRecord {
        record_id: format!("analysis:{conflict_id}:{analyzed_at}"),
        conflict_id: conflict_id.to_owned(),
        scope: AnalyzeConflictScope::Case {
            conflict_id: conflict_id.to_owned(),
        },
        input_fingerprint: input_fingerprint.to_owned(),
        baseline_classification: ConflictClassification::Uncertain,
        conclusion: Some(ConflictCaseAnalysis {
            conflict_id: conflict_id.to_owned(),
            baseline_classification: ConflictClassification::Uncertain,
            summary: "成员指纹不同，无法确认同一 Skill。".to_owned(),
            recommended_action: action,
            recommended_keep_member: None,
            key_evidence: vec!["fingerprints differ".to_owned()],
            uncertainties: Vec::new(),
            confidence: 40,
        }),
        source: DuplicateAnalysisSource::Llm,
        analyzed_at,
        failure_code: None,
        adopted_by_user: false,
    }
}

/// 记录一条分析时，指纹就是在那一刻按同样的「未裁决」口径算出来的。
fn fingerprint_for(cases: &[ConflictCaseFact], conflict_id: &str) -> String {
    let scope = AnalyzeConflictScope::Case {
        conflict_id: conflict_id.to_owned(),
    };
    let scoped: Vec<ConflictCaseFact> = cases
        .iter()
        .filter(|case| case.user_decision.is_none())
        .filter(|case| case.conflict_id == conflict_id)
        .cloned()
        .collect();
    build_conflict_analysis_input(&scope, &scoped)
        .expect("analysis input")
        .fingerprint
}

#[test]
fn only_pending_uncertain_conflicts_enter_the_workspace() {
    let cases = vec![
        case("conflict:pending", ConflictClassification::Uncertain),
        decided(
            "conflict:handled",
            ConflictClassification::Uncertain,
            ConflictClassification::DistinctSkill,
            30,
        ),
        case(
            "conflict:deterministic",
            ConflictClassification::DistinctSkill,
        ),
        decided(
            "conflict:confirmed",
            ConflictClassification::Uncertain,
            ConflictClassification::SameSkillVersion,
            10,
        ),
    ];

    let workspace = build_conflict_workspace(&cases, &[], 7, Some(5)).expect("workspace");

    // 默认队列只有待确认的 uncertain 冲突：已裁决与确定性结论都不回流。
    assert_eq!(workspace.cases.len(), 1);
    assert_eq!(workspace.cases[0].case.conflict_id, "conflict:pending");
    assert_eq!(workspace.relationship_revision, "7");
    assert_eq!(workspace.last_verified_at, Some(5));

    // 已处理项进入历史，最近优先，且累计数只统计明确处理完成的冲突。
    let handled_ids: Vec<&str> = workspace
        .handled
        .iter()
        .map(|record| record.conflict_id.as_str())
        .collect();
    assert_eq!(handled_ids, vec!["conflict:handled", "conflict:confirmed"]);
    assert_eq!(workspace.handled_count, 2);
    assert_eq!(
        workspace.handled[0].decision,
        ConflictDecision::KeepDistinct
    );
    assert_eq!(
        workspace.handled[1].decision,
        ConflictDecision::ConfirmSameSkill
    );
    assert_eq!(workspace.handled[0].decided_at, 30);
}

#[test]
fn each_conclusion_decision_records_its_state_time_and_history() {
    let pending = case("conflict:pending", ConflictClassification::Uncertain);

    let kept = plan_conflict_decision(&pending, ConflictDecision::KeepDistinct, 1_700_000_000)
        .expect("plan")
        .expect("a pending conflict is written");
    assert_eq!(kept.record.decision, ConflictDecision::KeepDistinct);
    assert_eq!(
        kept.record.conclusion,
        ConflictClassification::DistinctSkill
    );
    assert_eq!(kept.record.decided_at, 1_700_000_000);
    assert_eq!(
        kept.case.user_decision,
        Some(ConflictClassification::DistinctSkill)
    );
    assert_eq!(kept.case.decided_at, Some(1_700_000_000));
    assert_eq!(
        kept.case.classification,
        ConflictClassification::DistinctSkill
    );

    let confirmed =
        plan_conflict_decision(&pending, ConflictDecision::ConfirmSameSkill, 1_700_000_100)
            .expect("plan")
            .expect("a pending conflict is written");
    assert_eq!(
        confirmed.record.conclusion,
        ConflictClassification::SameSkillVersion
    );
    assert_eq!(
        confirmed.case.user_decision,
        Some(ConflictClassification::SameSkillVersion)
    );

    // 写入后的事实不再回流工作台，而是出现在已处理历史里。
    let workspace = build_conflict_workspace(std::slice::from_ref(&kept.case), &[], 9, None)
        .expect("workspace");
    assert!(workspace.cases.is_empty());
    assert_eq!(workspace.handled_count, 1);
    assert_eq!(workspace.handled[0].conflict_id, "conflict:pending");
}

#[test]
fn deferring_leaves_the_focus_only_and_writes_no_decision_or_fake_history() {
    let cases = vec![case("conflict:pending", ConflictClassification::Uncertain)];
    let before = build_conflict_workspace(&cases, &[], 7, None).expect("workspace");

    // 「暂不处理」不是决定：它不产生任何写入，所以再次读取工作台得到完全
    // 相同的结果，冲突仍然留在队列里等待处理。
    let after = build_conflict_workspace(&cases, &[], 7, None).expect("workspace");
    assert_eq!(before, after);
    assert_eq!(after.cases.len(), 1);
    assert!(after.handled.is_empty());
    assert_eq!(after.cases[0].case.user_decision, None);

    // 决定词汇表里没有「暂不处理」：每个决定要么写结论，要么转治理。
    for decision in [
        ConflictDecision::KeepDistinct,
        ConflictDecision::ConfirmSameSkill,
        ConflictDecision::CentralizeManagement,
    ] {
        assert!(
            decision.writes_conclusion() || decision.conclusion().is_none(),
            "{decision:?} must be an explicit action"
        );
    }
    assert_eq!(
        serde_json::to_value(ConflictDecision::KeepDistinct).unwrap(),
        json!("keep_distinct")
    );
    assert_eq!(
        serde_json::to_value(ConflictDecision::ConfirmSameSkill).unwrap(),
        json!("confirm_same_skill")
    );
    assert_eq!(
        serde_json::to_value(ConflictDecision::CentralizeManagement).unwrap(),
        json!("centralize_management")
    );
}

#[test]
fn re_deciding_the_same_case_is_idempotent_and_a_conflicting_decision_is_refused() {
    let pending = case("conflict:pending", ConflictClassification::Uncertain);
    let kept = plan_conflict_decision(&pending, ConflictDecision::KeepDistinct, 20)
        .expect("plan")
        .expect("written");

    // 幂等重放：同一决定不再写入第二条记录。
    assert!(
        plan_conflict_decision(&kept.case, ConflictDecision::KeepDistinct, 40)
            .expect("idempotent replay")
            .is_none()
    );

    // 已用其它决定处理过：拒绝，绝不悄悄覆盖用户裁决。
    let error = plan_conflict_decision(&kept.case, ConflictDecision::ConfirmSameSkill, 40)
        .expect_err("conflicting decision must be refused");
    assert_eq!(error.code, ErrorCode::OperationConflict);

    // 确定性结论（未裁决）不属于待确认队列，也不能被当作待确认冲突处理。
    let deterministic = case(
        "conflict:deterministic",
        ConflictClassification::DistinctSkill,
    );
    let error = plan_conflict_decision(&deterministic, ConflictDecision::KeepDistinct, 40)
        .expect_err("a deterministic case is not pending");
    assert_eq!(error.code, ErrorCode::OperationConflict);

    // 文件类决定不能走「只写结论」的入口。
    let error = plan_conflict_decision(&pending, ConflictDecision::CentralizeManagement, 40)
        .expect_err("centralize management must not write a conclusion");
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[test]
fn ai_recommendations_map_onto_explicit_actions_only() {
    assert_eq!(
        decision_for_analysis_action(ConflictAnalysisAction::SameSkillVersion),
        Some(ConflictDecision::ConfirmSameSkill)
    );
    assert_eq!(
        decision_for_analysis_action(ConflictAnalysisAction::DistinctSkill),
        Some(ConflictDecision::KeepDistinct)
    );
    // 模型无法可靠判断时不产生决定：界面只提供手动处理或暂不处理。
    assert_eq!(
        decision_for_analysis_action(ConflictAnalysisAction::KeepUncertain),
        None
    );
}

#[test]
fn centralize_management_returns_a_governance_handoff_and_never_changes_a_file() {
    let pending = case("conflict:pending", ConflictClassification::Uncertain);

    let handoff =
        plan_conflict_governance_handoff(&pending, Some("relation:1".to_owned())).expect("handoff");
    assert_eq!(handoff.conflict_id, "conflict:pending");
    assert_eq!(handoff.relation_id.as_deref(), Some("relation:1"));
    assert_eq!(
        handoff.intent,
        ConflictGovernanceIntent::CentralizeManagement
    );

    // 没有可治理关系边时如实返回 None，不伪造关系 id。
    let unresolved = plan_conflict_governance_handoff(&pending, None).expect("handoff");
    assert_eq!(unresolved.relation_id, None);

    // 只产出预览意图：冲突事实不变，仍然留在待确认队列里。
    let workspace =
        build_conflict_workspace(std::slice::from_ref(&pending), &[], 7, None).expect("workspace");
    assert_eq!(workspace.cases.len(), 1);
    assert_eq!(workspace.cases[0].case.user_decision, None);
    assert!(workspace.handled.is_empty());

    // 已处理完的冲突不能再转治理。
    let decided_case = decided(
        "conflict:handled",
        ConflictClassification::Uncertain,
        ConflictClassification::DistinctSkill,
        5,
    );
    let error = plan_conflict_governance_handoff(&decided_case, None)
        .expect_err("a handled conflict is not pending");
    assert_eq!(error.code, ErrorCode::OperationConflict);
}

#[test]
fn stale_analysis_is_marked_when_the_input_fingerprint_moves_on() {
    let pending = case("conflict:pending", ConflictClassification::Uncertain);
    let changed_member = {
        let mut value = pending.clone();
        value.members[1].fingerprint = Some("fp-changed".to_owned());
        value
    };

    // 指纹一致：旧分析对应当前事实，AI 建议可以映射成明确动作。
    let fresh = analysis(
        "conflict:pending",
        &fingerprint_for(std::slice::from_ref(&pending), "conflict:pending"),
        ConflictAnalysisAction::DistinctSkill,
        100,
    );
    let workspace = build_conflict_workspace(
        std::slice::from_ref(&pending),
        std::slice::from_ref(&fresh),
        7,
        None,
    )
    .expect("workspace");
    assert!(!workspace.cases[0].analysis_stale);
    assert_eq!(
        workspace.cases[0].recommended_decision,
        Some(ConflictDecision::KeepDistinct)
    );
    assert_eq!(
        workspace.cases[0]
            .latest_analysis
            .as_ref()
            .map(|record| record.record_id.as_str()),
        Some("analysis:conflict:pending:100")
    );

    // 事实变化：旧分析标为过期，界面不再把它当作可执行建议。
    assert!(
        conflict_analysis_is_stale(&fresh, std::slice::from_ref(&changed_member))
            .expect("staleness")
    );
    let stale = build_conflict_workspace(
        std::slice::from_ref(&changed_member),
        std::slice::from_ref(&fresh),
        8,
        None,
    )
    .expect("workspace");
    assert!(stale.cases[0].analysis_stale);
    assert_eq!(stale.cases[0].recommended_decision, None);
    assert!(stale.cases[0].latest_analysis.is_some());
}

#[test]
fn analysis_without_a_conclusion_recommends_nothing() {
    let pending = case("conflict:pending", ConflictClassification::Uncertain);
    let mut failed = analysis(
        "conflict:pending",
        &fingerprint_for(std::slice::from_ref(&pending), "conflict:pending"),
        ConflictAnalysisAction::KeepUncertain,
        100,
    );
    failed.conclusion = None;
    failed.failure_code = Some("llm.request_timeout".to_owned());
    failed.source = DuplicateAnalysisSource::DeterministicOnly;

    let workspace = build_conflict_workspace(std::slice::from_ref(&pending), &[failed], 7, None)
        .expect("workspace");
    assert!(!workspace.cases[0].analysis_stale);
    assert_eq!(workspace.cases[0].recommended_decision, None);
}

#[test]
fn workspace_ordering_is_stable_for_identical_facts() {
    let cases = vec![
        case("conflict:b", ConflictClassification::Uncertain),
        case("conflict:a", ConflictClassification::Uncertain),
        decided(
            "conflict:c",
            ConflictClassification::Uncertain,
            ConflictClassification::DistinctSkill,
            3,
        ),
    ];

    let first = build_conflict_workspace(&cases, &[], 1, None).expect("workspace");
    let reversed: Vec<ConflictCaseFact> = cases.iter().rev().cloned().collect();
    let second = build_conflict_workspace(&reversed, &[], 1, None).expect("workspace");

    assert_eq!(first, second);
    let ids: Vec<&str> = first
        .cases
        .iter()
        .map(|entry| entry.case.conflict_id.as_str())
        .collect();
    assert_eq!(ids, vec!["conflict:a", "conflict:b"]);
}

#[test]
fn workspace_revision_and_member_identity_survive_the_projection() {
    let skill_id: SkillId = "00000000-0000-0000-0000-0000000000a1".parse().unwrap();
    let mut pending = case("conflict:pending", ConflictClassification::Uncertain);
    pending.member_skill_ids = vec![skill_id];
    pending.members[0].skill_id = Some(skill_id);
    pending.members[0].provenance_id = Some("provenance:notes".to_owned());

    let workspace = build_conflict_workspace(std::slice::from_ref(&pending), &[], 12, Some(11))
        .expect("workspace");
    let projected = &workspace.cases[0].case;

    assert_eq!(projected.member_skill_ids, vec![skill_id]);
    assert_eq!(projected.members[0].skill_id, Some(skill_id));
    assert_eq!(
        projected.members[0].provenance_id.as_deref(),
        Some("provenance:notes")
    );
    assert_eq!(workspace.relationship_revision, "12");
    assert_eq!(workspace.last_verified_at, Some(11));
}
