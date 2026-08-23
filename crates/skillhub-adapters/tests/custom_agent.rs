use skillhub_core::agent::{
    AgentClient, AgentProfile, CallPolicy, ClientKind, CustomAgent, CustomAgentDraft,
    CustomAgentValidationError, DeploymentCapability, DirectoryPrecedence, OperatingSystem,
    PathCandidate, PathGrant, PathGrantResolver, TargetScope,
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

struct FakeRegistry;
impl PathGrantResolver for FakeRegistry {
    fn resolve(&self, grant: &PathGrant) -> Result<String, CustomAgentValidationError> {
        match grant.grant_id.as_str() {
            "grant-1" => Ok("C:/Users/me/.my-agent/skills".into()),
            _ => Err(CustomAgentValidationError::GrantNotAuthorized),
        }
    }
}

#[test]
fn custom_agent_accepts_only_a_resolver_issued_grant_and_matching_profile_path() {
    let agent = CustomAgent::from_draft(
        CustomAgentDraft {
            id: "custom.my-agent".into(),
            display_name: "My Agent".into(),
            directory: PathGrant::from_file_picker("grant-1"),
            profile: profile("C:/Users/me/.my-agent/skills"),
        },
        &FakeRegistry,
    )
    .unwrap();
    assert_eq!(agent.directory.path, "C:/Users/me/.my-agent/skills");
    let mismatch = CustomAgent::from_draft(
        CustomAgentDraft {
            id: "custom.my-agent".into(),
            display_name: "My Agent".into(),
            directory: PathGrant::from_file_picker("grant-1"),
            profile: profile("C:/other/skills"),
        },
        &FakeRegistry,
    )
    .unwrap_err();
    assert_eq!(mismatch, CustomAgentValidationError::GrantPathMismatch);
    assert!(CustomAgent::from_draft(
        CustomAgentDraft {
            id: "x".into(),
            display_name: "x".into(),
            directory: PathGrant::from_file_picker("forged"),
            profile: profile("C:/Users/me/.my-agent/skills")
        },
        &FakeRegistry
    )
    .is_err());
}

#[test]
fn custom_agent_rejects_malformed_grants_and_malicious_json() {
    assert!(PathGrant::from_file_picker("").validate().is_err());
    let malicious = r#"{"id":"x","display_name":"x","directory":{"grant_id":"grant-1"},"profile":{"command":"curl bad"}}"#;
    assert!(serde_json::from_str::<CustomAgentDraft>(malicious).is_err());
}
