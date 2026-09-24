use async_trait::async_trait;
use skillhub_core::application::{ImportBackend, ImportService};
use skillhub_core::import::{CandidateOwnership, ImportAction, ImportCandidate, ImportDecision};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{AppError, AppResult, SkillId};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

#[derive(Default)]
struct RecordingBackend {
    copied: Mutex<Vec<SkillId>>,
    verified: Mutex<Vec<SkillId>>,
    removed: Mutex<Vec<String>>,
    fail_verify: Mutex<bool>,
}

#[async_trait]
impl ImportBackend for RecordingBackend {
    async fn copy_into_library(&self, _candidate: &ImportCandidate) -> AppResult<SkillId> {
        let id = SkillId::new();
        self.copied.lock().unwrap().push(id);
        Ok(id)
    }

    async fn establish_managed_relation(
        &self,
        _candidate: &ImportCandidate,
        _skill_id: SkillId,
    ) -> AppResult<()> {
        Ok(())
    }

    async fn verify_managed_copy(&self, skill_id: SkillId) -> AppResult<()> {
        if *self.fail_verify.lock().unwrap() {
            return Err(AppError::new(
                skillhub_core::ErrorCode::InternalError,
                skillhub_core::Severity::Error,
            ));
        }
        self.verified.lock().unwrap().push(skill_id);
        Ok(())
    }

    async fn remove_original(&self, candidate: &ImportCandidate) -> AppResult<()> {
        self.removed
            .lock()
            .unwrap()
            .push(candidate.absolute_root.clone());
        Ok(())
    }
}

fn candidate(ownership: CandidateOwnership, runtime_name: &str, root: PathBuf) -> ImportCandidate {
    ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root.clone())),
        root.to_string_lossy(),
        ".",
        "SKILL.md",
        runtime_name,
    )
    .with_ownership(ownership, ImportAction::Review, None)
}

#[test]
fn local_copy_keeps_original_and_creates_one_managed_item() {
    block_on(async {
        let source = tempdir().unwrap();
        std::fs::write(source.path().join("SKILL.md"), "# notes").unwrap();
        let backend = Arc::new(RecordingBackend::default());
        let service = ImportService::new(backend.clone());
        let prepared = service
            .prepare(
                candidate(
                    CandidateOwnership::ArbitraryLocalDirectory,
                    "notes",
                    source.path().to_path_buf(),
                ),
                None,
                &[],
                &Default::default(),
            )
            .await
            .unwrap();

        let result = service
            .commit(prepared.id, ImportDecision::CopyIntoLibrary)
            .await
            .unwrap();
        assert!(source.path().join("SKILL.md").exists());
        assert_eq!(result.items.len(), 1);
        assert!(result.items[0].skill_id.is_some());
        assert_eq!(backend.copied.lock().unwrap().len(), 1);
    });
}

#[test]
fn takeover_does_not_remove_original_until_managed_copy_is_verified() {
    block_on(async {
        let source = tempdir().unwrap();
        std::fs::write(source.path().join("SKILL.md"), "# notes").unwrap();
        let backend = Arc::new(RecordingBackend::default());
        *backend.fail_verify.lock().unwrap() = true;
        let service = ImportService::new(backend.clone());
        let prepared = service
            .prepare(
                candidate(
                    CandidateOwnership::KnownAgentTarget,
                    "notes",
                    source.path().to_path_buf(),
                ),
                Some("sha256:incoming"),
                &[],
                &Default::default(),
            )
            .await
            .unwrap();

        let error = service
            .commit(prepared.id, ImportDecision::TakeOverAfterVerify)
            .await
            .unwrap_err();
        assert_eq!(error.code.as_str(), "internal.error");
        assert!(source.path().join("SKILL.md").exists());
        assert!(backend.removed.lock().unwrap().is_empty());
    });
}

#[test]
fn failed_commit_keeps_prepared_session_for_retry_and_cancel_is_explicit() {
    block_on(async {
        let source = tempdir().unwrap();
        std::fs::write(source.path().join("SKILL.md"), "# notes").unwrap();
        let backend = Arc::new(RecordingBackend::default());
        *backend.fail_verify.lock().unwrap() = true;
        let service = ImportService::new(backend.clone());
        let prepared = service
            .prepare(
                candidate(
                    CandidateOwnership::KnownAgentTarget,
                    "notes",
                    source.path().to_path_buf(),
                ),
                None,
                &[],
                &Default::default(),
            )
            .await
            .unwrap();
        assert!(service
            .commit(prepared.id, ImportDecision::TakeOverAfterVerify)
            .await
            .is_err());
        assert!(service.cancel(prepared.id).await.is_ok());
        assert!(service.cancel(prepared.id).await.is_err());
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn import_batch_contract_is_serde_stable_and_legacy_payloads_survive() {
    // 批次契约（plan 4.1/4.7）：CommitImport 携带 batch_id/candidate_key，
    // 批次命令存在；旧客户端缺省字段仍可反序列化（语义由应用层强制）。
    let commit = skillhub_core::CommitImport {
        prepared_import_id: skillhub_core::OperationId::new(),
        decision: ImportDecision::Skip,
        governance_decision: Default::default(),
        batch_id: Some("batch-1".into()),
        candidate_key: Some("acq|notes".into()),
    };
    let mut value = serde_json::to_value(&commit).expect("serialize commit");
    assert_eq!(value["batch_id"], "batch-1");
    value.as_object_mut().unwrap().remove("batch_id");
    value.as_object_mut().unwrap().remove("candidate_key");
    let legacy: skillhub_core::CommitImport =
        serde_json::from_value(value).expect("legacy payload deserializes");
    assert_eq!(legacy.batch_id, None);
    assert_eq!(legacy.candidate_key, None);

    let _begin = skillhub_core::api::BeginImportBatch {};
    let finalize = skillhub_core::api::FinalizeImportBatch {
        batch_id: "batch-1".into(),
    };
    assert_eq!(finalize.batch_id, "batch-1");
    let _query = skillhub_core::api::QueryOpenImportBatch {};

    let summary = skillhub_core::ImportSummary {
        operation_id: commit.prepared_import_id,
        items: Vec::new(),
        committed: true,
        batch: Some(skillhub_core::ImportBatchContext {
            batch_id: "batch-1".into(),
        }),
    };
    assert_eq!(summary.batch.as_ref().expect("batch").batch_id, "batch-1");
}
