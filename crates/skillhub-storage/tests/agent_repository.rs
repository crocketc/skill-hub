use skillhub_core::agent::{
    ClientInstance, ClientKind, DiscoverySnapshot, LogicalTarget, OperatingSystem, PhysicalTarget,
    TargetScope,
};
use skillhub_core::deployment::{
    DeploymentMode, DeploymentRecord, DeploymentState, ObservedMatchState, ObservedOrigin,
    ObservedRowAction,
};
use skillhub_core::import::{CandidateOwnership, ImportProvenance};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, ConflictMemberFact, DeploymentRelationFact, DirectoryNodeFact, DirectoryRole,
    FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, OwnershipState, RelationshipType,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::SkillId;
use skillhub_core::{DeploymentId, VersionId};
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
    let impact = database
        .relationship_repository()
        .list_relation_impact(&skill.to_string())
        .unwrap();
    assert_eq!(impact.deployments.len(), 1);
    assert_eq!(impact.source_relations.len(), 0);
    assert_eq!(impact.directory_nodes.len(), 1);
    assert_eq!(impact.directory_capabilities.len(), 2);
}

#[test]
fn managed_deployments_keep_distinct_runtime_entry_paths_under_one_target() {
    let database = Database::open_in_memory().unwrap();
    let first_version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000001")
            .unwrap();
    let second_version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000002")
            .unwrap();
    let first_skill = SkillId::new();
    let second_skill = SkillId::new();
    for (skill, version) in [
        (first_skill, &first_version),
        (second_skill, &second_version),
    ] {
        database
            .connection_for_test()
            .execute(
                "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Skill', 'skill', 'user_created', 0, 0)",
                [skill.to_string()],
            )
            .unwrap();
        database
            .connection_for_test()
            .execute(
                "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, ?3, '{}', 0)",
                rusqlite::params![version.to_string(), skill.to_string(), format!("sha256:{skill}")],
            )
            .unwrap();
    }
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('shared-target', 'shared.agent', 'global', 'C:/agents/skills', 0)",
            [],
        )
        .unwrap();

    for (skill, version_id, runtime_name) in [
        (first_skill, &first_version, "alpha"),
        (second_skill, &second_version, "beta"),
    ] {
        database
            .deployment_repository()
            .insert_sync(&DeploymentRecord {
                id: DeploymentId::new(),
                skill_id: skill,
                version_id: version_id.clone(),
                target_id: "shared-target".into(),
                state: DeploymentState::Deployed,
                mode: DeploymentMode::ManagedCopy,
                managed: true,
                runtime_name: runtime_name.into(),
                expected_hash: format!("sha256:{runtime_name}"),
                observed_hash: None,
            })
            .unwrap();
    }

    let relations = database.relationship_repository().list_relations().unwrap();
    assert_eq!(relations.len(), 2);
    let expected_alpha = std::path::Path::new("C:/agents/skills")
        .join("alpha")
        .to_string_lossy()
        .into_owned();
    let expected_beta = std::path::Path::new("C:/agents/skills")
        .join("beta")
        .to_string_lossy()
        .into_owned();
    assert!(
        relations
            .iter()
            .any(|relation| relation.path == expected_alpha),
        "actual={relations:?}, expected={expected_alpha}"
    );
    assert!(
        relations
            .iter()
            .any(|relation| relation.path == expected_beta),
        "actual={relations:?}, expected={expected_beta}"
    );
}

