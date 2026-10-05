use skillhub_application::library_runtime::LibraryContext;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, GetRollbackImpact, SetCurrentVersion,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{ApplicationFacade, ErrorCode, OperationPhase};
use skillhub_storage::{CentralLibrary, Database, VersionStore};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tempfile::TempDir;

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

struct VersionFixture {
    _root: TempDir,
    database_path: PathBuf,
    facade: LocalApplicationFacade,
    skill: Skill,
    first_version: skillhub_core::VersionRecord,
    target_version: skillhub_core::VersionRecord,
}

async fn version_fixture() -> VersionFixture {
    let root = tempfile::tempdir().expect("isolated fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Version adoption");
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

    VersionFixture {
        _root: root,
        database_path,
        facade: LocalApplicationFacade::new_with_library(database, &library_root),
        skill,
        first_version: first,
        target_version: target,
    }
}

#[tokio::test]
async fn a_deployment_relation_created_after_the_preview_rejects_the_stale_adoption() {
    let fixture = version_fixture().await;
    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;

    // 组合部署（CommitProjectAssembly）经 insert_sync 同步 deployment_relations。
    // 在预览与提交之间出现新的 Skill 部署关系时，提交前重核必须识别事实漂移。
    let database = Database::open(&fixture.database_path).expect("second connection");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES ('assembly-target', 'assembly.agent', 'global', 'C:/agents/assembly/skills', 0)",
            [],
        )
        .expect("seed assembly target");
    database
        .record_version(fixture.skill.id(), &fixture.target_version)
        .expect("register target version row");
    database
        .deployment_repository()
        .insert_sync(&skillhub_core::DeploymentRecord {
            id: skillhub_core::DeploymentId::new(),
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            target_id: "assembly-target".to_owned(),
            state: skillhub_core::DeploymentState::Deployed,
            mode: skillhub_core::DeploymentMode::ManagedCopy,
            managed: true,
            runtime_name: fixture.skill.runtime_name().to_owned(),
            expected_hash: fixture.target_version.manifest.tree_hash.clone(),
            observed_hash: None,
        })
        .expect("insert assembly deployment");
    drop(database);

    let error = fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect_err("stale preview must be rejected");
    assert_eq!(error.code, ErrorCode::OperationConflict);

    // 被拒绝的采用不得改变任何消费面。
    drop(fixture.facade);
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let selected: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [fixture.skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("database current pointer");
    assert_eq!(selected, fixture.first_version.id.to_string());
}

#[tokio::test]
async fn adopting_a_version_updates_the_database_current_pointer() {
    let fixture = version_fixture().await;
    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;
    fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect("adopt target version");
    drop(fixture.facade);

    let database = Database::open(&fixture.database_path).expect("reopen database");
    let selected: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [fixture.skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("database current pointer");

    assert_eq!(selected, fixture.target_version.id.to_string());
}

#[tokio::test]
async fn adopting_a_version_records_a_committed_operation_journal_entry() {
    let fixture = version_fixture().await;
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
            version_id: fixture.target_version.id,
            preview_id,
        }))
        .await
        .expect("adopt target version");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    drop(fixture.facade);

    let database = Database::open(&fixture.database_path).expect("reopen database");
    let record = database
        .operation_repository()
        .get_sync(summary.operation_id)
        .expect("read operation journal");

    assert_eq!(
        record.map(|record| record.phase),
        Some(OperationPhase::Committed)
    );
}

