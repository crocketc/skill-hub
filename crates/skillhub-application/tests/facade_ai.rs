use async_trait::async_trait;
use serde_json::json;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    api::{AppCommandResult, GetConflictWorkspace, ResolveConflictCase},
    catalog::{CatalogRepository, Skill},
    relationship::ConflictDecision,
    AppCommand, AppQuery as RootAppQuery, AppQueryResult, ApplicationFacade, ErrorCode, Severity,
};
use skillhub_storage::Database;

struct HelperLlmRunner;

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for HelperLlmRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        let output = match request.kind {
            skillhub_core::LlmTaskKind::DuplicateAnalysis => json!({
                "relations": [{
                    "skill_a": "00000000-0000-0000-0000-00000000000a",
                    "skill_b": "00000000-0000-0000-0000-00000000000b",
                    "coverage": "overlap",
                    "shared_abilities": ["extract PDF text"],
                    "unique_a": [],
                    "unique_b": [],
                    "evidence": ["same description"],
                    "recommendation": "keep_both"
                }]
            }),
            skillhub_core::LlmTaskKind::Translation => {
                json!({"translation": "提取 PDF 文本", "language": "zh-CN"})
            }
            skillhub_core::LlmTaskKind::SearchQuery => {
                json!({"query": "PDF extraction skill", "source_filters": ["github"]})
            }
            _ => json!({}),
        };
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "helper-request".to_owned(),
            kind: request.kind,
            output,
        })
    }
}

/// All capability switches default to off; these fixtures exercise the LLM
/// paths, so they opt in explicitly through desktop preferences.
async fn enable_all_llm_capabilities(facade: &LocalApplicationFacade) {
    facade
        .execute(AppCommand::SetDesktopPreferences(
            skillhub_core::DesktopPreferences {
                llm_capabilities: skillhub_core::settings::LlmCapabilitySettings {
                    safety_check: true,
                    semantic_duplicate: true,
                    description_translation: true,
                    online_search_assist: true,
                },
                ..skillhub_core::DesktopPreferences::default()
            },
        ))
        .await
        .expect("enable llm capabilities");
}

#[tokio::test]
async fn optional_ai_helpers_are_wired_without_network_or_implicit_writes() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "AI helpers")
        .with_description("Extract PDF text");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new(database);
    enable_all_llm_capabilities(&facade).await;

    let error = facade
        .execute(AppCommand::AnalyzeSemanticDuplicates(
            skillhub_core::AnalyzeSemanticDuplicates {
                skill_id: skill.id(),
            },
        ))
        .await
        .expect_err("semantic duplicate analysis is optional");
    assert_eq!(error.code, ErrorCode::LlmNotConfigured);
    assert_eq!(error.severity, Severity::Info);

    let error = facade
        .execute(AppCommand::TranslateDescription(
            skillhub_core::TranslateDescription {
                skill_id: skill.id(),
                language: "zh-CN".to_owned(),
                overwrite_user_revision: false,
            },
        ))
        .await
        .expect_err("translation is optional");
    assert_eq!(error.code, ErrorCode::LlmNotConfigured);

    let error = facade
        .execute(AppCommand::GenerateOnlineSearchQuery(
            skillhub_core::GenerateOnlineSearchQuery {
                text: "PDF skills".to_owned(),
            },
        ))
        .await
        .expect_err("query generation is optional");
    assert_eq!(error.code, ErrorCode::LlmNotConfigured);

    let evidence = facade
        .query(RootAppQuery::AnalyzeGlobalSkillEvidence(
            skillhub_core::AnalyzeGlobalSkillEvidence {
                window_days: 60,
                threshold_calls: 2,
            },
        ))
        .await
        .expect("evidence analysis");
    let AppQueryResult::GlobalSkillEvidence(evidence) = evidence else {
        panic!("expected evidence result");
    };
    assert!(evidence.experimental);
    assert_eq!(evidence.window_days, 60);
    assert_eq!(evidence.threshold_calls, 2);
    assert!(evidence.suggestions.is_empty());
    assert!(!evidence.coverage.complete);

    let saved = facade
        .execute(AppCommand::SaveUserTranslationRevision(
            skillhub_core::SaveUserTranslationRevision {
                skill_id: skill.id(),
                language: "zh-CN".to_owned(),
                source_description_hash: "source-hash".to_owned(),
                text: "提取 PDF 文本".to_owned(),
            },
        ))
        .await
        .expect("explicit user revision");
    assert!(matches!(saved, AppCommandResult::TranslationResult(_)));
}

