//! K5 复用修改与替换继承：另存副本的来源登记、上游谱系查询与替换继承。
//!
//! 约定（K0 契约 §K5/§2/§6）：
//! - `SaveMarkdownAsCopy` 的创建分支永远生成独立新主体与首版本；原主体、
//!   旧版本与网络来源保持不变，新主体不自动继承网络来源。
//! - 上游谱系作为「来源 skill+version → 新 skill 首版本」的有向事实登记，
//!   详情查询通过 `SkillResult.upstream_lineage` 暴露。
//! - 替换继承必须绑定持久化预览（preview_id + expires_at + 确认指纹）；
//!   只有显式选择的受管目标被接管，旧使用关系进入历史；共享物理目标
//!   必须逐项显式确认并列出全部消费者；任一目标失败不得中断其余项，
//!   不得声明全部继承或全部回滚，也不得删除仍被已成功目标使用的新主体。
//! - 中央库同名主体合法；显示名只影响展示，不得改写运行时名称。

use std::path::Path;

use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, GetSaveAsCopyReplacementPreview, GetSkill, ListDeployments,
    ListSkills, ReadMarkdownFile, SaveAsCopyInheritance, SaveAsCopyOrigin,
    SaveAsCopyReplacementChoice, SaveMarkdownAsCopy,
};
use skillhub_core::catalog::Skill;
use skillhub_core::{
    physical_id_for_path, AppCommand, AppQuery, AppResult, ApplicationFacade, DeploymentId,
    ErrorCode, OperationId, OperationPhase, RecoveryCandidate,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

struct Fixture {
    database_path: std::path::PathBuf,
    library_root: tempfile::TempDir,
    extra_dirs: Vec<tempfile::TempDir>,
}

impl Fixture {
    fn new() -> Fixture {
        let library_root = tempfile::tempdir().expect("library root");
        let scratch_dir = tempfile::tempdir().expect("scratch dir");
        let database_path = scratch_dir.path().join("skillhub.sqlite");
        // scratch_dir 存入 extra_dirs 以维持生命周期；database_path 指向其中。
        Fixture {
            database_path,
            library_root,
            extra_dirs: vec![scratch_dir],
        }
    }

    fn temp_dir(&mut self) -> std::path::PathBuf {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().to_path_buf();
        self.extra_dirs.push(dir);
        path
    }

    fn facade(&self) -> LocalApplicationFacade {
        LocalApplicationFacade::new_with_library(
            open_database(&self.database_path),
            self.library_root.path(),
        )
    }

    fn audit(&self) -> Database {
        open_database(&self.database_path)
    }
}

fn open_database(path: &Path) -> Database {
    Database::open(path).expect("open database")
}

struct SeededSource {
    skill: Skill,
    version_id: skillhub_core::VersionId,
    identity: String,
}

async fn seed_source_skill(fixture: &mut Fixture, name: &str, markdown: &str) -> SeededSource {
    let skill = Skill::new(skillhub_core::SkillId::new(), name);
    let database = open_database(&fixture.database_path);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");
    let source_dir = fixture.temp_dir();
    std::fs::write(source_dir.join("SKILL.md"), markdown).expect("write source");
    let library = CentralLibrary::initialize(fixture.library_root.path()).expect("library");
    let store = VersionStore::from_library(&library);
    let captured = store
        .capture(skill.id(), &source_dir)
        .expect("capture source");
    store
        .set_current(skill.id(), &captured.id)
        .expect("set current");
    // 与 create_skill 一致：来源版本登记进 SQL 版本表（origin 归属校验、
    // 部署外键都依赖它）。
    database
        .connection_for_test()
        .execute(
            "INSERT OR IGNORE INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![captured.id.to_string(), skill.id().to_string()],
        )
        .expect("insert source version");
    let (identity, _) = store
        .read_file(&captured.id, "SKILL.md", 1_048_576)
        .expect("read identity");
    SeededSource {
        skill,
        version_id: captured.id,
        identity,
    }
}

fn seed_network_source(database: &Database, skill_id: skillhub_core::SkillId) {
    database
        .connection_for_test()
        .execute(
            "INSERT INTO sources (id, kind, locator, revision, metadata_json, created_at) VALUES ('source-net', 'https', 'https://example.com/notebook.git', NULL, '{}', 0)",
            [],
        )
        .expect("insert source");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skill_sources (skill_id, source_id, relation) VALUES (?1, 'source-net', 'origin')",
            rusqlite::params![skill_id.to_string()],
        )
        .expect("link skill source");
}