#[tokio::test]
async fn applying_checkpoint_failure_keeps_all_version_consumers_untouched() {
    let fixture = version_fixture().await;
    let active = fixture.facade.library_runtime().snapshot().unwrap();
    let previous = active.current(fixture.skill.id()).unwrap().unwrap();
    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;
    fixture
        .facade
        .database_for_tests()
        .lock()
        .unwrap()
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER reject_version_adoption_applying \
             BEFORE UPDATE OF phase ON operations \
             WHEN NEW.kind='set_current_version' AND NEW.phase='applying' \
             BEGIN SELECT RAISE(FAIL, 'injected journal persistence failure'); END;",
        )
        .expect("install durable-checkpoint failure");

    let error = fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect_err("an unpersisted Applying phase must stop before physical writes");
    assert_eq!(error.code, ErrorCode::InternalError);

    let active = fixture.facade.library_runtime().snapshot().unwrap();
    assert_eq!(
        active.current(fixture.skill.id()).unwrap(),
        Some(previous.clone())
    );
    assert_eq!(
        std::fs::read_to_string(
            active
                .central
                .visible_skill_path(&fixture.skill)
                .join("SKILL.md")
        )
        .unwrap(),
        "# First\n"
    );
    assert_eq!(
        active
            .central
            .load_portable_skill(fixture.skill.id())
            .unwrap()
            .and_then(|(_, current)| current),
        Some(previous.clone())
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().unwrap();
    let database_pointer: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [fixture.skill.id().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(database_pointer, previous.to_string());
    assert_eq!(
        database
            .operation_repository()
            .get_sync(preview_id)
            .unwrap()
            .unwrap()
            .phase,
        OperationPhase::Prepared,
        "failed Applying checkpoint remains uncommitted and recoverable"
    );
}

#[tokio::test]
async fn restart_sweep_preserves_an_applying_version_adoption_for_recovery() {
    let root = tempfile::tempdir().expect("isolated fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Restart adoption");
    database
        .catalog_repository()
        .unwrap()
        .insert(&skill)
        .await
        .unwrap();
    let library = CentralLibrary::initialize(&library_root).unwrap();
    let store = VersionStore::from_library(&library);
    let first_source = tempfile::tempdir().unwrap();
    std::fs::write(first_source.path().join("SKILL.md"), "# First\n").unwrap();
    let first = store.capture(skill.id(), first_source.path()).unwrap();
    let target_source = tempfile::tempdir().unwrap();
    std::fs::write(target_source.path().join("SKILL.md"), "# Target\n").unwrap();
    let target = store.capture(skill.id(), target_source.path()).unwrap();
    store.set_current(skill.id(), &first.id).unwrap();
    database.record_current_version(skill.id(), &first).unwrap();
    library
        .materialize_current_skill(&skill, &first.id)
        .unwrap();
    library
        .save_portable_skill(&skill, Some(&first.id))
        .unwrap();
    let facade = LocalApplicationFacade::new_with_library(
        Database::open(&database_path).unwrap(),
        &library_root,
    );
    let preview_id = prepare_adoption(&facade, skill.id(), target.id.clone()).await;
    facade
        .database_for_tests()
        .lock()
        .unwrap()
        .connection_for_test()
        .execute(
            "UPDATE operations SET phase='applying',state='running' WHERE operation_id=?1",
            [preview_id.to_string()],
        )
        .unwrap();

    drop(facade);
    let reopened = LocalApplicationFacade::new_with_library(
        Database::open(&database_path).unwrap(),
        &library_root,
    );
    let record = reopened
        .database_for_tests()
        .lock()
        .unwrap()
        .operation_repository()
        .get_sync(preview_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        record.phase,
        OperationPhase::Applying,
        "startup sweep must preserve an operation that may have physical side effects"
    );
    let active = reopened.library_runtime().snapshot().unwrap();
    assert_eq!(active.current(skill.id()).unwrap(), Some(first.id));
    assert_eq!(
        std::fs::read_to_string(active.central.visible_skill_path(&skill).join("SKILL.md"))
            .unwrap(),
        "# First\n"
    );
}

#[tokio::test]
async fn portable_manifest_failure_restores_the_old_visible_version() {
    let root = tempfile::tempdir().expect("isolated fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Version rollback");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let fault_armed = Arc::new(AtomicBool::new(false));
    let fault = {
        let fault_armed = Arc::clone(&fault_armed);
        Arc::new(move |point: &str| {
            point == "before_manifest_replace" && fault_armed.swap(false, Ordering::SeqCst)
        })
    };
    let library = CentralLibrary::initialize_with_fault_handler(&library_root, fault)
        .expect("central library");
    let store = VersionStore::from_library(&library);
    let original_source = tempfile::tempdir().expect("original version source");
    std::fs::write(original_source.path().join("SKILL.md"), "# Original\n")
        .expect("write original version");
    let original = store
        .capture(skill.id(), original_source.path())
        .expect("capture original version");
    let target_source = tempfile::tempdir().expect("target version source");
    std::fs::write(target_source.path().join("SKILL.md"), "# Target\n")
        .expect("write target version");
    let target = store
        .capture(skill.id(), target_source.path())
        .expect("capture target version");
    store
        .set_current(skill.id(), &original.id)
        .expect("set original file-store pointer");
    library
        .materialize_current_skill(&skill, &original.id)
        .expect("materialize original version");
    library
        .save_portable_skill(&skill, Some(&original.id))
        .expect("save original portable metadata");
    database
        .record_current_version(skill.id(), &original)
        .expect("seed original database pointer");

    let facade = LocalApplicationFacade::new(database);
    facade
        .library_runtime()
        .publish(Arc::new(LibraryContext::from_library(library)))
        .expect("publish fault-injected library");
    fault_armed.store(true, Ordering::SeqCst);

    let preview_id = prepare_adoption(&facade, skill.id(), target.id.clone()).await;
    let error = facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: skill.id(),
            version_id: target.id.clone(),
            preview_id,
        }))
        .await
        .expect_err("portable manifest fault must abort version adoption");
    assert_eq!(error.code, ErrorCode::InternalError);

    let active = facade.library_runtime().snapshot().expect("active library");
    let file_store_current = active.current(skill.id()).expect("read file-store pointer");
    let portable_current = active
        .central
        .load_portable_skill(skill.id())
        .expect("read portable metadata")
        .and_then(|(_, current)| current);
    let visible_content =
        std::fs::read_to_string(active.central.visible_skill_path(&skill).join("SKILL.md"))
            .expect("read visible Skill");
    let database_handle = facade.database_for_tests();
    let database = database_handle.lock().expect("database lock");
    let database_current: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("read database pointer");

    assert_eq!(
        (
            file_store_current,
            database_current,
            portable_current,
            visible_content,
        ),
        (
            Some(original.id.clone()),
            original.id.to_string(),
            Some(original.id),
            "# Original\n".to_owned(),
        ),
        "a failed adoption must restore all four version consumers"
    );
}