#[tokio::test]
async fn configured_facade_runs_helpers_and_preserves_user_translation_revision() {
    let database = Database::open_in_memory().expect("database");
    let skill_a = Skill::new(
        "00000000-0000-0000-0000-00000000000a"
            .parse()
            .expect("skill id"),
        "PDF extraction A",
    )
    .with_description("Extract PDF text");
    let skill_b = Skill::new(
        "00000000-0000-0000-0000-00000000000b"
            .parse()
            .expect("skill id"),
        "PDF extraction B",
    )
    .with_description("Extract PDF text");
    for skill in [&skill_a, &skill_b] {
        database
            .catalog_repository()
            .expect("catalog repository")
            .insert(skill)
            .await
            .expect("insert skill");
        database
            .search_repository()
            .reindex_skill(&skillhub_core::search::SearchDocument {
                skill_id: skill.id(),
                display_name: skill.display_name().to_owned(),
                runtime_name: skill.runtime_name().to_owned(),
                original_description: skill.original_description().to_owned(),
                translated_description: None,
                user_note: None,
                tags: Vec::new(),
                author: None,
                license: None,
                requirements: Vec::new(),
                markdown: "extract PDF text".to_owned(),
            })
            .expect("index skill");
    }
    let profile = skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile");
    database
        .llm_profile_repository()
        .save(&profile)
        .expect("save profile");
    let root = tempfile::tempdir().expect("library");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        root.path(),
        std::sync::Arc::new(HelperLlmRunner),
    );
    enable_all_llm_capabilities(&facade).await;

    let duplicate = facade
        .execute(AppCommand::AnalyzeSemanticDuplicates(
            skillhub_core::AnalyzeSemanticDuplicates {
                skill_id: skill_a.id(),
            },
        ))
        .await
        .expect("duplicate analysis");
    let AppCommandResult::DuplicateAnalysis(duplicate) = duplicate else {
        panic!("expected duplicate analysis");
    };
    assert_eq!(duplicate.candidate_count, 2);
    assert!(!duplicate.applied_automatically);

    let translated = facade
        .execute(AppCommand::TranslateDescription(
            skillhub_core::TranslateDescription {
                skill_id: skill_a.id(),
                language: "zh-CN".to_owned(),
                overwrite_user_revision: false,
            },
        ))
        .await
        .expect("translation");
    let AppCommandResult::TranslationResult(translated) = translated else {
        panic!("expected translation");
    };
    assert_eq!(translated.text, "提取 PDF 文本");
    let source_hash = translated.provenance.source_description_hash.clone();
    facade
        .execute(AppCommand::SaveUserTranslationRevision(
            skillhub_core::SaveUserTranslationRevision {
                skill_id: skill_a.id(),
                language: "zh-CN".to_owned(),
                source_description_hash: source_hash,
                text: "我修改的译文".to_owned(),
            },
        ))
        .await
        .expect("save user translation revision");
    let error = facade
        .execute(AppCommand::TranslateDescription(
            skillhub_core::TranslateDescription {
                skill_id: skill_a.id(),
                language: "zh-CN".to_owned(),
                overwrite_user_revision: false,
            },
        ))
        .await
        .expect_err("user revision requires confirmation");
    assert_eq!(
        error.code,
        ErrorCode::TranslationUserRevisionRequiresConfirmation
    );

    let query = facade
        .execute(AppCommand::GenerateOnlineSearchQuery(
            skillhub_core::GenerateOnlineSearchQuery {
                text: "PDF skills".to_owned(),
            },
        ))
        .await
        .expect("online query suggestion");
    let AppCommandResult::OnlineSearchQuery(query) = query else {
        panic!("expected online query");
    };
    assert_eq!(query.query, "PDF extraction skill");
}

