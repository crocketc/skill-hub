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
    "doubao",
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
        "doubao-work",
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
fn link_capabilities_are_true_only_when_documented_or_probe_verified() {
    // DEV-21（2026-09-20 用户裁决，不静默放松）：junction 声明改为双通道——
    // ① skills.sh 安装器/Agent 明确支持；② Windows 真机探针实证（RC-13/RC-14：
    // 非管理员账号下 junction 落地为 reparse point、原文件零误删、探针零残留）。
    // 符号链接清单依据 skills.sh 的 supported agents 与默认 symlink 安装流程；
    // 其他客户端维持保守的 symlink:false，直到取得同等级证据。
    let catalog = ProfileCatalog::builtin();
    let skills_cli_supported = [
        "agent-skills.shared-directory",
        "anthropic.claude-code",
        "cline.extension",
        "cline.cli",
        "cline.sdk",
        "cline.acp",
        "codebuddy.code",
        "codex.cli",
        "cursor.editor",
        "cursor.cli",
        "github-copilot.cli",
        "github-copilot.ide",
        "google.antigravity.app",
        "google.antigravity.cli",
        "google.gemini-cli",
        "grok.build-cli",
        "grok.build-tui",
        "grok.build-acp",
        "hermes.agent",
        "kimi.code",
        "openai.codex-cli",
        "openai.codex-ide",
        "openclaw.agent",
        "opencode.cli",
        "pi.coding-agent",
        "qoder.ide",
        "qoder.cli",
        "trae.code",
        "windsurf.cascade",
        "zcode.desktop",
    ];
    let junction_probe_verified = [
        "openai.codex-cli",
        "openai.codex-ide",
        "anthropic.claude-code",
        "zcode.desktop",
        "openclaw.agent",
        // 2026-09-26 真机实证（junction-probe 探针 Skill）：六处 junction 全部
        // 出现在技能列表、调用返回探针字符串、共享目录与专属目录去重为一个条目。
        "agent-skills.shared-directory",
        "cursor.editor",
        "cursor.cli",
        "github-copilot.cli",
        "github-copilot.ide",
        "google.gemini-cli",
        "kimi.code",
        "trae.code",
    ];
    for profile in catalog.profiles {
        for client in profile.clients {
            let junction_allowed = junction_probe_verified.contains(&client.id.as_str());
            assert_eq!(
                client.deployment.junction, junction_allowed,
                "junction declaration must match the dual-channel evidence: {}",
                client.id
            );
            assert!(
                !client.deployment.junction
                    || !client
                        .deployment
                        .limitations
                        .iter()
                        .any(|limitation| limitation == "junction_support_unconfirmed"),
                "probe-verified junction must drop the unconfirmed limitation: {}",
                client.id
            );
            if skills_cli_supported.contains(&client.id.as_str()) {
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
fn gemini_cli_is_in_the_skills_cli_supported_set() {
    let catalog = ProfileCatalog::builtin();
    let client = catalog
        .profiles
        .iter()
        .flat_map(|profile| profile.clients.iter())
        .find(|client| client.id == "google.gemini-cli")
        .expect("Gemini CLI client is part of the bundled catalog");
    assert!(client.deployment.symlink);
    assert!(!client
        .deployment
        .limitations
        .iter()
        .any(|limitation| limitation == "runtime_loading_unknown"));
    assert!(!client
        .deployment
        .limitations
        .iter()
        .any(|limitation| limitation == "symlink_support_unconfirmed"));
}

#[test]
fn skills_cli_supported_profiles_do_not_retain_unknown_link_limitations() {
    let catalog = ProfileCatalog::builtin();
    for client in catalog
        .profiles
        .iter()
        .flat_map(|profile| profile.clients.iter())
        .filter(|client| {
            [
                "agent-skills.shared-directory",
                "cline.extension",
                "cline.cli",
                "cline.sdk",
                "cline.acp",
                "codebuddy.code",
                "cursor.editor",
                "cursor.cli",
                "github-copilot.cli",
                "github-copilot.ide",
                "google.antigravity.app",
                "google.antigravity.cli",
                "grok.build-cli",
                "grok.build-tui",
                "grok.build-acp",
                "hermes.agent",
                "kimi.code",
                "opencode.cli",
                "pi.coding-agent",
                "qoder.ide",
                "qoder.cli",
                "trae.code",
                "windsurf.cascade",
            ]
            .contains(&client.id.as_str())
        })
    {
        assert!(
            client.deployment.symlink,
            "skills.sh supported client must link: {}",
            client.id
        );
        assert!(!client
            .deployment
            .limitations
            .iter()
            .any(|limitation| limitation == "runtime_loading_unknown"));
        assert!(!client
            .deployment
            .limitations
            .iter()
            .any(|limitation| limitation == "symlink_support_unconfirmed"));
    }
}

#[test]
fn skills_cli_unsupported_boundaries_remain_copy_only() {
    let catalog = ProfileCatalog::builtin();
    let unsupported = [
        "codebuddy.workbuddy",
        "deepseek-harness.tui",
        "deepseek-harness.web",
        "comate.ide",
        "google.antigravity.ide",
        "google.antigravity.sdk",
    ];
    for client in catalog
        .profiles
        .iter()
        .flat_map(|profile| profile.clients.iter())
        .filter(|client| unsupported.contains(&client.id.as_str()))
    {
        assert!(
            !client.deployment.symlink,
            "skills.sh unsupported client must remain copy-only: {}",
            client.id
        );
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

/// 2026-09-25 验收裁决：真机确认的内置技能目录必须在 profile 层以
/// `builtin=true` 登记为只读平台目录；内置条目一律全局、可共存优先级，
/// 不参与部署与删除。WorkBuddy/DeepSeek Harness/Kimi 的内置目录位于安装
/// 目录或含变量段，无法以稳定占位符表达，本轮不登记（见调研文档）。
/// 2026-09-26：豆包工作内置目录经用户真机核实位于用户 AppData 下，
/// 可用 `{user_home}` 占位符稳定表达，追加登记（内置条目 5 → 6）。
#[test]
fn builtin_directories_are_declared_as_read_only_platform_candidates() {
    let catalog = ProfileCatalog::builtin();
    let builtin_paths = |client_id: &str| -> Vec<String> {
        catalog
            .profiles
            .iter()
            .flat_map(|profile| profile.clients.iter())
            .filter(|client| client.id == client_id)
            .flat_map(|client| client.path_candidates.iter())
            .filter(|candidate| candidate.builtin)
            .map(|candidate| candidate.path.clone())
            .collect()
    };
    for client_id in ["openai.codex-cli", "openai.codex-desktop"] {
        assert_eq!(
            builtin_paths(client_id),
            vec!["{user_home}/.codex/skills/.system".to_string()],
            "codex cli/desktop must declare exactly the nested .system built-in directory: {client_id}"
        );
    }
    assert_eq!(
        builtin_paths("cursor.editor"),
        vec!["{user_home}/.cursor/skills-cursor".to_string()],
    );
    assert_eq!(
        builtin_paths("trae.code"),
        vec![
            "{user_home}/.trae-cn/builtin_skills".to_string(),
            "{user_home}/.trae-cn/builtin/global/skills".to_string(),
        ],
    );
    assert_eq!(
        builtin_paths("doubao-work.desktop"),
        vec![
            "{user_home}/AppData/Local/DoubaoWork/User Data/Default/.doubaowork/agent_mode/workspace/.skills".to_string(),
        ],
    );
    let builtin_count = catalog
        .profiles
        .iter()
        .flat_map(|profile| profile.clients.iter())
        .flat_map(|client| client.path_candidates.iter())
        .filter(|candidate| candidate.builtin)
        .count();
    assert_eq!(
        builtin_count, 6,
        "only the real-machine confirmed built-in directories may be declared"
    );
    let all_builtin = catalog
        .profiles
        .iter()
        .flat_map(|profile| profile.clients.iter())
        .flat_map(|client| client.path_candidates.iter())
        .filter(|candidate| candidate.builtin);
    for candidate in all_builtin {
        assert!(
            candidate.scope == skillhub_core::agent::TargetScope::Global
                && candidate.precedence == skillhub_core::agent::DirectoryPrecedence::MayCoexist,
            "builtin entries stay global may_coexist read-only references"
        );
    }
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