#[tokio::test]
async fn adoption_rejects_a_shared_relation_link_replaced_with_another_directory() {
    let fixture = version_fixture().await;
    let outside = tempfile::tempdir_in(fixture._root.path()).expect("outside target");
    std::fs::write(outside.path().join("user.txt"), "keep outside").unwrap();
    let relation_root = fixture._root.path().join("agent");
    std::fs::create_dir_all(&relation_root).unwrap();
    let relation_path = relation_root.join("skill");
    create_directory_link(outside.path(), &relation_path).expect("create real relation link");

    let central_target = fixture
        .facade
        .library_runtime()
        .snapshot()
        .expect("active library")
        .central
        .visible_skill_path(&fixture.skill);
    let relation_path_text = relation_path.to_string_lossy().into_owned();
    let central_target_text = central_target.to_string_lossy().into_owned();
    let representation = if cfg!(windows) {
        skillhub_core::relationship::FileRepresentation::DirectoryJunction
    } else {
        skillhub_core::relationship::FileRepresentation::SymbolicLink
    };
    let database = fixture.facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .upsert_deployment_relation(&skillhub_core::relationship::DeploymentRelationFact {
            relation_id: "shared-link:agent:skill".to_owned(),
            skill_id: Some(fixture.skill.id()),
            agent_client_id: "agent.test".to_owned(),
            path: relation_path_text.clone(),
            path_key: skillhub_core::deployment::observed_path_key(&relation_path_text),
            directory_node_id: None,
            relationship: skillhub_core::relationship::RelationshipType::SharedDirectoryReference,
            file_representation: representation,
            ownership: skillhub_core::relationship::OwnershipState::SharedReference,
            link_target_path: Some(central_target_text.clone()),
            link_target_path_key: Some(skillhub_core::deployment::observed_path_key(
                &central_target_text,
            )),
            link_target_directory_id: None,
            content_fingerprint: "sha256:shared".to_owned(),
            origin: skillhub_core::deployment::ObservedOrigin::Import,
            match_state: skillhub_core::deployment::ObservedMatchState::ContentVerified,
            health_reasons: Some(Vec::new()),
            active: true,
            observed_at: 1,
            released_at: None,
        })
        .expect("seed observed shared relationship");

    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;
    let error = fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect_err("a fact claiming the central target cannot authorize another physical link");

    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("version_adoption_relation_identity_unverified")
    );
    let active = fixture.facade.library_runtime().snapshot().unwrap();
    assert_eq!(
        std::fs::read_to_string(
            active
                .central
                .visible_skill_path(&fixture.skill)
                .join("SKILL.md")
        )
        .unwrap(),
        "# First\n"
    );
    assert_eq!(
        std::fs::read_to_string(outside.path().join("user.txt")).unwrap(),
        "keep outside"
    );
}

