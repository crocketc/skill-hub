use std::path::PathBuf;
use std::time::Duration;

use skillhub_adapters::watcher::{WatchCoalescer, WatchHint, WatchHintKind, Watcher};
use skillhub_core::WatchService;

fn event(path: &str) -> WatchHint {
    WatchHint::new(path)
}

#[test]
fn repeated_editor_events_collapse_to_one_skill_hint() {
    let mut coalescer = WatchCoalescer::new(Duration::from_millis(400));
    coalescer.push(event("skills/pdf/SKILL.md"));
    coalescer.push(event("skills/pdf/SKILL.md"));

    assert_eq!(coalescer.flush_after_stable().len(), 1);
}

#[test]
fn changes_outside_active_roots_are_ignored() {
    let mut watcher = Watcher::new([PathBuf::from("/workspace/skills")]);
    watcher.start().unwrap();
    watcher.push(WatchHint::for_root(
        "/workspace/other",
        "/workspace/other/SKILL.md",
    ));
    watcher.push(WatchHint::for_root(
        "/workspace/skills",
        "/workspace/skills/pdf/SKILL.md",
    ));

    let hints = watcher.flush().unwrap();
    assert_eq!(hints.len(), 1);
    assert_eq!(
        hints[0].path(),
        PathBuf::from("/workspace/skills/pdf/SKILL.md")
    );
}

#[test]
fn overflow_resume_and_reconnection_request_compensation_scans() {
    let mut watcher = Watcher::new([PathBuf::from("/workspace/skills")]);
    watcher.start().unwrap();

    watcher.push(WatchHint::overflow("/workspace/skills"));
    watcher.push(WatchHint::app_resumed());
    watcher.push(WatchHint::reconnected("/workspace/skills"));

    assert!(watcher.take_compensation_scan());
    assert!(!watcher.take_compensation_scan());
}

#[test]
fn start_and_stop_are_idempotent_and_stop_discards_pending_hints() {
    let mut watcher = Watcher::new([PathBuf::from("/workspace/skills")]);
    watcher.start().unwrap();
    watcher.start().unwrap();
    watcher.push(event("/workspace/skills/pdf/SKILL.md"));
    watcher.stop().unwrap();
    watcher.stop().unwrap();

    assert!(!watcher.is_running());
    assert!(watcher.flush().unwrap().is_empty());
}

#[test]
fn hints_collapse_by_nearest_declared_skill_target() {
    let mut coalescer = WatchCoalescer::new(Duration::from_millis(400));
    coalescer.push(WatchHint::for_target(
        "/workspace/skills/pdf/SKILL.md",
        "pdf",
    ));
    coalescer.push(WatchHint::for_target(
        "/workspace/skills/pdf/references/example.md",
        "pdf",
    ));

    let hints = coalescer.flush_after_stable();
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].target_id(), Some("pdf"));
}

#[test]
fn ordinary_child_events_collapse_after_skill_marker_is_seen() {
    let mut coalescer = WatchCoalescer::new(Duration::ZERO);
    coalescer.push(event("skills/pdf/SKILL.md"));
    coalescer.push(event("skills/pdf/references/example.md"));
    coalescer.push(event("skills/pdf/references/other.md"));

    assert_eq!(coalescer.flush_after_stable().len(), 1);
}

#[test]
fn injected_scan_roots_merge_child_events_without_a_marker_hint() {
    let mut coalescer = WatchCoalescer::new(Duration::ZERO);
    coalescer.set_recognized_skill_roots([PathBuf::from("skills/pdf")]);
    coalescer.push(event("skills/pdf/references/example.md"));
    coalescer.push(event("skills/pdf/scripts/build.rs"));

    assert_eq!(coalescer.flush_after_stable().len(), 1);
}

#[cfg(windows)]
#[test]
fn windows_path_spelling_variants_share_one_injected_skill_key() {
    let mut coalescer = WatchCoalescer::new(Duration::ZERO);
    coalescer.set_recognized_skill_roots([PathBuf::from(r"C:\Users\X\skills\pdf")]);
    coalescer.push(event(r"c:/users/x/skills/pdf/references/example.md"));
    coalescer.push(event(r"C:\USERS\X\SKILLS\PDF\scripts\build.rs"));

    assert_eq!(coalescer.flush_after_stable().len(), 1);
}

#[test]
fn compensation_hint_is_distinct_from_confirmed_file_hint() {
    let overflow = WatchHint::overflow("/workspace/skills");
    let file = event("/workspace/skills/pdf/SKILL.md");
    assert_eq!(overflow.kind(), WatchHintKind::Overflow);
    assert_eq!(file.kind(), WatchHintKind::Changed);
}

#[test]
fn queued_hint_does_not_count_as_a_confirmed_fact_change() {
    let service = WatchService::new();
    service.set_active_roots([PathBuf::from("/workspace/skills")]);
    service.start().unwrap();
    assert!(service
        .emit_watch_hint(event("/workspace/skills/pdf/SKILL.md"))
        .unwrap());

    assert_eq!(service.confirmed_batches(), 0);
    assert_eq!(service.pending_hints().len(), 1);
}

#[test]
fn root_and_path_mismatch_is_rejected() {
    let mut watcher = Watcher::new([PathBuf::from("/workspace/skills")]);
    watcher.start().unwrap();
    assert!(!watcher.push(WatchHint::for_root(
        "/workspace/skills",
        "/workspace/other/SKILL.md",
    )));
}

#[test]
fn watcher_without_active_roots_does_not_accept_hints() {
    let mut watcher = Watcher::new(std::iter::empty::<PathBuf>());
    watcher.start().unwrap();
    assert!(!watcher.push(event("/workspace/skills/pdf/SKILL.md")));
    assert!(!watcher.on_app_resumed());
}

