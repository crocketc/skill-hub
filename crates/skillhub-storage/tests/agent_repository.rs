use skillhub_core::agent::{
    ClientInstance, ClientKind, DiscoverySnapshot, LogicalTarget, OperatingSystem, PhysicalTarget,
    TargetScope,
};
use skillhub_storage::Database;

fn snapshot(generation: u64, available: bool) -> DiscoverySnapshot {
    DiscoverySnapshot {
        generation,
        observed_at: generation,
        instances: vec![ClientInstance {
            profile_id: "openai".into(),
            client_id: "openai.codex-cli".into(),
            kind: ClientKind::Cli,
            supported_os: vec![OperatingSystem::Windows],
            available,
        }],
        logical_targets: vec![LogicalTarget {
            id: "target-1".into(),
            profile_id: "openai".into(),
            client_id: "openai.codex-cli".into(),
            scope: TargetScope::Global,
            path: "C:/home/.agents/skills".into(),
            marker: "SKILL.md".into(),
            precedence: skillhub_core::agent::DirectoryPrecedence::Preferred,
            exists: available,
            readable: available,
            writable: available,
            available,
            physical_id: "path:c:/home/.agents/skills".into(),
        }],
        physical_targets: vec![PhysicalTarget {
            id: "path:c:/home/.agents/skills".into(),
            path: "C:/home/.agents/skills".into(),
            exists: available,
            readable: available,
            writable: available,
            logical_target_ids: vec!["target-1".into()],
        }],
    }
}

#[test]
fn discovery_generation_replaces_atomically_and_preserves_disappeared_facts() {
    let database = Database::open_in_memory().unwrap();
    database
        .agent_repository()
        .replace(&snapshot(1, true))
        .unwrap();
    let saved = database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            instances: Vec::new(),
            logical_targets: Vec::new(),
            physical_targets: Vec::new(),
            ..snapshot(2, false)
        })
        .unwrap();
    assert_eq!(saved.generation, 2);
    assert!(saved.instances.iter().any(|instance| !instance.available));
    assert!(saved.logical_targets.iter().any(|target| !target.available));
    assert!(saved.physical_targets.iter().any(|target| !target.exists));
    assert_eq!(database.agent_repository().load().unwrap(), Some(saved));
}
