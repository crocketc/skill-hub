use skillhub_adapters::scanner::ScanService;
use skillhub_core::agent::{DirectoryPrecedence, LogicalTarget, TargetScope};
use skillhub_core::api::{RescanSkill, RunInitializationScan, ScanTargets};
use skillhub_core::scan::ScanScope;
use tempfile::tempdir;

fn discovery_target(scope: &ScanScope) -> LogicalTarget {
    let id = scope.id.clone();
    LogicalTarget {
        id: id.clone(),
        profile_id: "test".into(),
        client_id: "test".into(),
        scope: TargetScope::Global,
        path: scope.root.clone(),
        marker: scope.marker.clone(),
        precedence: DirectoryPrecedence::Preferred,
        exists: true,
        readable: true,
        writable: true,
        available: true,
        physical_id: id.clone(),
    }
}

fn register_scope(service: &mut ScanService, scope: ScanScope) {
    let target = discovery_target(&scope);
    service.register_discovery_target(&target).unwrap();
}

fn scan_scope(service: &mut ScanService, scope: ScanScope) -> skillhub_core::ScanResult {
    let id = scope.id.clone();
    register_scope(service, scope);
    service.scan_registered(&[id]).unwrap()
}

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
    let result = scan_scope(&mut service, ScanScope::new(registered.clone()));

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

    let mut service = ScanService::new();
    let scope = ScanScope::new(&root);
    let first = scan_scope(&mut service, scope.clone());
    let second = scan_scope(&mut service, scope);

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

    let mut service = ScanService::new();
    let scope = ScanScope::new(&root);
    let first = scan_scope(&mut service, scope.clone());
    std::fs::write(root.join("one/SKILL.md"), "name: changed\n").unwrap();
    let second = scan_scope(&mut service, scope);

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
fn same_length_rewrite_gets_a_new_metadata_fingerprint() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();
    let mut service = ScanService::new();
    let scope = ScanScope::new(&root);
    let first = scan_scope(&mut service, scope.clone());
    std::fs::write(root.join("one/SKILL.md"), "name: two\n").unwrap();
    let second = scan_scope(&mut service, scope);

    assert_eq!(first.discovered[0].size, second.discovered[0].size);
    assert_ne!(
        first.discovered[0].metadata_fingerprint,
        second.discovered[0].metadata_fingerprint
    );
    assert_ne!(
        first.discovered[0].fingerprint,
        second.discovered[0].fingerprint
    );
}

#[test]
fn persisted_snapshot_can_seed_incremental_scan_in_a_new_service() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();
    let scope = ScanScope::new(&root);

    let mut first_service = ScanService::new();
    let first = scan_scope(&mut first_service, scope.clone());
    let mut resumed_service = ScanService::new();
    let id = scope.id.clone();
    register_scope(&mut resumed_service, scope);
    let resumed = resumed_service
        .scan_registered_with_previous(&[id], &first)
        .unwrap();

    assert_eq!(resumed.reparsed_count, 0);
    assert_eq!(resumed.unchanged_count, 1);
    assert_eq!(
        resumed.discovered[0].fingerprint,
        first.discovered[0].fingerprint
    );
}

#[test]
fn invalid_scope_is_reported_and_other_registered_scope_still_scans() {
    let workspace = tempdir().unwrap();
    let valid = workspace.path().join("valid");
    std::fs::create_dir_all(valid.join("one")).unwrap();
    std::fs::write(valid.join("one/SKILL.md"), "name: one\n").unwrap();
    let mut service = ScanService::new();
    let missing = ScanScope::registered("missing", workspace.path().join("missing"));
    assert!(service
        .register_discovery_target(&discovery_target(&missing))
        .is_err());
    let result = scan_scope(&mut service, ScanScope::registered("valid", &valid));

    assert_eq!(result.discovered.len(), 1);
    assert!(result.errors.is_empty());
}

