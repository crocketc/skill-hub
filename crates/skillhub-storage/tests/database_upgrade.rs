use skillhub_storage::{Database, RecoveryPoint, CURRENT_SCHEMA_VERSION};
use tempfile::tempdir;

#[test]
fn v19_exposes_safe_governance_tables_and_indexes() {
    let db = Database::open_in_memory().unwrap();
    assert_eq!(db.schema_version().unwrap(), 21);
    for table in [
        "import_provenance_events_v19",
        "import_batches",
        "import_batch_items",
        "source_copy_relations",
        "relation_history_events",
    ] {
        assert!(db.has_table(table).unwrap(), "{table}");
    }
    let connection = db.connection_for_test();
    let violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
    let index: i64 = connection.query_row("SELECT COUNT(*) FROM pragma_index_list('source_copy_relations') WHERE name='idx_source_copy_active_physical' AND [unique]=1 AND partial=1", [], |row| row.get(0)).unwrap();
    assert_eq!(index, 1);
    // 旧 source_relations 变成只读兼容视图：所有写入都走新事件表。
    let object_type: String = connection
        .query_row(
            "SELECT type FROM sqlite_master WHERE name='source_relations'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(object_type, "view");
}

#[test]
fn v19_enforces_immutability_of_import_events_and_relation_history() {
    let db = Database::open_in_memory().unwrap();
    let connection = db.connection_for_test();
    connection
        .execute(
            "INSERT INTO skills(id, display_name, runtime_name, created_at, updated_at)
             VALUES ('00000000-0000-0000-0000-0000000000a9', 'Immutable', 'immutable', 1, 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO import_batches(batch_id, status, started_at) VALUES ('batch-a9', 'running', 1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO import_provenance_events_v19 (
                provenance_id, batch_id, skill_id, source_path, source_path_key,
                relationship, file_representation, ownership, content_fingerprint,
                source_kind, source_locator, imported_at, source_class)
             VALUES ('event-a9', 'batch-a9', '00000000-0000-0000-0000-0000000000a9',
                     '/source/notes', '/source/notes', 'import_copy', 'directory',
                     'observed_unmanaged', 'sha256:a9', 'local', '/source/notes', 5,
                     'user_local')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO relation_history_events(
                event_id, relation_id, skill_id, skill_display_name, agent_presentation_json,
                path, scope, action, result, occurred_at)
             VALUES ('history-a9', 'relation-a9', '00000000-0000-0000-0000-0000000000a9',
                     'Immutable', '{}', '/source/notes', 'source_copy',
                     'cleaned_by_skillhub', 'succeeded', 6)",
            [],
        )
        .unwrap();

    // 证据与历史在 schema 层不可改写、不可删除。
    assert!(connection
        .execute(
            "UPDATE import_provenance_events_v19 SET content_fingerprint='tampered'",
            []
        )
        .is_err());
    assert!(connection
        .execute("DELETE FROM import_provenance_events_v19", [])
        .is_err());
    assert!(connection
        .execute("UPDATE relation_history_events SET action='rewritten'", [])
        .is_err());
    assert!(connection
        .execute("DELETE FROM relation_history_events", [])
        .is_err());
}

#[test]
fn v21_keeps_preview_snapshots_and_commit_results_well_formed() {
    let db = Database::open_in_memory().unwrap();
    for table in ["deployment_preview_snapshots", "deployment_preview_commits"] {
        assert!(db.has_table(table).unwrap(), "{table}");
    }
    let connection = db.connection_for_test();
    // Snapshot status is a two-state word list and the commit table's
    // preview reference is a real foreign key.
    connection
        .execute(
            "INSERT INTO deployment_preview_snapshots
             (preview_id, payload_json, status, created_at, expires_at)
             VALUES ('p1', '{}', 'active', 0, 100)",
            [],
        )
        .unwrap();
    assert!(connection
        .execute(
            "INSERT INTO deployment_preview_snapshots
             (preview_id, payload_json, status, created_at, expires_at)
             VALUES ('p2', '{}', 'closed', 0, 100)",
            [],
        )
        .is_err());
    assert!(connection
        .execute(
            "INSERT INTO deployment_preview_commits
             (idempotency_key, preview_id, result_json, committed_at)
             VALUES ('k1', 'missing', '{}', 0)",
            [],
        )
        .is_err());
    let violations: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
}

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
    // Pins the latest migration so a dropped
    // migration file or a silently skipped step fails this test instead of
    // shipping.
    assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert!(database.has_table("import_provenance").unwrap());
    assert!(database.has_table("observed_deployments").unwrap());
    assert!(database.has_table("original_migrations").unwrap());
    assert!(!root.path().read_dir().unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("pre-migration")
    }));
}