#[tokio::test]
async fn evidence_query_reports_partial_local_records_as_experimental() {
    let database = Database::open_in_memory().expect("database");
    let skill_id = skillhub_core::SkillId::new();
    let evidence =
        skillhub_storage::UsageEvidenceRepository::new(vec![skillhub_core::UsageEvidence {
            skill_id,
            agent_id: Some("codex".to_owned()),
            calls: 1,
            source: "local_operation_evidence".to_owned(),
            complete: false,
        }]);
    let facade = LocalApplicationFacade::new_with_evidence(database, evidence);
    let result = facade
        .query(RootAppQuery::AnalyzeGlobalSkillEvidence(
            skillhub_core::AnalyzeGlobalSkillEvidence {
                window_days: 90,
                threshold_calls: 2,
            },
        ))
        .await
        .expect("evidence analysis");
    let AppQueryResult::GlobalSkillEvidence(result) = result else {
        panic!("expected evidence result");
    };
    assert!(result.experimental);
    assert_eq!(result.coverage.sources, vec!["local_operation_evidence"]);
    assert!(!result.coverage.complete);
    assert_eq!(result.suggestions[0].calls, 1);
    assert!(!result.suggestions[0].applied_automatically);
}

/// Always fails like an unreachable provider would.
struct FailingLlmRunner;

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for FailingLlmRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        _request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        Err(skillhub_core::AppError::llm_request_timeout(1_000))
    }
}

#[tokio::test]
async fn duplicate_analysis_surfaces_deterministic_results_when_llm_fails() {
    let database = Database::open_in_memory().expect("database");
    let skill_a = Skill::new(
        "00000000-0000-0000-0000-00000000000a"
            .parse()
            .expect("skill id"),
        "PDF extraction A",
    )
    .with_description("Extract PDF text");
    let skill_b = Skill::new(
        "00000000-0000-0000-0000-00000000000b"
            .parse()
            .expect("skill id"),
        "PDF extraction B",
    )
    .with_description("Extract PDF text");
    for skill in [&skill_a, &skill_b] {
        database
            .catalog_repository()
            .expect("catalog repository")
            .insert(skill)
            .await
            .expect("insert skill");
        database
            .search_repository()
            .reindex_skill(&skillhub_core::search::SearchDocument {
                skill_id: skill.id(),
                display_name: skill.display_name().to_owned(),
                runtime_name: skill.runtime_name().to_owned(),
                original_description: skill.original_description().to_owned(),
                translated_description: None,
                user_note: None,
                tags: Vec::new(),
                author: None,
                license: None,
                requirements: Vec::new(),
                markdown: "extract PDF text".to_owned(),
            })
            .expect("index skill");
    }
    let profile = skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile");
    database
        .llm_profile_repository()
        .save(&profile)
        .expect("save profile");
    let root = tempfile::tempdir().expect("library");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        root.path(),
        std::sync::Arc::new(FailingLlmRunner),
    );
    enable_all_llm_capabilities(&facade).await;

    let duplicate = facade
        .execute(AppCommand::AnalyzeSemanticDuplicates(
            skillhub_core::AnalyzeSemanticDuplicates {
                skill_id: skill_a.id(),
            },
        ))
        .await
        .expect("a failing LLM must not lose the deterministic layer");
    let AppCommandResult::DuplicateAnalysis(duplicate) = duplicate else {
        panic!("expected duplicate analysis");
    };
    assert_eq!(
        duplicate.source,
        skillhub_core::duplicate::DuplicateAnalysisSource::DeterministicOnly
    );
    assert_eq!(
        duplicate.failure_code.as_deref(),
        Some("llm.request_timeout")
    );
    assert!(duplicate.relations.is_empty());
    assert!(!duplicate.applied_automatically);
    assert!(duplicate.candidate_count >= 1);
    assert_eq!(
        duplicate.candidates.len(),
        duplicate.candidate_count as usize
    );
}

// --- Task 8: optional AI conflict analysis (design §3.4) ---

use skillhub_core::api::AnalyzeConflict;
use skillhub_core::duplicate::AnalyzeConflictScope;
use skillhub_core::relationship::{
    ConflictCaseFact, ConflictClassification, ConflictEvidence, ConflictKind,
};

