use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, GetRollbackImpact, SetCurrentVersion,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::ApplicationFacade;
use skillhub_storage::{CentralLibrary, Database, VersionStore};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

// #15（2026-10-08 裁决）：采用新版在切换库内树后必须同步重写全部受管部署。
// 链接部署核验重指向并记账新版本；受管复制按新版本重写实盘并记账
// expected_hash；单个目标失败不回滚整体采用，按目标如实留证。
// 本文件覆盖：健康复制重写、链接重记账、分叉复制诚实部分成功、
// 预览/统计把受管复制与独立副本分流。

async fn prepare_adoption(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
    target_version_id: skillhub_core::VersionId,
) -> skillhub_core::OperationId {
    let result = facade
        .query(AppQuery::GetRollbackImpact(GetRollbackImpact {
            skill_id,
            target_version_id,
        }))
        .await
        .expect("prepare version adoption preview");
    let AppQueryResult::RollbackImpact(impact) = result else {
        panic!("expected rollback impact preview");
    };
    impact.preview_id
}

struct AdoptionFixture {
    _root: TempDir,
    database_path: PathBuf,
    facade: LocalApplicationFacade,
    skill: Skill,
    first_version: skillhub_core::VersionRecord,
    target_version: skillhub_core::VersionRecord,
}

async fn adoption_fixture() -> AdoptionFixture {
    let root = tempfile::tempdir().expect("isolated fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Adoption deployments");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let library = CentralLibrary::initialize(&library_root).expect("central library");
    let store = VersionStore::from_library(&library);
    let first_source = tempfile::tempdir().expect("first version source");
    std::fs::write(first_source.path().join("SKILL.md"), "# First\n").expect("first content");
    let first = store
        .capture(skill.id(), first_source.path())
        .expect("capture first version");
    let target_source = tempfile::tempdir().expect("target version source");
    std::fs::write(target_source.path().join("SKILL.md"), "# Target\n").expect("target content");
    let target = store
        .capture(skill.id(), target_source.path())
        .expect("capture target version");
    store
        .set_current(skill.id(), &first.id)
        .expect("set initial file-store pointer");
    database
        .record_current_version(skill.id(), &first)
        .expect("seed initial database pointer");
    library
        .materialize_current_skill(&skill, &first.id)
        .expect("materialize initial version");
    library
        .save_portable_skill(&skill, Some(&first.id))
        .expect("seed portable metadata");

    AdoptionFixture {
        _root: root,
        database_path,
        facade: LocalApplicationFacade::new_with_library(database, &library_root),
        skill,
        first_version: first,
        target_version: target,
    }
}

/// Deployment tree hash of a single-file tree with the given SKILL.md content
/// (same format the apply flow records for expected/observed hashes).
fn tree_hash_of(content: &str) -> String {
    let dir = tempfile::tempdir().expect("hash temp dir");
    std::fs::write(dir.path().join("SKILL.md"), content).expect("hash content");
    DeploymentFilesystem::hash_tree(dir.path()).expect("hash tree")
}

fn visible_skill_tree(library_root: &Path, skill_id: skillhub_core::SkillId) -> PathBuf {
    let entry = std::fs::read_dir(library_root.join("skills"))
        .expect("skills directory")
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(skill_id.to_string().as_str())
        })
        .expect("visible skill directory");
    entry.path()
}

/// Seeds one real managed-copy deployment pinned to `version`, deployed from
/// `deployed_content` (the recorded expected hash uses the deployment tree hash
/// format, exactly what the apply flow records) and currently holding
/// `on_disk_content` on a fresh agent directory. Returns (deployment id,
/// destination path).
fn seed_managed_copy(
    fixture: &AdoptionFixture,
    index: usize,
    version: &skillhub_core::VersionRecord,
    deployed_content: &str,
    on_disk_content: &str,
) -> (skillhub_core::DeploymentId, PathBuf) {
    let target_path = fixture
        ._root
        .path()
        .join(format!("agents-copy-{index}"))
        .join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&destination).expect("create agent destination");
    std::fs::write(destination.join("SKILL.md"), deployed_content).expect("seed copy content");
    let deployed_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash deployed copy");
    let observed_hash = if on_disk_content != deployed_content {
        std::fs::write(destination.join("SKILL.md"), on_disk_content)
            .expect("overwrite copy content");
        DeploymentFilesystem::hash_tree(&destination).expect("hash diverged copy")
    } else {
        deployed_hash.clone()
    };

    let database = Database::open(&fixture.database_path).expect("fixture database");
    // 部署记账的 target_id 是目标目录的物理身份（fs:<dev>-<ino>），与
    // deployment_proof 的所有权核验同一口径。
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("target directory identity");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, ?2, 'global', ?3, 0)",
            rusqlite::params![
                target_id,
                "copy.agent",
                target_path.to_string_lossy().to_string()
            ],
        )
        .expect("seed copy target row");
    database
        .record_version(fixture.skill.id(), version)
        .expect("register deployed version row");
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .deployment_repository()
        .insert_sync(&skillhub_core::DeploymentRecord {
            id: deployment_id,
            skill_id: fixture.skill.id(),
            version_id: version.id.clone(),
            target_id,
            state: skillhub_core::DeploymentState::Deployed,
            mode: skillhub_core::DeploymentMode::ManagedCopy,
            managed: true,
            runtime_name: fixture.skill.runtime_name().to_owned(),
            expected_hash: deployed_hash,
            observed_hash: Some(observed_hash),
        })
        .expect("seed managed copy deployment");
    (deployment_id, destination)
}