// ============================================================================
// K1b：内容采用调用方的统一"四消费面一致 + 日志四相 + 失败补偿"采用流。
//
// CreateSkill / SaveSkillContent / SaveMarkdownContent / SaveMarkdownAsCopy /
// ApplySourceUpdate 与版本采用（SetCurrentVersion）共享同一批消费面：
// ①版本库指针 ②可见树 ③portable manifest ④DB current_pointers。
// 物理变更前必须先持久化恢复快照（Applying 检查点）；补偿全部成功 →
// RolledBack，任何补偿面失败 → NeedsRecovery 并保留恢复事实。
// ============================================================================

type ContentFaultHandler = skillhub_storage::ManifestFaultHandler;

/// "armed + fired" 故障注入：构造期默认不触发（initialize 的 manifest 写入
/// 不消耗），测试显式武装后只在被测命令路径上命中 `before_manifest_replace`。
/// one-shot 消费一次即失效；persistent 持续命中（补偿也会失败）。
struct ContentFault {
    armed: Arc<AtomicBool>,
    handler: ContentFaultHandler,
}

impl ContentFault {
    fn one_shot() -> Self {
        Self::build(false)
    }

    fn persistent() -> Self {
        Self::build(true)
    }

    fn build(persistent: bool) -> Self {
        let armed = Arc::new(AtomicBool::new(false));
        let handler = {
            let armed = Arc::clone(&armed);
            let fired = Arc::new(AtomicBool::new(false));
            Arc::new(move |point: &str| {
                point == "before_manifest_replace"
                    && armed.load(Ordering::SeqCst)
                    && (persistent || !fired.swap(true, Ordering::SeqCst))
            }) as ContentFaultHandler
        };
        Self { armed, handler }
    }

    fn arm(&self) {
        self.armed.store(true, Ordering::SeqCst);
    }
}

struct ContentFixture {
    _root: TempDir,
    database_path: PathBuf,
    library_root: PathBuf,
    facade: LocalApplicationFacade,
    skill: Skill,
    first_version: skillhub_core::VersionRecord,
}

