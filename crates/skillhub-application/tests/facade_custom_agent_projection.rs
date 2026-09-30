//! DEV-105：自定义 Agent 目录必须进入统一目录投影，与发现目录共用同一套
//! 身份、状态与能力规则。自定义 Agent 的持久化 id 与 create/update/remove
//! 命令 id 保持不变；目录事实（存在性、可读性、物理身份、能力交集）由
//! 后端系统验证产生，不再由前端硬编码。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    AgentDirectoryIdentity, AgentDirectoryRole, ClientKind, DirectoryObservationStatus,
    DirectoryPrecedence, OperatingSystem, ResolvedPathGrant, TargetScope,
};
use skillhub_core::api::{
    AppCommand, AppQuery, AppQueryResult, CreateCustomAgent, GetAgentDirectoryProjection,
    GetDeploymentPlan, ListCustomAgents, ListDeploymentTargets,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{
    AgentClient, AgentProfile, ApplicationFacade, CustomAgentDraft, DeploymentCapability,
    DeploymentMode, DeploymentPlanRequest, DeploymentRecord, DeploymentRepository, DeploymentState,
    ErrorCode, PathCandidate, PathGrant, SkillId, VersionId,
};
use skillhub_storage::{CentralLibrary, Database};

fn host_os() -> OperatingSystem {
    if cfg!(windows) {
        OperatingSystem::Windows
    } else {
        OperatingSystem::Macos
    }
}

fn profile(brand: &str, client_id: &str, directory_path: &str) -> AgentProfile {
    AgentProfile {
        profile_version: 1,
        research_date: "2026-09-29".into(),
        official_references: vec!["https://acme.example/docs".into()],
        brand: brand.into(),
        clients: vec![AgentClient {
            id: client_id.into(),
            kind: ClientKind::Cli,
            display_name: brand.into(),
            supported_os: vec![host_os()],
            path_candidates: vec![PathCandidate {
                path: directory_path.into(),
                agent_root: None,
                scope: TargetScope::Global,
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                marker: "SKILL.md".into(),
            }],
            skill_marker: "SKILL.md".into(),
            // 声明只支持受管复制：投影能力必须是宿主能力与声明的能力交集。
            deployment: DeploymentCapability {
                copy: true,
                symlink: false,
                junction: false,
                limitations: Vec::new(),
            },
            call_policy: skillhub_core::CallPolicy::Unknown,
        }],
    }
}

/// 建一个带自定义 Agent 的门面。`directory_exists` 控制授权目录是否真实存在。
/// `library_root` 必须随返回值保活：TempDir 一释放就会删掉整个集中库。
#[allow(clippy::type_complexity)]
async fn facade_with_custom_agent(
    directory_exists: bool,
) -> (
    LocalApplicationFacade,
    tempfile::TempDir,
    String,
    tempfile::TempDir,
    SkillId,
    VersionId,
) {
    let database_dir = tempfile::tempdir().expect("database dir");
    let database = Database::open(database_dir.path().join("skillhub.sqlite")).expect("database");
    let agent_root = tempfile::tempdir().expect("agent root");
    let directory = agent_root.path().join("acme-skills");
    let directory_path = directory.to_string_lossy().into_owned();
    if directory_exists {
        std::fs::create_dir_all(&directory).expect("create agent skills directory");
    }
    // 部署账目先于门面构造写入：target_id 使用自定义 Agent 的持久化 id。
    let skill = Skill::new(SkillId::new(), "Acme Skill");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('custom-acme','custom-acme','global','custom-acme-path',0)",
            [],
        )
        .expect("insert fixture target");
    let library_root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    // 集中库里捕获真实版本内容：计划解析要读版本目录。
    let source = tempfile::tempdir().expect("source");
    std::fs::write(
        source.path().join("SKILL.md"),
        "---\nname: acme-skill\ndescription: fixture skill\n---\n\n# Demo\n",
    )
    .expect("write skill markdown");
    let captured = skillhub_storage::VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    let version_id = captured.id;
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    database
        .deployment_repository()
        .insert(&DeploymentRecord {
            id: skillhub_core::DeploymentId::new(),
            skill_id: skill.id().clone(),
            version_id: version_id.clone(),
            target_id: "custom-acme".into(),
            state: DeploymentState::Deployed,
            mode: DeploymentMode::ManagedCopy,
            managed: true,
            runtime_name: "acme-skill".into(),
            expected_hash: "sha256:tree".into(),
            observed_hash: Some("sha256:tree".into()),
        })
        .await
        .expect("insert deployment");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    // 桌面选择器签发 grant（grant_id 即规范化路径）后再登记自定义 Agent。
    facade
        .register_path_grant(ResolvedPathGrant {
            grant_id: directory_path.clone(),
            path: directory_path.clone(),
            operating_system: host_os(),
        })
        .expect("register grant");
    facade
        .execute(AppCommand::CreateCustomAgent(CreateCustomAgent {
            agent: CustomAgentDraft {
                id: "custom-acme".into(),
                display_name: "Acme Reviewer".into(),
                directory: PathGrant::from_file_picker(directory_path.clone()),
                profile: profile("Acme", "acme.cli", &directory_path),
            },
        }))
        .await
        .expect("create custom agent");
    let skill_id = skill.id().clone();
    (
        facade,
        agent_root,
        directory_path,
        library_root,
        skill_id,
        version_id,
    )
}

