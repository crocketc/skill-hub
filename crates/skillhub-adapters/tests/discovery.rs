use skillhub_adapters::agent::discovery::{DiscoverAgents, DiscoveryRoots};
use skillhub_core::agent::OperatingSystem;
use tempfile::tempdir;

#[test]
fn discovery_reports_registered_client_and_writable_directory_without_runtime_claims() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();

    let roots = DiscoveryRoots::new(OperatingSystem::Windows, &home);
    let snapshot = DiscoverAgents::builtin().discover(&roots).unwrap();

    let instance = snapshot
        .instances
        .iter()
        .find(|instance| {
            instance.profile_id == "openai" && instance.client_id == "openai.codex-cli"
        })
        .unwrap();
    assert_eq!(
        instance.client_presence,
        skillhub_core::agent::ClientPresence::Unknown
    );
    let target = snapshot
        .logical_targets
        .iter()
        .find(|target| {
            target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills")
        })
        .unwrap();
    assert!(target.exists);
    assert!(target.readable);
    assert!(target.writable);

    let json = serde_json::to_string(&snapshot).unwrap();
    for forbidden in [
        "runtime_version",
        "login_state",
        "trust_state",
        "authorization",
        "usable",
    ] {
        assert!(!json.contains(forbidden), "discovery leaked {forbidden}");
    }
}

#[test]
fn two_clients_pointing_to_same_directory_share_one_physical_target() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    let logical = snapshot
        .logical_targets
        .iter()
        .filter(|target| target.scope == skillhub_core::agent::TargetScope::Global && target.exists)
        .filter(|target| target.profile_id == "openai")
        .filter(|target| {
            target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        logical.len(),
        2,
        "logical targets: {:?}",
        logical
            .iter()
            .map(|target| (&target.profile_id, &target.client_id, &target.path))
            .collect::<Vec<_>>()
    );
    assert_eq!(snapshot.physical_targets.len(), 1);
    assert!(
        snapshot.physical_targets[0]
            .logical_target_ids
            .iter()
            .filter(|id| logical.iter().any(|target| target.id == **id))
            .count()
            >= 2
    );
}

#[test]
fn absent_registered_directories_are_unavailable_without_being_created() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Macos, &home))
        .unwrap();
    assert!(!home.join(".agents/skills").exists());
    assert!(snapshot
        .logical_targets
        .iter()
        .any(|target| !target.exists && !target.available));
    assert!(snapshot
        .instances
        .iter()
        .any(|instance| instance.client_presence == skillhub_core::agent::ClientPresence::Unknown));
}

#[cfg(unix)]
#[test]
fn symlinked_directory_is_merged_by_filesystem_identity() {
    use std::os::unix::fs::symlink;
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    let real = workspace.path().join("real-skills");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    symlink(&real, home.join(".agents")).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Macos, &home))
        .unwrap();
    assert_eq!(snapshot.physical_targets.len(), 1);
    assert!(snapshot.physical_targets[0].logical_target_ids.len() >= 2);
}

#[test]
fn read_only_directory_is_not_reported_as_writable() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    let target = home.join(".agents/skills");
    std::fs::create_dir_all(&target).unwrap();
    let mut permissions = std::fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&target, permissions).unwrap();
    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    let target = snapshot
        .logical_targets
        .iter()
        .find(|target| {
            target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills")
        })
        .unwrap();
    assert!(target.exists && target.readable);
    assert!(!target.writable);
}
