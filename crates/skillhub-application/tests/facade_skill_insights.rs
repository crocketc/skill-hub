//! K7 验收回归（G-16/G-18）：Skill 洞察真实值与详情部署计数一致性。
//!
//! 通过公开 Facade 驱动，全部使用临时目录，绝不触碰真实用户文件。覆盖：
//! - 洞察的组合、依赖、外部变化来自真实关系事实（组合 + 导入关系分叉）；
//! - 空事实 Skill 返回结构完整的空结果，不伪造占位数据；
//! - 操作历史映射为用户事实文案码，不向调用方裸露裸 kind/phase；
//! - GetSkill 部署计数与列表投影同源一致：共享去重、已移除不计；
//!   托管链接/独立副本计数与 K1 影响语义一致。

use std::path::Path;

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, PhysicalTarget, TargetScope,
};
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CreateCombination, CreateSkill, GetSkill, ListSkills,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::{observed_path_key, ObservedOrigin};
use skillhub_core::relationship::{
    DeploymentRelationFact, FileRepresentation, OwnershipState, RelationshipType,
};
use skillhub_core::{AppCommand, AppQuery, ApplicationFacade, ObservedMatchState, SkillId};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

const CLIENT_ID: &str = "trae.code";
const BODY_V1: &str = "# Notes\n\nshared body\n";
const BODY_V2: &str = "# Notes rewritten\n";

fn register_agent_target(database: &Database, root: &std::path::Path) {
    let physical_id = skillhub_core::physical_id_for_path(root).expect("physical id");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-10-04T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: "trae-cn".into(),
                client_id: CLIENT_ID.into(),
                kind: ClientKind::IdeExtension,
                display_name: "Trae CN".into(),
                supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: vec![LogicalTarget {
                id: "target-1".into(),
                profile_id: "trae-cn".into(),
                client_id: CLIENT_ID.into(),
                scope: TargetScope::Global,
                path: root.to_string_lossy().into_owned(),
                agent_root_id: "fixture-root".into(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: physical_id.clone(),
                status: skillhub_core::agent::DirectoryObservationStatus::Existing,
                physical_identity_verified: true,
            }],
            physical_targets: vec![PhysicalTarget {
                id: physical_id,
                path: root.to_string_lossy().into_owned(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "unknown".into(),
                logical_target_ids: vec!["target-1".into()],
            }],
            agent_roots: Vec::new(),
        })
        .expect("save discovery");
}

fn facade_with_agent(workspace: &Path, agent_root: &Path) -> LocalApplicationFacade {
    std::fs::create_dir_all(agent_root).expect("agent root");
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    register_agent_target(&database, agent_root);
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, &library_root)
}

fn write_skill(root: &Path, body: &str) {
    std::fs::create_dir_all(root).expect("skill dir");
    std::fs::write(root.join("SKILL.md"), body).expect("write SKILL.md");
}

async fn prepare_and_commit_copy(
    facade: &LocalApplicationFacade,
    root: &Path,
    name: &str,
) -> SkillId {
    let candidate = skillhub_core::ImportCandidate::detected(
        skillhub_core::SourceDescriptor::new(
            skillhub_core::SourceKind::Local,
            skillhub_core::SourceLocator::local_path(root),
        ),
        root.to_string_lossy(),
        ".",
        "SKILL.md",
        name,
    )
    .with_ownership(
        skillhub_core::CandidateOwnership::KnownAgentTarget,
        skillhub_core::ImportAction::Review,
        None,
    );
    let prepared = facade
        .execute(AppCommand::PrepareImport(
            skillhub_core::api::PrepareImport {
                candidate,
                tree_hash: None,
            },
        ))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let governance_decision = skillhub_core::ImportGovernanceDecision {
        group_actions: prepared
            .analysis
            .governance_groups
            .iter()
            .map(|group| (group.group_id.clone(), group.default_action))
            .collect(),
        item_overrides: Default::default(),
    };
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::api::CommitImport {
            prepared_import_id: prepared.id,
            decision: skillhub_core::ImportDecision::CopyIntoLibrary,
            governance_decision,
            batch_id: None,
            candidate_key: None,
        }))
        .await
        .expect("commit import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary.items[0].skill_id.expect("skill in library")
}