/// 已存在的单版本 Skill：store 指针、DB 指针、portable、可见树四个消费面
/// 都指向 SKILL.md = "# First\n" 的首个版本；facade 带故障注入构造。
async fn content_fixture(fault: ContentFault) -> ContentFixture {
    let root = tempfile::tempdir().expect("isolated fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Content adoption");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_library_and_faults(
        database,
        &library_root,
        Arc::clone(&fault.handler),
    );
    let active = facade.library_runtime().snapshot().expect("active library");
    let store = VersionStore::from_library(&active.central);
    let first_source = tempfile::tempdir().expect("first version source");
    std::fs::write(first_source.path().join("SKILL.md"), "# First\n").expect("first content");
    let first = store
        .capture(skill.id(), first_source.path())
        .expect("capture first version");
    store
        .set_current(skill.id(), &first.id)
        .expect("set initial file-store pointer");
    facade
        .database_for_tests()
        .lock()
        .unwrap()
        .record_current_version(skill.id(), &first)
        .expect("seed initial database pointer");
    active
        .central
        .materialize_current_skill(&skill, &first.id)
        .expect("materialize initial version");
    active
        .central
        .save_portable_skill(&skill, Some(&first.id))
        .expect("seed portable metadata");
    fault.arm();

    ContentFixture {
        _root: root,
        database_path,
        library_root,
        facade,
        skill,
        first_version: first,
    }
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

fn portable_current_version(
    library_root: &Path,
    skill_id: skillhub_core::SkillId,
) -> Option<skillhub_core::VersionId> {
    let manifest = skillhub_storage::PortableManifestStore::new(
        library_root.join(".skillhub").join("library.json"),
        Arc::new(|_| false),
    )
    .load()
    .expect("read portable manifest");
    manifest
        .skills
        .into_iter()
        .find(|record| record.id == skill_id)
        .and_then(|record| record.current_version)
}

fn journal_phase(database_path: &Path, kind: &str) -> String {
    let database = Database::open(database_path).expect("reopen database");
    database
        .connection_for_test()
        .query_row(
            "SELECT phase FROM operations WHERE kind=?1",
            [kind],
            |row| row.get(0),
        )
        .expect("journal row for kind")
}

/// K1b-1：SaveMarkdownContent 在 portable 写入处失败（one-shot）。
/// 统一流要求四个消费面全部回到采用前事实，且日志终相 RolledBack。
#[tokio::test]
async fn k1b_save_markdown_portable_failure_restores_all_content_consumers() {
    let fixture = content_fixture(ContentFault::one_shot()).await;
    let read = fixture
        .facade
        .query(AppQuery::ReadMarkdownFile(
            skillhub_core::api::ReadMarkdownFile {
                skill_id: fixture.skill.id(),
                path: "SKILL.md".into(),
                version_id: None,
            },
        ))
        .await
        .expect("read current markdown");
    let AppQueryResult::MarkdownFile(content) = read else {
        panic!("expected markdown content");
    };

    let error = fixture
        .facade
        .execute(AppCommand::SaveMarkdownContent(
            skillhub_core::api::SaveMarkdownContent {
                skill_id: fixture.skill.id(),
                path: "SKILL.md".into(),
                markdown: "# Second".into(),
                expected_identity: content.content_identity,
            },
        ))
        .await
        .expect_err("a failed portable write must abort the markdown save");
    assert_eq!(error.code, ErrorCode::InternalError);
    drop(fixture.facade);

    // 可见树断言在 drop 之后用裸 fs 读；不得重新 initialize（会掩盖补偿缺口）。
    assert_eq!(
        std::fs::read_to_string(
            visible_skill_tree(&fixture.library_root, fixture.skill.id()).join("SKILL.md")
        )
        .expect("visible SKILL.md"),
        "# First\n",
        "可见树必须仍停留在一个失败保存之前的版本"
    );
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let pointer: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [fixture.skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("database current pointer");
    assert_eq!(pointer, fixture.first_version.id.to_string());
    assert_eq!(
        portable_current_version(&fixture.library_root, fixture.skill.id()),
        Some(fixture.first_version.id.clone()),
        "portable current_version 必须仍指向首个版本"
    );
    assert_eq!(
        journal_phase(&fixture.database_path, "save_markdown_content"),
        "rolled_back",
        "补偿全部成功的失败保存必须以 RolledBack 终结"
    );
}

/// K1b-2：同场景但持久故障——补偿本身也会失败。
/// 统一流必须以 NeedsRecovery 终结，并在 tmp 目录保留
/// `visible-backup-<skill_id>-*` 备份条目作为恢复事实。
#[tokio::test]
async fn k1b_persistent_portable_failure_during_save_markdown_retains_recovery_facts() {
    let fixture = content_fixture(ContentFault::persistent()).await;
    let read = fixture
        .facade
        .query(AppQuery::ReadMarkdownFile(
            skillhub_core::api::ReadMarkdownFile {
                skill_id: fixture.skill.id(),
                path: "SKILL.md".into(),
                version_id: None,
            },
        ))
        .await
        .expect("read current markdown");
    let AppQueryResult::MarkdownFile(content) = read else {
        panic!("expected markdown content");
    };

    let error = fixture
        .facade
        .execute(AppCommand::SaveMarkdownContent(
            skillhub_core::api::SaveMarkdownContent {
                skill_id: fixture.skill.id(),
                path: "SKILL.md".into(),
                markdown: "# Second".into(),
                expected_identity: content.content_identity,
            },
        ))
        .await
        .expect_err("a persistent portable failure must abort the markdown save");
    assert_eq!(error.code, ErrorCode::InternalError);
    drop(fixture.facade);

    assert_eq!(
        journal_phase(&fixture.database_path, "save_markdown_content"),
        "needs_recovery",
        "补偿失败的内容采用必须进入 NeedsRecovery"
    );
    let backup_prefix = format!("visible-backup-{}-", fixture.skill.id());
    let backups = std::fs::read_dir(fixture.library_root.join(".skillhub").join("tmp"))
        .expect("library tmp directory")
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(backup_prefix.as_str())
        })
        .count();
    assert!(
        backups >= 1,
        "补偿失败时必须保留 visible-backup-<skill_id>-* 恢复事实"
    );
}

