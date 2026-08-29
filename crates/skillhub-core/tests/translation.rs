use async_trait::async_trait;
use serde_json::json;
use skillhub_core::application::{TranslationRepository, TranslationService};
use skillhub_core::llm::{CredentialRef, LlmProfile, LlmTaskResponse, LlmTaskRunner};
use skillhub_core::translation::{TranslationOrigin, TranslationRecord};
use skillhub_core::{AppResult, ErrorCode, SkillId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct MemoryTranslations(Arc<Mutex<HashMap<(SkillId, String), TranslationRecord>>>);

#[async_trait(?Send)]
impl TranslationRepository for MemoryTranslations {
    async fn get(&self, skill_id: SkillId, language: &str) -> AppResult<Option<TranslationRecord>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&(skill_id, language.to_owned()))
            .cloned())
    }

    async fn save(&self, record: TranslationRecord) -> AppResult<()> {
        self.0
            .lock()
            .unwrap()
            .insert((record.skill_id, record.language.clone()), record);
        Ok(())
    }
}

struct Runner;

#[async_trait(?Send)]
impl LlmTaskRunner for Runner {
    async fn run(
        &self,
        _profile: &LlmProfile,
        request: skillhub_core::llm::LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse> {
        Ok(LlmTaskResponse {
            request_id: "translation-request".into(),
            kind: request.kind,
            output: json!({"translation": "提取 PDF 文本", "language": "zh-CN"}),
        })
    }
}

fn profile() -> LlmProfile {
    LlmProfile::new(
        "provider",
        "https://api.example.test/v1/chat/completions",
        "model",
        Some(CredentialRef::new("credential")),
    )
    .unwrap()
}

#[test]
fn translation_is_saved_separately_and_user_revision_requires_confirmation() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let skill_id = SkillId::new();
            let original = "Extract PDF text";
            let store = MemoryTranslations::default();
            let service = TranslationService::new(store.clone(), Runner);
            let generated = service
                .translate(skill_id, original, "source-hash", "zh-CN", Some(&profile()))
                .await
                .unwrap();
            assert_eq!(generated.text, "提取 PDF 文本");
            service
                .save_user_revision(skill_id, "zh-CN", "source-hash", "我修改的译文")
                .await
                .unwrap();
            let error = service
                .translate(
                    skill_id,
                    "Extract PDF text",
                    "source-hash",
                    "zh-CN",
                    Some(&profile()),
                )
                .await
                .unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::TranslationUserRevisionRequiresConfirmation
            );
            assert_eq!(original, "Extract PDF text");
            assert_eq!(
                store.get(skill_id, "zh-CN").await.unwrap().unwrap().origin,
                TranslationOrigin::UserRevision
            );
        });
}

#[test]
fn missing_llm_disables_optional_translation() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let service = TranslationService::new(MemoryTranslations::default(), Runner);
            let error = service
                .translate(SkillId::new(), "PDF", "hash", "zh-CN", None)
                .await
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::LlmNotConfigured);
        });
}
