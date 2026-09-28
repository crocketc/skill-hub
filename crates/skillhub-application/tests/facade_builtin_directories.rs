use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    AgentRootObservation, ClientInstance, ClientKind, ClientPresence,
    DirectoryObservationStatus, DirectoryPrecedence, DiscoverySnapshot, LogicalTarget,
    OperatingSystem, TargetScope,
};
use skillhub_core::api::{
    AppCommand as RootAppCommand, AppCommandResult, AppQuery as RootAppQuery, AppQueryResult,
    EnsureAgentTargetDirectory, GetDeploymentPlan, ListDeploymentTargets,
};
use skillhub_core::deployment::DeploymentPlanRequest;
use skillhub_core::{ApplicationFacade, DeploymentMode, ErrorCode, VersionId};
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