/// K1b-3：SaveSkillContent（源目录内容改为 "# Second"）在 portable 写入处
/// 失败（one-shot）：与 K1b-1 相同的四消费面矩阵 + RolledBack 终相。
#[tokio::test]
async fn k1b_save_skill_content_portable_failure_restores_all_content_consumers() {
    let fixture = content_fixture(ContentFault::one_shot()).await;
    let authoring = tempfile::tempdir().expect("authoring dir");
    std::fs::write(authoring.path().join("SKILL.md"), "# Second\n").expect("updated content");

    let error = fixture
        .facade
        .execute(AppCommand::SaveSkillContent(
            skillhub_core::api::SaveSkillContent {
                skill_id: fixture.skill.id(),
                source_path: authoring.path().to_string_lossy().into_owned(),
            },
        ))
        .await
        .expect_err("a failed portable write must abort the content save");
    assert_eq!(error.code, ErrorCode::InternalError);
    drop(fixture.facade);

    assert_eq!(
        std::fs::read_to_string(
            visible_skill_tree(&fixture.library_root, fixture.skill.id()).join("SKILL.md")
        )
        .expect("visible SKILL.md"),
        "# First\n",
        "可见树必须仍停留在一个失败保存之前的版本"
    );
    let database = Database::open(&fixture.database_path).expect("reopen database");
    let pointer: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [fixture.skill.id().to_string()],
            |row| row.get(0),
        )
        .expect("database current pointer");
    assert_eq!(pointer, fixture.first_version.id.to_string());
    assert_eq!(
        portable_current_version(&fixture.library_root, fixture.skill.id()),
        Some(fixture.first_version.id.clone())
    );
    assert_eq!(
        journal_phase(&fixture.database_path, "save_skill_content"),
        "rolled_back"
    );
}

