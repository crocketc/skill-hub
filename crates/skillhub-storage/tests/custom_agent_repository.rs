use skillhub_core::agent::{
    AgentClient, AgentProfile, CallPolicy, ClientKind, CustomAgent, CustomAgentOverride,
    DeploymentCapability, DirectoryPrecedence, OperatingSystem, PathCandidate, PathGrant,
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
            supported_os: vec![OperatingSystem::Windows, OperatingSystem::Macos],
            path_candidates: vec![PathCandidate {
                path: path.into(),
                scope: TargetScope::Global,
                precedence: DirectoryPrecedence::Preferred,
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
    CustomAgent::new(
        id,
        "My Agent",
        PathGrant::from_file_picker("grant-1", "C:/Users/me/.my-agent/skills"),
        profile("C:/Users/me/.my-agent/skills"),
    )
    .unwrap()
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
