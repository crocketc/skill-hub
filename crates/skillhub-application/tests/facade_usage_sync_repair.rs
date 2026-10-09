use skillhub_adapters::deployment::DeploymentFilesystem;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, CommitUsageChange, GetRollbackImpact,
    PrepareUsageChange, SetCurrentVersion,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::relationship::{UsageChangeItemStatus, UsageChangeResult};
use skillhub_core::ApplicationFacade;
use skillhub_storage::{CentralLibrary, Database, VersionStore};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

struct Fixture {
    _root: TempDir,
    database_path: PathBuf,
    library_root: PathBuf,
    skill: Skill,
    first_version: skillhub_core::VersionRecord,
    target_version: skillhub_core::VersionRecord,
}

async fn fixture() -> Fixture {
    let root = tempfile::tempdir().expect("fixture root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    let database = Database::open(&database_path).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Sync repair");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let library = CentralLibrary::initialize(&library_root).expect("library");
    let store = VersionStore::from_library(&library);
    let first_source = tempfile::tempdir().expect("first source");
    std::fs::write(first_source.path().join("SKILL.md"), "# First\n").expect("first content");
    let first_version = store
        .capture(skill.id(), first_source.path())
        .expect("capture first version");
    let target_source = tempfile::tempdir().expect("target source");
    std::fs::write(target_source.path().join("SKILL.md"), "# Target\n").expect("target content");
    let target_version = store
        .capture(skill.id(), target_source.path())
        .expect("capture target version");
    store
        .set_current(skill.id(), &first_version.id)
        .expect("initial current pointer");
    database
        .record_current_version(skill.id(), &first_version)
        .expect("initial database pointer");
    library
        .materialize_current_skill(&skill, &first_version.id)
        .expect("materialize current");
    library
        .save_portable_skill(&skill, Some(&first_version.id))
        .expect("save portable metadata");

    Fixture {
        _root: root,
        database_path,
        library_root,
        skill,
        first_version,
        target_version,
    }
}

fn facade(fixture: &Fixture) -> LocalApplicationFacade {
    LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    )
}

fn seed_managed_copy(
    fixture: &Fixture,
    name: &str,
    version: &skillhub_core::VersionRecord,
    deployed_content: &str,
    on_disk_content: &str,
) -> (skillhub_core::DeploymentId, PathBuf) {
    let target_path = fixture._root.path().join(name).join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&destination).expect("create target entry");
    std::fs::write(destination.join("SKILL.md"), deployed_content).expect("seed copy");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("copy hash");
    if on_disk_content != deployed_content {
        std::fs::write(destination.join("SKILL.md"), on_disk_content).expect("fork copy");
    }
    let observed_hash = DeploymentFilesystem::hash_tree(&destination).expect("observed hash");
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("physical target identity");
    let database = Database::open(&fixture.database_path).expect("database for seed");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, ?2, 'global', ?3, 0)",
            rusqlite::params![target_id, name, target_path.to_string_lossy().to_string()],
        )
        .expect("insert target");
    database
        .record_version(fixture.skill.id(), version)
        .expect("record version");
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
            expected_hash: expected_hash.clone(),
            observed_hash: Some(observed_hash),
        })
        .expect("insert managed deployment");
    (deployment_id, destination)
}

fn usage_change(
    action: &str,
    relation_id: &str,
    content_basis: Option<&str>,
) -> PrepareUsageChange {
    serde_json::from_value(serde_json::json!({
        "operation_id": skillhub_core::OperationId::new(),
        "action": action,
        "relation_ids": [relation_id],
        "problem_id": null,
        "skill_id": null,
        "requested_form": null,
        "copy_disposition": null,
        "content_basis": content_basis,
        "retain_entry_key": null,
        "selected_entry_keys": [],
        "runtime_name": null,
        "base_version_id": null,
        "non_recognized_destination": null
    }))
    .expect("deserialize requested usage action")
}