fn deployment_row(database_path: &Path, id: skillhub_core::DeploymentId) -> (String, String) {
    let database = Database::open(database_path).expect("reopen database");
    database
        .connection_for_test()
        .query_row(
            "SELECT version_id, expected_hash FROM deployments WHERE id=?1",
            [id.to_string()],
            |row| Ok((row.get(0).unwrap(), row.get(1).unwrap())),
        )
        .expect("deployment row")
}

fn managed_relation_fact(
    database_path: &Path,
    id: skillhub_core::DeploymentId,
) -> skillhub_core::relationship::DeploymentRelationFact {
    let database = Database::open(database_path).expect("reopen database");
    let relation_id = format!("managed:{}", id);
    database
        .relationship_repository()
        .list_relations()
        .expect("list relations")
        .into_iter()
        .find(|relation| relation.relation_id == relation_id)
        .unwrap_or_else(|| panic!("missing relation fact {relation_id}"))
}

#[tokio::test]
async fn adopting_a_new_version_rewrites_a_healthy_managed_copy_in_place() {
    let fixture = adoption_fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        1,
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );

    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;
    let result = fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect("adoption commits");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.phase, skillhub_core::OperationPhase::Committed);
    assert_eq!(summary.message_code, "version.adopted");

    // 复制部署落盘内容重写为新版本，且记账指向新版本；expected/observed
    // 与关系指纹都用部署树哈希口径记录新内容。
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("rewritten content"),
        "# Target\n"
    );
    let rewritten_hash = tree_hash_of("# Target\n");
    assert_eq!(
        deployment_row(&fixture.database_path, deployment_id),
        (
            fixture.target_version.id.to_string(),
            rewritten_hash.clone(),
        )
    );
    let fact = managed_relation_fact(&fixture.database_path, deployment_id);
    assert_eq!(fact.content_fingerprint, rewritten_hash);
    assert_eq!(
        fact.match_state,
        skillhub_core::deployment::ObservedMatchState::ContentVerified
    );
}

#[cfg(windows)]
fn seed_managed_link(
    fixture: &AdoptionFixture,
    visible_tree: &Path,
) -> (skillhub_core::DeploymentId, PathBuf) {
    let target_path = fixture._root.path().join("agents-link-1").join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&target_path).expect("create link parent");
    skillhub_adapters::deployment::create_junction(visible_tree, &destination)
        .expect("create junction deployment");

    let database = Database::open(&fixture.database_path).expect("fixture database");
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("target directory identity");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'link.agent', 'global', ?2, 0)",
            rusqlite::params![target_id, target_path.to_string_lossy().to_string()],
        )
        .expect("seed link target row");
    database
        .record_version(fixture.skill.id(), &fixture.first_version)
        .expect("register deployed version row");
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .deployment_repository()
        .insert_sync(&skillhub_core::DeploymentRecord {
            id: deployment_id,
            skill_id: fixture.skill.id(),
            version_id: fixture.first_version.id.clone(),
            target_id,
            state: skillhub_core::DeploymentState::Deployed,
            mode: skillhub_core::DeploymentMode::DirectoryJunction,
            managed: true,
            runtime_name: fixture.skill.runtime_name().to_owned(),
            expected_hash: DeploymentFilesystem::hash_tree(&destination).expect("hash linked tree"),
            observed_hash: Some(
                DeploymentFilesystem::hash_tree(&destination).expect("hash linked tree"),
            ),
        })
        .expect("seed managed link deployment");
    // 采用前事实核验要求链接关系记录 link_target（fail-closed）：与真实
    // 部署/收编链路一致，把可见树路径与 path_key 写回关系事实。
    let mut fact = database
        .relationship_repository()
        .list_relations()
        .expect("list relations")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{}", deployment_id))
        .expect("link relation fact");
    fact.link_target_path = Some(visible_tree.to_string_lossy().into_owned());
    fact.link_target_path_key = Some(skillhub_core::deployment::observed_path_key(
        visible_tree.to_string_lossy().as_ref(),
    ));
    database
        .relationship_repository()
        .upsert_deployment_relation(&fact)
        .expect("record link target");
    (deployment_id, destination)
}