#[test]
fn managed_relation_remains_authoritative_when_observed_reuses_its_path() {
    let database = Database::open_in_memory().unwrap();
    let managed_skill = SkillId::new();
    let observed_skill = SkillId::new();
    insert_skill_for_relationship_test(&database, managed_skill);
    insert_skill_for_relationship_test(&database, observed_skill);
    let version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000004")
            .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'sha256:managed', '{}', 0)",
            rusqlite::params![version.to_string(), managed_skill.to_string()],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('managed-target', 'agent', 'global', 'C:\\agents\\skills', 0)",
            [],
        )
        .unwrap();
    let deployment = DeploymentRecord {
        id: DeploymentId::new(),
        skill_id: managed_skill,
        version_id: version,
        target_id: "managed-target".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "demo".into(),
        expected_hash: "sha256:managed".into(),
        observed_hash: None,
    };
    database
        .deployment_repository()
        .insert_sync(&deployment)
        .unwrap();

    let path = r"C:\agents\skills\demo";
    database
        .provenance_repository()
        .apply_observed_row_action(
            "agent",
            path,
            &ObservedRowAction::EstablishVerified {
                skill_id: observed_skill,
                fingerprint: "sha256:observed".into(),
            },
            ObservedOrigin::Scan,
            200,
        )
        .unwrap();

    let relations = database.relationship_repository().list_relations().unwrap();
    assert_eq!(relations.len(), 1);
    assert_eq!(
        relations[0].relation_id,
        format!("managed:{}", deployment.id)
    );
    assert_eq!(relations[0].skill_id, Some(managed_skill));
    assert_eq!(relations[0].ownership, OwnershipState::SkillhubManaged);
    assert_eq!(relations[0].relationship, RelationshipType::ManagedCopy);

    for action in [
        ObservedRowAction::MarkUnreliable {
            match_state: ObservedMatchState::Diverged,
            fingerprint: "sha256:changed".into(),
        },
        ObservedRowAction::Release,
    ] {
        database
            .provenance_repository()
            .apply_observed_row_action("agent", path, &action, ObservedOrigin::Scan, 201)
            .unwrap();
    }
    let relation = &database.relationship_repository().list_relations().unwrap()[0];
    assert_eq!(relation.relation_id, format!("managed:{}", deployment.id));
    assert_eq!(relation.skill_id, Some(managed_skill));
    assert_eq!(relation.ownership, OwnershipState::SkillhubManaged);
    assert_eq!(relation.relationship, RelationshipType::ManagedCopy);
    assert!(relation.active);

    database
        .deployment_repository()
        .mark_removed_sync(deployment.id)
        .unwrap();
    let relation = &database.relationship_repository().list_relations().unwrap()[0];
    assert_eq!(relation.relation_id, format!("managed:{}", deployment.id));
    assert!(!relation.active);
}

#[test]
fn reconcile_updates_normalized_hash_state_and_timestamp() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill_for_relationship_test(&database, skill);
    let version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000005")
            .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'sha256:before', '{}', 0)",
            rusqlite::params![version.to_string(), skill.to_string()],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('reconcile-target', 'agent', 'global', '/agents/skills', 0)",
            [],
        )
        .unwrap();
    let deployment = DeploymentRecord {
        id: DeploymentId::new(),
        skill_id: skill,
        version_id: version.clone(),
        target_id: "reconcile-target".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "demo".into(),
        expected_hash: "sha256:before".into(),
        observed_hash: None,
    };
    database
        .deployment_repository()
        .insert_sync(&deployment)
        .unwrap();

    database
        .deployment_repository()
        .update_reconcile_facts_sync(
            deployment.id,
            &version,
            "sha256:before",
            Some("sha256:external"),
        )
        .unwrap();
    let updated = database.deployment_repository().list_all().unwrap();
    let relation = &database.relationship_repository().list_relations().unwrap()[0];
    let updated_at: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT updated_at FROM deployments WHERE id=?1",
            [deployment.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(updated[0].observed_hash.as_deref(), Some("sha256:external"));
    assert_eq!(relation.content_fingerprint, "sha256:external");
    assert_eq!(relation.match_state, ObservedMatchState::Diverged);
    assert_eq!(relation.observed_at, updated_at);
    assert!(relation.active);

    database
        .deployment_repository()
        .update_reconcile_facts_sync(
            deployment.id,
            &version,
            "sha256:collected",
            Some("sha256:collected"),
        )
        .unwrap();
    let relation = &database.relationship_repository().list_relations().unwrap()[0];
    assert_eq!(relation.content_fingerprint, "sha256:collected");
    assert_eq!(relation.match_state, ObservedMatchState::ContentVerified);
}

#[test]
fn normalized_source_and_observed_relations_choose_the_longest_directory_parent() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill_for_relationship_test(&database, skill);
    for (node_id, path) in [
        ("root-node", "/agents/skills"),
        ("nested-node", "/agents/skills/team"),
    ] {
        database
            .directory_repository()
            .upsert_node(&DirectoryNodeFact {
                node_id: node_id.into(),
                path: path.into(),
                path_key: String::new(),
                role: DirectoryRole::AgentNative,
                profile_id: None,
                agent_client_id: Some("agent".into()),
                exists: true,
                observed_at: 1,
                scan_source: Some("test".into()),
            })
            .unwrap();
    }
    let path = "/agents/skills/team/demo";
    database
        .relationship_repository()
        .upsert_source_relation(&skillhub_core::relationship::SourceRelationFact {
            provenance_id: "source-longest-parent".into(),
            skill_id: skill,
            directory_node_id: None,
            agent_client_id: Some("agent".into()),
            source_path: path.into(),
            source_path_key: String::new(),
            relationship: RelationshipType::ImportCopy,
            file_representation: FileRepresentation::Directory,
            ownership: OwnershipState::ObservedUnmanaged,
            link_target_path: None,
            link_target_directory_id: None,
            content_fingerprint: "sha256:source".into(),
            source: SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(path)),
            imported_at: 1,
        })
        .unwrap();
    database
        .provenance_repository()
        .apply_observed_row_action(
            "agent",
            path,
            &ObservedRowAction::EstablishVerified {
                skill_id: skill,
                fingerprint: "sha256:observed".into(),
            },
            ObservedOrigin::Scan,
            2,
        )
        .unwrap();

    let source = &database
        .relationship_repository()
        .list_source_relations()
        .unwrap()[0];
    assert_eq!(source.directory_node_id.as_deref(), Some("nested-node"));
    let observed = &database.relationship_repository().list_relations().unwrap()[0];
    assert_eq!(observed.directory_node_id.as_deref(), Some("nested-node"));
}