mod native_backend {
    //! Native backend contract tests. A fake backend and a manual clock drive
    //! coalescing, stop and overflow deterministically; the real notify backend
    //! only gets a bounded platform integration test.

    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use skillhub_adapters::watcher::{
        ManualWatchClock, NativeRelationshipWatcher, NativeWatchBackend, NativeWatchEvent,
        NativeWatchEventKind, NotifyWatchBackend, WatchHintKind,
    };
    use skillhub_core::AppResult;

    #[derive(Default)]
    struct FakeBackendState {
        started_roots: Option<Vec<PathBuf>>,
        stop_calls: usize,
        queue: VecDeque<NativeWatchEvent>,
    }

    #[derive(Clone, Default)]
    struct FakeBackend {
        state: Arc<Mutex<FakeBackendState>>,
    }

    impl FakeBackend {
        fn push(&self, event: NativeWatchEvent) {
            self.state.lock().unwrap().queue.push_back(event);
        }
    }

    impl NativeWatchBackend for FakeBackend {
        fn start(&mut self, roots: &[PathBuf]) -> AppResult<()> {
            self.state.lock().unwrap().started_roots = Some(roots.to_vec());
            Ok(())
        }

        fn stop(&mut self) -> AppResult<()> {
            self.state.lock().unwrap().stop_calls += 1;
            Ok(())
        }

        fn poll(&mut self) -> Vec<NativeWatchEvent> {
            self.state.lock().unwrap().queue.drain(..).collect()
        }
    }

    fn event(kind: NativeWatchEventKind, path: &str) -> NativeWatchEvent {
        NativeWatchEvent {
            kind,
            path: PathBuf::from(path),
        }
    }

    fn watcher(backend: FakeBackend, clock: ManualWatchClock) -> NativeRelationshipWatcher {
        NativeRelationshipWatcher::with_clock(
            [PathBuf::from("/lib")],
            Duration::from_millis(400),
            Box::new(backend),
            Box::new(clock),
        )
    }

    #[test]
    fn native_events_coalesce_into_one_confirmed_hint_after_stable_window() {
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut watcher = watcher(backend.clone(), clock.clone());

        watcher.start().unwrap();
        assert_eq!(
            backend.state.lock().unwrap().started_roots,
            Some(vec![PathBuf::from("/lib")])
        );

        watcher.set_recognized_skill_roots(["/lib/pdf"]);
        backend.push(event(NativeWatchEventKind::Changed, "/lib/pdf/SKILL.md"));
        backend.push(event(
            NativeWatchEventKind::Created,
            "/lib/pdf/references/a.md",
        ));
        backend.push(event(NativeWatchEventKind::Changed, "/elsewhere/x.md"));

        assert!(
            watcher.poll().unwrap().is_empty(),
            "before the stable window no fact change is confirmed"
        );

        clock.advance(400);
        let confirmed = watcher.poll().unwrap();
        assert_eq!(confirmed.len(), 1);
        assert_eq!(
            confirmed[0].path(),
            PathBuf::from("/lib/pdf/references/a.md")
        );
        assert_eq!(confirmed[0].root(), Some(Path::new("/lib")));
        assert_eq!(confirmed[0].kind(), WatchHintKind::Created);
        assert!(watcher.poll().unwrap().is_empty(), "hints drain once");
    }

    #[test]
    fn stop_stops_backend_and_discards_unconfirmed_native_events() {
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut watcher = watcher(backend.clone(), clock.clone());

        watcher.start().unwrap();
        backend.push(event(NativeWatchEventKind::Changed, "/lib/pdf/SKILL.md"));
        assert!(watcher.poll().unwrap().is_empty());

        watcher.stop().unwrap();
        assert_eq!(backend.state.lock().unwrap().stop_calls, 1);
        assert!(!watcher.is_running());

        clock.advance(1_000);
        assert!(watcher.poll().unwrap().is_empty());
        assert!(watcher.flush().unwrap().is_empty());

        backend.push(event(NativeWatchEventKind::Changed, "/lib/pdf/SKILL.md"));
        assert!(
            watcher.poll().unwrap().is_empty(),
            "events after stop are not confirmed"
        );
    }

    #[test]
    fn native_overflow_requests_compensation_scan_without_file_hint() {
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut watcher = watcher(backend.clone(), clock.clone());

        watcher.start().unwrap();
        backend.push(event(NativeWatchEventKind::Overflow, "/lib"));

        assert!(watcher.poll().unwrap().is_empty());
        assert!(watcher.take_compensation_scan());
        assert!(!watcher.take_compensation_scan());

        clock.advance(400);
        assert!(
            watcher.poll().unwrap().is_empty(),
            "overflow never becomes a file hint"
        );
    }

    #[test]
    fn notify_backend_confirms_real_file_changes_within_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let mut watcher = NativeRelationshipWatcher::new(
            [dir.path().to_path_buf()],
            Box::new(NotifyWatchBackend::new()),
        );
        watcher.start().unwrap();

        let marker = dir.path().join("skill.md");
        std::fs::write(&marker, "content").unwrap();

        let deadline = Instant::now() + Duration::from_secs(30);
        let mut confirmed = Vec::new();
        while Instant::now() < deadline {
            confirmed = watcher.poll().unwrap();
            if !confirmed.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(
            confirmed.iter().any(|hint| {
                hint.path() == marker
                    && matches!(
                        hint.kind(),
                        WatchHintKind::Created | WatchHintKind::Changed | WatchHintKind::Renamed
                    )
            }),
            "real backend event should be confirmed: {confirmed:?}"
        );
        watcher.stop().unwrap();
    }
}
