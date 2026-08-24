use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use skillhub_core::{AppEvent, AppResult, WatchConfirmation, WatchHint, WatchService};

#[derive(Clone, Default)]
struct FixtureScanner {
    revisions: Arc<AtomicUsize>,
    fail_next: Arc<AtomicBool>,
}

#[async_trait]
impl WatchConfirmation for FixtureScanner {
    async fn confirm(&self, _hints: Vec<WatchHint>) -> AppResult<()> {
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(skillhub_core::AppError::new(
                skillhub_core::ErrorCode::InternalError,
                skillhub_core::Severity::Error,
            ));
        }
        self.revisions.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn compensation_scan(&self) -> AppResult<()> {
        self.revisions.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn run(future: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future);
}

#[test]
fn watcher_hint_does_not_change_facts_until_rescan_confirms_it() {
    run(async {
        let scanner = Arc::new(FixtureScanner::default());
        let (events, mut receiver) = tokio::sync::broadcast::channel(4);
        let service = WatchService::with_confirmation(scanner.clone()).with_event_sender(events);
        service.set_active_roots(["/workspace/skills"]);
        service.start().unwrap();
        service
            .emit_watch_hint(WatchHint::new("/workspace/skills/pdf/SKILL.md"))
            .unwrap();
        service
            .emit_watch_hint(WatchHint::new(
                "/workspace/skills/pdf/references/example.md",
            ))
            .unwrap();
        service
            .emit_watch_hint(WatchHint::new("/workspace/skills/pdf/references/other.md"))
            .unwrap();

        assert_eq!(scanner.revisions.load(Ordering::SeqCst), 0);
        assert_eq!(service.pending_hints().len(), 1);
        assert!(receiver.try_recv().is_err());

        service.run_scheduled_confirmation().await.unwrap();

        assert_eq!(scanner.revisions.load(Ordering::SeqCst), 1);
        assert!(matches!(
            receiver.try_recv().unwrap(),
            AppEvent::FactsChanged(_)
        ));
    });
}

#[test]
fn injected_scan_root_merges_child_hints_without_a_marker_event() {
    let service = WatchService::new();
    service.set_active_roots(["/workspace/skills"]);
    service.set_recognized_skill_roots(["/workspace/skills/pdf"]);
    service.start().unwrap();

    service
        .emit_watch_hint(WatchHint::new(
            "/workspace/skills/pdf/references/example.md",
        ))
        .unwrap();
    service
        .emit_watch_hint(WatchHint::new("/workspace/skills/pdf/scripts/build.rs"))
        .unwrap();

    assert_eq!(service.pending_hints().len(), 1);
}

#[test]
fn failed_confirmation_requeues_hints_for_retry() {
    run(async {
        let scanner = Arc::new(FixtureScanner {
            fail_next: Arc::new(AtomicBool::new(true)),
            ..FixtureScanner::default()
        });
        let service = WatchService::with_confirmation(scanner.clone());
        service.set_active_roots(["/workspace/skills"]);
        service.start().unwrap();
        service
            .emit_watch_hint(WatchHint::new("/workspace/skills/pdf/SKILL.md"))
            .unwrap();

        assert!(service.run_scheduled_confirmation().await.is_err());
        assert_eq!(service.pending_hints().len(), 1);
        assert_eq!(scanner.revisions.load(Ordering::SeqCst), 0);

        service.run_scheduled_confirmation().await.unwrap();
        assert_eq!(service.pending_hints().len(), 0);
        assert_eq!(scanner.revisions.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn no_confirmation_scanner_cannot_confirm_or_publish_facts_changed() {
    run(async {
        let (events, mut receiver) = tokio::sync::broadcast::channel(4);
        let service = WatchService::new().with_event_sender(events);
        service.set_active_roots(["/workspace/skills"]);
        service.start().unwrap();
        service
            .emit_watch_hint(WatchHint::new("/workspace/skills/pdf/SKILL.md"))
            .unwrap();

        assert!(service.run_scheduled_confirmation().await.is_err());
        assert_eq!(service.pending_hints().len(), 1);
        assert!(receiver.try_recv().is_err());
    });
}

#[test]
fn root_and_path_mismatch_is_rejected_without_queueing_a_hint() {
    let service = WatchService::new();
    service.set_active_roots(["/workspace/skills"]);
    service.start().unwrap();

    let result = service.emit_watch_hint(WatchHint::for_root(
        "/workspace/skills",
        "/workspace/other/SKILL.md",
    ));

    assert!(result.is_err());
    assert!(service.pending_hints().is_empty());
}

#[test]
fn empty_active_roots_are_safe_and_do_not_mean_watch_everything() {
    let service = WatchService::new();
    service.start().unwrap();

    assert!(!service
        .emit_watch_hint(WatchHint::new("/workspace/skills/SKILL.md"))
        .unwrap());
    assert!(service.pending_hints().is_empty());
}