async fn scan(facade: &LocalApplicationFacade) {
    let scanned = facade
        .execute(AppCommand::RunInitializationScan(
            skillhub_core::api::RunInitializationScan {
                scope_ids: Vec::new(),
            },
        ))
        .await
        .expect("scan");
    assert!(matches!(scanned, AppCommandResult::ScanResult(_)));
}

async fn find_skill_by_name(facade: &LocalApplicationFacade, name: &str) -> SkillId {
    let result = facade
        .query(AppQuery::ListSkills(ListSkills {
            text: name.into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list skills");
    let AppQueryResult::SkillPage(page) = result else {
        panic!("expected skill list page");
    };
    page.items
        .into_iter()
        .find(|item| item.display_name == name)
        .unwrap_or_else(|| panic!("skill {name} in library"))
        .skill_id
}

async fn insights_of(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> skillhub_core::api::SkillInsightsResult {
    let result = facade
        .query(AppQuery::GetSkillInsights(
            skillhub_core::api::GetSkillInsights { skill_id },
        ))
        .await
        .expect("skill insights");
    let AppQueryResult::SkillInsights(insights) = result else {
        panic!("expected skill insights");
    };
    insights
}

async fn skill_detail(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> skillhub_core::api::SkillResult {
    let result = facade
        .query(AppQuery::GetSkill(GetSkill { skill_id }))
        .await
        .expect("get skill");
    let AppQueryResult::Skill(skill) = result else {
        panic!("expected skill result");
    };
    skill
}

#[tokio::test]
async fn insights_derive_combinations_and_external_changes_from_real_facts() {
    let workspace = tempfile::tempdir().expect("workspace");
    let agent_root = workspace.path().join("agents/trae/skills");
    let source = agent_root.join("notes");
    write_skill(&source, BODY_V1);
    let facade = facade_with_agent(workspace.path(), &agent_root);

    let notes = prepare_and_commit_copy(&facade, &source, "Notes").await;
    write_skill(&workspace.path().join("helper"), BODY_V1);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Helper".into(),
            source_path: workspace
                .path()
                .join("helper")
                .to_string_lossy()
                .into_owned(),
        }))
        .await
        .expect("create helper");
    let helper = find_skill_by_name(&facade, "Helper").await;
    facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![notes, helper],
        }))
        .await
        .expect("create combination");

    // 外部变化：agent 目录里的副本内容被改写后重扫，关系分叉。
    write_skill(&source, BODY_V2);
    scan(&facade).await;

    let insights = insights_of(&facade, notes).await;
    assert_eq!(insights.skill_id, notes);
    assert_eq!(
        insights.combinations.len(),
        1,
        "combination from real facts"
    );
    assert_eq!(insights.combinations[0].name, "Writing stack");
    assert_eq!(insights.combinations[0].other_member_labels, vec!["Helper"]);

    assert!(
        insights
            .dependencies
            .iter()
            .any(|dependency| dependency.path == source.to_string_lossy()
                && dependency.shape_code == "import_copy"),
        "the imported copy relation must appear as a dependency: {:?}",
        insights.dependencies
    );

    assert!(
        !insights.external_changes.is_empty(),
        "the diverged relation must surface as an external change"
    );
    assert!(
        insights
            .external_changes
            .iter()
            .all(|change| change.state_code == "content_diverged"),
        "every external change carries the diverged fact code: {:?}",
        insights.external_changes
    );
    assert!(
        insights
            .external_changes
            .iter()
            .any(|change| change.path == source.to_string_lossy()),
        "the external change points at the real source path: {:?}",
        insights.external_changes
    );
    assert_eq!(
        insights.operation_history_limitation.as_deref(),
        Some("skill_dimension_not_recorded")
    );
}

#[tokio::test]
async fn insights_for_a_skill_without_facts_return_structural_zeros() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(SkillId::new(), "Loner");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new(database);

    let insights = insights_of(&facade, skill.id()).await;
    assert_eq!(insights.skill_id, skill.id());
    assert!(insights.combinations.is_empty());
    assert!(insights.dependencies.is_empty());
    assert!(insights.external_changes.is_empty());
    assert!(insights.operation_history.is_empty());
    assert_eq!(
        insights.operation_history_limitation.as_deref(),
        Some("skill_dimension_not_recorded")
    );
}

