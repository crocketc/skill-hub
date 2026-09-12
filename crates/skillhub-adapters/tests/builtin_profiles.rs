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
    "pi",
    "deepseek-harness",
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
        "pi",
        "deepseek-harness",
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
        let expected_paths = expected_paths
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            actual_paths, expected_paths,
            "path expectations differ for {id}"
        );
    }
}

#[test]
fn embedded_builtin_catalog_matches_profiles_after_strict_validation() {
    let profile_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("profiles");
    let validated = PROFILE_FILES
        .iter()
        .map(|id| {
            skillhub_adapters::agent::load_profile(profile_dir.join(format!("{id}.json"))).unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(ProfileCatalog::builtin().profiles, validated);
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

#[test]
fn link_capabilities_are_true_only_when_officially_documented() {
    let catalog = ProfileCatalog::builtin();
    let documented = [
        "openai.codex-cli",
        "openai.codex-ide",
        "anthropic.claude-code",
        "zcode.desktop",
        "openclaw.agent",
    ];
    for profile in catalog.profiles {
        for client in profile.clients {
            assert!(
                !client.deployment.junction,
                "unconfirmed junction: {}",
                client.id
            );
            if documented.contains(&client.id.as_str()) {
                assert!(
                    client.deployment.symlink,
                    "documented symlink missing: {}",
                    client.id
                );
                continue;
            }
            assert!(
                !client.deployment.symlink,
                "unconfirmed symlink: {}",
                client.id
            );
            if !client.path_candidates.is_empty() {
                assert!(client
                    .deployment
                    .limitations
                    .iter()
                    .any(|limitation| limitation == "symlink_support_unconfirmed"));
            }
        }
    }
}

#[test]
fn zcode_prefers_the_real_agents_skills_directory() {
    let catalog = ProfileCatalog::builtin();
    let client = catalog
        .profiles
        .iter()
        .find(|profile| profile.brand == "ZCode")
        .expect("zcode profile")
        .clients
        .iter()
        .find(|client| client.id == "zcode.desktop")
        .expect("zcode.desktop client");
    let preferred = client.path_candidates.first().expect("path candidate");
    assert_eq!(
        preferred.path, "{user_home}/.agents/skills",
        "真实 ZCode 布局使用 ~/.agents/skills（与 codex-cli 同目录）；首选候选必须指向它"
    );
    assert_eq!(
        preferred.precedence,
        skillhub_core::agent::DirectoryPrecedence::Preferred
    );
}

#[test]
fn researched_client_boundaries_are_kept_as_separate_profiles() {
    let catalog = ProfileCatalog::builtin();
    let ids = catalog
        .profiles
        .iter()
        .flat_map(|profile| profile.clients.iter().map(|client| client.id.as_str()))
        .collect::<std::collections::BTreeSet<_>>();
    for expected in [
        "google.gemini-cli",
        "google.antigravity.app",
        "google.antigravity.cli",
        "google.antigravity.ide",
        "google.antigravity.sdk",
        "cline.extension",
        "cline.cli",
        "cline.sdk",
        "cline.acp",
        "github-copilot.cloud",
        "trae.work",
        "codebuddy.workbuddy",
        "kimi.work",
        "grok.build-cli",
        "grok.build-tui",
        "grok.build-acp",
        "pi.coding-agent",
        "deepseek-harness.tui",
        "deepseek-harness.web",
    ] {
        assert!(ids.contains(expected), "missing client {expected}");
    }
    for expected in [
        "openai.chatgpt-desktop",
        "anthropic.claude-desktop",
        "github-copilot.cloud",
        "trae.work",
        "codebuddy.workbuddy",
        "kimi.work",
        "grok.consumer",
        "grok.bot",
    ] {
        let client = catalog
            .profiles
            .iter()
            .flat_map(|profile| profile.clients.iter())
            .find(|client| client.id == expected)
            .unwrap();
        assert!(
            client.path_candidates.is_empty(),
            "{expected} must not claim a local target"
        );
    }
}

#[test]
fn pi_and_deepseek_harness_keep_their_native_and_shared_skill_roots() {
    let catalog = ProfileCatalog::builtin();
    let pi = catalog
        .profiles
        .iter()
        .find(|profile| profile.brand == "Pi")
        .expect("pi profile");
    let pi_paths = pi.clients[0]
        .path_candidates
        .iter()
        .map(|candidate| candidate.path.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        pi_paths,
        vec![
            "{user_home}/.pi/agent/skills",
            "{user_home}/.agents/skills",
            "{project_root}/.pi/skills",
            "{project_root}/.agents/skills",
        ]
    );

    let harness = catalog
        .profiles
        .iter()
        .find(|profile| profile.brand == "DeepSeek Harness")
        .expect("deepseek harness profile");
    for client in &harness.clients {
        let paths = client
            .path_candidates
            .iter()
            .map(|candidate| candidate.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "{project_root}/.dsh/skills",
                "{project_root}/.agents/skills",
                "{user_home}/.dsh/skills",
                "{user_home}/.agents/skills",
            ],
            "unexpected paths for {}",
            client.id
        );
    }
}
