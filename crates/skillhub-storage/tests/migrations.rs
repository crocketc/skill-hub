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

    assert_eq!(db.schema_version().unwrap(), 2);
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
