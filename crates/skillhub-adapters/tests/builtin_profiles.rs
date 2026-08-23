use skillhub_core::agent::ProfileCatalog;

const PROFILE_FILES: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "cursor",
    "github-copilot",
    "windsurf",
    "cline",
    "opencode",
    "trae",
    "qoder",
    "codebuddy",
    "comate",
    "kimi",
    "zcode",
    "openclaw",
    "hermes",
    "grok",
];

#[test]
fn builtin_catalog_contains_every_researched_brand_and_no_roo_code() {
    let ids = ProfileCatalog::builtin().profile_ids();
    for expected in [
        "openai",
        "anthropic",
        "google",
        "cursor",
        "github-copilot",
        "windsurf",
        "cline",
        "opencode",
        "trae",
        "qoder",
        "codebuddy",
        "comate",
        "kimi",
        "zcode",
        "openclaw",
        "hermes",
        "grok",
    ] {
        assert!(ids.contains(expected), "missing {expected}");
    }
    assert!(!ids.contains("roo-code"));
}

#[test]
fn every_builtin_profile_passes_strict_loader_and_matches_expectations() {
    let profile_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("profiles");
    let expectations: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/agents/builtin-profile-expectations.json"
    ))
    .unwrap();
    for id in PROFILE_FILES {
        let profile =
            skillhub_adapters::agent::load_profile(profile_dir.join(format!("{id}.json")))
                .unwrap_or_else(|error| panic!("invalid builtin profile {id}: {error}"));
        assert_eq!(profile.profile_version, 1);
        assert!(profile.clients.iter().all(|client| {
            client.supported_os.len() == 2
                && client.supported_os.iter().all(|os| {
                    matches!(
                        os,
                        skillhub_core::agent::OperatingSystem::Windows
                            | skillhub_core::agent::OperatingSystem::Macos
                    )
                })
        }));
        let expected_paths = expectations["profiles"][*id].as_array().unwrap();
        let actual_paths = profile
            .clients
            .iter()
            .flat_map(|client| {
                client
                    .path_candidates
                    .iter()
                    .map(|candidate| candidate.path.as_str())
            })
            .collect::<std::collections::BTreeSet<_>>();
        for expected in expected_paths.iter().filter_map(serde_json::Value::as_str) {
            assert!(
                actual_paths.contains(expected),
                "{id} missing expected path {expected}"
            );
        }
    }
}

#[test]
fn upload_only_clients_have_no_local_target_and_no_roo_code_file() {
    let catalog = ProfileCatalog::builtin();
    assert!(!std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("profiles/roo-code.json")
        .exists());
    for profile in catalog.profiles.iter().filter(|profile| {
        profile.brand == "Anthropic"
            || profile.brand == "CodeBuddy"
            || profile.brand == "Kimi"
            || profile.brand == "Grok"
    }) {
        assert!(profile
            .clients
            .iter()
            .any(|client| client.path_candidates.is_empty()));
    }
}