/// 在指定目标目录下种一个真实受管条目。`corrupt` 为 true 时在计算
/// expected_hash 之后篡改条目内容，使任何 verify_owned 校验确定性失败。
fn seed_managed_entry(
    fixture: &mut Fixture,
    database: &Database,
    skill_id: skillhub_core::SkillId,
    version_id: &skillhub_core::VersionId,
    runtime_name: &str,
    markdown: &str,
    corrupt: bool,
) -> DeploymentId {
    let target_dir = fixture.temp_dir();
    let destination = target_dir.join(runtime_name);
    std::fs::create_dir_all(&destination).expect("create entry");
    std::fs::write(destination.join("SKILL.md"), markdown).expect("write entry");
    let target_id = physical_id_for_path(&target_dir).expect("target identity");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash entry");
    if corrupt {
        std::fs::write(
            destination.join("SKILL.md"),
            format!("{markdown}tampered\n"),
        )
        .expect("corrupt entry");
    }
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_dir.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    database
        .connection_for_test()
        .execute(
            "INSERT OR IGNORE INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill_id.to_string()],
        )
        .expect("insert version");
    let deployment_id = DeploymentId::new();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'deployed', 'managed_copy', 1, ?5, ?6, ?6, 0, 0)",
            rusqlite::params![
                deployment_id.to_string(),
                skill_id.to_string(),
                version_id.to_string(),
                target_id,
                runtime_name,
                expected_hash,
            ],
        )
        .expect("insert deployment");
    deployment_id
}

async fn save_copy(
    facade: &LocalApplicationFacade,
    source: &SeededSource,
    inheritance: SaveAsCopyInheritance,
    display_name: Option<String>,
) -> AppResult<AppCommandResult> {
    facade
        .execute(AppCommand::SaveMarkdownAsCopy(SaveMarkdownAsCopy {
            skill_id: source.skill.id(),
            path: "SKILL.md".into(),
            markdown: "# Copied\n".into(),
            expected_identity: source.identity.clone(),
            origin: Some(SaveAsCopyOrigin {
                source_skill_id: source.skill.id(),
                source_version_id: source.version_id.clone(),
            }),
            inheritance,
            target_display_name: display_name,
        }))
        .await
}

fn saved_copy(result: AppCommandResult) -> skillhub_core::api::SaveAsCopyOutcome {
    let AppCommandResult::SavedSkillCopy(outcome) = result else {
        panic!("expected saved skill copy outcome");
    };
    outcome
}

