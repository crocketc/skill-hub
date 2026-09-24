//! Task 8 conflict-analysis record persistence tests (design §3.4).
//!
//! Analysis records are advisory traces: they may be adopted by the user, but
//! they must never touch `ConflictCase.user_decision`.

use skillhub_core::duplicate::{
    AnalyzeConflictScope, ConflictAnalysisAction, ConflictAnalysisRecord, ConflictCaseAnalysis,
    DuplicateAnalysisSource,
};
use skillhub_core::relationship::{
    ConflictCaseFact, ConflictClassification, ConflictEvidence, ConflictKind,
};
use skillhub_storage::{Database, CURRENT_SCHEMA_VERSION};

fn case(conflict_id: &str) -> ConflictCaseFact {
    ConflictCaseFact {
        conflict_id: conflict_id.to_owned(),
        kind: ConflictKind::SameNameDifferentContent,
        classification: ConflictClassification::Uncertain,
        member_skill_ids: Vec::new(),
        members: Vec::new(),
        evidence: ConflictEvidence::default(),
        user_decision: None,
        decided_at: None,
    }
}

fn record(record_id: &str, conflict_id: &str, failure: bool) -> ConflictAnalysisRecord {
    ConflictAnalysisRecord {
        record_id: record_id.to_owned(),
        conflict_id: conflict_id.to_owned(),
        scope: if failure {
            AnalyzeConflictScope::All
        } else {
            AnalyzeConflictScope::Case {
                conflict_id: conflict_id.to_owned(),
            }
        },
        input_fingerprint: "sha256:input".to_owned(),
        baseline_classification: ConflictClassification::Uncertain,
        conclusion: if failure {
            None
        } else {
            Some(ConflictCaseAnalysis {
                conflict_id: conflict_id.to_owned(),
                baseline_classification: ConflictClassification::Uncertain,
                summary: "成员指纹不同，建议人工判断。".to_owned(),
                recommended_action: ConflictAnalysisAction::KeepUncertain,
                recommended_keep_member: None,
                key_evidence: vec!["fingerprints differ".to_owned()],
                uncertainties: vec!["版本字段缺失".to_owned()],
                confidence: 35,
            })
        },
        source: if failure {
            DuplicateAnalysisSource::DeterministicOnly
        } else {
            DuplicateAnalysisSource::Llm
        },
        analyzed_at: 1_700_000_000,
        failure_code: failure.then(|| "llm.request_timeout".to_owned()),
        adopted_by_user: false,
    }
}

#[test]
fn analysis_records_round_trip_without_touching_the_user_decision() {
    let database = Database::open_in_memory().unwrap();
    database
        .conflict_repository()
        .create_case(&case("conflict-1"))
        .unwrap();
    database
        .conflict_repository()
        .create_case(&case("conflict-2"))
        .unwrap();

    let repository = database.conflict_analysis_repository();
    repository
        .insert_record(&record("record-1", "conflict-1", false))
        .unwrap();
    repository
        .insert_record(&record("record-2", "conflict-2", true))
        .unwrap();

    let all = repository.list_records(None).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].record_id, "record-1");
    assert_eq!(
        all[0].scope,
        AnalyzeConflictScope::Case {
            conflict_id: "conflict-1".into()
        }
    );
    assert_eq!(all[0].source, DuplicateAnalysisSource::Llm);
    assert_eq!(all[0].failure_code, None);
    let conclusion = all[0].conclusion.as_ref().expect("llm conclusion");
    assert_eq!(
        conclusion.recommended_action,
        ConflictAnalysisAction::KeepUncertain
    );
    assert_eq!(conclusion.confidence, 35);

    // 失败运行也留下可追踪记录：来源诚实降级 + 失败码。
    let failure = &all[1];
    assert_eq!(failure.source, DuplicateAnalysisSource::DeterministicOnly);
    assert_eq!(failure.conclusion, None);
    assert_eq!(failure.failure_code.as_deref(), Some("llm.request_timeout"));

    let single = repository.list_records(Some("conflict-2")).unwrap();
    assert_eq!(single.len(), 1);
    assert_eq!(single[0].record_id, "record-2");

    // Adoption is tracked on the record, never on the conflict case.
    repository.mark_adopted("record-1").unwrap();
    let adopted = repository.list_records(Some("conflict-1")).unwrap();
    assert!(adopted[0].adopted_by_user);
    let case_after = database.conflict_repository().list_cases().unwrap();
    assert_eq!(case_after[0].user_decision, None);
    assert_eq!(case_after[0].decided_at, None);
}

#[test]
fn adopting_a_missing_analysis_record_fails_honestly() {
    let database = Database::open_in_memory().unwrap();
    let error = database
        .conflict_analysis_repository()
        .mark_adopted("missing")
        .unwrap_err();
    assert_eq!(error.code, skillhub_core::ErrorCode::ObjectNotFound);
}

#[test]
fn v14_database_upgrades_to_current_schema_and_keeps_conflict_facts_readable() {
    let workspace = tempfile::tempdir().unwrap();
    let db_path = workspace.path().join("upgrade.sqlite");
    {
        // Build a genuine v14 database by hand; Database::open would migrate
        // immediately, so this part uses the raw connection.
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        for version in 1..=14 {
            let sql = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("migrations")
                .join(format!("{version:04}_*.sql"));
            let path = std::fs::read_dir(sql.parent().unwrap())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(&format!("{version:04}_")))
                })
                .unwrap();
            connection
                .execute_batch(&std::fs::read_to_string(path).unwrap())
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO conflict_cases (conflict_id, kind, classification, member_skill_ids_json, evidence_json, user_decision, decided_at)
                 VALUES ('conflict-legacy', 'same_name_different_content', 'uncertain', '[]', ?1, NULL, NULL)",
                [r#"{"fingerprints_match":null,"names_match":null,"identity_direction":null,"sufficient_identity_evidence":false}"#],
            )
            .unwrap();
        connection.pragma_update(None, "user_version", 14).unwrap();
    }
    let upgraded = Database::open(&db_path).unwrap();
    assert_eq!(upgraded.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert!(upgraded.has_table("conflict_analysis_records").unwrap());
    let cases = upgraded.conflict_repository().list_cases().unwrap();
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].conflict_id, "conflict-legacy");
    assert_eq!(cases[0].user_decision, None);
}
