use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::{
    AppQuery as RootAppQuery, AppQueryResult, GetDeploymentPlan, ListDeploymentTargets,
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
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::MayCoexist,
            shared_reference: false,
            builtin: true,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id,
        }],
        physical_targets: Vec::new(),
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
