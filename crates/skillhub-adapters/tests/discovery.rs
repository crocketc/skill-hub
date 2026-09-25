use skillhub_adapters::agent::discovery::{DiscoverAgents, DiscoveryRoots};
use skillhub_core::agent::OperatingSystem;
use tempfile::tempdir;

#[test]
fn discovery_reports_registered_client_and_writable_directory_without_runtime_claims() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();

    let roots = DiscoveryRoots::new(OperatingSystem::Windows, &home);
    let snapshot = DiscoverAgents::builtin().discover(&roots).unwrap();

    let instance = snapshot
        .instances
        .iter()
        .find(|instance| {
            instance.profile_id == "openai" && instance.client_id == "openai.codex-cli"
        })
        .unwrap();
    assert_eq!(
        instance.client_presence,
        skillhub_core::agent::ClientPresence::Unknown
    );
    let target = snapshot
        .logical_targets
        .iter()
        .find(|target| {
            target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills")
        })
        .unwrap();
    assert!(target.exists);
    assert!(target.readable);
    assert!(target.writable);

    let json = serde_json::to_string(&snapshot).unwrap();
    for forbidden in [
        "runtime_version",
        "login_state",
        "trust_state",
        "authorization",
        "usable",
    ] {
        assert!(!json.contains(forbidden), "discovery leaked {forbidden}");
    }
}

#[test]
fn two_clients_pointing_to_same_directory_share_one_physical_target() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    let logical = snapshot
        .logical_targets
        .iter()
        .filter(|target| target.scope == skillhub_core::agent::TargetScope::Global && target.exists)
        .filter(|target| target.profile_id == "openai")
        .filter(|target| {
            target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        logical.len(),
        3,
        // 2026-09-25：openai 品牌 codex-cli / codex-ide / codex-desktop 三个
        // 客户端都引用同一共享目录，各留一条 logical target。
        "logical targets: {:?}",
        logical
            .iter()
            .map(|target| (&target.profile_id, &target.client_id, &target.path))
            .collect::<Vec<_>>()
    );
    assert_eq!(snapshot.physical_targets.len(), 1);
    assert!(
        snapshot.physical_targets[0]
            .logical_target_ids
            .iter()
            .filter(|id| logical.iter().any(|target| target.id == **id))
            .count()
            >= 2
    );
}

#[test]
fn absent_registered_directories_are_unavailable_without_being_created() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Macos, &home))
        .unwrap();
    assert!(!home.join(".agents/skills").exists());
    assert!(snapshot
        .logical_targets
        .iter()
        .any(|target| !target.exists && !target.available));
    assert!(snapshot
        .instances
        .iter()
        .any(|instance| instance.client_presence == skillhub_core::agent::ClientPresence::Unknown));
}

#[test]
fn discovery_exposes_pi_and_deepseek_harness_native_targets() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    let project = workspace.path().join("project");
    std::fs::create_dir_all(home.join(".pi/agent/skills")).unwrap();
    std::fs::create_dir_all(home.join(".dsh/skills")).unwrap();
    std::fs::create_dir_all(project.join(".pi/skills")).unwrap();
    std::fs::create_dir_all(project.join(".dsh/skills")).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home).with_project_root(&project))
        .unwrap();

    for (profile_id, client_id, expected_paths) in [
        (
            "pi",
            "pi.coding-agent",
            vec![
                home.join(".pi").join("agent").join("skills"),
                project.join(".pi").join("skills"),
            ],
        ),
        (
            "deepseek-harness",
            "deepseek-harness.tui",
            vec![
                project.join(".dsh").join("skills"),
                home.join(".dsh").join("skills"),
            ],
        ),
        (
            "deepseek-harness",
            "deepseek-harness.web",
            vec![
                project.join(".dsh").join("skills"),
                home.join(".dsh").join("skills"),
            ],
        ),
    ] {
        let targets = snapshot
            .logical_targets
            .iter()
            .filter(|target| target.profile_id == profile_id && target.client_id == client_id)
            .filter(|target| target.exists)
            .collect::<Vec<_>>();
        let actual_paths = targets
            .iter()
            .map(|target| target.path.clone())
            .collect::<Vec<_>>();
        let expected_paths = expected_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(actual_paths, expected_paths, "paths for {client_id}");
        assert!(targets.iter().all(|target| target.marker == "SKILL.md"));
    }
}

