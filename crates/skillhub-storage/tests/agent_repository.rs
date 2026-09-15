use skillhub_core::agent::{
    ClientInstance, ClientKind, DiscoverySnapshot, LogicalTarget, OperatingSystem, PhysicalTarget,
    TargetScope,
};
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, ConflictMemberFact, DeploymentRelationFact, DirectoryNodeFact, DirectoryRole,
    FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, OwnershipState, RelationshipType,
};
use skillhub_core::SkillId;
use skillhub_storage::Database;

fn snapshot(generation: u64, available: bool) -> DiscoverySnapshot {
    DiscoverySnapshot {
        generation: generation.to_string(),
        observed_at: generation.to_string(),
        instances: vec![ClientInstance {
            profile_id: "openai".into(),
            client_id: "openai.codex-cli".into(),
            kind: ClientKind::Cli,
            display_name: "Fixture".into(),
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
            shared_reference: false,
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
            case_behavior: "case_insensitive_normalization".into(),
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

#[test]
fn shared_directory_supports_multiple_capabilities_and_relationship_queries() {
    let database = Database::open_in_memory().unwrap();
    let node = DirectoryNodeFact {
        node_id: "directory-shared".into(),
        path: "C:/Users/demo/.agents/skills".into(),
        path_key: "c:/users/demo/.agents/skills".into(),
        role: DirectoryRole::SharedDirectory,
        profile_id: None,
        agent_client_id: None,
        exists: true,
        observed_at: 1_700_000_000,
        scan_source: Some("discovery".into()),
    };
    database.directory_repository().upsert_node(&node).unwrap();
    database
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: "directory-trae".into(),
            path: "C:/Users/demo/.trae/skills".into(),
            path_key: "c:/users/demo/.trae/skills".into(),
            role: DirectoryRole::AgentNative,
            profile_id: Some("trae".into()),
            agent_client_id: Some("trae.code".into()),
            exists: true,
            observed_at: 1_700_000_001,
            scan_source: None,
        })
        .unwrap();

    for agent in ["trae.code", "claude.code"] {
        database
            .relationship_repository()
            .upsert_capability(&AgentDirectoryCapabilityFact {
                agent_client_id: agent.into(),
                directory_node_id: node.node_id.clone(),
                recognition: skillhub_core::relationship::DirectoryRecognition::Supported,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                evidence_reference: Some("official-doc".into()),
                researched_at: Some("2026-09-15".into()),
                applicable_platforms: vec!["windows".into(), "macos".into()],
            })
            .unwrap();
    }
    assert_eq!(
        database
            .relationship_repository()
            .list_capabilities()
            .unwrap()
            .len(),
        2
    );

    let skill = SkillId::new();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Shared', 'shared', 'user_created', 0, 0)",
            [skill.to_string()],
        )
        .unwrap();
    database
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: "relation-shared".into(),
            skill_id: Some(skill),
            agent_client_id: "trae.code".into(),
            path: "C:/Users/demo/.agents/skills/shared".into(),
            path_key: "c:/users/demo/.agents/skills/shared".into(),
            directory_node_id: Some(node.node_id.clone()),
            relationship: RelationshipType::SharedDirectoryRead,
            file_representation: FileRepresentation::Directory,
            ownership: OwnershipState::SharedReference,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: "sha256:shared".into(),
            origin: ObservedOrigin::Scan,
            match_state: ObservedMatchState::ContentVerified,
            active: true,
            observed_at: 1_700_000_002,
            released_at: None,
        })
        .unwrap();
    assert_eq!(
        database
            .relationship_repository()
            .list_relations()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        database
            .relationship_repository()
            .list_relation_impact(&skill.to_string())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn conflict_decisions_and_governance_tasks_round_trip_through_status_changes() {
    let database = Database::open_in_memory().unwrap();
    database
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: "directory-shared".into(),
            path: "C:/Users/demo/.agents/skills".into(),
            path_key: "c:/users/demo/.agents/skills".into(),
            role: DirectoryRole::SharedDirectory,
            profile_id: None,
            agent_client_id: None,
            exists: true,
            observed_at: 1_700_000_000,
            scan_source: None,
        })
        .unwrap();
    let skill = SkillId::new();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Conflict', 'conflict', 'user_created', 0, 0)",
            [skill.to_string()],
        )
        .unwrap();
    let case = ConflictCaseFact {
        conflict_id: "conflict-1".into(),
        kind: ConflictKind::SameNameDifferentContent,
        classification: ConflictClassification::Uncertain,
        member_skill_ids: vec![skill],
        members: vec![ConflictMemberFact {
            skill_id: Some(skill),
            version_id: None,
            provenance_id: None,
            directory_node_id: Some("directory-shared".into()),
            path: Some("C:/Users/demo/.agents/skills/conflict".into()),
            fingerprint: Some("sha256:one".into()),
        }],
        evidence: ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: None,
            sufficient_identity_evidence: false,
        },
        user_decision: None,
        decided_at: None,
    };
    database.conflict_repository().create_case(&case).unwrap();
    database
        .conflict_repository()
        .record_decision("conflict-1", ConflictClassification::DistinctSkill, 42)
        .unwrap();
    let stored = database.conflict_repository().list_cases().unwrap();
    assert_eq!(
        stored[0].user_decision,
        Some(ConflictClassification::DistinctSkill)
    );
    assert_eq!(stored[0].decided_at, Some(42));

    let task = GovernanceTaskFact {
        task_id: "task-1".into(),
        kind: GovernanceTaskKind::ConfirmSharedDirectoryImpact,
        subject_id: "conflict-1".into(),
        detail: "确认共享目录影响".into(),
        resolved: false,
        created_at: 50,
        resolved_at: None,
    };
    database.governance_task_repository().create(&task).unwrap();
    assert_eq!(
        database
            .governance_task_repository()
            .list_pending()
            .unwrap()
            .len(),
        1
    );
    database
        .governance_task_repository()
        .resolve("task-1", 60)
        .unwrap();
    assert!(database
        .governance_task_repository()
        .list_pending()
        .unwrap()
        .is_empty());
}
