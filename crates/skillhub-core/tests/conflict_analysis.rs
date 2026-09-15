//! Task 8 conflict-analysis domain contract tests.
//!
//! The AI layer is optional and advisory: the deterministic baseline always
//! stays visible, conclusions must stay short, and nothing here may write a
//! `ConflictCase.user_decision`.

use serde_json::json;
use skillhub_core::duplicate::{
    build_conflict_analysis_input, parse_conflict_analysis_response, AnalyzeConflictScope,
    ConflictAnalysisAction, DuplicateAnalysisSource,
};
use skillhub_core::relationship::{
    ConflictCaseFact, ConflictClassification, ConflictEvidence, ConflictKind, IdentityDirection,
};

fn case(conflict_id: &str, fingerprint_a: &str, fingerprint_b: &str) -> ConflictCaseFact {
    ConflictCaseFact {
        conflict_id: conflict_id.to_owned(),
        kind: ConflictKind::SameNameDifferentContent,
        classification: ConflictClassification::Uncertain,
        member_skill_ids: Vec::new(),
        members: vec![
            skillhub_core::relationship::ConflictMemberFact {
                skill_id: None,
                version_id: None,
                provenance_id: None,
                directory_node_id: None,
                path: Some(format!("/lib/{conflict_id}-a")),
                fingerprint: Some(fingerprint_a.to_owned()),
            },
            skillhub_core::relationship::ConflictMemberFact {
                skill_id: None,
                version_id: None,
                provenance_id: None,
                directory_node_id: None,
                path: Some(format!("/agent/{conflict_id}-b")),
                fingerprint: Some(fingerprint_b.to_owned()),
            },
        ],
        evidence: ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: Some(IdentityDirection::Unknown),
            sufficient_identity_evidence: false,
        },
        user_decision: None,
        decided_at: None,
    }
}

fn two_cases() -> Vec<ConflictCaseFact> {
    vec![
        case("conflict:notes", "fp-a1", "fp-b1"),
        case("conflict:pdf", "fp-a2", "fp-b2"),
    ]
}

#[test]
fn conflict_analysis_scope_serializes_all_category_case_and_skill() {
    let all = serde_json::to_value(AnalyzeConflictScope::All).unwrap();
    assert_eq!(all, json!({ "type": "all" }));

    let category = serde_json::to_value(AnalyzeConflictScope::Category {
        classification: ConflictClassification::Uncertain,
    })
    .unwrap();
    assert_eq!(
        category,
        json!({ "type": "category", "value": { "classification": "uncertain" } })
    );

    let case_scope = serde_json::to_value(AnalyzeConflictScope::Case {
        conflict_id: "conflict:notes".to_owned(),
    })
    .unwrap();
    assert_eq!(
        case_scope,
        json!({ "type": "case", "value": { "conflict_id": "conflict:notes" } })
    );

    let skill = serde_json::to_value(AnalyzeConflictScope::Skill {
        skill_id: "00000000-0000-0000-0000-00000000000a".parse().unwrap(),
    })
    .unwrap();
    assert_eq!(
        skill,
        json!({ "type": "skill", "value": { "skill_id": "00000000-0000-0000-0000-00000000000a" } })
    );
}

#[test]
fn analysis_input_carries_scope_facts_deterministic_baseline_and_stable_fingerprint() {
    let cases = two_cases();
    let scope = AnalyzeConflictScope::All;
    let input = build_conflict_analysis_input(&scope, &cases).expect("analysis input");

    assert_eq!(input.scope, scope);
    // The fingerprint is a content fingerprint: identical facts produce the
    // same value, any fact change produces a different one.
    let again = build_conflict_analysis_input(&scope, &cases).expect("analysis input");
    assert_eq!(input.fingerprint, again.fingerprint);
    let mutated = two_cases();
    let mut mutated_case = mutated[0].clone();
    mutated_case.members[0].fingerprint = Some("fp-changed".to_owned());
    let changed =
        build_conflict_analysis_input(&scope, &[mutated_case, mutated[1].clone()]).expect("input");
    assert_ne!(input.fingerprint, changed.fingerprint);

    // The request is the new conflict-analysis task, embeds the case facts and
    // the deterministic baseline, and demands a short advisory conclusion.
    assert_eq!(
        input.request.kind,
        skillhub_core::LlmTaskKind::ConflictAnalysis
    );
    assert!(input.request.input.contains("conflict:notes"));
    assert!(input.request.input.contains("conflict:pdf"));
    assert!(input.request.input.contains("fp-a1"));
    assert!(input.request.input.contains("baseline"));
    assert!(input.request.input.contains("short"));
    assert!(!input.request.input.is_empty());
    assert!(input.request.response_schema.is_object());
}