async fn projection_of(facade: &LocalApplicationFacade) -> skillhub_core::AgentDirectoryProjection {
    let result = facade
        .query(AppQuery::GetAgentDirectoryProjection(
            GetAgentDirectoryProjection,
        ))
        .await
        .expect("query agent directory projection");
    let AppQueryResult::AgentDirectoryProjection(projection) = result else {
        panic!("expected agent directory projection");
    };
    projection
}

#[tokio::test]
async fn custom_agent_directories_enter_the_projection_with_verified_facts() {
    let (facade, _agent_root, directory_path, _library_root, _skill_id, _version_id) = facade_with_custom_agent(true).await;

    let projection = projection_of(&facade).await;
    let fact = projection
        .directories
        .iter()
        .find(|fact| {
            fact.members
                .iter()
                .any(|member| member.logical_target_id == "custom-acme")
        })
        .expect("custom agent directory must appear in the projection");
    assert_eq!(fact.role, AgentDirectoryRole::AgentNative);
    assert_eq!(fact.path, directory_path);
    assert_eq!(fact.status, DirectoryObservationStatus::Existing);
    assert!(fact.exists && fact.readable);
    assert!(matches!(
        fact.identity,
        AgentDirectoryIdentity::VerifiedPhysical(_)
    ));

    let member = fact
        .members
        .iter()
        .find(|member| member.logical_target_id == "custom-acme")
        .expect("custom agent member fact");
    assert_eq!(member.brand.as_deref(), Some("Acme"));
    assert_eq!(member.client_id.as_deref(), Some("acme.cli"));
    assert_eq!(member.kind, Some(ClientKind::Cli));
    assert!(member.availability.available);
    // D-9：能力取宿主与 profile 声明的交集；声明只允许受管复制时，
    // 即使宿主支持符号链接也不得出现在可提供方式里。
    assert_eq!(member.capabilities.modes, vec![DeploymentMode::ManagedCopy]);
    assert_eq!(
        member.capabilities.preferred_mode,
        Some(DeploymentMode::ManagedCopy)
    );
    // 部署账目按持久化 id 关联：卡片成员能力与部署事实同源。
    assert_eq!(
        member.deployment_status,
        skillhub_core::AgentDirectoryDeploymentStatus::Deployed
    );
    assert_eq!(member.managed_deployment_count, 1);
}

#[tokio::test]
async fn custom_agent_missing_directory_is_reported_instead_of_dropped() {
    let (facade, _agent_root, _directory_path, _library_root, _skill_id, _version_id) = facade_with_custom_agent(false).await;

    let projection = projection_of(&facade).await;
    let fact = projection
        .directories
        .iter()
        .find(|fact| {
            fact.members
                .iter()
                .any(|member| member.logical_target_id == "custom-acme")
        })
        .expect("custom agent with missing directory must stay visible");
    assert_eq!(fact.status, DirectoryObservationStatus::Missing);
    assert!(!fact.exists);
    // 目录缺失时没有可验证的物理身份：候选身份必须限定在持久化实体上，
    // 不能用路径文本冒充物理身份。
    assert!(matches!(
        &fact.identity,
        AgentDirectoryIdentity::Candidate(value) if value == "custom::custom-acme"
    ));
    let member = fact
        .members
        .iter()
        .find(|member| member.logical_target_id == "custom-acme")
        .expect("custom agent member fact");
    assert!(!member.availability.exists);
    assert!(!member.availability.available);
}

/// 2026-09-30 裁决：登记/编辑时持久化目录物理身份基线，部署链路据此识别
/// 「目录被整体替换」。基线经 ListCustomAgents 原样可读，与实体同生命周期。
#[tokio::test]
async fn create_custom_agent_persists_the_directory_identity_baseline() {
    let (facade, _agent_root, _directory_path, _library_root, _skill_id, _version_id) = facade_with_custom_agent(true).await;

    let result = facade
        .query(AppQuery::ListCustomAgents(ListCustomAgents))
        .await
        .expect("list custom agents");
    let AppQueryResult::CustomAgents(agents) = result else {
        panic!("expected custom agents");
    };
    let agent = agents
        .iter()
        .find(|candidate| candidate.id == "custom-acme")
        .expect("created custom agent");
    assert!(
        agent.directory_physical_id.is_some(),
        "registration must record the observed physical identity baseline"
    );
}

