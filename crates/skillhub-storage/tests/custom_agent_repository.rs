use skillhub_core::agent::{
    AgentClient, AgentProfile, CallPolicy, ClientKind, CustomAgent, CustomAgentOverride,
    DeploymentCapability, DirectoryPrecedence, OperatingSystem, PathCandidate, ResolvedPathGrant,
    TargetScope,
};
use skillhub_storage::Database;

fn profile(path: &str) -> AgentProfile {
    AgentProfile {
        profile_version: 1,
        research_date: "2026-08-23".into(),
        official_references: vec!["https://example.com/custom-agent".into()],
        brand: "My Agent".into(),
        clients: vec![AgentClient {
            id: "my-agent.cli".into(),
            kind: ClientKind::Cli,
            display_name: "Fixture".into(),
            supported_os: vec![OperatingSystem::Windows, OperatingSystem::Macos],
            path_candidates: vec![PathCandidate {
                path: path.into(),
                agent_root: None,
                scope: TargetScope::Global,
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                marker: "SKILL.md".into(),
            }],
            skill_marker: "SKILL.md".into(),
            deployment: DeploymentCapability {
                copy: true,
                symlink: false,
                junction: false,
                limitations: vec![],
            },
            call_policy: CallPolicy::Unknown,
        }],
    }
}

fn agent(id: &str) -> CustomAgent {
    agent_at(id, "C:/Users/me/.my-agent/skills")
}

fn agent_at(id: &str, path: &str) -> CustomAgent {
    CustomAgent {
        id: id.into(),
        display_name: "My Agent".into(),
        directory: ResolvedPathGrant {
            grant_id: "grant-1".into(),
            path: path.into(),
            operating_system: OperatingSystem::Windows,
        },
        directory_physical_id: None,
        profile: profile(path),
    }
}

#[test]
fn custom_agent_crud_and_override_reset_preserve_directory() {
    let database = Database::open_in_memory().unwrap();
    let original_path = "C:/Users/me/.my-agent/skills";
    database
        .custom_agent_repository()
        .create(agent("custom.my-agent"))
        .unwrap();
    database
        .custom_agent_repository()
        .set_override(CustomAgentOverride {
            profile_id: "custom.my-agent".into(),
            directory: ResolvedPathGrant {
                grant_id: "grant-1".into(),
                path: "C:/Users/me/.my-agent/alternate-skills".into(),
                operating_system: OperatingSystem::Windows,
            },
            profile: profile("C:/Users/me/.my-agent/alternate-skills"),
        })
        .unwrap();
    assert_eq!(
        database
            .custom_agent_repository()
            .list_overrides()
            .unwrap()
            .len(),
        1
    );
    database
        .custom_agent_repository()
        .reset_override("custom.my-agent")
        .unwrap();
    assert!(database
        .custom_agent_repository()
        .list_overrides()
        .unwrap()
        .is_empty());
    database
        .custom_agent_repository()
        .remove("custom.my-agent")
        .unwrap();
    assert!(database
        .custom_agent_repository()
        .list()
        .unwrap()
        .is_empty());
    assert_eq!(original_path, "C:/Users/me/.my-agent/skills");
}

#[test]
fn duplicate_and_missing_custom_agent_operations_are_deterministic() {
    let database = Database::open_in_memory().unwrap();
    database
        .custom_agent_repository()
        .create(agent("custom.my-agent"))
        .unwrap();
    let duplicate = database
        .custom_agent_repository()
        .create(agent("custom.my-agent"))
        .unwrap_err();
    assert_eq!(duplicate.code.as_str(), "agent_profile.invalid_capability");
    let missing = database
        .custom_agent_repository()
        .remove("custom.missing")
        .unwrap_err();
    assert_eq!(missing.code.as_str(), "object.not_found");
    let missing_override = database
        .custom_agent_repository()
        .reset_override("custom.my-agent")
        .unwrap_err();
    assert_eq!(missing_override.code.as_str(), "object.not_found");
}

#[test]
fn unknown_profile_override_is_rejected() {
    let database = Database::open_in_memory().unwrap();
    let error = database
        .custom_agent_repository()
        .set_override(CustomAgentOverride {
            profile_id: "unknown.profile".into(),
            directory: ResolvedPathGrant {
                grant_id: "grant-1".into(),
                path: "C:/Users/me/.my-agent/skills".into(),
                operating_system: OperatingSystem::Windows,
            },
            profile: profile("C:/Users/me/.my-agent/skills"),
        })
        .unwrap_err();
    assert_eq!(error.code.as_str(), "object.not_found");
}

#[test]
fn failed_custom_agent_write_rolls_back_and_does_not_touch_target() {
    let database = Database::open_in_memory().unwrap();
    database
        .custom_agent_repository()
        .create(agent("custom.my-agent"))
        .unwrap();
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_custom_agents BEFORE UPDATE OF value_json ON settings
             WHEN NEW.key = 'custom_agents'
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();
    assert!(database
        .custom_agent_repository()
        .update(agent("custom.my-agent"))
        .is_err());
    assert_eq!(
        database.custom_agent_repository().list().unwrap()[0]
            .directory
            .path,
        "C:/Users/me/.my-agent/skills"
    );
}

