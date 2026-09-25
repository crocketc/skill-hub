use skillhub_storage::{Database, DeploymentPreviewSnapshot};

fn snapshot(id: &str, created_at: i64, expires_at: i64, status: &str) -> DeploymentPreviewSnapshot {
    DeploymentPreviewSnapshot {
        preview_id: id.into(),
        payload_json: format!(r#"{{"preview_id":"{id}"}}"#),
        status: status.into(),
        created_at,
        expires_at,
    }
}

#[test]
fn active_snapshots_round_trip_and_survive_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("skillhub.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.deployment_preview_repository()
            .insert(&snapshot("preview-1", 100, 700, "active"))
            .unwrap();
    }
    // A restart must be able to revalidate an unexpired snapshot.
    let reopened = Database::open(&path).unwrap();
    let active = reopened
        .deployment_preview_repository()
        .get_active("preview-1", 500)
        .unwrap()
        .expect("unexpired snapshot stays active across a restart");
    assert_eq!(active.preview_id, "preview-1");
    assert_eq!(active.status, "active");
    assert_eq!(active.created_at, 100);
    assert_eq!(active.expires_at, 700);
}

#[test]
fn expired_snapshots_are_never_returned_as_active() {
    let db = Database::open_in_memory().unwrap();
    db.deployment_preview_repository()
        .insert(&snapshot("preview-expired", 0, 100, "active"))
        .unwrap();

    assert!(db
        .deployment_preview_repository()
        .get_active("preview-expired", 101)
        .unwrap()
        .is_none());
    // Exactly at the expiry instant the snapshot is already unusable.
    assert!(db
        .deployment_preview_repository()
        .get_active("preview-expired", 100)
        .unwrap()
        .is_none());
    // The row itself stays readable for diagnostics.
    assert_eq!(
        db.deployment_preview_repository()
            .get("preview-expired")
            .unwrap()
            .expect("row kept for diagnostics")
            .status,
        "active"
    );
}

#[test]
fn consuming_is_one_way_and_unknown_ids_are_refused() {
    let db = Database::open_in_memory().unwrap();
    db.deployment_preview_repository()
        .insert(&snapshot("preview-2", 0, 900, "active"))
        .unwrap();

    db.deployment_preview_repository()
        .consume("preview-2")
        .unwrap();
    assert!(db
        .deployment_preview_repository()
        .get_active("preview-2", 100)
        .unwrap()
        .is_none());
    assert_eq!(
        db.deployment_preview_repository()
            .get("preview-2")
            .unwrap()
            .expect("consumed row kept")
            .status,
        "consumed"
    );
    // A consumed snapshot cannot be revived or re-consumed.
    assert!(db
        .deployment_preview_repository()
        .consume("preview-2")
        .is_err());

    assert!(db
        .deployment_preview_repository()
        .consume("missing")
        .is_err());
}

#[test]
fn commit_results_are_idempotent_per_key_and_tamper_proof() {
    let db = Database::open_in_memory().unwrap();
    db.deployment_preview_repository()
        .insert(&snapshot("preview-3", 0, 900, "active"))
        .unwrap();
    let repository = db.deployment_preview_repository();
    assert!(repository.find_commit_result("key-1").unwrap().is_none());

    repository
        .insert_commit_result("key-1", "preview-3", r#"{"pairs":[]}"#, 100)
        .unwrap();
    assert_eq!(
        repository.find_commit_result("key-1").unwrap(),
        Some(r#"{"pairs":[]}"#.to_owned())
    );

    // The same idempotency key with a different result must never overwrite
    // the recorded outcome of the first execution.
    repository
        .insert_commit_result("key-1", "preview-3", r#"{"pairs":"forged"}"#, 101)
        .unwrap_err();
    assert_eq!(
        repository.find_commit_result("key-1").unwrap(),
        Some(r#"{"pairs":[]}"#.to_owned())
    );

    // Distinct commits keep distinct results.
    repository
        .insert_commit_result("key-2", "preview-3", r#"{"pairs":[1]}"#, 102)
        .unwrap();
    assert_eq!(
        repository.find_commit_result("key-2").unwrap(),
        Some(r#"{"pairs":[1]}"#.to_owned())
    );
}

#[test]
fn duplicate_preview_ids_and_foreign_commit_keys_are_rejected() {
    let db = Database::open_in_memory().unwrap();
    let repository = db.deployment_preview_repository();
    repository
        .insert(&snapshot("preview-4", 0, 900, "active"))
        .unwrap();
    repository
        .insert(&snapshot("preview-4", 1, 901, "active"))
        .unwrap_err();

    repository
        .insert_commit_result("key-3", "preview-4", "{}", 100)
        .unwrap();
    // A commit result must reference a known preview snapshot.
    repository
        .insert_commit_result("key-4", "no-such-preview", "{}", 101)
        .unwrap_err();
}