async fn skill_result(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
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

async fn deployments_of(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> Vec<skillhub_core::deployment::DeploymentRecord> {
    let result = facade
        .query(AppQuery::ListDeployments(ListDeployments {
            skill_id: Some(skill_id),
        }))
        .await
        .expect("list deployments");
    let AppQueryResult::Deployments(records) = result else {
        panic!("expected deployment records");
    };
    records
}

async fn preview_replacement(
    facade: &LocalApplicationFacade,
    source_skill_id: skillhub_core::SkillId,
    targets: Vec<DeploymentId>,
) -> skillhub_core::api::SaveAsCopyReplacementPreview {
    let result = facade
        .query(AppQuery::GetSaveAsCopyReplacementPreview(
            GetSaveAsCopyReplacementPreview {
                source_skill_id,
                targets,
            },
        ))
        .await
        .expect("preview replacement");
    let AppQueryResult::SaveAsCopyReplacementPreview(preview) = result else {
        panic!("expected replacement preview");
    };
    preview
}

async fn replacement_candidates(facade: &LocalApplicationFacade) -> Vec<OperationId> {
    let result = facade
        .query(AppQuery::ListRecoveryCandidates)
        .await
        .expect("list recovery candidates");
    let AppQueryResult::RecoveryCandidates(candidates) = result else {
        panic!("expected recovery candidates");
    };
    let candidates: Vec<RecoveryCandidate> = candidates;
    candidates.into_iter().map(|c| c.operation_id).collect()
}

fn choice(deployment_id: DeploymentId, confirm: bool) -> SaveAsCopyReplacementChoice {
    SaveAsCopyReplacementChoice {
        deployment_id,
        confirm_shared_target_removal: confirm,
    }
}

/// RED：携带 origin 另存副本 → 独立新主体 + 首版本 + 可查询上游谱系，
/// 原主体不变，网络来源不被继承。
#[tokio::test]
async fn copy_with_origin_creates_independent_skill_first_version_and_queryable_lineage() {
    let mut fixture = Fixture::new();
    let source = seed_source_skill(&mut fixture, "Notebook", "# Notebook\n").await;
    {
        let database = open_database(&fixture.database_path);
        seed_network_source(&database, source.skill.id());
    }
    let facade = fixture.facade();

    let outcome = saved_copy(
        save_copy(&facade, &source, SaveAsCopyInheritance::None, None)
            .await
            .expect("save as copy"),
    );
    assert_ne!(outcome.skill_id, source.skill.id());
    assert_ne!(outcome.version_id, source.version_id);
    assert!(
        outcome.lineage_registered,
        "the copy must register its upstream lineage"
    );
    assert_eq!(
        outcome.inheritance,
        skillhub_core::api::SaveAsCopyInheritanceOutcome::NotRequested
    );

    let copy_view = skill_result(&facade, outcome.skill_id).await;
    let lineage = copy_view
        .upstream_lineage
        .expect("the copy must expose upstream lineage");
    assert_eq!(lineage.source_skill_id, source.skill.id());
    assert_eq!(lineage.source_version_id, source.version_id);
    assert_eq!(lineage.source_display_name.as_deref(), Some("Notebook"));
    assert!(lineage.created_at.is_some());
    // 网络来源是来源主体的事实：副本不继承，仅登记谱系。
    assert_eq!(copy_view.source_kind, None);

    let source_view = skill_result(&facade, source.skill.id()).await;
    assert!(source_view.upstream_lineage.is_none());
    assert_eq!(source_view.source_kind.as_deref(), Some("https"));

    let original = facade
        .query(AppQuery::ReadMarkdownFile(ReadMarkdownFile {
            skill_id: source.skill.id(),
            path: "SKILL.md".into(),
            version_id: None,
        }))
        .await
        .expect("read original");
    let AppQueryResult::MarkdownFile(original) = original else {
        panic!("expected original markdown");
    };
    assert_eq!(original.markdown, "# Notebook\n");
}

/// RED：显示名只影响展示——不再有「(copy)」硬编码后缀；运行时名称跟随
/// 来源；中央库同名主体合法共存。
#[tokio::test]
async fn copy_display_name_has_no_copy_suffix_and_only_affects_display() {
    let mut fixture = Fixture::new();
    let source = seed_source_skill(&mut fixture, "Notebook", "# Notebook\n").await;
    let facade = fixture.facade();
    let source_view = skill_result(&facade, source.skill.id()).await;

    let first = saved_copy(
        save_copy(
            &facade,
            &source,
            SaveAsCopyInheritance::None,
            Some("带批注的笔记本".into()),
        )
        .await
        .expect("save first copy"),
    );
    assert_eq!(first.display_name, "带批注的笔记本");

    let second = saved_copy(
        save_copy(&facade, &source, SaveAsCopyInheritance::None, None)
            .await
            .expect("save second copy"),
    );
    assert_eq!(
        second.display_name, "Notebook",
        "无显式显示名时沿用来源显示名，不得追加 (copy)"
    );

    let second_view = skill_result(&facade, second.skill_id).await;
    assert_eq!(
        second_view.runtime_name, source_view.runtime_name,
        "运行时名称继承来源，显示名不得改写运行时名称"
    );

    // 中央库允许同名主体：来源与两个副本（同名运行时名称）共存。
    let listed = facade
        .query(AppQuery::ListSkills(ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list skills");
    let AppQueryResult::SkillPage(page) = listed else {
        panic!("expected skill page");
    };
    assert!(page.total >= 3, "来源与两个副本必须共存");
    assert!(
        page.items
            .iter()
            .all(|item| !item.display_name.contains("(copy)")),
        "任何主体都不得出现 (copy) 后缀"
    );
    let second_item = page
        .items
        .iter()
        .find(|item| item.skill_id == second.skill_id)
        .expect("second copy must be listed");
    assert_eq!(second_item.display_name, "Notebook");
}

/// RED：不请求继承时，原主体的使用关系保持不变；谱系仍然登记。
#[tokio::test]
async fn inheritance_none_preserves_original_relations_and_registers_lineage() {
    let mut fixture = Fixture::new();
    let source = seed_source_skill(&mut fixture, "Notebook", "# Notebook\n").await;
    let database = open_database(&fixture.database_path);
    let kept = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook",
        "# Notebook\n",
        false,
    );
    drop(database);
    let facade = fixture.facade();

    let outcome = saved_copy(
        save_copy(&facade, &source, SaveAsCopyInheritance::None, None)
            .await
            .expect("save as copy"),
    );
    assert!(outcome.lineage_registered);
    assert_eq!(
        outcome.inheritance,
        skillhub_core::api::SaveAsCopyInheritanceOutcome::NotRequested
    );

    let source_deployments = deployments_of(&facade, source.skill.id()).await;
    assert_eq!(source_deployments.len(), 1);
    assert_eq!(source_deployments[0].id, kept);
    assert!(deployments_of(&facade, outcome.skill_id).await.is_empty());
    let _ = source_deployments;
}

/// RED：替换继承只接管显式选择的真实受管条目——条目内容换新、部署记录
/// 重新指向并验证、旧使用关系进入历史；未选择的目标与原主体不变。
#[tokio::test]
async fn replacement_takes_over_only_selected_managed_targets_and_records_history() {
    let mut fixture = Fixture::new();
    let source = seed_source_skill(&mut fixture, "Notebook", "# Notebook\n").await;
    let database = open_database(&fixture.database_path);
    let selected = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook-selected",
        "# Notebook\n",
        false,
    );
    let untouched = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook-untouched",
        "# Notebook\n",
        false,
    );
    drop(database);
    let facade = fixture.facade();
    let preview = preview_replacement(&facade, source.skill.id(), vec![selected]).await;
    assert_eq!(preview.source_skill_id, source.skill.id());
    assert_eq!(preview.source_version_id, source.version_id);
    assert!(!preview.preview_id.to_string().is_empty());
    assert!(!preview.expires_at.is_empty());
    assert!(!preview.confirmation_fingerprint.is_empty());
    assert_eq!(preview.targets.len(), 1);
    let item = &preview.targets[0];
    assert_eq!(item.deployment_id, selected);
    assert!(item.managed, "只允许替换受管目标");
    assert_eq!(item.blocker, None);
    assert!(!item.requires_shared_target_confirmation);
    assert_eq!(item.consumer_deployment_ids, vec![selected]);

    let outcome = saved_copy(
        save_copy(
            &facade,
            &source,
            SaveAsCopyInheritance::ReplaceTargets {
                preview_id: preview.preview_id,
                targets: vec![choice(selected, false)],
            },
            None,
        )
        .await
        .expect("save as copy with replacement"),
    );
    let skillhub_core::api::SaveAsCopyInheritanceOutcome::Replaced { items } = &outcome.inheritance
    else {
        panic!(
            "expected replaced inheritance outcome, got {:?}",
            outcome.inheritance
        );
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].deployment_id, selected);
    assert_eq!(
        items[0].status,
        skillhub_core::api::SaveAsCopyTargetStatus::Applied
    );
    assert_eq!(items[0].error_code, None);
    assert_eq!(items[0].consumer_deployment_ids, vec![selected]);
    assert!(outcome.lineage_registered);

    // 部署记录重新指向新主体且同一位置只保留一条有效记录。
    let copy_deployments = deployments_of(&facade, outcome.skill_id).await;
    assert_eq!(copy_deployments.len(), 1);
    assert_eq!(copy_deployments[0].id, selected);
    assert_eq!(copy_deployments[0].runtime_name, "notebook-selected");
    let source_deployments = deployments_of(&facade, source.skill.id()).await;
    assert_eq!(source_deployments.len(), 1);
    assert_eq!(source_deployments[0].id, untouched);

    // 旧使用关系进入追加历史：结束 + 建立。
    let audit = fixture.audit();
    let history = audit
        .governance_history_repository()
        .list_for_relation(&format!("managed:{selected}"))
        .expect("read governance history");
    assert!(
        history
            .iter()
            .any(|event| event.action == "replace_inheritance"
                && event.result == "source_relation_ended"),
        "旧使用关系必须以历史事件结束：{history:?}"
    );
    assert!(
        history
            .iter()
            .any(|event| event.action == "replace_inheritance"
                && event.result == "new_relation_established"),
        "新使用关系必须以历史事件建立：{history:?}"
    );
}