#[test]
fn managed_runtime_entry_path_preserves_windows_separator_style() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill_for_relationship_test(&database, skill);
    let version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000006")
            .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'sha256:windows', '{}', 0)",
            rusqlite::params![version.to_string(), skill.to_string()],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('windows-target', 'agent', 'global', 'C:\\Users\\demo\\.agents\\skills', 0)",
            [],
        )
        .unwrap();
    database
        .deployment_repository()
        .insert_sync(&DeploymentRecord {
            id: DeploymentId::new(),
            skill_id: skill,
            version_id: version,
            target_id: "windows-target".into(),
            state: DeploymentState::Deployed,
            mode: DeploymentMode::ManagedCopy,
            managed: true,
            runtime_name: "demo".into(),
            expected_hash: "sha256:windows".into(),
            observed_hash: None,
        })
        .unwrap();

    let relation = &database.relationship_repository().list_relations().unwrap()[0];
    assert_eq!(relation.path, r"C:\Users\demo\.agents\skills\demo");
    assert_eq!(
        relation.path_key,
        skillhub_core::deployment::observed_path_key(&relation.path)
    );
}

#[test]
fn deployment_relation_upsert_replaces_relation_id_and_removal_hits_the_new_id() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000002")
            .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Skill', 'skill', 'user_created', 0, 0)",
            [skill.to_string()],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'sha256:content', '{}', 0)",
            rusqlite::params![version.to_string(), skill.to_string()],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('target', 'agent', 'global', '/agents/skills', 0)",
            [],
        )
        .unwrap();

    let deployment = DeploymentRecord {
        id: DeploymentId::new(),
        skill_id: skill,
        version_id: version,
        target_id: "target".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "skill".into(),
        expected_hash: "sha256:content".into(),
        observed_hash: None,
    };
    database
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: "old-relation".into(),
            skill_id: Some(skill),
            agent_client_id: "agent".into(),
            path: std::path::Path::new("/agents/skills")
                .join("skill")
                .to_string_lossy()
                .into_owned(),
            path_key: "caller-supplied-wrong-key".into(),
            directory_node_id: None,
            relationship: RelationshipType::ManagedCopy,
            file_representation: FileRepresentation::Copy,
            ownership: OwnershipState::SkillhubManaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: "sha256:content".into(),
            origin: ObservedOrigin::Import,
            match_state: ObservedMatchState::ContentVerified,
            active: true,
            observed_at: 1,
            released_at: None,
        })
        .unwrap();
    let mut replacement = deployment_relation_for_test(&deployment, "replacement-relation");
    replacement.path_key = "still-wrong-key".into();
    database
        .relationship_repository()
        .upsert_deployment_relation(&replacement)
        .unwrap();

    let relations = database.relationship_repository().list_relations().unwrap();
    assert_eq!(relations.len(), 1);
    assert_eq!(relations[0].relation_id, "replacement-relation");
    assert_eq!(
        relations[0].path_key,
        skillhub_core::deployment::observed_path_key(&replacement.path)
    );

    database
        .deployment_repository()
        .insert_sync(&deployment)
        .unwrap();
    database
        .deployment_repository()
        .mark_removed_sync(deployment.id)
        .unwrap();
    let relation = database.relationship_repository().list_relations().unwrap();
    assert!(!relation[0].active, "relations={relation:?}");
    assert!(relation[0].released_at.is_some());
}

