use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    AgentRootObservation, ClientInstance, ClientKind, ClientPresence,
    DirectoryObservationStatus, DirectoryPrecedence, DiscoverySnapshot, LogicalTarget,
    OperatingSystem, TargetScope,
};
use skillhub_core::api::{
    AppCommand as RootAppCommand, AppCommandResult, AppQuery as RootAppQuery, AppQueryResult,
    EnsureAgentTargetDirectory, GetAgentDirectoryProjection, GetDeploymentPlan,
    ListDeploymentTargets,
};
use skillhub_core::catalog::CatalogRepository;
use skillhub_core::deployment::DeploymentPlanRequest;
use skillhub_core::{ApplicationFacade, DeploymentMode, DeploymentRepository, ErrorCode, VersionId};
use skillhub_storage::{CentralLibrary, Database};

/// 内置目录测试基座：一个可用（exists/readable/writable）的内置逻辑目标。
async fn facade_with_builtin_target() -> (LocalApplicationFacade, tempfile::TempDir) {
    let database_dir = tempfile::tempdir().expect("database dir");
    let database = Database::open(database_dir.path().join("skillhub.sqlite")).expect("database");
    let target_root = tempfile::tempdir().expect("builtin target root");
    let physical_id =
        skillhub_core::physical_id_for_path(target_root.path()).expect("target identity");
    let snapshot = DiscoverySnapshot {
        generation: "1".into(),
        observed_at: "2026-09-25T00:00:00Z".into(),
        instances: vec![ClientInstance {
            profile_id: "openai-codex".into(),
            client_id: "codex.cli".into(),
            kind: ClientKind::Cli,
            display_name: "Codex CLI".into(),
            supported_os: vec![OperatingSystem::Windows],
            client_presence: ClientPresence::Unknown,
        }],
        logical_targets: vec![LogicalTarget {
            id: "openai-codex:codex.cli:global:builtin-system".into(),
            profile_id: "openai-codex".into(),
            client_id: "codex.cli".into(),
            scope: TargetScope::Global,
            path: target_root.path().to_string_lossy().into_owned(),
            agent_root_id: "fixture-root".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::MayCoexist,
            shared_reference: false,
            builtin: true,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id,
            status: skillhub_core::agent::DirectoryObservationStatus::Existing,
            physical_identity_verified: true,
        }],
        physical_targets: Vec::new(),
        agent_roots: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("central library");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    (facade, target_root)
}

/// 2026-09-25 验收裁决：内置技能目录只读观察，SkillHub 不提供部署/删除。
/// 部署目标清单不得列出内置目录；按逻辑目标 id 直接请求部署计划必须拒绝。
#[tokio::test]
async fn builtin_directories_are_not_deployment_targets() {
    let (facade, _target_root) = facade_with_builtin_target().await;

    let listed = facade
        .query(RootAppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list deployment targets");
    let AppQueryResult::DeploymentTargets(targets) = listed else {
        panic!("expected deployment targets");
    };
    assert!(
        targets.is_empty(),
        "builtin directories must not be offered as deployment targets: {targets:?}"
    );

    let planned = facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: DeploymentPlanRequest {
                skill_id: skillhub_core::SkillId::new(),
                version_id: VersionId::parse(&format!("sha256:{}", "a".repeat(64))).unwrap(),
                runtime_name: "any".into(),
                logical_target_ids: vec!["openai-codex:codex.cli:global:builtin-system".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await;
    let error = planned.expect_err("planning against a builtin directory must be rejected");
    assert_eq!(
        error.code,
        ErrorCode::ObjectNotFound,
        "builtin logical targets stay out of the registered deployment index"
    );
}

#[tokio::test]
async fn identified_agent_with_missing_skill_directory_is_listed_as_pending_target() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let skill_path = root.path().join("skills");
    let root_path = root.path().to_string_lossy().into_owned();
    let snapshot = DiscoverySnapshot {
        generation: "1".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: vec![ClientInstance {
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            kind: ClientKind::Cli,
            display_name: "Fixture".into(),
            supported_os: vec![OperatingSystem::Macos],
            client_presence: ClientPresence::Unknown,
        }],
        agent_roots: vec![AgentRootObservation {
            id: "fixture-root".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: root_path,
            status: DirectoryObservationStatus::Existing,
            exists: true,
            readable: true,
            writable: true,
            physical_id: Some("fs:root".into()),
            physical_identity_verified: true,
        }],
        logical_targets: vec![LogicalTarget {
            id: "fixture-target".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: skill_path.to_string_lossy().into_owned(),
            agent_root_id: "fixture-root".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: false,
            builtin: false,
            exists: false,
            readable: false,
            writable: false,
            available: false,
            physical_id: "path:pending".into(),
            status: DirectoryObservationStatus::Missing,
            physical_identity_verified: false,
        }],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let facade = LocalApplicationFacade::new(database);

    let listed = facade
        .query(RootAppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list deployment targets");
    let AppQueryResult::DeploymentTargets(targets) = listed else {
        panic!("expected deployment targets");
    };
    assert_eq!(targets.len(), 1);
    assert!(!targets[0].available);
    assert_eq!(
        targets[0].directory_status,
        Some(DirectoryObservationStatus::Missing)
    );
    assert!(!targets[0].physical_identity_verified);
    assert!(!targets[0].modes.is_empty());
}

#[tokio::test]
async fn agent_directory_projection_preserves_member_identity_and_capabilities() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let shared_path = root.path().join("shared");
    let ordinary_path = root.path().join("ordinary");
    let distinct_path = root.path().join("distinct");
    let candidate_path = root.path().join("candidate");
    std::fs::create_dir_all(&shared_path).expect("shared path");
    std::fs::create_dir_all(&ordinary_path).expect("ordinary path");
    std::fs::create_dir_all(&distinct_path).expect("distinct path");
    let ordinary_physical_id = skillhub_core::physical_id_for_path(&ordinary_path)
        .expect("ordinary directory identity");

    let instance = |client_id: &str, kind| ClientInstance {
        profile_id: if client_id == "agent-skills" {
            "agent-skills"
        } else {
            "openai"
        }
        .into(),
        client_id: client_id.into(),
        kind,
        display_name: client_id.into(),
        supported_os: vec![OperatingSystem::Windows],
        client_presence: ClientPresence::Unknown,
    };
    let root_observation = |id: &str, client_id: &str| AgentRootObservation {
        id: id.into(),
        profile_id: if client_id == "agent-skills" {
            "agent-skills"
        } else {
            "openai"
        }
        .into(),
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: root.path().to_string_lossy().into_owned(),
        status: DirectoryObservationStatus::Existing,
        exists: true,
        readable: true,
        writable: true,
        physical_id: Some(format!("root:{id}")),
        physical_identity_verified: true,
    };
    let logical = |id: &str,
                   client_id: &str,
                   path: &std::path::Path,
                   physical_id: &str,
                   verified: bool,
                   shared| LogicalTarget {
        id: id.into(),
        profile_id: if client_id == "agent-skills" {
            "agent-skills"
        } else {
            "openai"
        }
        .into(),
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: path.to_string_lossy().into_owned(),
        agent_root_id: format!("root:{client_id}"),
        marker: "SKILL.md".into(),
        precedence: DirectoryPrecedence::Preferred,
        shared_reference: shared,
        builtin: false,
        exists: path.exists(),
        readable: path.exists(),
        writable: path.exists(),
        available: path.exists(),
        physical_id: physical_id.into(),
        status: if path.exists() {
            DirectoryObservationStatus::Existing
        } else {
            DirectoryObservationStatus::Missing
        },
        physical_identity_verified: verified,
    };

    let mut other_brand_instance = instance("other-brand.cli", ClientKind::Cli);
    other_brand_instance.profile_id = "other-brand".into();
    let mut other_brand_target = logical(
        "other-brand-same-directory",
        "other-brand.cli",
        &ordinary_path,
        &ordinary_physical_id,
        true,
        false,
    );
    other_brand_target.profile_id = "other-brand".into();
    other_brand_target.agent_root_id = "root:other-brand.cli".into();
    let snapshot = DiscoverySnapshot {
        generation: "projection-test".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: vec![
            instance("openai.codex-cli", ClientKind::Cli),
            instance("openai.chatgpt-desktop", ClientKind::Desktop),
            instance("openai.codex-ide", ClientKind::IdeExtension),
            instance("openai.unknown-root", ClientKind::Cli),
            instance("agent-skills", ClientKind::SharedDirectory),
            other_brand_instance,
        ],
        agent_roots: vec![
            root_observation("root:openai.codex-cli", "openai.codex-cli"),
            root_observation("root:openai.chatgpt-desktop", "openai.chatgpt-desktop"),
            root_observation("root:openai.codex-ide", "openai.codex-ide"),
            root_observation("root:agent-skills", "agent-skills"),
            root_observation("root:other-brand.cli", "other-brand.cli"),
        ],
        logical_targets: vec![
            logical(
                "shared-canonical",
                "agent-skills",
                &shared_path,
                "physical:shared",
                true,
                true,
            ),
            logical(
                "shared-cli",
                "openai.codex-cli",
                &shared_path,
                "physical:shared",
                true,
                true,
            ),
            logical(
                "shared-unidentified",
                "openai.unknown-root",
                &shared_path,
                "physical:shared",
                true,
                true,
            ),
            logical(
                "ordinary-cli",
                "openai.codex-cli",
                &ordinary_path,
                &ordinary_physical_id,
                true,
                false,
            ),
            logical(
                "ordinary-desktop",
                "openai.chatgpt-desktop",
                &ordinary_path,
                &ordinary_physical_id,
                true,
                false,
            ),
            other_brand_target,
            {
                let mut target = logical(
                    "ordinary-builtin",
                    "openai.codex-cli",
                    &ordinary_path,
                    &ordinary_physical_id,
                    true,
                    false,
                );
                target.builtin = true;
                target
            },
            logical(
                "ordinary-shared",
                "openai.codex-cli",
                &ordinary_path,
                &ordinary_physical_id,
                true,
                true,
            ),
            logical(
                "distinct-ide",
                "openai.codex-ide",
                &distinct_path,
                "physical:distinct",
                true,
                false,
            ),
            logical(
                "candidate-cli",
                "openai.codex-cli",
                &candidate_path,
                "candidate:same-text",
                false,
                false,
            ),
            logical(
                "candidate-cli-second",
                "openai.codex-cli",
                &candidate_path,
                "candidate:same-text",
                false,
                false,
            ),
            logical(
                "candidate-desktop",
                "openai.chatgpt-desktop",
                &candidate_path,
                "candidate:same-text",
                false,
                false,
            ),
        ],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save snapshot");
    let project = skillhub_core::project::Project::new(
        skillhub_core::ProjectId::new(),
        "Same physical directory as an Agent",
        &ordinary_path,
    );
    database
        .project_repository()
        .register(project)
        .expect("register project fact");
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .query(RootAppQuery::GetAgentDirectoryProjection(
            GetAgentDirectoryProjection,
        ))
        .await
        .expect("projection query");
    let AppQueryResult::AgentDirectoryProjection(projection) = result else {
        panic!("expected directory projection");
    };

    let shared = projection
        .directories
        .iter()
        .find(|fact| {
            fact.members
                .iter()
                .any(|member| member.logical_target_id == "shared-canonical")
        })
        .expect("shared entity");
    assert_eq!(
        shared.members.len(),
        2,
        "canonical target and recognized brand association are members"
    );
    assert_eq!(
        shared.role,
        skillhub_core::AgentDirectoryRole::SharedDirectory
    );
    assert_eq!(
        projection
            .directories
            .iter()
            .filter(|fact| fact.members.iter().any(|member| {
                member.logical_target_id == "shared-canonical"
                    || member.logical_target_id == "shared-cli"
            }))
            .count(),
        1,
        "one shared physical directory produces exactly one entity"
    );
    assert!(shared
        .members
        .iter()
        .all(|member| member.logical_target_id != "shared-unidentified"));
    assert!(shared
        .members
        .iter()
        .any(|member| member.logical_target_id == "shared-cli"
            && member.kind == Some(ClientKind::Cli)));

    let same_physical_identity = projection
        .directories
        .iter()
        .filter(|fact| {
            fact.identity
                == skillhub_core::AgentDirectoryIdentity::VerifiedPhysical(
                    ordinary_physical_id.clone(),
                )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        same_physical_identity.len(),
        5,
        "brand and role boundaries plus the independent project entity"
    );
    let ordinary = same_physical_identity
        .iter()
        .find(|fact| fact.role != skillhub_core::AgentDirectoryRole::Project)
        .expect("Agent entity");
    assert_eq!(
        ordinary.role,
        skillhub_core::AgentDirectoryRole::AgentNative
    );
    assert_eq!(
        ordinary.members.len(),
        2,
        "same brand and role combine client kinds without merging other roles"
    );
    assert!(ordinary
        .members
        .iter()
        .any(|member| member.kind == Some(ClientKind::Cli)));
    assert!(ordinary
        .members
        .iter()
        .any(|member| member.kind == Some(ClientKind::Desktop)));
    let builtin = same_physical_identity
        .iter()
        .find(|fact| fact.role == skillhub_core::AgentDirectoryRole::Builtin)
        .expect("builtin entity remains independent");
    assert_eq!(builtin.members.len(), 1);
    assert_eq!(builtin.members[0].logical_target_id, "ordinary-builtin");
    let shared_entities = same_physical_identity
        .iter()
        .filter(|fact| fact.role == skillhub_core::AgentDirectoryRole::SharedDirectory)
        .collect::<Vec<_>>();
    assert_eq!(
        shared_entities.len(),
        1,
        "shared directory is one independent entity"
    );
    assert_eq!(shared_entities[0].members.len(), 1);
    assert_eq!(
        shared_entities[0].members[0].logical_target_id,
        "ordinary-shared"
    );
    let other_brand = same_physical_identity
        .iter()
        .find(|fact| {
            fact.members
                .iter()
                .any(|member| member.brand.as_deref() == Some("other-brand"))
        })
        .expect("other brand remains independent");
    assert_eq!(
        other_brand.role,
        skillhub_core::AgentDirectoryRole::AgentNative
    );
    assert_eq!(other_brand.members.len(), 1);
    let cli_member = ordinary
        .members
        .iter()
        .find(|member| member.logical_target_id == "ordinary-cli")
        .expect("CLI member");
    let desktop_member = ordinary
        .members
        .iter()
        .find(|member| member.logical_target_id == "ordinary-desktop")
        .expect("desktop member");
    let host = skillhub_adapters::deployment::DeploymentFilesystem::new().available_capabilities();
    let profiles = skillhub_core::ProfileCatalog::builtin();
    let cli_declared = profiles
        .deployment_capability_for_client("openai.codex-cli")
        .expect("CLI profile capability");
    let desktop_declared = profiles
        .deployment_capability_for_client("openai.chatgpt-desktop")
        .expect("desktop profile capability");
    let expected_cli = host.intersect(cli_declared);
    let expected_desktop = host.intersect(desktop_declared);
    let modes = |capability: &skillhub_core::DeploymentCapability| {
        [
            (capability.symlink, DeploymentMode::SymbolicLink),
            (capability.junction, DeploymentMode::DirectoryJunction),
            (capability.copy, DeploymentMode::ManagedCopy),
        ]
        .into_iter()
        .filter_map(|(supported, mode)| supported.then_some(mode))
        .collect::<Vec<_>>()
    };
    assert_eq!(cli_member.capabilities.deployment, expected_cli);
    assert_eq!(cli_member.capabilities.modes, modes(&expected_cli));
    assert_eq!(
        cli_member.capabilities.preferred_mode,
        modes(&expected_cli).first().copied()
    );
    assert_eq!(desktop_member.capabilities.deployment, expected_desktop);
    assert_eq!(desktop_member.capabilities.modes, modes(&expected_desktop));
    assert_eq!(
        desktop_member.capabilities.preferred_mode,
        modes(&expected_desktop).first().copied()
    );
    assert!(ordinary
        .members
        .iter()
        .all(|member| member.availability.status == DirectoryObservationStatus::Existing));
    assert!(ordinary
        .members
        .iter()
        .all(|member| member.availability.available));
    assert!(same_physical_identity
        .iter()
        .any(|fact| fact.role == skillhub_core::AgentDirectoryRole::Project
            && fact.members.len() == 1));

    assert!(
        projection.directories.iter().any(|fact| fact
            .members
            .iter()
            .any(|member| member.logical_target_id == "distinct-ide")),
        "different physical paths remain separate"
    );
    let candidates: Vec<_> = projection
        .directories
        .iter()
        .filter(|fact| {
            fact.members
                .iter()
                .any(|member| member.logical_target_id.starts_with("candidate-"))
        })
        .collect();
    assert_eq!(
        candidates.len(),
        2,
        "candidate identity is scoped to the observing Agent root"
    );
    assert!(candidates.iter().all(|fact| !fact.identity.is_verified()));
    assert!(
        candidates.iter().any(|fact| fact.members.len() == 2),
        "same root and candidate identity can group targets"
    );
    assert_ne!(candidates[0].identity, candidates[1].identity);
}

#[tokio::test]
async fn agent_directory_projection_keeps_abnormal_agent_root_observations() {
    let database = Database::open_in_memory().expect("database");
    let fixture_root = tempfile::tempdir().expect("fixture root");
    let statuses = [
        DirectoryObservationStatus::NonDirectory,
        DirectoryObservationStatus::Inaccessible,
        DirectoryObservationStatus::BrokenLink,
    ];
    let mut roots = Vec::new();
    let mut targets = Vec::new();
    for (index, status) in statuses.into_iter().enumerate() {
        let id = format!("root-{index}");
        roots.push(AgentRootObservation {
            id: id.clone(),
            profile_id: format!("fixture-{index}"),
            client_id: format!("fixture-{index}.cli"),
            scope: TargetScope::Global,
            path: fixture_root.path().join(&id).to_string_lossy().into_owned(),
            status,
            exists: false,
            readable: false,
            writable: false,
            physical_id: None,
            physical_identity_verified: false,
        });
        targets.push(LogicalTarget {
            id: format!("target-{index}"),
            profile_id: format!("fixture-{index}"),
            client_id: format!("fixture-{index}.cli"),
            scope: TargetScope::Global,
            path: fixture_root
                .path()
                .join(&id)
                .join("skills")
                .to_string_lossy()
                .into_owned(),
            agent_root_id: id,
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: false,
            builtin: false,
            exists: false,
            readable: false,
            writable: false,
            available: false,
            physical_id: format!("candidate-{index}"),
            status: DirectoryObservationStatus::Missing,
            physical_identity_verified: false,
        });
    }
    let snapshot = DiscoverySnapshot {
        generation: "abnormal-roots".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: Vec::new(),
        agent_roots: roots,
        logical_targets: targets,
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .query(RootAppQuery::GetAgentDirectoryProjection(GetAgentDirectoryProjection))
        .await
        .expect("query projection");
    let AppQueryResult::AgentDirectoryProjection(projection) = result else {
        panic!("expected Agent directory projection");
    };

    assert_eq!(
        projection.directories.len(),
        3,
        "abnormal roots must remain visible"
    );
    assert_eq!(
        projection
            .directories
            .iter()
            .map(|directory| directory.status)
            .collect::<Vec<_>>(),
        statuses,
        "a failed root observation must not be rewritten as a missing skill directory"
    );
    let result = facade
        .query(RootAppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list abnormal targets");
    let AppQueryResult::DeploymentTargets(targets) = result else {
        panic!("expected deployment targets");
    };
    assert_eq!(
        targets.iter().map(|target| target.directory_status).collect::<Vec<_>>(),
        statuses.into_iter().map(Some).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn agent_directory_projection_preserves_identity_changed_status() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let skills_path = root.path().join("skills");
    std::fs::create_dir(&skills_path).expect("create replacement skills directory");
    let current_identity =
        skillhub_core::physical_id_for_path(&skills_path).expect("current identity");
    let skill =
        skillhub_core::catalog::Skill::new(skillhub_core::SkillId::new(), "Identity changed");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id =
        VersionId::parse(&format!("sha256:{}", "d".repeat(64))).expect("version id");
    database.connection_for_test().execute(
        "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
        rusqlite::params![version_id.to_string(), skill.id().to_string()],
    )
    .expect("insert version");
    let old_identity = "fs:old-directory-identity";
    database.connection_for_test().execute(
        "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'fixture.cli', 'global', ?2, 0)",
        rusqlite::params![old_identity, skills_path.to_string_lossy().into_owned()],
    )
    .expect("register old physical identity");
    database.connection_for_test().execute(
        "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'deployed', 'managed_copy', 1, 'example', 'hash', 'hash', 0, 0)",
        rusqlite::params![skillhub_core::DeploymentId::new().to_string(), skill.id().to_string(), version_id.to_string(), old_identity],
    )
    .expect("register active deployment");
    let snapshot = DiscoverySnapshot {
        generation: "identity-changed".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: Vec::new(),
        agent_roots: vec![AgentRootObservation {
            id: "root".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: root.path().to_string_lossy().into_owned(),
            status: DirectoryObservationStatus::Existing,
            exists: true,
            readable: true,
            writable: true,
            physical_id: Some("root-physical".into()),
            physical_identity_verified: true,
        }],
        logical_targets: vec![LogicalTarget {
            id: "target".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: skills_path.to_string_lossy().into_owned(),
            agent_root_id: "root".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: false,
            builtin: false,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id: current_identity,
            status: DirectoryObservationStatus::Existing,
            physical_identity_verified: true,
        }],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .query(RootAppQuery::GetAgentDirectoryProjection(GetAgentDirectoryProjection))
        .await
        .expect("query projection");
    let AppQueryResult::AgentDirectoryProjection(projection) = result else {
        panic!("expected Agent directory projection");
    };
    assert_eq!(projection.directories.len(), 1);
    assert_eq!(
        projection.directories[0].status,
        DirectoryObservationStatus::IdentityChanged
    );
    assert_eq!(
        projection.directories[0].members[0].availability.status,
        DirectoryObservationStatus::IdentityChanged
    );
    assert!(!projection.directories[0].available);
    let result = facade
        .query(RootAppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list identity-changed target");
    let AppQueryResult::DeploymentTargets(targets) = result else {
        panic!("expected deployment targets");
    };
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].directory_status, Some(DirectoryObservationStatus::IdentityChanged));
    assert!(!targets[0].available);
}

#[tokio::test]
async fn unresolved_registered_and_observed_paths_do_not_prove_identity_changed() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let skills_path = root.path().join("skills");
    std::fs::create_dir(&skills_path).expect("create skills directory");
    let stale_identity =
        skillhub_core::physical_id_for_path(&skills_path).expect("stale identity");
    let skill = skillhub_core::catalog::Skill::new(skillhub_core::SkillId::new(), "Stale scan");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id = VersionId::parse(&format!("sha256:{}", "e".repeat(64))).expect("version id");
    database.connection_for_test().execute(
        "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
        rusqlite::params![version_id.to_string(), skill.id().to_string()],
    ).expect("insert version");
    database.connection_for_test().execute(
        "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'fixture.cli', 'global', ?2, 0)",
        rusqlite::params![stale_identity, skills_path.to_string_lossy().into_owned()],
    ).expect("register stale target");
    database.connection_for_test().execute(
        "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'deployed', 'managed_copy', 1, 'example', 'hash', 'hash', 0, 0)",
        rusqlite::params![skillhub_core::DeploymentId::new().to_string(), skill.id().to_string(), version_id.to_string(), stale_identity],
    ).expect("insert stale deployment");
    std::fs::remove_dir(&skills_path).expect("remove observed directory");

    let snapshot = DiscoverySnapshot {
        generation: "stale-unresolved-identity".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: Vec::new(),
        agent_roots: vec![AgentRootObservation {
            id: "root".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: root.path().to_string_lossy().into_owned(),
            status: DirectoryObservationStatus::Existing,
            exists: true,
            readable: true,
            writable: true,
            physical_id: Some("root-physical".into()),
            physical_identity_verified: true,
        }],
        logical_targets: vec![LogicalTarget {
            id: "target".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: skills_path.to_string_lossy().into_owned(),
            agent_root_id: "root".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: false,
            builtin: false,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id: "fs:replacement-observation".into(),
            status: DirectoryObservationStatus::Existing,
            physical_identity_verified: true,
        }],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .query(RootAppQuery::GetAgentDirectoryProjection(
            GetAgentDirectoryProjection,
        ))
        .await
        .expect("query projection");
    let AppQueryResult::AgentDirectoryProjection(projection) = result else {
        panic!("expected Agent directory projection");
    };
    assert_eq!(projection.directories.len(), 1);
    assert_eq!(
        projection.directories[0].status,
        DirectoryObservationStatus::Existing,
        "two failed canonicalizations must not be treated as matching paths"
    );
}

#[tokio::test]
async fn agent_directory_projection_reports_deployment_facts_per_logical_member() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let directory = root.path().join("skills");
    std::fs::create_dir_all(&directory).expect("skill directory");
    let physical_id = skillhub_core::physical_id_for_path(&directory).expect("physical identity");
    let make_instance = |client_id: &str, kind| ClientInstance {
        profile_id: "fixture".into(),
        client_id: client_id.into(),
        kind,
        display_name: client_id.into(),
        supported_os: vec![OperatingSystem::Windows],
        client_presence: ClientPresence::Unknown,
    };
    let make_root = |client_id: &str| AgentRootObservation {
        id: format!("root:{client_id}"),
        profile_id: "fixture".into(),
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: root.path().to_string_lossy().into_owned(),
        status: DirectoryObservationStatus::Existing,
        exists: true,
        readable: true,
        writable: true,
        physical_id: Some(format!("root:{client_id}")),
        physical_identity_verified: true,
    };
    let make_target = |client_id: &str| LogicalTarget {
        id: format!("fixture.{client_id}.target"),
        profile_id: "fixture".into(),
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: directory.to_string_lossy().into_owned(),
        agent_root_id: format!("root:{client_id}"),
        marker: "SKILL.md".into(),
        precedence: DirectoryPrecedence::Preferred,
        shared_reference: false,
        builtin: false,
        exists: true,
        readable: true,
        writable: true,
        available: true,
        physical_id: physical_id.clone(),
        status: DirectoryObservationStatus::Existing,
        physical_identity_verified: true,
    };
    let snapshot = DiscoverySnapshot {
        generation: "1".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: vec![
            make_instance("cli", ClientKind::Cli),
            make_instance("desktop", ClientKind::Desktop),
        ],
        agent_roots: vec![make_root("cli"), make_root("desktop")],
        logical_targets: vec![make_target("cli"), make_target("desktop")],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let skill = skillhub_core::catalog::Skill::new(skillhub_core::SkillId::new(), "Fixture skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let version_id = VersionId::parse(&format!("sha256:{}", "a".repeat(64))).expect("version id");
    database.connection_for_test().execute(
        "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES (?1,?2,'hash','{}',0)",
        rusqlite::params![version_id.to_string(), skill.id().to_string()],
    ).expect("insert version");
    database.connection_for_test().execute(
        "INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('fixture.cli.target','fixture','global','fixture',0)",
        [],
    ).expect("insert target");
    let deployment = skillhub_core::DeploymentRecord {
        id: skillhub_core::DeploymentId::new(),
        skill_id: skill.id(),
        version_id,
        target_id: "fixture.cli.target".into(),
        state: skillhub_core::DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "fixture-skill".into(),
        expected_hash: "sha256:tree".into(),
        observed_hash: Some("sha256:tree".into()),
    };
    database
        .deployment_repository()
        .insert(&deployment)
        .await
        .expect("insert deployment");
    let repository = database.deployment_repository();
    for (index, (state, managed)) in [
        (skillhub_core::DeploymentState::NeedsRecovery, true),
        (skillhub_core::DeploymentState::Removed, true),
        (skillhub_core::DeploymentState::Deployed, false),
    ]
    .into_iter()
    .enumerate()
    {
        let mut additional = deployment.clone();
        additional.id = skillhub_core::DeploymentId::new();
        additional.state = state;
        additional.managed = managed;
        additional.runtime_name = format!("fixture-skill-{index}");
        repository
            .insert(&additional)
            .await
            .expect("insert filtered deployment row");
    }
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .query(RootAppQuery::GetAgentDirectoryProjection(
            GetAgentDirectoryProjection,
        ))
        .await
        .expect("query Agent directory projection");
    let AppQueryResult::AgentDirectoryProjection(projection) = result else {
        panic!("expected Agent directory projection");
    };
    let directory = projection
        .directories
        .iter()
        .find(|fact| fact.members.len() == 2)
        .expect("one directory with both logical members");
    let deployed = directory
        .members
        .iter()
        .find(|member| member.client_id.as_deref() == Some("cli"))
        .expect("deployed member");
    let sibling = directory
        .members
        .iter()
        .find(|member| member.client_id.as_deref() == Some("desktop"))
        .expect("not-deployed sibling");

    assert_eq!(
        deployed.deployment_status,
        skillhub_core::AgentDirectoryDeploymentStatus::Deployed
    );
    assert_eq!(deployed.managed_deployment_relation_count, 2);
    assert_eq!(deployed.managed_deployment_count, 1);
    assert_eq!(
        sibling.deployment_status,
        skillhub_core::AgentDirectoryDeploymentStatus::NotDeployed
    );
    assert_eq!(sibling.managed_deployment_relation_count, 0);
    assert_eq!(sibling.managed_deployment_count, 0);
}

#[tokio::test]
async fn explicit_target_creation_creates_only_skill_directory_and_rescans() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let skill_path = root.path().join("skills");
    let snapshot = DiscoverySnapshot {
        generation: "1".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: vec![ClientInstance {
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            kind: ClientKind::Cli,
            display_name: "Fixture".into(),
            supported_os: vec![OperatingSystem::Macos],
            client_presence: ClientPresence::Unknown,
        }],
        agent_roots: vec![AgentRootObservation {
            id: "fixture-root".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: root.path().to_string_lossy().into_owned(),
            status: DirectoryObservationStatus::Existing,
            exists: true,
            readable: true,
            writable: true,
            physical_id: Some("fs:root".into()),
            physical_identity_verified: true,
        }],
        logical_targets: vec![LogicalTarget {
            id: "fixture-target".into(),
            profile_id: "fixture".into(),
            client_id: "fixture.cli".into(),
            scope: TargetScope::Global,
            path: skill_path.to_string_lossy().into_owned(),
            agent_root_id: "fixture-root".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: false,
            builtin: false,
            exists: false,
            readable: false,
            writable: false,
            available: false,
            physical_id: "path:pending".into(),
            status: DirectoryObservationStatus::Missing,
            physical_identity_verified: false,
        }],
        physical_targets: Vec::new(),
    };
    database.agent_repository().replace(&snapshot).expect("save discovery");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("central library");
    let facade = LocalApplicationFacade::new(database,);

    let result = facade
        .execute(RootAppCommand::EnsureAgentTargetDirectory(EnsureAgentTargetDirectory {
            target_id: "fixture-target".into(),
        }))
        .await
        .expect("create target directory");

    assert!(skill_path.is_dir());
    assert!(matches!(result, AppCommandResult::DiscoverySnapshot(_)));
}

/// DEV-106：共享目录部署目标的可提供方式必须是组内全体成员能力交集，
/// 不能只取 canonical 客户端的声明——否则混合能力会被高估并错误提交。
#[tokio::test]
async fn shared_directory_targets_offer_the_intersection_of_member_capabilities() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let shared_path = root.path().join("shared");
    std::fs::create_dir_all(&shared_path).expect("shared path");

    let instance = |profile_id: &str, client_id: &str, kind| ClientInstance {
        profile_id: profile_id.into(),
        client_id: client_id.into(),
        kind,
        display_name: client_id.into(),
        supported_os: vec![OperatingSystem::Windows],
        client_presence: ClientPresence::Unknown,
    };
    let root_observation = |profile_id: &str, client_id: &str| AgentRootObservation {
        id: format!("root:{client_id}"),
        profile_id: profile_id.into(),
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: root.path().to_string_lossy().into_owned(),
        status: DirectoryObservationStatus::Existing,
        exists: true,
        readable: true,
        writable: true,
        physical_id: Some(format!("root:{client_id}")),
        physical_identity_verified: true,
    };
    let logical = |id: &str, profile_id: &str, client_id: &str| LogicalTarget {
        id: id.into(),
        profile_id: profile_id.into(),
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: shared_path.to_string_lossy().into_owned(),
        agent_root_id: format!("root:{client_id}"),
        marker: "SKILL.md".into(),
        precedence: DirectoryPrecedence::Preferred,
        shared_reference: true,
        builtin: false,
        exists: true,
        readable: true,
        writable: true,
        available: true,
        physical_id: "physical:shared".into(),
        status: DirectoryObservationStatus::Existing,
        physical_identity_verified: true,
    };
    let snapshot = DiscoverySnapshot {
        generation: "shared-capabilities".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: vec![
            instance("agent-skills", "agent-skills.shared-directory", ClientKind::SharedDirectory),
            instance("openai", "openai.codex-desktop", ClientKind::Desktop),
        ],
        agent_roots: vec![
            root_observation("agent-skills", "agent-skills.shared-directory"),
            root_observation("openai", "openai.codex-desktop"),
        ],
        logical_targets: vec![
            logical("shared-canonical", "agent-skills", "agent-skills.shared-directory"),
            logical("shared-desktop", "openai", "openai.codex-desktop"),
        ],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save snapshot");
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .query(RootAppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list deployment targets");
    let AppQueryResult::DeploymentTargets(targets) = result else {
        panic!("expected deployment targets");
    };
    let shared = targets
        .iter()
        .find(|target| target.shared_directory)
        .expect("one shared canonical target");
    // codex-desktop 只声明受管复制；canonical 的全部支持不能抬高整组能力。
    assert_eq!(shared.modes, vec![DeploymentMode::ManagedCopy]);
    assert_eq!(shared.preferred_mode, Some(DeploymentMode::ManagedCopy));
}

/// DEV-106：部署目标查询与目录投影的一致性核对——普通成员逐一对应、
/// 共享目录只折叠一份、内置不进目标、待建保留可创建、自定义 Agent 的
/// 边界（投影有卡，部署目标暂不收录）显式固定，防止漂移。
#[tokio::test]
async fn deployment_targets_agree_with_the_projection_on_selectable_members() {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("agent root");
    let ordinary_path = root.path().join("ordinary");
    let shared_path = root.path().join("shared");
    std::fs::create_dir_all(&ordinary_path).expect("ordinary path");
    std::fs::create_dir_all(&shared_path).expect("shared path");
    let ordinary_physical_id = skillhub_core::physical_id_for_path(&ordinary_path)
        .expect("ordinary identity");
    let shared_physical_id = skillhub_core::physical_id_for_path(&shared_path)
        .expect("shared identity");

    let instance = |profile_id: &str, client_id: &str, kind| ClientInstance {
        profile_id: profile_id.into(),
        client_id: client_id.into(),
        kind,
        display_name: client_id.into(),
        supported_os: vec![OperatingSystem::Windows],
        client_presence: ClientPresence::Unknown,
    };
    let root_observation = |client_id: &str| AgentRootObservation {
        id: format!("root:{client_id}"),
        profile_id: if client_id == "agent-skills.shared-directory" {
            "agent-skills".into()
        } else {
            "openai".into()
        },
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: root.path().to_string_lossy().into_owned(),
        status: DirectoryObservationStatus::Existing,
        exists: true,
        readable: true,
        writable: true,
        physical_id: Some(format!("root:{client_id}")),
        physical_identity_verified: true,
    };
    let logical = |id: &str,
                   client_id: &str,
                   path: &std::path::Path,
                   physical_id: &str,
                   verified: bool,
                   shared,
                   builtin| LogicalTarget {
        id: id.into(),
        profile_id: if client_id == "agent-skills.shared-directory" {
            "agent-skills".into()
        } else {
            "openai".into()
        },
        client_id: client_id.into(),
        scope: TargetScope::Global,
        path: path.to_string_lossy().into_owned(),
        agent_root_id: format!("root:{client_id}"),
        marker: "SKILL.md".into(),
        precedence: DirectoryPrecedence::Preferred,
        shared_reference: shared,
        builtin,
        exists: path.exists(),
        readable: path.exists(),
        writable: path.exists(),
        available: path.exists(),
        physical_id: physical_id.into(),
        status: if path.exists() {
            DirectoryObservationStatus::Existing
        } else {
            DirectoryObservationStatus::Missing
        },
        physical_identity_verified: verified,
    };
    let candidate_path = root.path().join("candidate").join("skills");
    let mut builtin_target = logical(
        "ordinary-builtin",
        "openai.codex-cli",
        &ordinary_path,
        &ordinary_physical_id,
        true,
        false,
        true,
    );
    builtin_target.builtin = true;
    let snapshot = DiscoverySnapshot {
        generation: "consistency".into(),
        observed_at: "2026-09-29T00:00:00Z".into(),
        instances: vec![
            instance("openai", "openai.codex-cli", ClientKind::Cli),
            instance("openai", "openai.chatgpt-desktop", ClientKind::Desktop),
            instance("agent-skills", "agent-skills.shared-directory", ClientKind::SharedDirectory),
        ],
        agent_roots: vec![
            root_observation("openai.codex-cli"),
            root_observation("openai.chatgpt-desktop"),
            root_observation("agent-skills.shared-directory"),
        ],
        logical_targets: vec![
            logical("ordinary-cli", "openai.codex-cli", &ordinary_path, &ordinary_physical_id, true, false, false),
            logical("ordinary-desktop", "openai.chatgpt-desktop", &ordinary_path, &ordinary_physical_id, true, false, false),
            builtin_target,
            logical("shared-canonical", "agent-skills.shared-directory", &shared_path, &shared_physical_id, true, true, false),
            logical("shared-cli", "openai.codex-cli", &shared_path, &shared_physical_id, true, true, false),
            logical("candidate-cli", "openai.codex-cli", &candidate_path, "candidate:text", false, false, false),
        ],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save snapshot");
    let facade = LocalApplicationFacade::new(database);
    // 自定义 Agent（注册实体）：2026-09-30 裁决起进入部署目标清单，规则
    // 与内置 Agent 统一，投影与目标清单不得漂移。
    let custom_directory = tempfile::tempdir().expect("custom directory");
    facade
        .register_path_grant(skillhub_core::agent::ResolvedPathGrant {
            grant_id: custom_directory.path().to_string_lossy().into_owned(),
            path: custom_directory.path().to_string_lossy().into_owned(),
            operating_system: skillhub_core::agent::OperatingSystem::Macos,
        })
        .expect("register custom grant");
    facade
        .execute(RootAppCommand::CreateCustomAgent(
            skillhub_core::api::CreateCustomAgent {
                agent: skillhub_core::CustomAgentDraft {
                    id: "custom-acme".into(),
                    display_name: "Acme".into(),
                    directory: skillhub_core::PathGrant::from_file_picker(
                        custom_directory.path().to_string_lossy().into_owned(),
                    ),
                    profile: skillhub_core::AgentProfile {
                        profile_version: 1,
                        research_date: "2026-09-29".into(),
                        official_references: vec!["https://acme.example".into()],
                        brand: "Acme".into(),
                        clients: vec![skillhub_core::AgentClient {
                            id: "acme.cli".into(),
                            kind: ClientKind::Cli,
                            display_name: "Acme".into(),
                            supported_os: vec![skillhub_core::agent::OperatingSystem::Macos],
                            path_candidates: vec![skillhub_core::PathCandidate {
                                path: custom_directory.path().to_string_lossy().into_owned(),
                                agent_root: None,
                                scope: TargetScope::Global,
                                precedence: DirectoryPrecedence::Preferred,
                                shared_reference: false,
                                builtin: false,
                                marker: "SKILL.md".into(),
                            }],
                            skill_marker: "SKILL.md".into(),
                            deployment: skillhub_core::DeploymentCapability {
                                copy: true,
                                symlink: false,
                                junction: false,
                                limitations: Vec::new(),
                            },
                            call_policy: skillhub_core::CallPolicy::Unknown,
                        }],
                    },
                },
            },
        ))
        .await
        .expect("create custom agent");

    let projected = facade
        .query(RootAppQuery::GetAgentDirectoryProjection(
            GetAgentDirectoryProjection,
        ))
        .await
        .expect("projection query");
    let AppQueryResult::AgentDirectoryProjection(projection) = projected else {
        panic!("expected projection");
    };
    let listed = facade
        .query(RootAppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list deployment targets");
    let AppQueryResult::DeploymentTargets(targets) = listed else {
        panic!("expected deployment targets");
    };
    let target_ids = targets
        .iter()
        .map(|target| target.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();

    for fact in &projection.directories {
        match fact.role {
            skillhub_core::AgentDirectoryRole::Builtin => {
                for member in &fact.members {
                    assert!(
                        !target_ids.contains(member.logical_target_id.as_str()),
                        "builtin member {} must stay out of deployment targets",
                        member.logical_target_id
                    );
                }
            }
            skillhub_core::AgentDirectoryRole::SharedDirectory => {
                let shared_rows = targets
                    .iter()
                    .filter(|target| target.shared_directory)
                    .collect::<Vec<_>>();
                assert_eq!(
                    shared_rows.len(),
                    1,
                    "one shared physical directory folds into exactly one selectable target"
                );
                let canonical_ids = fact
                    .members
                    .iter()
                    .map(|member| member.logical_target_id.as_str())
                    .collect::<std::collections::BTreeSet<_>>();
                assert!(
                    canonical_ids.contains(shared_rows[0].id.as_str()),
                    "the shared target must be the canonical member of the projection group"
                );
            }
            skillhub_core::AgentDirectoryRole::AgentNative
            | skillhub_core::AgentDirectoryRole::Project => {
                for member in &fact.members {
                    assert!(
                        target_ids.contains(member.logical_target_id.as_str()),
                        "selectable member {} must appear in deployment targets",
                        member.logical_target_id
                    );
                }
            }
        }
    }
    let candidate = targets
        .iter()
        .find(|target| target.id == "candidate-cli")
        .expect("pending candidate stays creatable");
    assert!(!candidate.available);
    // 自定义 Agent 的目录在夹具中真实存在且身份已验证：作为可选目标出现。
    let custom = targets
        .iter()
        .find(|target| target.id == "custom-acme")
        .expect("custom agent joins deployment targets under the unified rule");
    assert!(custom.available);
}