/// Echoes one short conclusion per conflict case found in the request input.
/// It counts calls so tests can prove the LLM was (or was not) invoked.
struct ConflictEchoLlmRunner {
    calls: std::sync::Mutex<u32>,
}

impl ConflictEchoLlmRunner {
    fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            calls: std::sync::Mutex::new(0),
        })
    }

    fn calls(&self) -> u32 {
        *self.calls.lock().expect("call counter")
    }
}

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for ConflictEchoLlmRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        if request.kind != skillhub_core::LlmTaskKind::ConflictAnalysis {
            return Err(skillhub_core::AppError::new(
                ErrorCode::LlmInvalidStructuredResponse,
                Severity::Error,
            ));
        }
        *self.calls.lock().expect("call counter") += 1;
        // Extract the seeded conflict ids straight from the fact payload so
        // every input case gets exactly one advisory conclusion.
        let mut cases = Vec::new();
        let rest = request.input.as_str();
        let mut cursor = 0;
        while let Some(found) = rest[cursor..].find("\"conflict_id\":\"") {
            let start = cursor + found + "\"conflict_id\":\"".len();
            let end = start + rest[start..].find('"').expect("terminated id");
            let conflict_id = &rest[start..end];
            cursor = end;
            if cases
                .iter()
                .any(|case: &serde_json::Value| case["conflict_id"] == *conflict_id)
            {
                continue;
            }
            cases.push(json!({
                "conflict_id": conflict_id,
                "summary": "成员指纹不同，无法确认是否同一 Skill。".to_owned(),
                "recommended_action": "keep_uncertain",
                "recommended_keep_member": serde_json::Value::Null,
                "key_evidence": ["fingerprints differ"],
                "uncertainties": ["版本字段缺失"],
                "confidence": 40
            }));
        }
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "conflict-echo".to_owned(),
            kind: request.kind,
            output: json!({ "cases": cases }),
        })
    }
}

fn conflict_case(
    conflict_id: &str,
    classification: ConflictClassification,
    member_skill_id: Option<skillhub_core::SkillId>,
    user_decision: Option<ConflictClassification>,
) -> ConflictCaseFact {
    ConflictCaseFact {
        conflict_id: conflict_id.to_owned(),
        kind: ConflictKind::SameNameDifferentContent,
        classification,
        member_skill_ids: member_skill_id.into_iter().collect(),
        members: member_skill_id
            .map(|skill_id| {
                vec![skillhub_core::relationship::ConflictMemberFact {
                    skill_id: Some(skill_id),
                    version_id: None,
                    provenance_id: None,
                    directory_node_id: None,
                    path: Some(format!("/lib/{conflict_id}")),
                    fingerprint: Some("sha256:member".to_owned()),
                }]
            })
            .unwrap_or_default(),
        evidence: ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: None,
            sufficient_identity_evidence: false,
        },
        user_decision,
        decided_at: user_decision.map(|_| 1_000),
    }
}

async fn conflict_fixture(
    runner: std::sync::Arc<ConflictEchoLlmRunner>,
) -> (LocalApplicationFacade, skillhub_core::SkillId) {
    let database = Database::open_in_memory().expect("database");
    let skill_id = "00000000-0000-0000-0000-00000000000a"
        .parse()
        .expect("skill id");
    // The member row carries a real skill identity (FK to skills).
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skillhub_core::catalog::Skill::new(skill_id, "Notes"))
        .await
        .expect("seed skill");
    {
        let repository = database.conflict_repository();
        repository
            .create_case(&conflict_case(
                "conflict:notes",
                ConflictClassification::Uncertain,
                Some(skill_id),
                None,
            ))
            .expect("case a");
        repository
            .create_case(&conflict_case(
                "conflict:reader",
                ConflictClassification::DistinctSkill,
                None,
                None,
            ))
            .expect("case b");
        repository
            .create_case(&conflict_case(
                "conflict:decided",
                ConflictClassification::Uncertain,
                None,
                Some(ConflictClassification::DistinctSkill),
            ))
            .expect("decided case");
    }
    let profile = skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile");
    database
        .llm_profile_repository()
        .save(&profile)
        .expect("save profile");
    let root = tempfile::tempdir().expect("library");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        root.path(),
        runner as std::sync::Arc<dyn skillhub_core::LlmTaskRunner>,
    );
    enable_all_llm_capabilities(&facade).await;
    (facade, skill_id)
}

