use skillhub_storage::{Database, RecoveryPoint};
use tempfile::tempdir;

#[test]
fn existing_database_gets_a_same_volume_recovery_point_and_discards_it_after_success() {
    let root = tempdir().unwrap();
    let path = root.path().join("skillhub.sqlite");
    std::fs::write(&path, b"before").unwrap();
    let point = RecoveryPoint::create(&path).unwrap().unwrap();
    assert!(point.backup_path().exists());
    point.discard().unwrap();
    assert!(!root.path().read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("pre-migration")
    }));
}

#[test]
fn invalid_database_is_restored_and_recovery_sidecar_is_removed() {
    let root = tempdir().unwrap();
    let path = root.path().join("skillhub.sqlite");
    std::fs::write(&path, b"not sqlite").unwrap();
    assert!(Database::open(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"not sqlite");
    assert!(!root.path().read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("pre-migration")
    }));
}

#[test]
fn opening_an_existing_database_migrates_and_leaves_no_recovery_sidecar() {
    let root = tempdir().unwrap();
    let path = root.path().join("skillhub.sqlite");
    let database = Database::open(&path).unwrap();
    assert_eq!(database.schema_version().unwrap(), 6);
    assert!(!root.path().read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("pre-migration")
    }));
}