/// K1b-4：CreateSkill 在 save_portable_skill 处失败（one-shot）。
/// 新建主体的补偿必须把四个消费面的"新增物"全部移除：catalog 无行、
/// store 指针为空、portable 无记录、可见树目录不存在、versions 无残留。
#[tokio::test]
async fn k1b_create_skill_portable_failure_removes_the_new_visible_tree() {
    let fixture_root = tempfile::tempdir().expect("isolated fixture root");
    let database_path = fixture_root.path().join("skillhub.sqlite");
    let library_root = fixture_root.path().join("library");
    let fault = ContentFault::one_shot();
    let database = Database::open(&database_path).expect("database");
    let facade = LocalApplicationFacade::new_with_library_and_faults(
        database,
        &library_root,
        Arc::clone(&fault.handler),
    );
    fault.arm();
    let authoring = tempfile::tempdir_in(fixture_root.path()).expect("authoring dir");
    std::fs::write(authoring.path().join("SKILL.md"), "# Fresh\n").expect("fresh content");

    let error = facade
        .execute(AppCommand::CreateSkill(skillhub_core::api::CreateSkill {
            name: "Fresh skill".into(),
            source_path: authoring.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect_err("a failed portable write must abort the skill creation");
    assert_eq!(error.code, ErrorCode::InternalError);
    drop(facade);

    assert_eq!(
        journal_phase(&database_path, "create_skill"),
        "rolled_back",
        "新建主体补偿成功必须以 RolledBack 终结"
    );
    let database = Database::open(&database_path).expect("reopen database");
    let catalog_rows: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM skills", [], |row| row.get(0))
        .expect("catalog count");
    assert_eq!(catalog_rows, 0, "失败的创建不得留下 catalog 行");
    let pointer_rows: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM current_pointers", [], |row| {
            row.get(0)
        })
        .expect("pointer count");
    assert_eq!(pointer_rows, 0, "失败的创建不得留下版本库当前指针");
    let version_rows: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM versions", [], |row| row.get(0))
        .expect("version count");
    assert_eq!(version_rows, 0, "失败的创建不得留下 versions 残留");
    assert_eq!(
        portable_current_version(&library_root, skillhub_core::SkillId::new()),
        None,
        "portable manifest 不得有失败创建的记录"
    );
    let manifest = skillhub_storage::PortableManifestStore::new(
        library_root.join(".skillhub").join("library.json"),
        Arc::new(|_| false),
    )
    .load()
    .expect("read portable manifest");
    assert!(
        manifest.skills.is_empty(),
        "失败创建不得在 portable manifest 留下任何 skill 记录"
    );
    let visible_entries = std::fs::read_dir(library_root.join("skills"))
        .expect("skills directory")
        .flatten()
        .count();
    assert_eq!(
        visible_entries, 0,
        "失败创建必须移除已物化的可见树（当前实现遗留该目录）"
    );
}

// ---- K1b-5：TakeUpstream 成功路径复用 upstream fixture ----

fn archive_server(route: &'static str, body: Vec<u8>) -> String {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address");
    let body = Arc::new(body);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let body = Arc::clone(&body);
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                let (status, payload) = if path.starts_with(route) {
                    (200, body.as_slice())
                } else {
                    (404, b"not found".as_slice())
                };
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(payload);
            });
        }
    });
    format!("http://{address}")
}

fn repo_zip(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        for (name, body) in entries {
            zip.start_file(name, SimpleFileOptions::default())
                .expect("zip entry");
            zip.write_all(&body).expect("zip body");
        }
        zip.finish().expect("zip finish");
    }
    cursor.into_inner()
}

fn upstream_origin() -> skillhub_core::UpstreamOrigin {
    skillhub_core::UpstreamOrigin {
        url: "https://github.com/anthropics/skills".into(),
        branch: "main".into(),
        directory: "pdf".into(),
    }
}