#[cfg(unix)]
#[test]
fn symlinked_directory_is_merged_by_filesystem_identity() {
    use skillhub_core::agent::{
        AgentClient, AgentProfile, CallPolicy, ClientKind, DeploymentCapability,
        DirectoryPrecedence, PathCandidate, ProfileCatalog, TargetScope,
    };
    use std::os::unix::fs::symlink;
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    let real = workspace.path().join("real-skills");
    std::fs::create_dir_all(real.join("skills")).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    symlink(&real, home.join("linked")).unwrap();

    let candidate = |path: &str, scope: TargetScope| PathCandidate {
        path: path.into(),
        scope,
        precedence: DirectoryPrecedence::Preferred,
        marker: "SKILL.md".into(),
        shared_reference: false,
        builtin: false,
    };
    let client = |id: &str, path: PathCandidate| AgentClient {
        id: id.into(),
        display_name: id.into(),
        kind: ClientKind::Cli,
        supported_os: vec![OperatingSystem::Macos],
        path_candidates: vec![path],
        skill_marker: "SKILL.md".into(),
        deployment: DeploymentCapability {
            copy: true,
            symlink: false,
            junction: false,
            limitations: vec![],
        },
        call_policy: CallPolicy::Unknown,
    };
    let catalog = ProfileCatalog {
        profiles: vec![AgentProfile {
            profile_version: 1,
            research_date: "2026-08-21".into(),
            official_references: vec!["https://example.com".into()],
            brand: "Fixture".into(),
            clients: vec![
                client(
                    "fixture.link",
                    candidate("{user_home}/linked/skills", TargetScope::Global),
                ),
                client(
                    "fixture.real",
                    candidate("{project_root}/skills", TargetScope::Project),
                ),
            ],
        }],
    };

    let snapshot = DiscoverAgents::new(catalog)
        .discover(&DiscoveryRoots::new(OperatingSystem::Macos, &home).with_project_root(&real))
        .unwrap();
    assert_eq!(snapshot.physical_targets.len(), 1);
    assert_eq!(snapshot.physical_targets[0].logical_target_ids.len(), 2);
    assert_eq!(
        snapshot.physical_targets[0].case_behavior,
        "volume_case_behavior_unknown_preserved_case_fallback"
    );
}

#[cfg(windows)]
#[test]
fn windows_alias_paths_are_merged_by_filesystem_identity() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    let alias = home.join("..").join("home");
    std::fs::create_dir_all(home.join("skills")).unwrap();
    let snapshot = DiscoverAgents::new(alias_catalog())
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home).with_project_root(alias))
        .unwrap();
    assert_eq!(snapshot.physical_targets.len(), 1);
    assert_eq!(snapshot.physical_targets[0].logical_target_ids.len(), 2);
    assert_eq!(
        snapshot.physical_targets[0].case_behavior,
        "case_insensitive_normalization"
    );
}

#[cfg(windows)]
fn alias_catalog() -> skillhub_core::agent::ProfileCatalog {
    use skillhub_core::agent::{
        AgentClient, AgentProfile, CallPolicy, ClientKind, DeploymentCapability,
        DirectoryPrecedence, PathCandidate, TargetScope,
    };
    let client = |id: &str, path: &str, scope| AgentClient {
        id: id.into(),
        display_name: id.into(),
        kind: ClientKind::Cli,
        supported_os: vec![OperatingSystem::Windows],
        path_candidates: vec![PathCandidate {
            path: path.into(),
            scope,
            precedence: DirectoryPrecedence::Preferred,
            marker: "SKILL.md".into(),
            shared_reference: false,
            builtin: false,
        }],
        skill_marker: "SKILL.md".into(),
        deployment: DeploymentCapability {
            copy: true,
            symlink: false,
            junction: false,
            limitations: vec![],
        },
        call_policy: CallPolicy::Unknown,
    };
    skillhub_core::agent::ProfileCatalog {
        profiles: vec![AgentProfile {
            profile_version: 1,
            research_date: "2026-08-21".into(),
            official_references: vec!["https://example.com".into()],
            brand: "Fixture".into(),
            clients: vec![
                client("fixture.user", "{user_home}/skills", TargetScope::Global),
                client(
                    "fixture.project",
                    "{project_root}/skills",
                    TargetScope::Project,
                ),
            ],
        }],
    }
}

#[test]
fn zcode_desktop_is_available_in_agents_skills_and_shares_one_physical_target_with_codex_cli() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    let zcode = snapshot
        .logical_targets
        .iter()
        .find(|target| target.profile_id == "zcode" && target.client_id == "zcode.desktop")
        .expect("zcode.desktop logical target");
    assert!(
        zcode.available,
        "home 只有 ~/.agents/skills 时 zcode.desktop 必须可用"
    );
    let codex = snapshot
        .logical_targets
        .iter()
        .find(|target| {
            target.profile_id == "openai"
                && target.client_id == "openai.codex-cli"
                && (target.path.ends_with(".agents\\skills")
                    || target.path.ends_with(".agents/skills"))
        })
        .expect("codex-cli logical target");
    assert!(codex.available);
    assert_eq!(
        zcode.physical_id, codex.physical_id,
        "不同品牌 client 指向同一物理目录时必须合并到同一物理目标"
    );
}