/// RED：共享物理目标——预览列出全部消费者；未显式确认时提交被拒绝且
/// 什么都不改；确认后物理条目只被操作一次，其余消费者不受影响。
#[tokio::test]
async fn shared_target_replacement_requires_confirmation_and_lists_consumers() {
    let mut fixture = Fixture::new();
    let source = seed_source_skill(&mut fixture, "Notebook", "# Notebook\n").await;
    let database = open_database(&fixture.database_path);
    let target_dir = fixture.temp_dir();
    let alpha = seed_managed_entry_at(
        &database,
        &target_dir,
        source.skill.id(),
        &source.version_id,
        "notebook-alpha",
        "# Notebook\n",
    );
    let beta = seed_managed_entry_at(
        &database,
        &target_dir,
        source.skill.id(),
        &source.version_id,
        "notebook-beta",
        "# Notebook\n",
    );
    drop(database);
    let facade = fixture.facade();

    let preview = preview_replacement(&facade, source.skill.id(), vec![alpha]).await;
    assert_eq!(preview.targets.len(), 1);
    let mut consumers = preview.targets[0]
        .consumer_deployment_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>();
    consumers.sort();
    let mut expected = vec![alpha.to_string(), beta.to_string()];
    expected.sort();
    assert_eq!(consumers, expected, "预览必须列出共享目标的全部消费者");
    assert!(preview.targets[0].requires_shared_target_confirmation);

    // 未显式确认：提交被拒绝，条目与记账都不得改变。
    let rejected = save_copy(
        &facade,
        &source,
        SaveAsCopyInheritance::ReplaceTargets {
            preview_id: preview.preview_id,
            targets: vec![choice(alpha, false)],
        },
        None,
    )
    .await
    .expect_err("shared target replacement requires explicit confirmation");
    assert_eq!(rejected.code, ErrorCode::OperationConflict);
    assert_eq!(deployments_of(&facade, source.skill.id()).await.len(), 2);
    assert!(skill_result(&facade, source.skill.id())
        .await
        .upstream_lineage
        .is_none());

    // 显式确认（新预览）：alpha 条目换新，beta 保持来源主体。
    let confirmed_preview = preview_replacement(&facade, source.skill.id(), vec![alpha]).await;
    let outcome = saved_copy(
        save_copy(
            &facade,
            &source,
            SaveAsCopyInheritance::ReplaceTargets {
                preview_id: confirmed_preview.preview_id,
                targets: vec![choice(alpha, true)],
            },
            None,
        )
        .await
        .expect("save as copy with confirmed replacement"),
    );
    let skillhub_core::api::SaveAsCopyInheritanceOutcome::Replaced { items } = &outcome.inheritance
    else {
        panic!("expected replaced inheritance outcome");
    };
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0].status,
        skillhub_core::api::SaveAsCopyTargetStatus::Applied
    );
    assert_eq!(deployments_of(&facade, outcome.skill_id).await.len(), 1);
    assert_eq!(deployments_of(&facade, source.skill.id()).await.len(), 1);
}

