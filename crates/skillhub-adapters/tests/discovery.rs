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
        2,
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
    };
    let client = |id: &str, path: PathCandidate| AgentClient {
        id: id.into(),
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
        kind: ClientKind::Cli,
        supported_os: vec![OperatingSystem::Windows],
        path_candidates: vec![PathCandidate {
            path: path.into(),
            scope,
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