fn deploy_row(
    fixture: &Fixture,
    deployment_id: skillhub_core::DeploymentId,
) -> skillhub_core::DeploymentRecord {
    let database = Database::open(&fixture.database_path).expect("reopen database");
    database
        .deployment_repository()
        .list_all()
        .expect("list deployments")
        .into_iter()
        .find(|record| record.id == deployment_id)
        .expect("managed deployment row")
}

fn prepare_and_commit(
    facade: &LocalApplicationFacade,
    request: PrepareUsageChange,
) -> UsageChangeResult {
    let prepared = facade
        .prepare_usage_change(request)
        .expect("prepare action");
    facade
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("commit action")
}

async fn adopt_target_version(facade: &LocalApplicationFacade, fixture: &Fixture) -> String {
    let result = facade
        .query(AppQuery::GetRollbackImpact(GetRollbackImpact {
            skill_id: fixture.skill.id(),
            target_version_id: fixture.target_version.id.clone(),
        }))
        .await
        .expect("prepare adoption");
    let AppQueryResult::RollbackImpact(impact) = result else {
        panic!("expected rollback impact");
    };
    let result = facade
        .execute(AppCommand::SetCurrentVersion(SetCurrentVersion {
            skill_id: fixture.skill.id(),
            version_id: fixture.target_version.id.clone(),
            preview_id: impact.preview_id,
        }))
        .await
        .expect("adopt version");
    let AppCommandResult::OperationSummary(summary) = result else {
        panic!("expected operation summary");
    };
    summary.message_code
}

#[tokio::test]
async fn sync_failure_remains_managed_and_retries_after_restart() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "retry-agent",
        &fixture.first_version,
        "# First\n",
        "# Forked\n",
    );
    let first_facade = facade(&fixture);
    assert_eq!(
        adopt_target_version(&first_facade, &fixture).await,
        "version.adopted_deployment_partial"
    );
    drop(first_facade);
    let restarted_facade = facade(&fixture);
    let after_restart = deploy_row(&fixture, deployment_id);
    assert!(after_restart.managed);
    assert_eq!(after_restart.version_id, fixture.first_version.id);

    let prepared = restarted_facade
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect("prepare retry");
    let manifest_path = version_manifest_path(&fixture, &fixture.target_version);
    let manifest = std::fs::read(&manifest_path).expect("save source manifest");
    std::fs::remove_file(&manifest_path).expect("temporarily make source unverifiable");
    let failed = restarted_facade
        .commit_usage_change(CommitUsageChange {
            operation_id: prepared.operation_id,
            prepared_id: prepared.prepared_id,
        })
        .expect("return per-target sync failure");
    assert_eq!(failed.item_results[0].status, UsageChangeItemStatus::Failed);
    assert!(deploy_row(&fixture, deployment_id).managed);
    assert_eq!(
        deploy_row(&fixture, deployment_id).version_id,
        fixture.first_version.id
    );
    let database = Database::open(&fixture.database_path).expect("database after failed sync");
    let failed_relation = database
        .relationship_repository()
        .list_relations()
        .expect("managed relation facts")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relation after failed sync");
    assert_eq!(
        failed_relation.health_reasons,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::ContentChanged,
            skillhub_core::relationship::RelationHealthReason::OperationFailed,
        ])
    );
    drop(database);

    std::fs::write(&manifest_path, manifest).expect("restore source manifest");
    drop(restarted_facade);
    let retry_facade = facade(&fixture);
    let result = prepare_and_commit(
        &retry_facade,
        usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ),
    );
    assert_eq!(result.item_results.len(), 1);
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("synced content"),
        "# Target\n"
    );
    let after_retry = deploy_row(&fixture, deployment_id);
    assert!(after_retry.managed);
    assert_eq!(after_retry.version_id, fixture.target_version.id);
    let database = Database::open(&fixture.database_path).expect("database after retry");
    let recovered_relation = database
        .relationship_repository()
        .list_relations()
        .expect("managed relation facts after retry")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relation after retry");
    assert_eq!(recovered_relation.health_reasons, Some(Vec::new()));
}

fn version_manifest_path(fixture: &Fixture, version: &skillhub_core::VersionRecord) -> PathBuf {
    fixture
        .library_root
        .join(".skillhub")
        .join("versions")
        .join(fixture.skill.id().to_string())
        .join(format!(
            "{}.json",
            version
                .id
                .as_str()
                .strip_prefix("sha256:")
                .unwrap_or(version.id.as_str())
        ))
}

