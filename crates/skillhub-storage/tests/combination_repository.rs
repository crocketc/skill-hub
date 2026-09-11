//! Combination repository durability rules: duplicate-name defense on
//! create/rename and loud conflicts for legacy rows that share one name
//! (previously resolved silently via `ORDER BY created_at LIMIT 1`).

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

/// Seeds two combination rows that share one name, mimicking legacy data
/// created before the duplicate-name defense existed.
fn seed_ambiguous_name(database: &Database, name: &str) {
    for suffix in ["a", "b"] {
        database
            .connection_for_test()
            .execute(
                "INSERT INTO combinations(id,name,created_at,updated_at) VALUES(?1,?2,1,1)",
                [format!("combo-{suffix}"), name.to_string()],
            )
            .expect("seed legacy combination row");
    }
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
fn update_members_reports_a_conflict_for_ambiguous_names() {
    let database = Database::open_in_memory().expect("database");
    let first = insert_skill(&database, "First");
    seed_ambiguous_name(&database, "Legacy combo");
    let repository = database.combination_repository();

    let error = repository
        .update_members("Legacy combo", &[first])
        .expect_err("an ambiguous name must not be silently narrowed");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error
            .params
            .get("combination")
            .and_then(|value| value.as_str()),
        Some("Legacy combo")
    );
    assert_eq!(
        error.params.get("matches").and_then(|value| value.as_i64()),
        Some(2),
        "the error must state how many rows collide"
    );
    assert_eq!(name_count(&database, "Legacy combo"), 2);
}

#[test]
fn delete_reports_a_conflict_for_ambiguous_names() {
    let database = Database::open_in_memory().expect("database");
    seed_ambiguous_name(&database, "Legacy combo");
    let repository = database.combination_repository();

    let error = repository
        .delete("Legacy combo")
        .expect_err("an ambiguous delete must not silently remove every row");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("matches").and_then(|value| value.as_i64()),
        Some(2)
    );
    assert_eq!(name_count(&database, "Legacy combo"), 2);
}

#[test]
fn rename_rejects_ambiguous_names_and_existing_targets() {
    let database = Database::open_in_memory().expect("database");
    let first = insert_skill(&database, "First");
    seed_ambiguous_name(&database, "Legacy combo");
    let repository = database.combination_repository();

    let error = repository
        .rename("Legacy combo", "Whatever")
        .expect_err("an ambiguous rename must fail loudly");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(name_count(&database, "Legacy combo"), 2);

    repository.create("Other stack", &[first]).expect("create");
    let error = repository
        .rename("Other stack", "Legacy combo")
        .expect_err("renaming onto an existing name must fail");
    assert_eq!(error.code, ErrorCode::TargetExists);
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