#[test]
fn rescan_skill_only_visits_the_requested_directory() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("one/nested")).unwrap();
    std::fs::create_dir_all(root.join("two")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();
    std::fs::write(root.join("one/nested/SKILL.md"), "name: nested\n").unwrap();
    std::fs::write(root.join("two/SKILL.md"), "name: two\n").unwrap();
    let scope = ScanScope::registered("skills", &root);
    let mut service = ScanService::new();

    register_scope(&mut service, scope);
    let result = service
        .rescan_registered_skill("skills", root.join("one"))
        .unwrap();

    assert_eq!(result.discovered.len(), 1);
    assert!(result.discovered[0].path.ends_with("one"));
    assert_eq!(result.visited_paths.len(), 1);
    assert!(!result
        .visited_paths
        .iter()
        .any(|path| path.ends_with("two")));
}

#[test]
fn unregistered_absolute_paths_cannot_be_submitted_as_scan_commands() {
    assert!(
        serde_json::from_value::<RunInitializationScan>(serde_json::json!({
            "scopes": [{"root": "C:/outside", "marker": "SKILL.md"}]
        }))
        .is_err()
    );
    assert!(serde_json::from_value::<ScanTargets>(serde_json::json!({
        "scopes": [{"root": "C:/outside", "marker": "SKILL.md"}]
    }))
    .is_err());
    assert!(serde_json::from_value::<RescanSkill>(serde_json::json!({
        "scope": {"root": "C:/outside", "marker": "SKILL.md"}, "path": "C:/outside/a"
    }))
    .is_err());
}

#[test]
fn scanner_requires_a_registered_scope_id_before_scanning() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();
    let mut service = ScanService::new();

    assert!(service.scan_registered(&["missing".into()]).is_err());
    register_scope(&mut service, ScanScope::registered("known", &root));
    let result = service.scan_registered(&["known".into()]).unwrap();
    assert_eq!(result.discovered.len(), 1);
}

#[test]
fn profile_marker_is_case_aware_and_not_user_selectable() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("wrong")).unwrap();
    std::fs::write(root.join("wrong/skill.md"), "wrong\n").unwrap();
    let mut service = ScanService::new();

    let target = discovery_target(&ScanScope::new(&root).with_marker("skill.md"));
    assert!(service.register_discovery_target(&target).is_err());
}

#[test]
fn unavailable_discovery_target_cannot_authorize_a_scan_root() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("outside");
    std::fs::create_dir_all(&root).unwrap();
    let mut target = discovery_target(&ScanScope::new(&root));
    target.available = false;
    let mut service = ScanService::new();

    assert!(service.register_discovery_target(&target).is_err());
    assert!(service.scan_registered(&[target.id]).is_err());
}

#[test]
fn three_hundred_skill_fixture_scans_and_reuses_all_unchanged_entries() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    for index in 0..300 {
        let directory = root.join(format!("skill-{index:03}"));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            format!("name: skill-{index:03}\n"),
        )
        .unwrap();
    }
    let scope = ScanScope::new(&root);
    let mut service = ScanService::new();
    let first = scan_scope(&mut service, scope.clone());
    let second = scan_scope(&mut service, scope);

    assert_eq!(first.discovered.len(), 300);
    assert_eq!(second.discovered.len(), 300);
    assert_eq!(second.reparsed_count, 0);
    assert_eq!(second.unchanged_count, 300);
}

#[cfg(unix)]
#[test]
fn symlink_loop_is_not_followed() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let root = workspace.path().join("skills");
    std::fs::create_dir_all(root.join("one")).unwrap();
    std::fs::write(root.join("one/SKILL.md"), "name: one\n").unwrap();
    symlink(&root, root.join("one/loop")).unwrap();
    let mut service = ScanService::new();

    let result = scan_scope(&mut service, ScanScope::new(&root));

    assert_eq!(result.discovered.len(), 1);
    assert!(result
        .visited_paths
        .iter()
        .all(|path| !path.contains("loop/loop")));
}