#[tokio::test]
async fn forked_copy_is_not_overwritten_without_content_choice() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "forked-agent",
        &fixture.first_version,
        "# First\n",
        "# User edit\n",
    );
    let app = facade(&fixture);
    let error = app
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            None,
        ))
        .expect_err("forked copy requires an explicit content choice");
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("reason")
            .and_then(serde_json::Value::as_str),
        Some("usage_sync_content_choice_required")
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("user content"),
        "# User edit\n"
    );
    assert!(deploy_row(&fixture, deployment_id).managed);
}

#[tokio::test]
async fn missing_entry_requires_explicit_restore() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "missing-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    std::fs::remove_dir_all(&destination).expect("remove target");
    let app = facade(&fixture);
    let error = app
        .prepare_usage_change(usage_change(
            "sync",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ))
        .expect_err("sync must not restore a missing entry implicitly");
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert!(!destination.exists());

    let result = prepare_and_commit(
        &app,
        usage_change("restore", &format!("managed:{deployment_id}"), None),
    );
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored copy"),
        "# First\n"
    );
}

#[cfg(unix)]
fn seed_managed_link(fixture: &Fixture) -> (skillhub_core::DeploymentId, PathBuf, PathBuf) {
    use std::os::unix::fs::symlink;
    let target_path = fixture._root.path().join("link-agent").join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&target_path).expect("create target");
    let visible_tree = fixture.library_root.join("skills").join(format!(
        "{}-{}",
        fixture.skill.runtime_name(),
        fixture.skill.id()
    ));
    let visible_tree = if visible_tree.exists() {
        visible_tree
    } else {
        std::fs::read_dir(fixture.library_root.join("skills"))
            .expect("skills directory")
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(&fixture.skill.id().to_string())
            })
            .expect("visible skill tree")
            .path()
    };
    symlink(&visible_tree, &destination).expect("create managed link");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash link");
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("physical target identity");
    let database = Database::open(&fixture.database_path).expect("database");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'link-agent', 'global', ?2, 0)",
            rusqlite::params![target_id, target_path.to_string_lossy().to_string()],
        )
        .expect("insert target");
    database
        .record_version(fixture.skill.id(), &fixture.first_version)
        .expect("record version");
    let deployment_id = skillhub_core::DeploymentId::new();
    database
        .deployment_repository()
        .insert_sync(&skillhub_core::DeploymentRecord {
            id: deployment_id,
            skill_id: fixture.skill.id(),
            version_id: fixture.first_version.id.clone(),
            target_id,
            state: skillhub_core::DeploymentState::Deployed,
            mode: skillhub_core::DeploymentMode::SymbolicLink,
            managed: true,
            runtime_name: fixture.skill.runtime_name().to_owned(),
            expected_hash: expected_hash.clone(),
            observed_hash: Some(expected_hash),
        })
        .expect("insert managed link");
    (deployment_id, destination, visible_tree)
}

#[cfg(windows)]
fn seed_managed_link(fixture: &Fixture) -> (skillhub_core::DeploymentId, PathBuf, PathBuf) {
    let target_path = fixture._root.path().join("link-agent").join("skills");
    let destination = target_path.join(fixture.skill.runtime_name());
    std::fs::create_dir_all(&target_path).expect("create target");
    let visible_tree = std::fs::read_dir(fixture.library_root.join("skills"))
        .expect("skills directory")
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(&fixture.skill.id().to_string())
        })
        .expect("visible skill tree")
        .path();
    skillhub_adapters::deployment::create_junction(&visible_tree, &destination)
        .expect("create managed junction");
    let expected_hash = DeploymentFilesystem::hash_tree(&destination).expect("hash junction");
    let target_id =
        skillhub_core::physical_id_for_path(&target_path).expect("physical target identity");
    let database = Database::open(&fixture.database_path).expect("database");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO targets (id, agent_id, scope, path, created_at) VALUES (?1, 'link-agent', 'global', ?2, 0)",
            rusqlite::params![target_id, target_path.to_string_lossy().to_string()],
        )
        .expect("insert target");
    database
        .record_version(fixture.skill.id(), &fixture.first_version)
        .expect("record version");
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
            expected_hash: expected_hash.clone(),
            observed_hash: Some(expected_hash),
        })
        .expect("insert managed junction");
    (deployment_id, destination, visible_tree)
}