#[tokio::test]
async fn insights_map_operation_history_to_user_fact_codes() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = LocalApplicationFacade::new_with_library(
        Database::open(workspace.path().join("db.sqlite")).expect("database"),
        workspace.path().join("library"),
    );
    write_skill(&workspace.path().join("solo"), BODY_V1);
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Solo".into(),
            source_path: workspace.path().join("solo").to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");
    let solo = find_skill_by_name(&facade, "Solo").await;
    facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Solo stack".into(),
            members: vec![solo],
        }))
        .await
        .expect("create combination");

    let insights = insights_of(&facade, solo).await;
    assert!(
        !insights.operation_history.is_empty(),
        "real journal rows must surface"
    );
    let codes: Vec<&str> = insights
        .operation_history
        .iter()
        .map(|entry| entry.message_code.as_str())
        .collect();
    assert!(
        codes.contains(&"insights.operation.combination_changed.succeeded"),
        "a committed combination change must map to the user fact code: {codes:?}"
    );
    assert!(
        codes.contains(&"insights.operation.skill_added.succeeded"),
        "a committed skill creation must map to the user fact code: {codes:?}"
    );
    for code in &codes {
        assert!(
            code.starts_with("insights.operation."),
            "every history entry uses a presentation code: {code}"
        );
        assert!(
            !code.contains("create_skill") && !code.contains("create_combination"),
            "raw journal kinds must not leak into presentation codes: {code}"
        );
    }
    for entry in &insights.operation_history {
        assert!(
            entry.at_epoch.is_some(),
            "journal rows carry their creation time: {entry:?}"
        );
    }
}

fn create_test_directory_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, destination)
    }
    #[cfg(windows)]
    {
        skillhub_adapters::deployment::create_junction(source, destination)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source, destination);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory links are not supported on this platform",
        ))
    }
}