#[test]
fn parsed_conclusions_stay_short_stay_in_scope_and_never_exceed_confidence() {
    let cases = two_cases();
    let scope = AnalyzeConflictScope::All;
    let input = build_conflict_analysis_input(&scope, &cases).expect("analysis input");
    let long_text = "x".repeat(600);
    let response = json!({
        "cases": [
            {
                "conflict_id": "conflict:notes",
                "summary": long_text,
                "recommended_action": "same_skill_version",
                "recommended_keep_member": "/lib/conflict:notes-a",
                "key_evidence": [long_text, long_text, long_text, long_text, long_text],
                "uncertainties": ["版本字段缺失"],
                "confidence": 180
            },
            {
                // Not part of this run's input: must be dropped, never shown.
                "conflict_id": "conflict:outside",
                "summary": "invented",
                "recommended_action": "distinct_skill",
                "recommended_keep_member": null,
                "key_evidence": [],
                "uncertainties": [],
                "confidence": 10
            }
        ]
    });

    let analysis =
        parse_conflict_analysis_response(&input.scope, &input.fingerprint, 1, &cases, response)
            .expect("parsed analysis");

    assert_eq!(analysis.scope, scope);
    assert_eq!(analysis.input_fingerprint, input.fingerprint);
    assert_eq!(analysis.skipped_decided_cases, 1);
    // Out-of-scope conclusions are dropped: only input cases may appear.
    assert_eq!(analysis.cases.len(), 1);
    let conclusion = &analysis.cases[0];
    assert_eq!(conclusion.conflict_id, "conflict:notes");
    // 确定性基线保留在每条结论里，先于 AI 意见展示。
    assert_eq!(
        conclusion.baseline_classification,
        ConflictClassification::Uncertain
    );
    // Short conclusions: long model output is capped, never rendered as prose.
    assert!(conclusion.summary.chars().count() <= 200);
    assert!(conclusion.key_evidence.len() <= 4);
    assert!(conclusion
        .key_evidence
        .iter()
        .all(|entry| entry.chars().count() <= 160));
    assert_eq!(
        conclusion.recommended_action,
        ConflictAnalysisAction::SameSkillVersion
    );
    // Keep-member must reference one of the case members.
    assert_eq!(
        conclusion.recommended_keep_member.as_deref(),
        Some("/lib/conflict:notes-a")
    );
    assert_eq!(conclusion.confidence, 100);
    assert_eq!(analysis.source, DuplicateAnalysisSource::Llm);
    assert_eq!(analysis.failure_code, None);
}

#[test]
fn parsed_keep_member_outside_the_case_members_is_dropped() {
    let cases = two_cases();
    let scope = AnalyzeConflictScope::Case {
        conflict_id: "conflict:notes".to_owned(),
    };
    let filtered: Vec<ConflictCaseFact> = cases
        .iter()
        .filter(|case| case.conflict_id == "conflict:notes")
        .cloned()
        .collect();
    let input = build_conflict_analysis_input(&scope, &filtered).expect("analysis input");
    let response = json!({
        "cases": [{
            "conflict_id": "conflict:notes",
            "summary": "成员指纹不同，无法确认同一 Skill。",
            "recommended_action": "keep_uncertain",
            "recommended_keep_member": "/somewhere/else",
            "key_evidence": ["fingerprints differ"],
            "uncertainties": [],
            "confidence": 30
        }]
    });

    let analysis =
        parse_conflict_analysis_response(&input.scope, &input.fingerprint, 0, &filtered, response)
            .expect("parsed analysis");

    assert_eq!(
        analysis.cases[0].recommended_action,
        ConflictAnalysisAction::KeepUncertain
    );
    assert_eq!(analysis.cases[0].recommended_keep_member, None);
}

#[test]
fn malformed_conflict_analysis_responses_fail_with_a_trackable_code() {
    let cases = two_cases();
    let input =
        build_conflict_analysis_input(&AnalyzeConflictScope::All, &cases).expect("analysis input");

    let error = parse_conflict_analysis_response(
        &input.scope,
        &input.fingerprint,
        0,
        &cases,
        json!({ "unrelated": true }),
    )
    .expect_err("malformed response must fail");
    assert_eq!(
        error.code,
        skillhub_core::ErrorCode::LlmInvalidStructuredResponse
    );

    // A missing mandatory field is just as invalid as a wrong shape.
    let error = parse_conflict_analysis_response(
        &input.scope,
        &input.fingerprint,
        0,
        &cases,
        json!({ "cases": [{ "conflict_id": "conflict:notes" }] }),
    )
    .expect_err("incomplete case conclusion must fail");
    assert_eq!(
        error.code,
        skillhub_core::ErrorCode::LlmInvalidStructuredResponse
    );
}

#[test]
fn analysis_result_reports_the_total_scope_size_even_when_capped() {
    let cases = two_cases();
    let scope = AnalyzeConflictScope::All;
    let input = build_conflict_analysis_input(&scope, &cases).expect("analysis input");
    let response = json!({
        "cases": [
            {
                "conflict_id": "conflict:notes",
                "summary": "成员指纹不同，无法确认是否同一 Skill。",
                "recommended_action": "same_skill_version",
                "recommended_keep_member": null,
                "key_evidence": [],
                "uncertainties": [],
                "confidence": 40
            }
        ]
    });

    let analysis =
        parse_conflict_analysis_response(&input.scope, &input.fingerprint, 0, &cases, response)
            .expect("parsed analysis");

    // 范围内共 2 组、本次仅回 1 条结论：总数必须如实上报，
    // 前端据此标注"已分析 1 / 共 2"，不得假装已覆盖全部。
    assert_eq!(analysis.total_case_count, 2);
    assert_eq!(analysis.cases.len(), 1);
}