/// RED：第 3 个目标中途失败 → 逐项结果可归属、登记恢复依据、不得声明
/// 全部继承或全部回滚、不得删除新主体或原主体。
#[tokio::test]
async fn a_mid_failure_replacement_reports_per_item_results_and_recovery_basis() {
    let mut fixture = Fixture::new();
    let source = seed_source_skill(&mut fixture, "Notebook", "# Notebook\n").await;
    let database = open_database(&fixture.database_path);
    let first = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook-one",
        "# Notebook\n",
        false,
    );
    let second = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook-two",
        "# Notebook\n",
        false,
    );
    let failing = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook-three",
        "# Notebook\n",
        true,
    );
    drop(database);
    let facade = fixture.facade();

    let preview =
        preview_replacement(&facade, source.skill.id(), vec![first, second, failing]).await;
    let outcome = saved_copy(
        save_copy(
            &facade,
            &source,
            SaveAsCopyInheritance::ReplaceTargets {
                preview_id: preview.preview_id,
                targets: vec![
                    choice(first, false),
                    choice(second, false),
                    choice(failing, false),
                ],
            },
            None,
        )
        .await
        .expect("partial failure must return a per-item outcome"),
    );
    let skillhub_core::api::SaveAsCopyInheritanceOutcome::PartiallyReplaced { items } =
        &outcome.inheritance
    else {
        panic!(
            "expected partially replaced outcome, got {:?}",
            outcome.inheritance
        );
    };
    assert_eq!(items.len(), 3);
    let status_of = |id: &DeploymentId| {
        items
            .iter()
            .find(|item| &item.deployment_id == id)
            .unwrap_or_else(|| panic!("missing item for {id}"))
    };
    assert_eq!(
        status_of(&first).status,
        skillhub_core::api::SaveAsCopyTargetStatus::Applied
    );
    assert_eq!(
        status_of(&second).status,
        skillhub_core::api::SaveAsCopyTargetStatus::Applied
    );
    assert_eq!(
        status_of(&failing).status,
        skillhub_core::api::SaveAsCopyTargetStatus::Failed
    );
    assert_eq!(
        status_of(&failing).error_code,
        Some(ErrorCode::OwnershipMismatch),
        "身份漂移必须以归属校验错误呈现"
    );
    assert_eq!(
        status_of(&first).consumer_deployment_ids,
        vec![first],
        "成功项只归属自己的消费者"
    );
    assert!(outcome.lineage_registered);

    // 恢复依据：操作日志保留 Applying 相位与逐项载荷，并出现恢复候选。
    let recovery_id = outcome
        .recovery_operation_id
        .expect("partial failure must persist recovery");
    let audit = fixture.audit();
    let record = audit
        .operation_repository()
        .get_sync(recovery_id)
        .expect("read operation journal")
        .expect("operation journal row must exist");
    assert_eq!(record.phase, OperationPhase::Applying);
    assert!(!record.recovery_data.is_null(), "逐项载荷必须持久化");
    drop(audit);
    assert!(replacement_candidates(&facade).await.contains(&recovery_id));

    // 已成功目标保持接管，失败目标保持原状；新主体与原主体都不得被删除。
    assert_eq!(deployments_of(&facade, outcome.skill_id).await.len(), 2);
    let source_deployments = deployments_of(&facade, source.skill.id()).await;
    assert_eq!(source_deployments.len(), 1);
    assert_eq!(source_deployments[0].id, failing);
    assert!(skill_result(&facade, outcome.skill_id)
        .await
        .upstream_lineage
        .is_some());
}

