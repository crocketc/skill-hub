use async_trait::async_trait;

use crate::llm::translation::{
    build_translation_request, parse_translation_response, TranslationOrigin,
    TranslationProvenance, TranslationRecord, TranslationResult,
};
use crate::llm::{LlmProfile, LlmTaskRunner};
use crate::{AppError, AppResult, ErrorCode, Severity, SkillId};

#[async_trait(?Send)]
pub trait TranslationRepository: Send + Sync {
    async fn get(&self, skill_id: SkillId, language: &str) -> AppResult<Option<TranslationRecord>>;
    async fn save(&self, record: TranslationRecord) -> AppResult<()>;
}

pub struct TranslationService<R, T> {
    repository: R,
    runner: T,
}

impl<R, T> TranslationService<R, T>
where
    R: TranslationRepository,
    T: LlmTaskRunner,
{
    pub fn new(repository: R, runner: T) -> Self {
        Self { repository, runner }
    }

    pub async fn translate(
        &self,
        skill_id: SkillId,
        original_description: &str,
        source_description_hash: &str,
        language: &str,
        profile: Option<&LlmProfile>,
    ) -> AppResult<TranslationResult> {
        let existing = self.repository.get(skill_id, language).await?;
        if let Some(record) = existing {
            if record.provenance.source_description_hash == source_description_hash {
                if record.origin == TranslationOrigin::UserRevision {
                    return Err(AppError::new(
                        ErrorCode::TranslationUserRevisionRequiresConfirmation,
                        Severity::Warning,
                    ));
                }
                return Ok(TranslationResult {
                    skill_id,
                    language: record.language,
                    text: record.text,
                    provenance: record.provenance,
                });
            }
        }
        let profile =
            profile.ok_or_else(|| AppError::new(ErrorCode::LlmNotConfigured, Severity::Info))?;
        let response = self
            .runner
            .run(
                profile,
                build_translation_request(original_description, language)?,
            )
            .await?;
        let text = parse_translation_response(response.output, language)?;
        let provenance = TranslationProvenance {
            source_description_hash: source_description_hash.to_owned(),
            provider: profile.provider.clone(),
            model: profile.model.clone(),
            origin: TranslationOrigin::Generated,
        };
        self.repository
            .save(TranslationRecord {
                skill_id,
                language: language.to_owned(),
                text: text.clone(),
                provenance: provenance.clone(),
                origin: TranslationOrigin::Generated,
            })
            .await?;
        Ok(TranslationResult {
            skill_id,
            language: language.to_owned(),
            text,
            provenance,
        })
    }

    pub async fn save_user_revision(
        &self,
        skill_id: SkillId,
        language: &str,
        source_description_hash: &str,
        text: &str,
    ) -> AppResult<()> {
        if text.trim().is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error));
        }
        let provenance = TranslationProvenance {
            source_description_hash: source_description_hash.to_owned(),
            provider: "user".to_owned(),
            model: "user_revision".to_owned(),
            origin: TranslationOrigin::UserRevision,
        };
        self.repository
            .save(TranslationRecord {
                skill_id,
                language: language.to_owned(),
                text: text.to_owned(),
                provenance,
                origin: TranslationOrigin::UserRevision,
            })
            .await
    }
}
