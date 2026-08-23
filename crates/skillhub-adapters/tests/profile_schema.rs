use skillhub_adapters::agent::{load_catalog, load_profile, parse_custom_profile};

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

#[test]
fn catalog_loader_ignores_json_schema_document() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("codex.json"),
        include_str!("../profiles/codex.json"),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("schema.json"),
        include_str!("../profiles/schema.json"),
    )
    .unwrap();
    let catalog = load_catalog(dir.path()).unwrap();
    assert_eq!(catalog.profiles.len(), 1);
    assert_eq!(catalog.profiles[0].brand, "OpenAI Codex");
}

#[test]
fn rejects_unbounded_home_and_network_roots_but_accepts_bounded_candidates() {
    for path in [
        "%USERPROFILE%",
        "$HOME",
        "{user_home}",
        "/Users/alice",
        "/home/alice",
        "C:/Users/alice",
        "\\\\server\\share",
        "//server/share",
        "C:/Users/alice/../..",
        "{user_home}/..",
        "%USERPROFILE%/..",
        "//server/share/..",
        "%USERPROFILE%/.codex/../..",
        "{user_home}\\.agents\\..\\..",
    ] {
        let json = profile_with_path(path);
        assert!(
            parse_custom_profile(&json).is_err(),
            "accepted unsafe root: {path}"
        );
    }
    for path in [
        "%USERPROFILE%/.codex/skills",
        "$HOME/.agents/skills",
        "{user_home}/.agents/skills",
        "/Users/alice/.agents/skills",
        "C:/Users/alice/.agents/skills",
        "//server/share/skills",
    ] {
        let json = profile_with_path(path);
        assert!(
            parse_custom_profile(&json).is_ok(),
            "rejected bounded path: {path}"
        );
    }
}

#[test]
fn validates_date_references_and_non_empty_arrays() {
    for (date, reference, references) in [
        (
            "2026-13-01",
            "https://example.com",
            "[\"https://example.com\"]",
        ),
        ("2026-01-01", "not-a-url", "[\"not-a-url\"]"),
        ("2026-01-01", "https://example.com", "[]"),
    ] {
        let json = format!(
            r#"{{"profile_version":1,"research_date":"{date}","official_references":{references},"brand":"Example","clients":[{{"id":"example.cli","kind":"cli","supported_os":["windows"],"path_candidates":[{{"path":"%USERPROFILE%/.example/skills","scope":"global","precedence":"preferred","marker":"SKILL.md"}}],"skill_marker":"SKILL.md","deployment":{{"copy":true,"symlink":false,"junction":false}},"call_policy":"unknown"}}]}}"#
        );
        let _ = reference;
        assert!(parse_custom_profile(&json).is_err());
    }
    for reference in [
        "https:// /",
        "https://example.com bad",
        "https:///missing-host",
    ] {
        let json = format!(
            r#"{{"profile_version":1,"research_date":"2026-01-01","official_references":["{reference}"],"brand":"Example","clients":[{{"id":"example.cli","kind":"cli","supported_os":["windows"],"path_candidates":[{{"path":"%USERPROFILE%/.example/skills","scope":"global","precedence":"preferred","marker":"SKILL.md"}}],"skill_marker":"SKILL.md","deployment":{{"copy":true,"symlink":false,"junction":false}},"call_policy":"unknown"}}]}}"#
        );
        assert!(
            parse_custom_profile(&json).is_err(),
            "accepted invalid URI: {reference}"
        );
    }
}

fn profile_with_path(path: &str) -> String {
    format!(
        r#"{{"profile_version":1,"research_date":"2026-01-01","official_references":["https://example.com"],"brand":"Example","clients":[{{"id":"example.cli","kind":"cli","supported_os":["windows","macos"],"path_candidates":[{{"path":{path:?},"scope":"global","precedence":"preferred","marker":"SKILL.md"}}],"skill_marker":"SKILL.md","deployment":{{"copy":true,"symlink":false,"junction":false}},"call_policy":"unknown"}}]}}"#
    )
}
