use async_trait::async_trait;
use skillhub_core::application::{SourceService, SourceUpdateBackend};
use skillhub_core::source::{
    SourceDescriptor, SourceKind, SourceLocator, SourceUpdateFileChange, SourceUpdatePreview,
};
use skillhub_core::{AppResult, OperationId, SkillId, SourceState, UpdateDecision};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct RecordingSourceBackend {
    checks: Mutex<Vec<SkillId>>,
    relinks: Mutex<Vec<(SkillId, SourceDescriptor)>>,
    prepares: Mutex<Vec<SkillId>>,
    commits: Mutex<Vec<(SkillId, OperationId, UpdateDecision)>>,
}

fn preview_for(skill_id: SkillId) -> SourceUpdatePreview {
    SourceUpdatePreview {
        skill_id,
        preview_id: OperationId::new(),
        expires_at: "2026-01-01T00:00:00Z".into(),
        confirmation_fingerprint: "fingerprint".into(),
        current_version_id: None,
        candidate_identity: "sha256:candidate".into(),
        upstream_label: None,
        files: vec![SourceUpdateFileChange {
            path: "SKILL.md".into(),
            change: skillhub_core::SourceUpdateFileChangeKind::Modified,
        }],
    }
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

    async fn prepare_source_update(&self, skill_id: SkillId) -> AppResult<SourceUpdatePreview> {
        self.prepares.lock().unwrap().push(skill_id);
        Ok(preview_for(skill_id))
    }

    async fn commit_source_update(
        &self,
        skill_id: SkillId,
        preview_id: OperationId,
        decision: UpdateDecision,
    ) -> AppResult<skillhub_core::AppliedSourceUpdate> {
        self.commits
            .lock()
            .unwrap()
            .push((skill_id, preview_id, decision));
        Ok(skillhub_core::AppliedSourceUpdate::new(skill_id, decision))
    }
}

#[test]
fn commit_forwards_to_the_backend_and_checks_first() {
    block_on(async {
        let backend = Arc::new(RecordingSourceBackend::default());
        let service = SourceService::new(backend.clone());
        let skill_id = SkillId::new();
        let check = service.check_update(skill_id).await.unwrap();
        assert_eq!(check.state, SourceState::UpdateAvailableWithLocalChanges);

        let preview = service.prepare_update(skill_id).await.unwrap();
        assert_eq!(preview.candidate_identity, "sha256:candidate");

        let applied = service
            .commit_update(skill_id, preview.preview_id, UpdateDecision::TakeUpstream)
            .await
            .unwrap();
        assert_eq!(applied.skill_id, skill_id);
        assert_eq!(
            backend
                .commits
                .lock()
                .unwrap()
                .as_slice()
                .iter()
                .map(|(_, preview_id, decision)| (preview_id.to_string(), *decision))
                .collect::<Vec<_>>(),
            vec![(preview.preview_id.to_string(), UpdateDecision::TakeUpstream)],
            "TakeUpstream 必须携带预览绑定到达后端"
        );
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
        assert!(backend.commits.lock().unwrap().is_empty());
    });
}

#[test]
fn keep_local_and_cancel_are_non_destructive_decisions() {
    block_on(async {
        let backend = Arc::new(RecordingSourceBackend::default());
        let service = SourceService::new(backend.clone());
        let skill_id = SkillId::new();
        let kept = service
            .commit_update(skill_id, OperationId::new(), UpdateDecision::KeepLocal)
            .await
            .unwrap();
        let cancelled = service
            .commit_update(skill_id, OperationId::new(), UpdateDecision::Cancel)
            .await
            .unwrap();
        assert_eq!(kept.decision, UpdateDecision::KeepLocal);
        assert_eq!(cancelled.decision, UpdateDecision::Cancel);
        assert!(
            backend.commits.lock().unwrap().is_empty(),
            "非破坏性决定不得触碰后端"
        );
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
