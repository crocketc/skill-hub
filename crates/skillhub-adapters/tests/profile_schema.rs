use skillhub_adapters::agent::{load_profile, parse_custom_profile};

fn load_fixture_profile(
    name: &str,
) -> Result<skillhub_core::agent::AgentProfile, skillhub_adapters::agent::ProfileLoadError> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("profiles")
        .join(format!("{name}.json"));
    load_profile(path)
}

#[test]
fn profile_declares_paths_and_capabilities_but_no_commands() {
    let profile = load_fixture_profile("codex").unwrap();
    assert!(!profile.clients.is_empty());
    assert!(profile
        .clients
        .iter()
        .all(|c| !c.path_candidates.is_empty()));
    assert!(!serde_json::to_string(&profile).unwrap().contains("shell"));
}

#[test]
fn rejects_custom_profile_with_command_or_unbounded_scan_root() {
    let command = include_str!("fixtures/unsafe-command.json");
    let error = parse_custom_profile(command).unwrap_err();
    assert_eq!(error.code.as_str(), "agent_profile.invalid_capability");

    let root = include_str!("fixtures/unsafe-root.json");
    let error = parse_custom_profile(root).unwrap_err();
    assert_eq!(error.code.as_str(), "agent_profile.invalid_capability");
}

#[test]
fn rejects_unknown_fields_in_sensitive_profile_sections() {
    let json = r#"{
      "profile_version": 1, "research_date": "2026-08-22", "official_references": [],
      "brand": "Example", "clients": [{
        "id": "example.cli", "kind": "cli", "supported_os": ["windows"],
        "path_candidates": [{"path": "%USERPROFILE%/.example/skills", "scope": "global", "precedence": "preferred", "marker": "SKILL.md", "unexpected": true}],
        "skill_marker": "SKILL.md", "deployment": {"copy": true, "symlink": false, "junction": false, "unexpected": true},
        "call_policy": "unknown"
      }]
    }"#;
    let error = parse_custom_profile(json).unwrap_err();
    assert_eq!(error.code.as_str(), "agent_profile.invalid_capability");
}
