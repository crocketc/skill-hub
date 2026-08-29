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
