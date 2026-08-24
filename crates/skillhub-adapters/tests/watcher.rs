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