#[cfg(windows)]
#[tokio::test]
async fn adopting_a_new_version_re_records_managed_links_to_the_new_version() {
    let fixture = adoption_fixture().await;
    let visible_tree =
        visible_skill_tree(&fixture._root.path().join("library"), fixture.skill.id());
    let (deployment_id, destination) = seed_managed_link(&fixture, &visible_tree);

    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;
    let result = fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect("adoption commits");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.message_code, "version.adopted");

    // 链接仍解析进库内可见树，且新内容经链接可达。
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("linked content"),
        "# Target\n"
    );
    // 记账：链接部署指向新版本，expected_hash 与关系指纹随新树更新
    // （部署树哈希口径，与 reconcile 校验一致）。
    let linked_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash linked tree");
    assert_eq!(
        deployment_row(&fixture.database_path, deployment_id),
        (fixture.target_version.id.to_string(), linked_hash.clone(),)
    );
    let fact = managed_relation_fact(&fixture.database_path, deployment_id);
    assert_eq!(fact.content_fingerprint, linked_hash);
}

#[tokio::test]
async fn a_diverged_managed_copy_is_left_untouched_and_reported_honestly() {
    let fixture = adoption_fixture().await;
    let (healthy_id, healthy_destination) = seed_managed_copy(
        &fixture,
        1,
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    let (diverged_id, diverged_destination) = seed_managed_copy(
        &fixture,
        2,
        &fixture.first_version,
        "# First\n",
        "# User edit\n",
    );

    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;
    let result = fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect("adoption still commits; copy rewrite is per-target honest");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    assert_eq!(summary.message_code, "version.adopted_deployment_partial");

    // 健康副本重写；分叉副本一字不动（不覆盖用户修改）。
    assert_eq!(
        std::fs::read_to_string(healthy_destination.join("SKILL.md")).expect("healthy content"),
        "# Target\n"
    );
    assert_eq!(
        std::fs::read_to_string(diverged_destination.join("SKILL.md")).expect("diverged content"),
        "# User edit\n"
    );
    // 分叉副本记账仍钉在旧版本与部署时哈希，可经既有 reconcile 流程结算。
    assert_eq!(
        deployment_row(&fixture.database_path, diverged_id),
        (
            fixture.first_version.id.to_string(),
            tree_hash_of("# First\n"),
        )
    );
    // 关系事实如实标记分叉与健康异常，进入治理可见面。
    let fact = managed_relation_fact(&fixture.database_path, diverged_id);
    assert_eq!(
        fact.match_state,
        skillhub_core::deployment::ObservedMatchState::Diverged
    );
    assert!(fact.health_reasons.as_ref().is_some_and(|reasons| reasons
        .contains(&skillhub_core::relationship::RelationHealthReason::ContentChanged)));
    assert_eq!(
        deployment_row(&fixture.database_path, healthy_id),
        (
            fixture.target_version.id.to_string(),
            tree_hash_of("# Target\n"),
        )
    );
}

#[tokio::test]
async fn adoption_facts_stop_counting_managed_copies_as_independent_copies() {
    let fixture = adoption_fixture().await;
    let (deployment_id, _destination) = seed_managed_copy(
        &fixture,
        1,
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    let relation_id = format!("managed:{}", deployment_id);

    let result = fixture
        .facade
        .query(AppQuery::GetRollbackImpact(GetRollbackImpact {
            skill_id: fixture.skill.id(),
            target_version_id: fixture.target_version.id.clone(),
        }))
        .await
        .expect("adoption facts");
    let AppQueryResult::RollbackImpact(impact) = result else {
        panic!("expected rollback impact");
    };
    let copy_row = impact
        .relations
        .iter()
        .find(|relation| relation.relation_id == relation_id)
        .expect("managed copy impact row");
    // 受管复制不是独立副本：预览不再把它归入「独立副本·原样保留」。
    assert!(!copy_row.independent_copy);
    // 副本内容与当前版本一致时如实算作跟随当前版本。
    assert!(copy_row.follows_current);

    // 采用新版后，被重写的副本仍跟随（新）当前版本；独立副本判定不回潮。
    let preview_id = impact.preview_id;
    fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect("adoption commits");
    let result = fixture
        .facade
        .query(AppQuery::GetRollbackImpact(GetRollbackImpact {
            skill_id: fixture.skill.id(),
            target_version_id: fixture.first_version.id.clone(),
        }))
        .await
        .expect("rollback facts after adoption");
    let AppQueryResult::RollbackImpact(impact) = result else {
        panic!("expected rollback impact");
    };
    let copy_row = impact
        .relations
        .iter()
        .find(|relation| relation.relation_id == relation_id)
        .expect("managed copy impact row");
    assert!(!copy_row.independent_copy);
    assert!(copy_row.follows_current);
}

#[tokio::test]
async fn skill_stats_exclude_managed_copies_from_independent_copy_count() {
    let fixture = adoption_fixture().await;
    seed_managed_copy(
        &fixture,
        1,
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );

    let result = fixture
        .facade
        .query(AppQuery::GetSkill(skillhub_core::api::GetSkill {
            skill_id: fixture.skill.id(),
        }))
        .await
        .expect("skill stats");
    let AppQueryResult::Skill(skill) = result else {
        panic!("expected skill result");
    };
    // 受管复制是受管去向，不再计入「独立副本」统计（与预览同一口径）。
    assert_eq!(skill.independent_copy_count, 0);
}