#[test]
fn read_only_directory_is_not_reported_as_writable() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    let target = home.join(".agents/skills");
    std::fs::create_dir_all(&target).unwrap();
    let mut permissions = std::fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&target, permissions).unwrap();
    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    let target = snapshot
        .logical_targets
        .iter()
        .find(|target| {
            target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills")
        })
        .unwrap();
    assert!(target.exists && target.readable);
    assert!(!target.writable);
}

#[test]
fn generic_agents_directory_has_exactly_one_ownership_target_per_scope() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    let project = workspace.path().join("project");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();
    std::fs::create_dir_all(project.join(".agents/skills")).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home).with_project_root(&project))
        .unwrap();

    let owners = snapshot
        .logical_targets
        .iter()
        .filter(|target| {
            (target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills"))
                && !target.shared_reference
        })
        .collect::<Vec<_>>();
    assert_eq!(
        owners.len(),
        2,
        "每个作用域只能有一个归属条目，实际: {:?}",
        snapshot
            .logical_targets
            .iter()
            .map(|target| (&target.profile_id, &target.client_id, &target.path))
            .collect::<Vec<_>>()
    );
    assert!(owners
        .iter()
        .all(|target| target.profile_id == "agent-skills"
            && target.client_id == "agent-skills.shared-directory"));
    assert_eq!(
        owners
            .iter()
            .filter(|target| target.scope == skillhub_core::agent::TargetScope::Global)
            .count(),
        1
    );
    assert_eq!(
        owners
            .iter()
            .filter(|target| target.scope == skillhub_core::agent::TargetScope::Project)
            .count(),
        1
    );
    assert!(owners.iter().all(|target| target.available));

    // 品牌侧仍然看到共享目录可用（部署/扫描语义不回归），但全部降级为
    // shared_reference，不再各自产出归属条目。
    let references = snapshot
        .logical_targets
        .iter()
        .filter(|target| {
            (target.path.ends_with(".agents\\skills") || target.path.ends_with(".agents/skills"))
                && target.shared_reference
        })
        .collect::<Vec<_>>();
    assert!(
        references.len() >= 10,
        "品牌共享引用数量不应回退（实际 {}）",
        references.len()
    );
    assert!(references
        .iter()
        .all(|target| target.profile_id != "agent-skills"));
    assert!(
        references.iter().all(|target| target.available),
        "品牌共享引用必须保留目录可用性语义"
    );
    assert!(references
        .iter()
        .any(|target| target.profile_id == "openai" && target.client_id == "openai.codex-cli"));
    assert!(references
        .iter()
        .any(|target| target.profile_id == "zcode" && target.client_id == "zcode.desktop"));
}

#[test]
fn generic_ownership_target_resolves_the_user_home_placeholder_per_platform() {
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".agents/skills")).unwrap();

    let snapshot = DiscoverAgents::builtin()
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    let target = snapshot
        .logical_targets
        .iter()
        .find(|target| target.profile_id == "agent-skills" && !target.shared_reference)
        .expect("通用归属条目");
    // `{user_home}` 占位符经 PathBuf 展开：Windows 形态为
    // `{user_home}\.agents\skills`（反斜杠由宿主 PathBuf 决定），
    // POSIX 形态为 `{user_home}/.agents/skills`。这里锁定两种平台下
    // 展开结果都与 user_home 精确拼接，而不是字符串替换残留。
    assert_eq!(
        target.path,
        home.join(".agents")
            .join("skills")
            .to_string_lossy()
            .into_owned()
    );
    let expected_suffix = if cfg!(windows) {
        ".agents\\skills"
    } else {
        ".agents/skills"
    };
    assert!(
        target.path.ends_with(expected_suffix),
        "Windows/宿主路径形态必须由 PathBuf 决定：{}",
        target.path
    );
}

