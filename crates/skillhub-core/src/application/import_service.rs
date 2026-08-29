use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::import::{
    analyze_import, ExistingSkillRecord, ImportAnalysis, ImportCandidate, ImportDecision,
};
use crate::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity, SkillId};

/// Side effects required by a committed import. The native adapter owns the
/// actual filesystem/library implementation; this service owns ordering and
/// decision safety.
#[async_trait]
pub trait ImportBackend: Send + Sync {
    async fn copy_into_library(&self, candidate: &ImportCandidate) -> AppResult<SkillId>;
    async fn establish_managed_relation(
        &self,
        candidate: &ImportCandidate,
        skill_id: SkillId,
    ) -> AppResult<()>;
    async fn verify_managed_copy(&self, skill_id: SkillId) -> AppResult<()>;
    async fn remove_original(&self, candidate: &ImportCandidate) -> AppResult<()>;
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PreparedImport {
    pub id: OperationId,
    pub candidate: ImportCandidate,
    pub analysis: ImportAnalysis,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportItemResult {
    pub skill_id: Option<SkillId>,
    pub decision: ImportDecision,
    pub original_preserved: bool,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportSummary {
    pub operation_id: OperationId,
    pub items: Vec<ImportItemResult>,
    pub committed: bool,
}

pub struct ImportService<B> {
    backend: Arc<B>,
    prepared: Arc<Mutex<HashMap<OperationId, PreparedImport>>>,
}

impl<B> Clone for ImportService<B> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
            prepared: self.prepared.clone(),
        }
    }
}

impl<B> ImportService<B>
where
    B: ImportBackend + 'static,
{
    pub fn new(backend: Arc<B>) -> Self {
        Self {
            backend,
            prepared: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Analyze without writing to the central library or touching the source.
    pub async fn prepare(
        &self,
        candidate: ImportCandidate,
        candidate_tree_hash: Option<&str>,
        existing: &[ExistingSkillRecord],
    ) -> AppResult<PreparedImport> {
        let prepared = PreparedImport {
            id: OperationId::new(),
            analysis: analyze_import(candidate.clone(), candidate_tree_hash, existing),
            candidate,
        };
        self.prepared
            .lock()
            .await
            .insert(prepared.id, prepared.clone());
        Ok(prepared)
    }

    /// Commit only an action offered by the immutable preparation result.
    /// Failed side effects leave the preparation available for retry.
    pub async fn commit(
        &self,
        id: OperationId,
        decision: ImportDecision,
    ) -> AppResult<ImportSummary> {
        let prepared = self
            .prepared
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| not_found("prepared_import"))?;
        if !prepared.analysis.actions.contains(&decision) {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("field", "decision")
                .with_action(RecoveryAction::ChooseAnotherName));
        }

        let existing_skill = prepared.analysis.matches.first().map(|item| item.skill_id);
        let (skill_id, original_preserved) = match decision {
            ImportDecision::ReuseExisting => (existing_skill, true),
            ImportDecision::EstablishManagedRelation => {
                let skill_id = existing_skill.ok_or_else(|| not_found("existing_skill"))?;
                self.backend
                    .establish_managed_relation(&prepared.candidate, skill_id)
                    .await?;
                (Some(skill_id), true)
            }
            ImportDecision::CopyIntoLibrary
            | ImportDecision::KeepIndependent
            | ImportDecision::CopyAsIndependentManagedSkill => {
                let skill_id = self.backend.copy_into_library(&prepared.candidate).await?;
                (Some(skill_id), true)
            }
            ImportDecision::TakeOverAfterVerify => {
                let skill_id = self.backend.copy_into_library(&prepared.candidate).await?;
                self.backend.verify_managed_copy(skill_id).await?;
                self.backend.remove_original(&prepared.candidate).await?;
                (Some(skill_id), false)
            }
            ImportDecision::Skip => (None, true),
        };

        self.prepared.lock().await.remove(&id);
        Ok(ImportSummary {
            operation_id: id,
            items: vec![ImportItemResult {
                skill_id,
                decision,
                original_preserved,
            }],
            committed: true,
        })
    }

    pub async fn cancel(&self, id: OperationId) -> AppResult<()> {
        if self.prepared.lock().await.remove(&id).is_none() {
            return Err(not_found("prepared_import"));
        }
        Ok(())
    }
}

fn not_found(field: &str) -> AppError {
    AppError::new(ErrorCode::ObjectNotFound, Severity::Error)
        .with_param("field", field)
        .with_action(RecoveryAction::ChooseAnotherName)
}