/// RED：预览一次性——提交成功后同一 preview_id 复用被拒绝；记账漂移
/// （指纹失效）同样拒绝，不得基于过期预览执行替换。
#[tokio::test]
async fn stale_or_consumed_previews_are_rejected() {
    let mut fixture = Fixture::new();
    let source = seed_source_skill(&mut fixture, "Notebook", "# Notebook\n").await;
    let database = open_database(&fixture.database_path);
    let first = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook-first",
        "# Notebook\n",
        false,
    );
    let second = seed_managed_entry(
        &mut fixture,
        &database,
        source.skill.id(),
        &source.version_id,
        "notebook-second",
        "# Notebook\n",
        false,
    );
    drop(database);
    let facade = fixture.facade();

    let preview = preview_replacement(&facade, source.skill.id(), vec![first]).await;
    saved_copy(
        save_copy(
            &facade,
            &source,
            SaveAsCopyInheritance::ReplaceTargets {
                preview_id: preview.preview_id,
                targets: vec![choice(first, false)],
            },
            None,
        )
        .await
        .expect("first replacement must succeed"),
    );

    // 预览一次性：同一 preview_id 不得再次驱动替换。
    let replay = save_copy(
        &facade,
        &source,
        SaveAsCopyInheritance::ReplaceTargets {
            preview_id: preview.preview_id,
            targets: vec![choice(second, false)],
        },
        None,
    )
    .await
    .expect_err("consumed preview must be rejected");
    assert_eq!(replay.code, ErrorCode::OperationConflict);

    // 记账漂移使指纹失效：预览之后部署记录被改动 → 提交被拒绝。
    let drifted = preview_replacement(&facade, source.skill.id(), vec![second]).await;
    {
        let audit = fixture.audit();
        audit
            .connection_for_test()
            .execute(
                "UPDATE deployments SET runtime_name='drifted' WHERE id=?1",
                rusqlite::params![second.to_string()],
            )
            .expect("drift deployment accounting");
    }
    let stale = save_copy(
        &facade,
        &source,
        SaveAsCopyInheritance::ReplaceTargets {
            preview_id: drifted.preview_id,
            targets: vec![choice(second, false)],
        },
        None,
    )
    .await
    .expect_err("fingerprint drift must invalidate the preview");
    assert_eq!(stale.code, ErrorCode::OperationConflict);
}