#[test]
fn spelling_variants_of_one_directory_collapse_to_one_logical_target_per_client_scope() {
    // DEV-5：同一 client 同一 scope 下，仅斜杠/点段拼写不同的同一路径必须
    // 按 (physical_id, scope) 归并为一条 logical target；不同 client 仍各留
    // 一条（保留"同目录、不同客户端"的语义）。
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join("skills")).unwrap();

    use skillhub_core::agent::{
        AgentClient, AgentProfile, CallPolicy, ClientKind, DeploymentCapability,
        DirectoryPrecedence, PathCandidate, TargetScope,
    };
    let candidate = |path: &str| PathCandidate {
        path: path.into(),
        scope: TargetScope::Global,
        precedence: DirectoryPrecedence::Preferred,
        marker: "SKILL.md".into(),
        shared_reference: false,
        builtin: false,
    };
    let client = AgentClient {
        id: "fixture.user".into(),
        display_name: "Fixture".into(),
        kind: ClientKind::Cli,
        supported_os: vec![OperatingSystem::Windows, OperatingSystem::Macos],
        path_candidates: vec![
            candidate("{user_home}/skills"),
            candidate("{user_home}/./skills"),
        ],
        skill_marker: "SKILL.md".into(),
        deployment: DeploymentCapability {
            copy: true,
            symlink: false,
            junction: false,
            limitations: vec![],
        },
        call_policy: CallPolicy::Unknown,
    };
    let catalog = skillhub_core::agent::ProfileCatalog {
        profiles: vec![AgentProfile {
            profile_version: 1,
            research_date: "2026-09-20".into(),
            official_references: vec!["https://example.com".into()],
            brand: "Fixture".into(),
            clients: vec![client],
        }],
    };

    let snapshot = DiscoverAgents::new(catalog)
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    assert_eq!(
        snapshot.logical_targets.len(),
        1,
        "logical targets: {:?}",
        snapshot
            .logical_targets
            .iter()
            .map(|target| (&target.client_id, &target.scope, &target.path))
            .collect::<Vec<_>>()
    );
    assert_eq!(snapshot.physical_targets.len(), 1);
    assert_eq!(snapshot.physical_targets[0].logical_target_ids.len(), 1);
}

#[test]
fn builtin_candidates_flow_into_logical_targets_as_platform_read_only_roots() {
    // 2026-09-25 验收裁决：内置技能目录在 profile 候选层声明（builtin=true），
    // 发现层必须原样落到 LogicalTarget，供只读内置卡片与部署门控消费；
    // 普通候选默认 builtin=false，存量快照反序列化也不受影响。
    let workspace = tempdir().unwrap();
    let home = workspace.path().join("home");
    std::fs::create_dir_all(home.join(".codex/skills/.system")).unwrap();

    use skillhub_core::agent::{
        AgentClient, AgentProfile, CallPolicy, ClientKind, DeploymentCapability,
        DirectoryPrecedence, PathCandidate, TargetScope,
    };
    let candidate = |path: &str, builtin: bool| PathCandidate {
        path: path.into(),
        scope: TargetScope::Global,
        precedence: DirectoryPrecedence::Preferred,
        marker: "SKILL.md".into(),
        shared_reference: false,
        builtin,
    };
    let client = AgentClient {
        id: "fixture.cli".into(),
        display_name: "Fixture".into(),
        kind: ClientKind::Cli,
        supported_os: vec![OperatingSystem::Windows, OperatingSystem::Macos],
        path_candidates: vec![
            candidate("{user_home}/.codex/skills", false),
            candidate("{user_home}/.codex/skills/.system", true),
        ],
        skill_marker: "SKILL.md".into(),
        deployment: DeploymentCapability {
            copy: true,
            symlink: false,
            junction: false,
            limitations: vec![],
        },
        call_policy: CallPolicy::Unknown,
    };
    let catalog = skillhub_core::agent::ProfileCatalog {
        profiles: vec![AgentProfile {
            profile_version: 1,
            research_date: "2026-09-25".into(),
            official_references: vec!["https://example.com".into()],
            brand: "Fixture".into(),
            clients: vec![client],
        }],
    };

    let snapshot = DiscoverAgents::new(catalog)
        .discover(&DiscoveryRoots::new(OperatingSystem::Windows, &home))
        .unwrap();
    assert_eq!(snapshot.logical_targets.len(), 2);
    let builtin = snapshot
        .logical_targets
        .iter()
        .find(|target| target.path.ends_with(".system"))
        .expect("builtin candidate expands to a logical target");
    assert!(
        builtin.builtin,
        "builtin candidate must stay marked builtin"
    );
    assert!(builtin.available, "existing builtin directory is available");
    let user = snapshot
        .logical_targets
        .iter()
        .find(|target| !target.path.ends_with(".system"))
        .expect("user-level candidate expands to a logical target");
    assert!(!user.builtin, "plain candidates must not be marked builtin");

    let json = serde_json::to_string(&snapshot).unwrap();
    assert!(
        json.contains("\"builtin\":true"),
        "builtin flag must be serialized for downstream consumers"
    );
}