async fn analysis_of(
    facade: &LocalApplicationFacade,
    scope: AnalyzeConflictScope,
) -> skillhub_core::duplicate::ConflictAnalysis {
    let result = facade
        .execute(AppCommand::AnalyzeConflict(AnalyzeConflict { scope }))
        .await
        .expect("conflict analysis is a result, never a fake conclusion");
    let AppCommandResult::ConflictAnalysis(analysis) = result else {
        panic!("expected conflict analysis");
    };
    analysis
}

#[tokio::test]
async fn conflict_analysis_without_llm_reports_baseline_and_failure_code_without_faking() {
    let database = Database::open_in_memory().expect("database");
    database
        .conflict_repository()
        .create_case(&conflict_case(
            "conflict:notes",
            ConflictClassification::Uncertain,
            None,
            None,
        ))
        .expect("case");
    let facade = LocalApplicationFacade::new(database);
    enable_all_llm_capabilities(&facade).await;

    let analysis = analysis_of(&facade, AnalyzeConflictScope::All).await;
    // No provider: the honest failure code, no invented AI conclusions.
    assert_eq!(
        analysis.source,
        skillhub_core::duplicate::DuplicateAnalysisSource::DeterministicOnly
    );
    assert_eq!(analysis.failure_code.as_deref(), Some("llm.not_configured"));
    assert!(analysis.cases.is_empty());

    // 确定性优先：AI 不可用时确定性冲突分组照常返回。
    let overview = facade
        .query(RootAppQuery::GetRelationshipOverview(
            skillhub_core::api::GetRelationshipOverview {
                scope: skillhub_core::api::RelationshipOverviewScope::All,
            },
        ))
        .await
        .expect("relationship overview");
    let AppQueryResult::RelationshipOverview(overview) = overview else {
        panic!("expected overview");
    };
    assert_eq!(overview.conflict_cases.len(), 1);
    assert_eq!(overview.conflict_cases[0].user_decision, None);

    // Without an analysis run there is nothing to persist.
    let records = facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .conflict_analysis_repository()
        .list_records(None)
        .expect("records");
    assert!(records.is_empty());
}

#[tokio::test]
async fn conflict_analysis_respects_the_capability_switch_and_never_calls_the_llm() {
    let database = Database::open_in_memory().expect("database");
    database
        .conflict_repository()
        .create_case(&conflict_case(
            "conflict:notes",
            ConflictClassification::Uncertain,
            None,
            None,
        ))
        .expect("case");
    let profile = skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile");
    database
        .llm_profile_repository()
        .save(&profile)
        .expect("save profile");
    let runner = ConflictEchoLlmRunner::new();
    let root = tempfile::tempdir().expect("library");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        root.path(),
        runner.clone() as std::sync::Arc<dyn skillhub_core::LlmTaskRunner>,
    );

    let analysis = analysis_of(&facade, AnalyzeConflictScope::All).await;
    assert_eq!(
        analysis.failure_code.as_deref(),
        Some("llm.capability_disabled")
    );
    assert!(analysis.cases.is_empty());
    assert_eq!(
        runner.calls(),
        0,
        "a disabled capability must not call the LLM"
    );
    assert!(facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .conflict_analysis_repository()
        .list_records(None)
        .expect("records")
        .is_empty());
}

