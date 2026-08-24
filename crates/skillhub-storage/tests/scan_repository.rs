use skillhub_core::scan::{DiscoveredSkill, ScanGeneration, ScanIssue, ScanResult};
use skillhub_storage::Database;

fn snapshot() -> ScanResult {
    ScanResult {
        generation: ScanGeneration {
            generation: 1,
            observed_at: 10,
        },
        roots: vec!["C:/registered".into()],
        discovered: vec![DiscoveredSkill {
            root: "C:/registered".into(),
            relative_path: "example".into(),
            path: "C:/registered/example".into(),
            marker: "SKILL.md".into(),
            marker_size: 12,
            marker_modified_at: 10,
            size: 12,
            latest_modified_at: 10,
            fingerprint: "sha256:abc".into(),
            metadata_fingerprint: "sha256:def".into(),
        }],
        visited_paths: vec!["C:/registered".into()],
        reparsed_count: 1,
        unchanged_count: 0,
        errors: Vec::<ScanIssue>::new(),
    }
}

#[test]
fn scan_repository_round_trips_last_confirmed_snapshot() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.scan_repository();
    assert!(repository.load().unwrap().is_none());

    let saved = repository.replace(&snapshot()).unwrap();
    assert_eq!(repository.load().unwrap(), Some(saved));
}