#[test]
fn profile_override_can_target_builtin_metadata_without_mutating_builtin_files() {
    let database = Database::open_in_memory().unwrap();
    database
        .custom_agent_repository()
        .set_override(CustomAgentOverride {
            profile_id: "openai".into(),
            directory: ResolvedPathGrant {
                grant_id: "grant-2".into(),
                path: "C:/Users/me/.custom-codex/skills".into(),
                operating_system: OperatingSystem::Windows,
            },
            profile: profile("C:/Users/me/.custom-codex/skills"),
        })
        .unwrap();
    assert_eq!(
        database.custom_agent_repository().list_overrides().unwrap()[0].profile_id,
        "openai"
    );
    database
        .custom_agent_repository()
        .reset_override("openai")
        .unwrap();
    assert!(database
        .custom_agent_repository()
        .list_overrides()
        .unwrap()
        .is_empty());
}

#[test]
fn second_settings_write_failure_rolls_back_agents_and_overrides_together() {
    let database = Database::open_in_memory().unwrap();
    database
        .custom_agent_repository()
        .create(agent("custom.my-agent"))
        .unwrap();
    database
        .custom_agent_repository()
        .set_override(CustomAgentOverride {
            profile_id: "custom.my-agent".into(),
            directory: ResolvedPathGrant {
                grant_id: "grant-1".into(),
                path: "C:/Users/me/.my-agent/skills".into(),
                operating_system: OperatingSystem::Windows,
            },
            profile: profile("C:/Users/me/.my-agent/skills"),
        })
        .unwrap();
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_custom_override BEFORE UPDATE OF value_json ON settings
         WHEN NEW.key = 'custom_agent_profile_overrides'
         BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();
    let result = database.custom_agent_repository().remove("custom.my-agent");
    assert!(result.is_err());
    assert_eq!(database.custom_agent_repository().list().unwrap().len(), 1);
    assert_eq!(
        database
            .custom_agent_repository()
            .list_overrides()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn remove_never_deletes_a_real_granted_directory() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("skills");
    std::fs::create_dir_all(&path).unwrap();
    let path = path.to_string_lossy().into_owned();
    let database = Database::open_in_memory().unwrap();
    database
        .custom_agent_repository()
        .create(agent_at("custom.real", &path))
        .unwrap();
    database
        .custom_agent_repository()
        .remove("custom.real")
        .unwrap();
    assert!(std::path::Path::new(&path).is_dir());
    assert!(directory.path().is_dir());
}

/// 2026-09-30 裁决：自定义 Agent 登记/编辑时持久化目录物理身份基线，部署
/// 链路据此识别「目录被整体替换」。基线随实体一起走 settings JSON 读写。
#[test]
fn custom_agent_identity_baseline_round_trips_with_the_entity() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.custom_agent_repository();

    let stored = agent_at("custom.acme", "C:/Users/me/.acme/skills");
    assert_eq!(stored.directory_physical_id, None);
    repository.create(stored.clone()).unwrap();
    repository.update({
        let mut with_baseline = stored.clone();
        with_baseline.directory_physical_id = Some("physical-1".into());
        with_baseline
    }).unwrap();

    let listed = repository.list().unwrap();
    let listed = listed
        .iter()
        .find(|candidate| candidate.id == "custom.acme")
        .expect("custom agent survives the baseline update");
    assert_eq!(listed.directory_physical_id.as_deref(), Some("physical-1"));
}

/// 兼容边界：旧版本写入的 settings JSON 没有基线字段，必须以 None 读回，
/// 不得拒绝加载或要求迁移。
#[test]
fn legacy_custom_agent_rows_without_a_baseline_still_load() {
    let database = Database::open_in_memory().unwrap();
    database
        .custom_agent_repository()
        .create(agent_at("custom.legacy", "C:/Users/me/.legacy/skills"))
        .unwrap();

    let raw: String = database
        .connection_for_test()
        .query_row(
            "SELECT value_json FROM settings WHERE key='custom_agents'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut entries: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for entry in entries.as_array_mut().expect("agents array") {
        entry
            .as_object_mut()
            .expect("agent object")
            .remove("directory_physical_id");
    }
    database
        .connection_for_test()
        .execute(
            "UPDATE settings SET value_json=?1 WHERE key='custom_agents'",
            [entries.to_string()],
        )
        .unwrap();

    let listed = database.custom_agent_repository().list().unwrap();
    let legacy = listed
        .iter()
        .find(|candidate| candidate.id == "custom.legacy")
        .expect("legacy row still loads");
    assert_eq!(legacy.directory_physical_id, None);
}
