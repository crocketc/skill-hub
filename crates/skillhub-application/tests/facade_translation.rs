//! Description translation persistence and batch behaviour: translations
//! survive facade restarts, staleness is derived from the source description
//! hash, batch translation never loses successful items to one failure, and
//! user revisions are never silently overwritten.

use async_trait::async_trait;
use serde_json::json;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{
    api::{AppCommandResult, BatchTranslationItemFailure},
    AppCommand, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode, SkillId,
};
use skillhub_storage::Database;

/// Translates everything except the descriptions marked to fail, so a batch
/// can exercise the per-item failure path without network access.
struct SelectiveRunner;

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for SelectiveRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        if request.input.contains("fail-me") {
            return Err(skillhub_core::AppError::llm_request_timeout(1_000));
        }
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "translation-request".to_owned(),
            kind: request.kind,
            output: json!({"translation": "提取 PDF 文本", "language": "zh-CN"}),
        })
    }
}

async fn enable_translation(facade: &LocalApplicationFacade) {
    facade
        .execute(AppCommand::SetDesktopPreferences(
            skillhub_core::DesktopPreferences {
                llm_capabilities: skillhub_core::settings::LlmCapabilitySettings {
                    description_translation: true,
                    ..skillhub_core::settings::LlmCapabilitySettings::default()
                },
                ..skillhub_core::DesktopPreferences::default()
            },
        ))
        .await
        .expect("enable translation capability");
}

fn skill_with_description(tag: &str, description: &str) -> Skill {
    let id: SkillId = format!("00000000-0000-0000-0000-00000000000{tag}")
        .parse()
        .expect("skill id");
    Skill::new(id, format!("Skill {tag}")).with_description(description)
}

async fn list_translations(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> Vec<skillhub_core::llm::TranslationView> {
    let result = facade
        .query(AppQuery::ListTranslations(
            skillhub_core::api::ListTranslations { skill_id },
        ))
        .await
        .expect("list translations");
    let AppQueryResult::Translations(translations) = result else {
        panic!("expected translations");
    };
    translations
}

#[tokio::test]
async fn translations_persist_across_restarts_and_flag_stale_descriptions() {
    let library = tempfile::tempdir().expect("library dir");
    let database_path = library.path().join("library.sqlite");
    let id: SkillId = "00000000-0000-0000-0000-00000000000a"
        .parse()
        .expect("skill id");

    {
        let database = Database::open(&database_path).expect("database");
        let skill = skill_with_description("a", "Extract PDF text");
        database
            .catalog_repository()
            .expect("catalog repository")
            .insert(&skill)
            .await
            .expect("insert skill");
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
        let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
            database,
            library.path(),
            std::sync::Arc::new(SelectiveRunner),
        );
        enable_translation(&facade).await;
        let translated = facade
            .execute(AppCommand::TranslateDescription(
                skillhub_core::TranslateDescription {
                    skill_id: id,
                    language: "zh-CN".to_owned(),
                },
            ))
            .await
            .expect("translate");
        assert!(matches!(translated, AppCommandResult::TranslationResult(_)));
        let translations = list_translations(&facade, id).await;
        assert_eq!(translations.len(), 1);
        assert!(!translations[0].needs_update);
        assert_eq!(translations[0].record.text, "提取 PDF 文本");
        assert_eq!(translations[0].record.provenance.provider, "test");
    }

    // Restart over the same database: the translation survives, and changing
    // the source description flips the row to "needs update".
    let database = Database::open(&database_path).expect("database");
    database
        .catalog_repository()
        .expect("catalog repository")
        .remove_sync(id)
        .expect("remove skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill_with_description("a", "Extract PDF pages and text"))
        .expect("reinsert skill");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        library.path(),
        std::sync::Arc::new(SelectiveRunner),
    );
    enable_translation(&facade).await;
    let persisted = list_translations(&facade, id).await;
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].record.text, "提取 PDF 文本");
    assert!(persisted[0].needs_update);
}

#[tokio::test]
async fn batch_translation_reports_each_item_and_keeps_the_rest() {
    let database = Database::open_in_memory().expect("database");
    let skill_a = skill_with_description("a", "Extract PDF text");
    let skill_b = skill_with_description("b", "fail-me: Extract DOCX text");
    let skill_c = skill_with_description("c", "Extract images from PDF");
    for skill in [&skill_a, &skill_b, &skill_c] {
        database
            .catalog_repository()
            .expect("catalog repository")
            .insert(skill)
            .await
            .expect("insert skill");
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
    let library = tempfile::tempdir().expect("library");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        library.path(),
        std::sync::Arc::new(SelectiveRunner),
    );
    enable_translation(&facade).await;

    let outcome = facade
        .execute(AppCommand::TranslateDescriptionsBatch(
            skillhub_core::TranslateDescriptionsBatch {
                skill_ids: vec![skill_a.id(), skill_b.id(), skill_c.id()],
                language: "zh-CN".to_owned(),
            },
        ))
        .await
        .expect("batch translation");
    let AppCommandResult::BatchTranslationResult(outcome) = outcome else {
        panic!("expected batch outcome");
    };
    assert_eq!(outcome.language, "zh-CN");
    let translated_ids: Vec<SkillId> = outcome
        .translated
        .iter()
        .map(|result| result.skill_id)
        .collect();
    assert_eq!(translated_ids, vec![skill_a.id(), skill_c.id()]);
    assert_eq!(outcome.failed.len(), 1);
    let BatchTranslationItemFailure { skill_id, code, .. } = &outcome.failed[0];
    assert_eq!(*skill_id, skill_b.id());
    assert_eq!(code, "llm.request_timeout");
}

#[tokio::test]
async fn regeneration_never_silently_overwrites_user_revisions() {
    let database = Database::open_in_memory().expect("database");
    let skill = skill_with_description("a", "Extract PDF text");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
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
    let library = tempfile::tempdir().expect("library");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        library.path(),
        std::sync::Arc::new(SelectiveRunner),
    );
    enable_translation(&facade).await;
    facade
        .execute(AppCommand::TranslateDescription(
            skillhub_core::TranslateDescription {
                skill_id: skill.id(),
                language: "zh-CN".to_owned(),
            },
        ))
        .await
        .expect("initial translation");
    facade
        .execute(AppCommand::SaveUserTranslationRevision(
            skillhub_core::SaveUserTranslationRevision {
                skill_id: skill.id(),
                language: "zh-CN".to_owned(),
                source_description_hash: "hash".to_owned(),
                text: "我亲自润色的译文".to_owned(),
            },
        ))
        .await
        .expect("save user revision");

    let error = facade
        .execute(AppCommand::TranslateDescription(
            skillhub_core::TranslateDescription {
                skill_id: skill.id(),
                language: "zh-CN".to_owned(),
            },
        ))
        .await
        .expect_err("user revision requires confirmation");
    assert_eq!(
        error.code,
        ErrorCode::TranslationUserRevisionRequiresConfirmation
    );
}