#[tokio::test]
async fn replaced_link_requires_backup() {
    let fixture = fixture().await;
    let (deployment_id, destination, _visible_tree) = seed_managed_link(&fixture);
    #[cfg(unix)]
    std::fs::remove_file(&destination).expect("remove old symlink");
    #[cfg(windows)]
    std::fs::remove_dir(&destination).expect("remove old junction");
    std::fs::create_dir_all(&destination).expect("replace link with a directory");
    std::fs::write(destination.join("user.txt"), "keep me").expect("replacement content");
    let app = facade(&fixture);
    let result = prepare_and_commit(
        &app,
        usage_change(
            "repair",
            &format!("managed:{deployment_id}"),
            Some("library_current"),
        ),
    );
    let item = &result.item_results[0];
    assert_eq!(item.status, UsageChangeItemStatus::Applied, "{item:?}");
    let backup = item
        .recovery_point
        .as_ref()
        .expect("replacement backup retained");
    assert_eq!(
        std::fs::read_to_string(Path::new(&backup.path).join("user.txt"))
            .expect("read backed up replacement"),
        "keep me"
    );
    assert!(deploy_row(&fixture, deployment_id).managed);
}

#[tokio::test]
async fn restore_uses_real_target_mode() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "copy-mode-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    std::fs::remove_dir_all(&destination).expect("remove target");
    let result = prepare_and_commit(
        &facade(&fixture),
        usage_change("restore", &format!("managed:{deployment_id}"), None),
    );
    assert_eq!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    let restored = std::fs::symlink_metadata(&destination).expect("restored entry");
    assert!(!restored.file_type().is_symlink());
    assert_eq!(
        std::fs::read_to_string(destination.join("SKILL.md")).expect("restored content"),
        "# First\n"
    );
}

#[tokio::test]
async fn unverified_restore_is_not_success() {
    let fixture = fixture().await;
    let (deployment_id, destination) = seed_managed_copy(
        &fixture,
        "unverified-agent",
        &fixture.first_version,
        "# First\n",
        "# First\n",
    );
    std::fs::remove_dir_all(&destination).expect("remove target");
    let database = Database::open(&fixture.database_path).expect("database for missing fact");
    let mut missing_relation = database
        .relationship_repository()
        .list_relations()
        .expect("relations")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("managed relationship");
    missing_relation.health_reasons = Some(vec![
        skillhub_core::relationship::RelationHealthReason::TargetEntryMissing,
    ]);
    database
        .relationship_repository()
        .upsert_deployment_relation(&missing_relation)
        .expect("persist missing target fact");
    let version_manifest = version_manifest_path(&fixture, &fixture.first_version);
    std::fs::remove_file(version_manifest).expect("remove pinned source version manifest");
    let result = prepare_and_commit(
        &facade(&fixture),
        usage_change("restore", &format!("managed:{deployment_id}"), None),
    );
    assert_ne!(
        result.item_results[0].status,
        UsageChangeItemStatus::Applied
    );
    assert!(!destination.exists());
    assert!(deploy_row(&fixture, deployment_id).managed);
    let after_failure = Database::open(&fixture.database_path).expect("database after failure");
    let failed_relation = after_failure
        .relationship_repository()
        .list_relations()
        .expect("relations after failed restore")
        .into_iter()
        .find(|relation| relation.relation_id == format!("managed:{deployment_id}"))
        .expect("failed relationship remains active");
    assert_eq!(
        failed_relation.health_reasons,
        Some(vec![
            skillhub_core::relationship::RelationHealthReason::TargetEntryMissing,
            skillhub_core::relationship::RelationHealthReason::OperationFailed,
        ])
    );
}