#[test]
fn managed_deployment_projection_rolls_back_with_legacy_deployment_on_relation_failure() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version =
        VersionId::parse("sha256:0000000000000000000000000000000000000000000000000000000000000003")
            .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Skill', 'skill', 'user_created', 0, 0)",
            [skill.to_string()],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'sha256:content', '{}', 0)",
            rusqlite::params![version.to_string(), skill.to_string()],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('target', 'agent', 'global', '/agents/skills', 0)",
            [],
        )
        .unwrap();
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_managed_relation BEFORE INSERT ON deployment_relations
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();

    let deployment = DeploymentRecord {
        id: DeploymentId::new(),
        skill_id: skill,
        version_id: version,
        target_id: "target".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "skill".into(),
        expected_hash: "sha256:content".into(),
        observed_hash: None,
    };
    assert!(database
        .deployment_repository()
        .insert_sync(&deployment)
        .is_err());
    let legacy_count: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM deployments", [], |row| row.get(0))
        .unwrap();
    assert_eq!(legacy_count, 0);

    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_managed_relation;")
        .unwrap();
    database
        .deployment_repository()
        .insert_sync(&deployment)
        .unwrap();
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_relation_release BEFORE UPDATE OF active ON deployment_relations
             BEGIN SELECT RAISE(ABORT, 'injected release'); END;",
        )
        .unwrap();
    assert!(database
        .deployment_repository()
        .mark_removed_sync(deployment.id)
        .is_err());
    let state: String = database
        .connection_for_test()
        .query_row("SELECT state FROM deployments", [], |row| row.get(0))
        .unwrap();
    assert_eq!(state, "deployed");
    database
        .connection_for_test()
        .execute_batch("DROP TRIGGER fail_relation_release;")
        .unwrap();
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_relation_detach BEFORE UPDATE OF ownership ON deployment_relations
             BEGIN SELECT RAISE(ABORT, 'injected detach'); END;",
        )
        .unwrap();
    assert!(database
        .deployment_repository()
        .detach_management_sync(deployment.id)
        .is_err());
    let managed: i64 = database
        .connection_for_test()
        .query_row("SELECT managed FROM deployments", [], |row| row.get(0))
        .unwrap();
    assert_eq!(managed, 1);
}

#[test]
fn provenance_and_relationship_impact_include_shared_consumers_and_sources() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill_for_relationship_test(&database, skill);
    let node = DirectoryNodeFact {
        node_id: "shared-node".into(),
        path: "/shared/skills".into(),
        path_key: "wrong-key".into(),
        role: DirectoryRole::SharedDirectory,
        profile_id: None,
        agent_client_id: None,
        exists: true,
        observed_at: 1,
        scan_source: None,
    };
    database.directory_repository().upsert_node(&node).unwrap();
    for agent in ["agent.one", "agent.two"] {
        database
            .relationship_repository()
            .upsert_capability(&AgentDirectoryCapabilityFact {
                agent_client_id: agent.into(),
                directory_node_id: node.node_id.clone(),
                recognition: skillhub_core::relationship::DirectoryRecognition::Supported,
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec![],
            })
            .unwrap();
    }
    let source = ImportProvenance::new(
        skill,
        "/shared/skills/demo",
        SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path("/shared/skills/demo"),
        ),
        CandidateOwnership::KnownAgentTarget,
        "sha256:source",
        2,
    )
    .with_agent_client_id("agent.one");
    database
        .provenance_repository()
        .upsert_provenance(&source)
        .unwrap();
    database
        .relationship_repository()
        .upsert_deployment_relation(&DeploymentRelationFact {
            relation_id: "shared-consumer".into(),
            skill_id: Some(skill),
            agent_client_id: "agent.two".into(),
            path: "/shared/skills/demo".into(),
            path_key: "wrong-key".into(),
            directory_node_id: Some(node.node_id),
            relationship: RelationshipType::SharedDirectoryRead,
            file_representation: FileRepresentation::Directory,
            ownership: OwnershipState::SharedReference,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: "sha256:source".into(),
            origin: ObservedOrigin::Scan,
            match_state: ObservedMatchState::ContentVerified,
            active: true,
            observed_at: 3,
            released_at: None,
        })
        .unwrap();

    let impact = database
        .relationship_repository()
        .list_relation_impact(&skill.to_string())
        .unwrap();
    assert_eq!(impact.deployments.len(), 1);
    assert_eq!(impact.source_relations.len(), 1);
    assert_eq!(impact.directory_capabilities.len(), 2);
    assert_eq!(impact.directory_nodes.len(), 1);
}

fn insert_skill_for_relationship_test(database: &Database, skill: SkillId) {
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Demo', 'demo', 'user_created', 0, 0)",
            [skill.to_string()],
        )
        .unwrap();
}

fn deployment_relation_for_test(
    deployment: &DeploymentRecord,
    relation_id: &str,
) -> DeploymentRelationFact {
    DeploymentRelationFact {
        relation_id: relation_id.into(),
        skill_id: Some(deployment.skill_id),
        agent_client_id: "agent".into(),
        path: std::path::Path::new("/agents/skills")
            .join("skill")
            .to_string_lossy()
            .into_owned(),
        path_key: "wrong-key".into(),
        directory_node_id: None,
        relationship: RelationshipType::ManagedCopy,
        file_representation: FileRepresentation::Copy,
        ownership: OwnershipState::SkillhubManaged,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: deployment.expected_hash.clone(),
        origin: ObservedOrigin::Import,
        match_state: ObservedMatchState::ContentVerified,
        active: true,
        observed_at: 1,
        released_at: None,
    }
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
