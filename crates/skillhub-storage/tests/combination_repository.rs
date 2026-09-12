//! Combination repository durability rules: duplicate-name defense on
//! create/rename. Legacy "ambiguous shared name" conflicts were retired with
//! migration 0012: the unique index makes duplicate names unconstructible, so
//! the schema (not the repository) now guards that invariant — see
//! `migrations.rs::v11_database_dedupes_combination_names_and_enforces_uniqueness`.

use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{ErrorCode, RecoveryAction, SkillId};
use skillhub_storage::Database;
use std::future::Future;

fn block_on<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(future)
}

fn insert_skill(database: &Database, name: &str) -> SkillId {
    let skill = Skill::new(SkillId::new(), name);
    let repository = database.catalog_repository().expect("catalog repository");
    block_on(repository.insert(&skill)).expect("insert skill");
    skill.id()
}

fn name_count(database: &Database, name: &str) -> i64 {
    database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM combinations WHERE name=?1",
            [name],
            |row| row.get(0),
        )
        .expect("count combination rows")
}

#[test]
fn create_rejects_duplicate_names_with_target_exists() {
    let database = Database::open_in_memory().expect("database");
    let first = insert_skill(&database, "First");
    let repository = database.combination_repository();

    repository
        .create("Writing stack", &[first])
        .expect("create");
    let error = repository
        .create("Writing stack", &[first])
        .expect_err("a duplicate combination name must be rejected");
    assert_eq!(error.code, ErrorCode::TargetExists);
    assert_eq!(
        error
            .params
            .get("combination")
            .and_then(|value| value.as_str()),
        Some("Writing stack")
    );
    assert_eq!(error.actions, vec![RecoveryAction::ChooseAnotherName]);
    assert_eq!(name_count(&database, "Writing stack"), 1);
    assert_eq!(repository.list().expect("list").len(), 1);
}

#[test]
fn rename_rejects_existing_targets() {
    let database = Database::open_in_memory().expect("database");
    let first = insert_skill(&database, "First");
    let repository = database.combination_repository();

    repository.create("Other stack", &[first]).expect("create");
    repository
        .create("Writing stack", &[first])
        .expect("create");
    let error = repository
        .rename("Other stack", "Writing stack")
        .expect_err("renaming onto an existing name must fail");
    assert_eq!(error.code, ErrorCode::TargetExists);
    assert_eq!(name_count(&database, "Other stack"), 1);
    assert_eq!(name_count(&database, "Writing stack"), 1);
}

#[test]
fn single_name_update_delete_and_rename_still_resolve() {
    let database = Database::open_in_memory().expect("database");
    let first = insert_skill(&database, "First");
    let second = insert_skill(&database, "Second");
    let repository = database.combination_repository();

    repository
        .create("Writing stack", &[first])
        .expect("create");
    repository
        .update_members("Writing stack", &[first, second])
        .expect("update members");
    let view = repository
        .rename("Writing stack", "Prose stack")
        .expect("rename");
    assert_eq!(view.name, "Prose stack");
    assert_eq!(view.members, vec![first, second]);

    repository.delete("Prose stack").expect("delete");
    assert!(repository.list().expect("list").is_empty());
}

#[test]
fn rename_reports_missing_sources_as_object_not_found() {
    let database = Database::open_in_memory().expect("database");
    let first = insert_skill(&database, "First");
    let repository = database.combination_repository();

    let error = repository
        .rename("No such combination", "Whatever")
        .expect_err("renaming a missing combination must fail");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
    let _ = first;
}