fn is_test_directory_link(path: &Path) -> bool {
    #[cfg(unix)]
    {
        std::fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        skillhub_adapters::deployment::is_reparse_point(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        false
    }
}

fn relation_fact(
    relation_id: &str,
    skill_id: SkillId,
    path: &Path,
    relationship: RelationshipType,
    representation: FileRepresentation,
    ownership: OwnershipState,
) -> DeploymentRelationFact {
    DeploymentRelationFact {
        relation_id: relation_id.to_owned(),
        skill_id: Some(skill_id),
        agent_client_id: CLIENT_ID.to_owned(),
        path: path.to_string_lossy().into_owned(),
        path_key: observed_path_key(&path.to_string_lossy()),
        directory_node_id: None,
        relationship,
        file_representation: representation,
        ownership,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: "sha256:fixture".to_owned(),
        origin: ObservedOrigin::Scan,
        match_state: ObservedMatchState::ContentVerified,
        health_reasons: None,
        active: true,
        observed_at: 0,
        released_at: None,
    }
}

/// G-16：详情与列表共用同一份部署事实分类——共享目标去重、已移除不计；
/// 托管链接/独立副本计数与 K1 影响语义一致。
#[tokio::test]
async fn detail_deployment_counts_match_the_library_list_projection() {
    let root = tempfile::tempdir().expect("fixture root");
    let library_root = root.path().join("library");
    let database = Database::open(root.path().join("db.sqlite")).expect("database");
    let skill = Skill::new(SkillId::new(), "Counted");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let library = CentralLibrary::initialize(&library_root).expect("central library");
    let store = VersionStore::from_library(&library);
    let source = tempfile::tempdir().expect("version source");
    write_skill(source.path(), BODY_V1);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    database
        .record_current_version(skill.id(), &version)
        .expect("record version");
    library
        .materialize_current_skill(&skill, &version.id)
        .expect("materialize visible tree");
    let visible_root = library.visible_skill_path(&skill);
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    // 部署事实：两个 Agent 目标（其一重复行证明共享去重）、一个已移除
    // 行（不计入）、一个项目目标。
    let connection = facade.database_for_tests().clone();
    let database = connection.lock().expect("database lock");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('proj-1', 'Demo', 'C:/fixture/project', 0, 0)",
            [],
        )
        .expect("insert project");
    for (target_id, project_id) in [
        ("agent-t1", None),
        ("agent-t2", None),
        ("proj-t1", Some("proj-1")),
    ] {
        database
            .connection_for_test()
            .execute(
                "INSERT INTO targets (id, agent_id, project_id, scope, path, created_at) VALUES (?1, 'agent-fixture', ?2, 'global', 'C:/fixture/target', 0)",
                rusqlite::params![target_id, project_id],
            )
            .expect("insert target");
    }
    for (deployment_id, target_id, state, runtime) in [
        ("dep-1", "agent-t1", "deployed", "managed-link-a"),
        ("dep-2", "agent-t1", "deployed", "managed-link-b"),
        ("dep-3", "agent-t2", "deployed", "managed-link-c"),
        ("dep-4", "agent-t1", "removed", "managed-link-d"),
        ("dep-5", "proj-t1", "deployed", "managed-copy-a"),
    ] {
        database
            .connection_for_test()
            .execute(
                "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'directory_junction', 1, ?6, 'sha256:expected', 'sha256:expected', 0, 0)",
                rusqlite::params![
                    deployment_id,
                    skill.id().to_string(),
                    version.id.to_string(),
                    target_id,
                    state,
                    runtime,
                ],
            )
            .expect("insert deployment");
    }
    drop(database);

    // 关系事实：指向当前物化树的真实链接（托管链接）+ 树外真实目录
    // 副本（独立副本）。
    let link = root.path().join("agents/linked");
    std::fs::create_dir_all(link.parent().expect("agents dir")).expect("agents dir");
    if let Err(error) = create_test_directory_link(&visible_root, &link) {
        eprintln!(
            "SKILLHUB-TEST-SKIP; detail_deployment_counts; this host cannot create the platform's directory link: {error}"
        );
        return;
    }
    assert!(is_test_directory_link(&link));
    let copied = root.path().join("agents/copied");
    write_skill(&copied, BODY_V1);
    {
        let connection = facade.database_for_tests().clone();
        let database = connection.lock().expect("database lock");
        database
            .relationship_repository()
            .upsert_deployment_relation(&relation_fact(
                "rel-link",
                skill.id(),
                &link,
                RelationshipType::ManagedLink,
                if cfg!(windows) {
                    FileRepresentation::DirectoryJunction
                } else {
                    FileRepresentation::SymbolicLink
                },
                OwnershipState::SkillhubManaged,
            ))
            .expect("insert link relation");
        database
            .relationship_repository()
            .upsert_deployment_relation(&relation_fact(
                "rel-copy",
                skill.id(),
                &copied,
                RelationshipType::ImportCopy,
                FileRepresentation::Directory,
                OwnershipState::ObservedUnmanaged,
            ))
            .expect("insert copy relation");
    }

    let list = {
        let result = facade
            .query(AppQuery::ListSkills(ListSkills {
                text: String::new(),
                page: 1,
                page_size: 10,
                filters: Default::default(),
                sort: Default::default(),
            }))
            .await
            .expect("list skills");
        let AppQueryResult::SkillPage(page) = result else {
            panic!("expected skill list page");
        };
        page.items
            .into_iter()
            .find(|item| item.skill_id == skill.id())
            .expect("listed skill")
    };
    let detail = skill_detail(&facade, skill.id()).await;

    // 共享去重 + 已移除不计：agent 2 个独立目标（t1 重复行合并、removed
    // 排除）、项目 1 个。
    assert_eq!(list.agent_deployment_count, 2);
    assert_eq!(list.project_deployment_count, 1);
    assert_eq!(
        detail.agent_deployment_count, list.agent_deployment_count,
        "detail and list share the same deployment fact classification"
    );
    assert_eq!(
        detail.project_deployment_count, list.project_deployment_count,
        "detail and list share the same deployment fact classification"
    );
    assert_eq!(
        detail.managed_link_count, 1,
        "only the link that follows the current visible tree counts as managed"
    );
    assert_eq!(
        detail.independent_copy_count, 1,
        "the tree-off copy relation counts as an independent copy"
    );
}
