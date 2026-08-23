use skillhub_core::agent::{
    ClientInstance, ClientKind, DiscoverySnapshot, LogicalTarget, OperatingSystem, PhysicalTarget,
    TargetScope,
};
use skillhub_storage::Database;

fn snapshot(generation: u64, available: bool) -> DiscoverySnapshot {
    DiscoverySnapshot {
        generation: generation.to_string(),
        observed_at: generation.to_string(),
        instances: vec![ClientInstance {
            profile_id: "openai".into(),
            client_id: "openai.codex-cli".into(),
            kind: ClientKind::Cli,
            supported_os: vec![OperatingSystem::Windows],
            client_presence: skillhub_core::agent::ClientPresence::Unknown,
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
    assert_eq!(saved.generation, "2");
    assert!(saved.instances.iter().any(|instance| {
        instance.client_presence == skillhub_core::agent::ClientPresence::Unknown
    }));
    assert!(saved.logical_targets.iter().any(|target| !target.available));
    assert!(saved.physical_targets.iter().any(|target| !target.exists));
    assert_eq!(database.agent_repository().load().unwrap(), Some(saved));
}

#[test]
fn failed_snapshot_replace_keeps_previous_snapshot() {
    let database = Database::open_in_memory().unwrap();
    let original = database
        .agent_repository()
        .replace(&snapshot(1, true))
        .unwrap();
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_agent_snapshot BEFORE UPDATE OF value_json ON settings
             WHEN NEW.key = 'agent_discovery_snapshot'
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();
    assert!(database
        .agent_repository()
        .replace(&snapshot(2, false))
        .is_err());
    assert_eq!(database.agent_repository().load().unwrap(), Some(original));
}
