use async_trait::async_trait;
use skillhub_core::application::{SourceService, SourceUpdateBackend};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{AppResult, SkillId, SourceState, UpdateDecision};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct RecordingSourceBackend {
    checks: Mutex<Vec<SkillId>>,
    relinks: Mutex<Vec<(SkillId, SourceDescriptor)>>,
    applies: Mutex<Vec<(SkillId, UpdateDecision)>>,
}

#[async_trait]
impl SourceUpdateBackend for RecordingSourceBackend {
    async fn relink_source(&self, skill_id: SkillId, source: SourceDescriptor) -> AppResult<()> {
        self.relinks.lock().unwrap().push((skill_id, source));
        Ok(())
    }

    async fn check_source_update(
        &self,
        skill_id: SkillId,
    ) -> AppResult<skillhub_core::UpstreamCheckResult> {
        self.checks.lock().unwrap().push(skill_id);
        Ok(skillhub_core::UpstreamCheckResult::new(
            skill_id,
            SourceState::UpdateAvailableWithLocalChanges,
        ))
    }

    async fn apply_source_update(
        &self,
        skill_id: SkillId,
        decision: UpdateDecision,
    ) -> AppResult<skillhub_core::AppliedSourceUpdate> {
        self.applies.lock().unwrap().push((skill_id, decision));
        Ok(skillhub_core::AppliedSourceUpdate::new(skill_id, decision))
    }
}

#[test]
fn update_never_overwrites_local_modification_without_explicit_choice() {
    block_on(async {
        let backend = Arc::new(RecordingSourceBackend::default());
        let service = SourceService::new(backend.clone());
        let skill_id = SkillId::new();
        let check = service.check_update(skill_id).await.unwrap();
        assert_eq!(check.state, SourceState::UpdateAvailableWithLocalChanges);

        let error = service
            .apply_update(skill_id, UpdateDecision::TakeUpstream)
            .await
            .unwrap_err();
        assert_eq!(error.code.as_str(), "operation.conflict");
        assert!(backend.applies.lock().unwrap().is_empty());
    });
}

#[test]
fn relink_records_new_source_without_applying_an_update() {
    block_on(async {
        let backend = Arc::new(RecordingSourceBackend::default());
        let service = SourceService::new(backend.clone());
        let skill_id = SkillId::new();
        let source = SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url("https://github.com/example/skill"),
        );
        service
            .relink_source(skill_id, source.clone())
            .await
            .unwrap();
        assert_eq!(
            backend.relinks.lock().unwrap().as_slice(),
            &[(skill_id, source)]
        );
        assert!(backend.applies.lock().unwrap().is_empty());
    });
}

#[test]
fn keep_local_and_cancel_are_non_destructive_decisions() {
    block_on(async {
        let backend = Arc::new(RecordingSourceBackend::default());
        let service = SourceService::new(backend.clone());
        let skill_id = SkillId::new();
        let kept = service
            .apply_update(skill_id, UpdateDecision::KeepLocal)
            .await
            .unwrap();
        let cancelled = service
            .apply_update(skill_id, UpdateDecision::Cancel)
            .await
            .unwrap();
        assert_eq!(kept.decision, UpdateDecision::KeepLocal);
        assert_eq!(cancelled.decision, UpdateDecision::Cancel);
        assert!(backend.applies.lock().unwrap().is_empty());
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