async fn import_skill_with_upstream(
    facade: &LocalApplicationFacade,
    content: &str,
) -> skillhub_core::SkillId {
    let source = tempfile::tempdir().expect("source");
    std::fs::create_dir_all(source.path()).expect("create source dir");
    std::fs::write(source.path().join("SKILL.md"), content).expect("write skill");
    let candidate = skillhub_core::ImportCandidate::detected(
        skillhub_core::SourceDescriptor::new(
            skillhub_core::SourceKind::Local,
            skillhub_core::SourceLocator::local_path(source.path()),
        ),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    )
    .with_upstream(upstream_origin());

    let prepared = facade
        .execute(AppCommand::PrepareImport(skillhub_core::PrepareImport {
            candidate,
            tree_hash: None,
            runtime_name_override: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: skillhub_core::ImportDecision::CopyIntoLibrary,
            governance_decision: skillhub_core::ImportGovernanceDecision {
                group_actions: prepared
                    .analysis
                    .governance_groups
                    .iter()
                    .map(|group| (group.group_id.clone(), group.default_action))
                    .collect(),
                item_overrides: Default::default(),
            },
            batch_id: None,
            candidate_key: None,
            runtime_name_override: None,
            batch_signature: None,
            security_decision: None,
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary.items[0].skill_id.expect("imported skill id")
}

/// K1b-5：TakeUpstream 成功后四个消费面必须一致指向新版本；当前实现
/// 从不写 DB current_pointers（导入写入的旧指针被遗留），RED。
#[tokio::test]
async fn k1b_take_upstream_success_points_every_consumer_at_the_new_version() {
    let base = archive_server(
        "/anthropics/skills/archive/refs/heads/main.zip",
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream\n".to_vec(),
        )]),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let database = Database::open(&database_path).expect("database");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        skillhub_adapters::source::RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;

    let preview = facade
        .execute(AppCommand::PrepareSourceUpdate(
            skillhub_core::PrepareSourceUpdate { skill_id },
        ))
        .await
        .expect("prepare must preview the git candidate");
    let AppCommandResult::SourceUpdatePreview(preview) = preview else {
        panic!("expected source update preview");
    };
    let applied = facade
        .execute(AppCommand::CommitSourceUpdate(
            skillhub_core::CommitSourceUpdate {
                preview_id: preview.preview_id,
                decision: skillhub_core::UpdateDecision::TakeUpstream,
            },
        ))
        .await
        .expect("take upstream must apply for a git source");
    let AppCommandResult::AppliedSourceUpdate(applied) = applied else {
        panic!("expected applied source update");
    };
    let new_version = applied.new_version.clone().expect("采用上游必须创建新版本");
    drop(facade);

    let database = Database::open(&database_path).expect("reopen database");
    let pointer: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [skill_id.to_string()],
            |row| row.get(0),
        )
        .expect("database current pointer");
    assert_eq!(
        pointer,
        new_version.to_string(),
        "DB current_pointers 必须指向采用后的新版本"
    );
    let library = CentralLibrary::open_existing(&library_root).expect("reopen library");
    assert_eq!(
        VersionStore::from_library(&library)
            .current(skill_id)
            .expect("read store pointer"),
        Some(new_version.clone()),
        "版本库指针必须指向新版本"
    );
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Changed upstream\n",
        "可见树内容必须来自上游"
    );
    assert_eq!(
        portable_current_version(&library_root, skill_id),
        Some(new_version.clone()),
        "portable current_version 必须指向新版本"
    );
    assert_eq!(
        journal_phase(&database_path, "commit_source_update"),
        "committed",
        "成功的来源采用必须留下 Committed 日志行"
    );
}

fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        skillhub_adapters::deployment::create_junction(target, link)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory links are unsupported on this platform",
        ))
    }
}

#[tokio::test]
async fn adoption_rechecks_database_pointer_drift_after_the_basic_check_await() {
    let fixture = version_fixture().await;
    let initial_pointer = fixture
        .facade
        .library_runtime()
        .snapshot()
        .unwrap()
        .current(fixture.skill.id())
        .unwrap()
        .expect("initial current version");
    let preview_id = prepare_adoption(
        &fixture.facade,
        fixture.skill.id(),
        fixture.target_version.id.clone(),
    )
    .await;
    let trigger = format!(
        "CREATE TRIGGER drift_current_pointer_after_check \
         AFTER INSERT ON check_runs \
         WHEN NEW.version_id='{}' AND NEW.kind='basic' \
         BEGIN UPDATE current_pointers SET version_id='{}' WHERE skill_id='{}'; END;",
        fixture.target_version.id,
        fixture.target_version.id,
        fixture.skill.id(),
    );
    fixture
        .facade
        .database_for_tests()
        .lock()
        .unwrap()
        .connection_for_test()
        .execute_batch(&trigger)
        .expect("install deterministic in-flight drift");

    let error = fixture
        .facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id,
        }))
        .await
        .expect_err("a changed current pointer invalidates the preview after awaited checks");

    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("version_preview_facts_changed_before_apply")
    );
    let active = fixture.facade.library_runtime().snapshot().unwrap();
    assert_eq!(
        active.current(fixture.skill.id()).unwrap(),
        Some(initial_pointer.clone())
    );
    assert_eq!(
        std::fs::read_to_string(
            active
                .central
                .visible_skill_path(&fixture.skill)
                .join("SKILL.md")
        )
        .unwrap(),
        "# First\n"
    );
    assert_eq!(
        active
            .central
            .load_portable_skill(fixture.skill.id())
            .unwrap()
            .and_then(|(_, current)| current),
        Some(initial_pointer)
    );
    let database = fixture.facade.database_for_tests();
    let database = database.lock().unwrap();
    let externally_changed_pointer: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [fixture.skill.id().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        externally_changed_pointer,
        fixture.target_version.id.to_string(),
        "the adoption must not overwrite the concurrent database fact"
    );
}
