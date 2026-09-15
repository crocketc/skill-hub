use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::import::{
    analyze_import, ExistingSkillRecord, ImportAnalysis, ImportCandidate, ImportDecision,
};
use crate::relationship::GovernanceTaskFact;
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
#[serde(rename_all = "snake_case")]
pub enum ImportItemStatus {
    Succeeded,
    Skipped,
    Failed,
    Todo,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportItemResult {
    pub skill_id: Option<SkillId>,
    pub decision: ImportDecision,
    pub status: ImportItemStatus,
    pub original_preserved: bool,
    /// Stable machine-readable reason for a skipped or failed item.  Display
    /// copy belongs to the client; callers must not parse a prose message.
    #[serde(default)]
    pub reason_code: Option<String>,
    /// Persisted relationship-governance work created by this import item.
    /// Each fact has a stable `task_id` and is queryable through the existing
    /// relationship overview API.
    #[serde(default)]
    pub governance_tasks: Vec<GovernanceTaskFact>,
    /// OPT-20260914-08：导入即存证。提交成功时携带本次导入落库的溯源
    /// 记录（来源/Agent 形态/原始路径/导入时间/内容指纹/所有权状态），
    /// 供导入摘要展示；复用/跳过等未新建存证的分支为 None。
    #[serde(default)]
    pub provenance: Option<crate::import::ImportProvenance>,
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
        source_facts: &crate::import::ImportSourceFacts,
    ) -> AppResult<PreparedImport> {
        let prepared = PreparedImport {
            id: OperationId::new(),
            analysis: analyze_import(
                candidate.clone(),
                candidate_tree_hash,
                existing,
                source_facts,
            ),
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
                // Import only creates a managed copy.  Original-source removal
                // is a separate, explicitly prepared governance operation.
                (Some(skill_id), true)
            }
            ImportDecision::Skip => (None, true),
        };

        self.prepared.lock().await.remove(&id);
        Ok(ImportSummary {
            operation_id: id,
            items: vec![ImportItemResult {
                skill_id,
                decision,
                status: if decision == ImportDecision::Skip {
                    ImportItemStatus::Skipped
                } else {
                    ImportItemStatus::Succeeded
                },
                original_preserved,
                reason_code: None,
                governance_tasks: Vec::new(),
                provenance: None,
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
