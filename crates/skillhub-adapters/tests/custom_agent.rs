use skillhub_core::agent::{
    AgentClient, AgentProfile, CallPolicy, ClientKind, CustomAgent, DeploymentCapability,
    DirectoryPrecedence, OperatingSystem, PathCandidate, PathGrant, TargetScope,
};

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

#[test]
fn custom_agent_accepts_explicit_file_picker_grant() {
    let agent = CustomAgent::new(
        "custom.my-agent",
        "My Agent",
        PathGrant::from_file_picker("grant-1", "C:/Users/me/.my-agent/skills"),
        profile("C:/Users/me/.my-agent/skills"),
    )
    .unwrap();
    assert_eq!(agent.directory.path, "C:/Users/me/.my-agent/skills");
}

#[test]
fn custom_agent_rejects_missing_or_unbounded_grants_and_paths() {
    assert!(PathGrant::from_file_picker("", "C:/skills")
        .validate()
        .is_err());
    assert!(PathGrant::from_file_picker("grant", "").validate().is_err());
    assert!(CustomAgent::new(
        "custom.my-agent",
        "My Agent",
        PathGrant::from_file_picker("grant-1", "C:/Users/me"),
        profile("C:/Users/me"),
    )
    .is_err());
    assert!(CustomAgent::new(
        "custom.my-agent",
        "My Agent",
        PathGrant::from_file_picker("grant-1", "C:/Users/me/.agent/skills"),
        profile("C:/Users/me/.agent/skills/**"),
    )
    .is_err());
}

#[test]
fn custom_agent_has_no_command_or_runtime_fields() {
    let serialized = serde_json::to_value(profile("C:/skills")).unwrap();
    let text = serialized.to_string();
    assert!(!text.contains("command"));
    assert!(!text.contains("script"));
    assert!(!text.contains("shell"));
}