#[tokio::test]
async fn configured_conflict_analysis_keeps_conclusions_short_and_user_decisions_separate() {
    let runner = ConflictEchoLlmRunner::new();
    let (facade, _skill_id) = conflict_fixture(runner.clone()).await;

    let analysis = analysis_of(&facade, AnalyzeConflictScope::All).await;
    assert_eq!(analysis.scope, AnalyzeConflictScope::All);
    assert!(analysis.input_fingerprint.starts_with("sha256:"));
    // 已裁决的冲突组不送 AI：结果与记录都不会出现。
    assert_eq!(analysis.skipped_decided_cases, 1);
    assert_eq!(analysis.cases.len(), 2);
    assert!(analysis
        .cases
        .iter()
        .all(|case| case.summary.chars().count() <= 200));
    assert!(analysis.cases.iter().all(|case| case.confidence <= 100));
    assert!(analysis
        .cases
        .iter()
        .all(
            |case| case.baseline_classification == ConflictClassification::Uncertain
                || case.baseline_classification == ConflictClassification::DistinctSkill
        ));
    assert_eq!(runner.calls(), 1);

    // 分析记录持久化：含来源、指纹、基线与失败码（成功为空）。
    let database = facade.database_for_tests();
    let records = database
        .lock()
        .expect("database lock")
        .conflict_analysis_repository()
        .list_records(None)
        .expect("records");
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|record| !record.adopted_by_user));
    assert!(records.iter().all(|record| record.source
        == skillhub_core::duplicate::DuplicateAnalysisSource::Llm
        && record.failure_code.is_none()
        && record.conclusion.is_some()));

    // AI 记录绝不改变 ConflictCase.user_decision。
    let cases = database
        .lock()
        .expect("database lock")
        .conflict_repository()
        .list_cases()
        .expect("cases");
    let decided = cases
        .iter()
        .find(|case| case.conflict_id == "conflict:decided")
        .expect("decided case");
    assert_eq!(
        decided.user_decision,
        Some(ConflictClassification::DistinctSkill)
    );
    assert!(cases
        .iter()
        .filter(|case| case.conflict_id != "conflict:decided")
        .all(|case| case.user_decision.is_none()));
}

/// 冲突处理的 AI 层始终只是建议：没有模型也能人工决定，决定之后分析不再
/// 反转或覆盖它，工作台也不会把已裁决项送回分析。
#[tokio::test]
async fn conflict_analysis_never_replaces_a_manual_decision() {
    let database = Database::open_in_memory().expect("database");
    let skill_id = "00000000-0000-0000-0000-00000000000a"
        .parse()
        .expect("skill id");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&Skill::new(skill_id, "Notes"))
        .await
        .expect("seed skill");
    database
        .conflict_repository()
        .create_case(&conflict_case(
            "conflict:notes",
            ConflictClassification::Uncertain,
            Some(skill_id),
            None,
        ))
        .expect("case");
    // 没有 LLM runner，也没有模型配置：人工处理必须照常可用。
    let facade = LocalApplicationFacade::new(database);
    enable_all_llm_capabilities(&facade).await;

    let analysis = analysis_of(&facade, AnalyzeConflictScope::All).await;
    assert_eq!(analysis.failure_code.as_deref(), Some("llm.not_configured"));
    assert!(analysis.cases.is_empty());

    let workspace = match facade
        .query(RootAppQuery::GetConflictWorkspace(GetConflictWorkspace))
        .await
        .expect("conflict workspace")
    {
        AppQueryResult::ConflictWorkspace(workspace) => workspace,
        other => panic!("expected conflict workspace, got {other:?}"),
    };
    assert_eq!(workspace.cases.len(), 1);
    assert!(workspace.cases[0].latest_analysis.is_none());
    let resolved = facade
        .execute(AppCommand::ResolveConflictCase(ResolveConflictCase {
            conflict_id: "conflict:notes".to_owned(),
            decision: ConflictDecision::KeepDistinct,
            expected_relationship_revision: workspace.relationship_revision.clone(),
        }))
        .await
        .expect("manual decision without any LLM");
    let AppCommandResult::ConflictResolved(outcome) = resolved else {
        panic!("expected conflict resolution outcome");
    };
    assert_eq!(
        outcome.conclusion,
        Some(ConflictClassification::DistinctSkill)
    );
    assert!(outcome.governance.is_none());

    // 已裁决的冲突不再送 AI，也不会被后续分析反转。
    let after = analysis_of(&facade, AnalyzeConflictScope::All).await;
    assert_eq!(after.skipped_decided_cases, 1);
    assert_eq!(after.total_case_count, 0);
    assert!(after.cases.is_empty());
    let cases = facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .conflict_repository()
        .list_cases()
        .expect("cases");
    assert_eq!(
        cases[0].user_decision,
        Some(ConflictClassification::DistinctSkill)
    );
    assert_eq!(cases[0].decided_at, outcome.decided_at);
}

