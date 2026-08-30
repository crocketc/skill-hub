use async_trait::async_trait;
use serde_json::json;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    api::AppCommandResult,
    catalog::{CatalogRepository, Skill},
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