/// 在指定目标目录下种一个真实受管条目（共享目标场景：同一目录两个条目）。
fn seed_managed_entry_at(
    database: &Database,
    target_dir: &Path,
    skill_id: skillhub_core::SkillId,
    version_id: &skillhub_core::VersionId,
    runtime_name: &str,
    markdown: &str,
) -> DeploymentId {
    let destination = target_dir.join(runtime_name);
    std::fs::create_dir_all(&destination).expect("create entry");
    std::fs::write(destination.join("SKILL.md"), markdown).expect("write entry");
    let target_id = physical_id_for_path(target_dir).expect("target identity");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash entry");
    database
        .connection_for_test()
        .execute(
            "INSERT OR IGNORE INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'agent-fixture', 'global', ?2, 0)",
            rusqlite::params![target_id, target_dir.to_string_lossy().into_owned()],
        )
        .expect("insert target");
    database
        .connection_for_test()
        .execute(
            "INSERT OR IGNORE INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version_id.to_string(), skill_id.to_string()],
        )
        .expect("insert version");
    let deployment_id = DeploymentId::new();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO deployments (id, skill_id, version_id, target_id, state, method, managed, runtime_name, expected_hash, observed_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'deployed', 'managed_copy', 1, ?5, ?6, ?6, 0, 0)",
            rusqlite::params![
                deployment_id.to_string(),
                skill_id.to_string(),
                version_id.to_string(),
                target_id,
                runtime_name,
                expected_hash,
            ],
        )
        .expect("insert deployment");
    deployment_id
}