#[tokio::test]
async fn conflict_analysis_failure_leaves_trackable_records_and_a_working_deterministic_layer() {
    let database = Database::open_in_memory().expect("database");
    database
        .conflict_repository()
        .create_case(&conflict_case(
            "conflict:notes",
            ConflictClassification::Uncertain,
            None,
            None,
        ))
        .expect("case");
    let profile = skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile");
    database
        .llm_profile_repository()
        .save(&profile)
        .expect("save profile");
    let root = tempfile::tempdir().expect("library");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        root.path(),
        std::sync::Arc::new(FailingLlmRunner),
    );
    enable_all_llm_capabilities(&facade).await;

    let analysis = analysis_of(&facade, AnalyzeConflictScope::All).await;
    assert_eq!(
        analysis.source,
        skillhub_core::duplicate::DuplicateAnalysisSource::DeterministicOnly
    );
    assert_eq!(
        analysis.failure_code.as_deref(),
        Some("llm.request_timeout")
    );
    assert!(analysis.cases.is_empty());

    // 失败码可追踪：每个冲突组留下带失败码的分析记录。
    let records = facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .conflict_analysis_repository()
        .list_records(Some("conflict:notes"))
        .expect("records");
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].failure_code.as_deref(),
        Some("llm.request_timeout")
    );
    assert_eq!(records[0].conclusion, None);
    assert_eq!(
        records[0].baseline_classification,
        ConflictClassification::Uncertain
    );
}

#[tokio::test]
async fn conflict_analysis_filters_cases_for_all_category_case_and_skill_scopes() {
    let runner = ConflictEchoLlmRunner::new();
    let (facade, skill_id) = conflict_fixture(runner.clone()).await;

    let case_scope = analysis_of(
        &facade,
        AnalyzeConflictScope::Case {
            conflict_id: "conflict:notes".to_owned(),
        },
    )
    .await;
    assert_eq!(case_scope.cases.len(), 1);
    assert_eq!(case_scope.cases[0].conflict_id, "conflict:notes");

    let uncertain = analysis_of(
        &facade,
        AnalyzeConflictScope::Category {
            classification: ConflictClassification::Uncertain,
        },
    )
    .await;
    let mut uncertain_ids: Vec<_> = uncertain
        .cases
        .iter()
        .map(|case| case.conflict_id.as_str())
        .collect();
    uncertain_ids.sort_unstable();
    assert_eq!(uncertain_ids, vec!["conflict:notes"]);

    let distinct = analysis_of(
        &facade,
        AnalyzeConflictScope::Category {
            classification: ConflictClassification::DistinctSkill,
        },
    )
    .await;
    assert_eq!(distinct.cases.len(), 1);
    assert_eq!(distinct.cases[0].conflict_id, "conflict:reader");

    let skill_scope = analysis_of(&facade, AnalyzeConflictScope::Skill { skill_id }).await;
    assert_eq!(skill_scope.cases.len(), 1);
    assert_eq!(skill_scope.cases[0].conflict_id, "conflict:notes");

    assert_eq!(runner.calls(), 4);
}

#[tokio::test]
async fn analyze_all_reports_total_scope_size_beyond_the_request_cap() {
    let runner = ConflictEchoLlmRunner::new();
    let (facade, _skill_id) = conflict_fixture(runner).await;
    enable_all_llm_capabilities(&facade).await;
    {
        let handle = facade.database_for_tests();
        let database = handle.lock().expect("database lock");
        for index in 0..18 {
            database
                .conflict_repository()
                .create_case(&conflict_case(
                    &format!("conflict:bulk-{index:02}"),
                    ConflictClassification::Uncertain,
                    None,
                    None,
                ))
                .expect("seed case");
        }
    }

    let analysis = analysis_of(&facade, AnalyzeConflictScope::All).await;
    // 夹具自带 2 个未决组 + 本测试 18 个 = 20 个未决组；单次请求上限
    // 截断结论，但范围内总数必须如实上报。
    assert_eq!(analysis.total_case_count, 20);
    assert_eq!(analysis.cases.len(), 16);
}
