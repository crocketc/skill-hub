use skillhub_application::library_runtime::LibraryContext;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, GetRollbackImpact,
    SetCurrentVersion,
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
        target_version: target,
    }
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
    assert_eq!(active.current(fixture.skill.id()).unwrap(), Some(previous.clone()));
    assert_eq!(
        std::fs::read_to_string(active.central.visible_skill_path(&fixture.skill).join("SKILL.md"))
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
    library.materialize_current_skill(&skill, &first.id).unwrap();
    library.save_portable_skill(&skill, Some(&first.id)).unwrap();
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
        .upsert_deployment_relation(
            &skillhub_core::relationship::DeploymentRelationFact {
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
                link_target_path_key: Some(
                    skillhub_core::deployment::observed_path_key(&central_target_text),
                ),
                link_target_directory_id: None,
                content_fingerprint: "sha256:shared".to_owned(),
                origin: skillhub_core::deployment::ObservedOrigin::Import,
                match_state: skillhub_core::deployment::ObservedMatchState::ContentVerified,
                health_reasons: Some(Vec::new()),
                active: true,
                observed_at: 1,
                released_at: None,
            },
        )
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
        error.params.get("reason").and_then(serde_json::Value::as_str),
        Some("version_adoption_relation_identity_unverified")
    );
    let active = fixture.facade.library_runtime().snapshot().unwrap();
    assert_eq!(
        std::fs::read_to_string(active.central.visible_skill_path(&fixture.skill).join("SKILL.md"))
            .unwrap(),
        "# First\n"
    );
    assert_eq!(
        std::fs::read_to_string(outside.path().join("user.txt")).unwrap(),
        "keep outside"
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
        error.params.get("reason").and_then(serde_json::Value::as_str),
        Some("version_preview_facts_changed_before_apply")
    );
    let active = fixture.facade.library_runtime().snapshot().unwrap();
    assert_eq!(
        active.current(fixture.skill.id()).unwrap(),
        Some(initial_pointer.clone())
    );
    assert_eq!(
        std::fs::read_to_string(active.central.visible_skill_path(&fixture.skill).join("SKILL.md"))
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
