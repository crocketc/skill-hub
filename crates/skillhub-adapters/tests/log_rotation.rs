//! Development-stage local log storage discipline: bounded files, single
//! previous generation, and everything inside the configured directory
//! (never inside the managed skill library area).

use skillhub_adapters::logging::{LocalLogConfig, LogEvent, LogLevel};
use std::collections::BTreeMap;
use std::path::Path;

fn event(code: &str) -> LogEvent {
    LogEvent {
        event_code: code.to_owned(),
        operation_id: Some("op-1".into()),
        phase: Some("planned".into()),
        duration_ms: None,
        counts: BTreeMap::new(),
        params: BTreeMap::new(),
        skill_body: None,
        level: LogLevel::Info,
    }
}

fn log_path(directory: &Path) -> std::path::PathBuf {
    directory.join("skillhub.log")
}

#[test]
fn events_land_inside_the_configured_directory() {
    let workspace = tempfile::tempdir().expect("tempdir");
    let directory = workspace.path().join("logs");
    let config = LocalLogConfig::new(directory.clone(), 64 * 1024);

    config
        .write_event(&event("desktop.startup"))
        .expect("write startup event");

    let path = log_path(&directory);
    assert!(
        path.is_file(),
        "skillhub.log must exist inside the log directory"
    );
    let text = std::fs::read_to_string(&path).expect("read log file");
    assert!(
        text.contains("\"desktop.startup\""),
        "log line must carry the event code: {text}"
    );
}

#[test]
fn events_below_the_minimal_production_level_are_skipped() {
    let workspace = tempfile::tempdir().expect("tempdir");
    let directory = workspace.path().join("logs");
    // Production default: the minimal level keeps key-path Info events and
    // every Error, while Debug detail stays out of the file.
    let config = LocalLogConfig::new(directory.clone(), 64 * 1024);

    let mut debug_event = event("migration.recovery.advance");
    debug_event.level = LogLevel::Debug;
    config
        .write_event(&debug_event)
        .expect("debug events are accepted and filtered");

    assert!(
        !log_path(&directory).exists(),
        "Debug detail must not reach the file under the minimal production level"
    );

    config
        .write_event(&event("journal.record"))
        .expect("info event");
    let mut error_event = event("storage.error");
    error_event.level = LogLevel::Error;
    config.write_event(&error_event).expect("error event");

    let text = std::fs::read_to_string(log_path(&directory)).expect("read log file");
    assert_eq!(
        text.lines().count(),
        2,
        "Info and Error pass the minimal level: {text}"
    );
    assert!(
        text.contains("\"level\":\"error\""),
        "error lines are labelled so triage can grep them: {text}"
    );
}

#[test]
fn development_can_raise_the_detail_level() {
    let workspace = tempfile::tempdir().expect("tempdir");
    let directory = workspace.path().join("logs");
    let config = LocalLogConfig::new(directory.clone(), 64 * 1024).with_min_level(LogLevel::Debug);

    let mut debug_event = event("migration.recovery.advance");
    debug_event.level = LogLevel::Debug;
    config.write_event(&debug_event).expect("write debug event");

    let text = std::fs::read_to_string(log_path(&directory)).expect("read log file");
    assert!(
        text.contains("\"level\":\"debug\""),
        "raised level keeps development detail: {text}"
    );
}

#[test]
fn oversized_log_rotates_to_exactly_one_bounded_previous_generation() {
    let workspace = tempfile::tempdir().expect("tempdir");
    let directory = workspace.path().join("logs");
    let max_bytes: u64 = 256;
    let config = LocalLogConfig::new(directory.clone(), max_bytes);

    for index in 0..60 {
        config
            .write_event(&event(&format!("journal.record.{index}")))
            .expect("write event");
    }

    let current = log_path(&directory);
    let previous = directory.join("skillhub.log.1");
    assert!(current.is_file(), "the active log file must keep its name");
    assert!(
        previous.is_file(),
        "crossing max_bytes must rotate skillhub.log into skillhub.log.1"
    );
    assert!(
        !directory.join("skillhub.log.2").exists(),
        "only one previous generation may exist; older bytes are dropped"
    );

    // The rotation check runs before each append, so a generation can hold at
    // most max_bytes-1 bytes plus one event; total stays bounded near 2x.
    let event_overhead: u64 = 512;
    let current_len = std::fs::metadata(&current).expect("current metadata").len();
    let previous_len = std::fs::metadata(&previous)
        .expect("previous metadata")
        .len();
    assert!(
        current_len <= max_bytes + event_overhead,
        "active file exceeded the bound: {current_len} bytes"
    );
    assert!(
        previous_len <= max_bytes + event_overhead,
        "rotated file exceeded the bound: {previous_len} bytes"
    );
    assert!(
        current_len + previous_len <= 2 * (max_bytes + event_overhead),
        "total log footprint must stay bounded near 2x max_bytes"
    );

    // Rotation keeps working across generations: the previous file always
    // holds older lines than the active one.
    let previous_text = std::fs::read_to_string(&previous).expect("read previous");
    let current_text = std::fs::read_to_string(&current).expect("read current");
    let previous_first = previous_text.lines().next().expect("previous line");
    let current_first = current_text.lines().next().expect("current line");
    assert_ne!(
        previous_first, current_first,
        "rotation must move older lines into the previous generation"
    );
}
