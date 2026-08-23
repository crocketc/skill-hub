use rusqlite::Connection;
use skillhub_storage::Database;
use tempfile::NamedTempFile;

fn fixture_database_with_schema_version(version: u32) -> NamedTempFile {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    connection
        .pragma_update(None, "user_version", version)
        .unwrap();
    connection.close().unwrap();
    file
}

#[test]
fn empty_database_migrates_to_current_schema_and_enables_fts5() {
    let db = Database::open_in_memory().unwrap();

    assert_eq!(db.schema_version().unwrap(), 4);
    assert!(db.has_table("skills_fts").unwrap());
}

#[test]
fn database_newer_than_application_is_rejected_with_read_only_recovery() {
    let db = fixture_database_with_schema_version(999);
    let error = Database::open(db.path()).unwrap_err();

    assert_eq!(error.code.as_str(), "database.newer_schema");
    assert!(error
        .actions
        .iter()
        .any(|action| action.as_str() == "open_read_only"));
}

#[test]
fn open_exposes_the_migration_report() {
    let db = Database::open_in_memory().unwrap();
    let report = db.migration_report();

    assert_eq!(report.from_version, 0);
    assert_eq!(report.to_version, 4);
    assert_eq!(report.applied_versions, vec![1, 2, 3, 4]);
}

#[test]
fn v2_database_upgrades_catalog_metadata_table() {
    let file = NamedTempFile::new().unwrap();
    let connection = Connection::open(file.path()).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .unwrap();
    connection
        .execute_batch(include_str!("../migrations/0002_fts.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 2).unwrap();
    connection.execute("INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES ('legacy','Legacy','legacy',1,1)", []).unwrap();
    drop(connection);
    let db = Database::open(file.path()).unwrap();
    assert!(db.has_table("catalog_skill_metadata").unwrap());
    assert_eq!(
        db.connection_for_test()
            .query_row(
                "SELECT display_name FROM skills WHERE id='legacy'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "Legacy"
    );
}
