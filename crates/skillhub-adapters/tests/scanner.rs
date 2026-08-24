use skillhub_adapters::scanner::ScanService;
use skillhub_core::scan::ScanScope;
use tempfile::tempdir;

#[test]
fn scanner_recognizes_only_the_profile_marker_inside_registered_roots() {
    let workspace = tempdir().unwrap();
    let registered = workspace.path().join("registered");
    let unrelated = workspace.path().join("Documents/private");
    std::fs::create_dir_all(registered.join("example/nested")).unwrap();
    std::fs::create_dir_all(registered.join("wrong-case")).unwrap();
    std::fs::create_dir_all(&unrelated).unwrap();
    std::fs::write(registered.join("example/SKILL.md"), "name: example\n").unwrap();
    std::fs::write(registered.join("example/nested/readme.md"), "nested\n").unwrap();
    std::fs::write(registered.join("wrong-case/skill.md"), "not a marker\n").unwrap();
    std::fs::write(unrelated.join("SKILL.md"), "must not be visited\n").unwrap();

    let mut service = ScanService::new();
    let result = service.scan([ScanScope::new(registered.clone())]).unwrap();

    assert_eq!(result.discovered.len(), 1);
    let discovered = &result.discovered[0];
    assert_eq!(discovered.marker, "SKILL.md");
    assert_eq!(discovered.relative_path, "example");
    assert!(discovered
        .path
        .replace('\\', "/")
        .ends_with("registered/example"));
    assert!(result
        .visited_paths
        .iter()
        .all(|path| !path.ends_with("Documents/private")));
    assert!(result
        .discovered
        .iter()
        .all(|skill| !skill.path.contains("wrong-case")));
}

#[test]
fn second_scan_reuses_unchanged_skill_fingerprint() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();

    let scope = ScanScope::new(&root);
    let mut service = ScanService::new();
    let first = service.scan([scope.clone()]).unwrap();
    let second = service.scan([scope]).unwrap();

    assert_eq!(first.discovered.len(), 1);
    assert_eq!(first.reparsed_count, 1);
    assert_eq!(second.discovered.len(), 1);
    assert_eq!(second.reparsed_count, 0);
    assert_eq!(second.unchanged_count, 1);
    assert_eq!(
        first.discovered[0].fingerprint,
        second.discovered[0].fingerprint
    );
}

#[test]
fn changed_skill_is_rehashed_without_scanning_a_sibling_root() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    let sibling = workspace.path().join("unregistered");
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::create_dir_all(sibling.join("outside")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();
    std::fs::write(sibling.join("outside/SKILL.md"), "outside\n").unwrap();

    let scope = ScanScope::new(&root);
    let mut service = ScanService::new();
    let first = service.scan([scope.clone()]).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: changed\n").unwrap();
    let second = service.scan([scope]).unwrap();

    assert_eq!(second.discovered.len(), 1);
    assert_eq!(second.reparsed_count, 1);
    assert_eq!(second.unchanged_count, 0);
    assert_ne!(
        first.discovered[0].fingerprint,
        second.discovered[0].fingerprint
    );
    assert!(second
        .visited_paths
        .iter()
        .all(|path| !path.contains("unregistered")));
}

#[test]
fn persisted_snapshot_can_seed_incremental_scan_in_a_new_service() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();
    let scope = ScanScope::new(&root);

    let mut first_service = ScanService::new();
    let first = first_service.scan([scope.clone()]).unwrap();
    let mut resumed_service = ScanService::new();
    let resumed = resumed_service.scan_with_previous([scope], &first).unwrap();

    assert_eq!(resumed.reparsed_count, 0);
    assert_eq!(resumed.unchanged_count, 1);
    assert_eq!(
        resumed.discovered[0].fingerprint,
        first.discovered[0].fingerprint
    );
}