/// 2026-09-30 裁决：自定义 Agent 进入部署目标清单，规则与内置 Agent 完全
/// 统一——可用性来自系统验证，可提供方式是宿主与声明的能力交集，标签用
/// 品牌名而不是内部 id。
#[tokio::test]
async fn custom_agents_are_offered_as_deployment_targets_with_unified_rules() {
    let (facade, _agent_root, _directory_path, _library_root, _skill_id, _version_id) = facade_with_custom_agent(true).await;

    let result = facade
        .query(AppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list deployment targets");
    let AppQueryResult::DeploymentTargets(targets) = result else {
        panic!("expected deployment targets");
    };
    let target = targets
        .iter()
        .find(|candidate| candidate.id == "custom-acme")
        .expect("custom agent must appear as a deployment target");
    assert_eq!(target.label, "Acme");
    assert_eq!(target.agent_client_id.as_deref(), Some("acme.cli"));
    assert!(target.available);
    assert!(target.physical_identity_verified);
    assert_eq!(
        target.directory_status,
        Some(DirectoryObservationStatus::Existing)
    );
    // 声明只允许受管复制：即使宿主支持链接也不得抬高可提供方式。
    assert_eq!(target.modes, vec![DeploymentMode::ManagedCopy]);
    assert_eq!(target.preferred_mode, Some(DeploymentMode::ManagedCopy));
    assert!(!target.shared_directory);
}

/// 目录被整体替换（删除重建）后：目标清单必须标记身份变化且不可选，
/// 投影同步呈现 IdentityChanged，计划解析必须拒绝该目标。
#[tokio::test]
async fn replaced_custom_agent_directories_are_flagged_and_rejected_from_planning() {
    let (facade, _agent_root, directory_path, _library_root, _skill_id, _version_id) = facade_with_custom_agent(true).await;
    std::fs::remove_dir_all(&directory_path).expect("remove directory");
    std::fs::create_dir_all(&directory_path).expect("recreate empty directory");

    let result = facade
        .query(AppQuery::ListDeploymentTargets(ListDeploymentTargets))
        .await
        .expect("list deployment targets");
    let AppQueryResult::DeploymentTargets(targets) = result else {
        panic!("expected deployment targets");
    };
    let target = targets
        .iter()
        .find(|candidate| candidate.id == "custom-acme")
        .expect("replaced directory keeps its row instead of silently vanishing");
    assert!(!target.available);
    assert_eq!(
        target.directory_status,
        Some(DirectoryObservationStatus::IdentityChanged)
    );

    let projection = projection_of(&facade).await;
    let fact = projection
        .directories
        .iter()
        .find(|fact| {
            fact.members
                .iter()
                .any(|member| member.logical_target_id == "custom-acme")
        })
        .expect("projection keeps the custom fact");
    assert_eq!(fact.status, DirectoryObservationStatus::IdentityChanged);
    let member = fact
        .members
        .iter()
        .find(|member| member.logical_target_id == "custom-acme")
        .expect("member fact");
    assert!(!member.availability.available);

    let planned = facade
        .query(AppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: DeploymentPlanRequest {
                skill_id: skillhub_core::SkillId::new(),
                version_id: VersionId::parse(&format!("sha256:{}", "b".repeat(64)))
                    .expect("version id"),
                runtime_name: "replaced-skill".into(),
                logical_target_ids: vec!["custom-acme".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await;
    let error = planned.expect_err("planning against a replaced directory must be rejected");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

/// 正常路径：已登记且身份未变的自定义 Agent 必须能进入部署计划。
#[tokio::test]
async fn deployment_plan_resolves_a_verified_custom_agent_target() {
    let (facade, _agent_root, _directory_path, _library_root, skill_id, version_id) =
        facade_with_custom_agent(true).await;

    let planned = facade
        .query(AppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: DeploymentPlanRequest {
                skill_id,
                version_id,
                runtime_name: "acme-skill".into(),
                logical_target_ids: vec!["custom-acme".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect("planning against a verified custom target must succeed");
    let AppQueryResult::DeploymentPlan(plan) = planned else {
        panic!("expected deployment plan");
    };
    assert!(
        plan.targets
            .iter()
            .any(|target| target.logical_target_ids == ["custom-acme".to_string()]),
        "plan must cover the custom target"
    );
}
