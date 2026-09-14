use skillhub_core::agent::ProfileCatalog;

const PROFILE_FILES: &[&str] = &[
    "agent-skills",
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
        "agent-skills",
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
            !client.display_name.trim().is_empty()
                && client.supported_os.len() == 2
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
    // CodeBuddy 不再出现在该清单：WorkBuddy 已于 2026-09-05 真机确认本地
    // 目录（见 workbuddy_local_directories_follow_the_2026_09_05_confirmation）。
    for profile in catalog.profiles.iter().filter(|profile| {
        profile.brand == "Anthropic" || profile.brand == "Kimi" || profile.brand == "Grok"
    }) {
        assert!(profile
            .clients
            .iter()
            .any(|client| client.path_candidates.is_empty()));
    }
}

#[test]
fn workbuddy_local_directories_follow_the_2026_09_05_confirmation() {
    let catalog = ProfileCatalog::builtin();
    let client = catalog
        .profiles
        .iter()
        .find(|profile| profile.brand == "CodeBuddy")
        .expect("codebuddy profile")
        .clients
        .iter()
        .find(|client| client.id == "codebuddy.workbuddy")
        .expect("codebuddy.workbuddy client");
    let paths = client
        .path_candidates
        .iter()
        .map(|candidate| (candidate.path.as_str(), candidate.precedence.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        paths,
        vec![
            (
                "{user_home}/.workbuddy/skills",
                skillhub_core::agent::DirectoryPrecedence::Preferred
            ),
            (
                "{project_root}/.workbuddy/skills",
                skillhub_core::agent::DirectoryPrecedence::Preferred
            ),
        ],
        "WorkBuddy 用户级与项目级目录按 2026-09-05 Windows 真机确认登记"
    );
    assert!(
        client
            .deployment
            .limitations
            .iter()
            .any(|limitation| limitation == "runtime_loading_unknown"),
        "刷新/加载行为仍未知，必须保留限制说明"
    );
    assert!(
        !client.deployment.symlink && !client.deployment.junction,
        "WorkBuddy 链接能力未经官方确认，不得声明"
    );
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
    // OPT-20260914-07：共享目录归属收归通用 Agent 目录后，品牌侧条目必须
    // 标记 shared_reference，保证归属卡片只出现一次而部署优先级不变。
    assert!(
        preferred.shared_reference,
        "品牌侧 ~/.agents/skills 条目必须标记为共享引用"
    );
}

#[test]
fn generic_agent_skills_directory_is_a_single_brand_agnostic_profile() {
    let catalog = ProfileCatalog::builtin();
    let profile = catalog
        .profiles
        .iter()
        .find(|profile| profile.brand == "Agent Skills")
        .expect("通用 Agent Skills profile 必须登记在内置目录中");
    assert_eq!(profile.clients.len(), 1, "通用目录只承接一个伪客户端");
    let client = &profile.clients[0];
    assert_eq!(client.id, "agent-skills.shared-directory");
    assert_eq!(
        client.kind,
        skillhub_core::agent::ClientKind::SharedDirectory
    );
    assert_eq!(client.display_name, "Agent Skills");
    let owned = client
        .path_candidates
        .iter()
        .map(|candidate| (candidate.path.as_str(), candidate.scope.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        owned,
        vec![
            (
                "{user_home}/.agents/skills",
                skillhub_core::agent::TargetScope::Global
            ),
            (
                "{project_root}/.agents/skills",
                skillhub_core::agent::TargetScope::Project
            ),
        ],
        "通用 profile 必须同时承接用户级与项目级 .agents/skills 约定目录"
    );
    assert!(
        client
            .path_candidates
            .iter()
            .all(|candidate| !candidate.shared_reference),
        "通用 profile 自身条目是归属条目，不得标记 shared_reference"
    );
    assert!(
        profile
            .official_references
            .iter()
            .any(|url| url.starts_with("https://agentskills.io/")),
        "通用目录的官方依据必须是 agentskills.io 官方资料"
    );
}

#[test]
fn brand_profiles_reference_agents_skills_without_claiming_ownership() {
    let catalog = ProfileCatalog::builtin();
    let mut referenced = 0;
    for profile in catalog
        .profiles
        .iter()
        .filter(|profile| profile.brand != "Agent Skills")
    {
        for client in &profile.clients {
            for candidate in &client.path_candidates {
                if candidate.path.contains(".agents/skills") {
                    referenced += 1;
                    assert!(
                        candidate.shared_reference,
                        "{} 的 {} 引用 {} 时必须标记 shared_reference",
                        profile.brand, client.id, candidate.path
                    );
                }
            }
        }
    }
    assert!(
        referenced >= 20,
        "既有调研覆盖了大量品牌共享引用，数量不应回退（实际 {referenced}）"
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
    // OPT-20260914-07: codebuddy.workbuddy 从本清单移出——2026-09-05 Windows
    // 真机确认了 `~/.workbuddy/skills` 与 `<workspace>/.workbuddy/skills`，
    // WorkBuddy 现在登记本地目录（见
    // workbuddy_local_directories_follow_the_2026_09_05_confirmation）。
    // 其余聊天/云端/移动客户端仍必须保持“无本地目标”边界。
    for expected in [
        "openai.chatgpt-desktop",
        "anthropic.claude-desktop",
        "github-copilot.cloud",
        "trae.work",
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
