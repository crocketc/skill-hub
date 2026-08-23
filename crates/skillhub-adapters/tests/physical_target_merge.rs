use skillhub_adapters::agent::discovery::{DiscoverAgents, DiscoveryRoots};
use skillhub_core::agent::OperatingSystem;
use tempfile::tempdir;

#[test]
fn physical_target_merge_keeps_logical_client_relationships() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();
    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();

    assert_eq!(snapshot.physical_targets.len(), 1);
    let physical = &snapshot.physical_targets[0];
    assert!(physical.logical_target_ids.iter().all(|id| {
        snapshot
            .logical_targets
            .iter()
            .any(|target| target.id == *id)
    }));
    assert!(snapshot
        .instances
        .iter()
        .filter(|instance| instance.available)
        .any(|instance| instance.client_id == "openai.codex-cli"));
}
