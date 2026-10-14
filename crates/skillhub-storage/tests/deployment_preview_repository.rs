use skillhub_storage::{Database, DeploymentPreviewSnapshot};

fn snapshot(id: &str, created_at: i64, expires_at: i64, status: &str) -> DeploymentPreviewSnapshot {
    DeploymentPreviewSnapshot {
        preview_id: id.into(),
        payload_json: format!(r#"{{"preview_id":"{id}"}}"#),
        request_json: None,
        status: status.into(),
        created_at,
        expires_at,
    }
}

#[test]
fn recent_uncommitted_requests_survive_restart_and_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("skillhub.sqlite");
    let saved_request = r#"{"items":[{"skill_id":"skill-1","logical_target_ids":["target-a"],"preference":"automatic"}],"confirmations":{},"exclusions":[]}"#;
    {
        let db = Database::open(&path).unwrap();
        let repository = db.deployment_preview_repository();
        let mut older = snapshot("older", 100, 200, "active");
        older.request_json = Some(saved_request.to_owned());
        repository.insert(&older).unwrap();

        let mut newest = snapshot("newest", 300, 320, "active");
        newest.request_json = Some(saved_request.to_owned());
        repository.insert(&newest).unwrap();

        let mut consumed = snapshot("consumed", 350, 450, "consumed");
        consumed.request_json = Some(saved_request.to_owned());
        repository.insert(&consumed).unwrap();

        repository
            .insert(&snapshot("legacy", 375, 475, "active"))
            .unwrap();
    }

    let reopened = Database::open(&path).unwrap();
    let repository = reopened.deployment_preview_repository();
    // At logical time 400 this preview has expired, but its original
    // selection remains available so the user can request a fresh preview.
    assert!(repository.get_active("newest", 400).unwrap().is_none());
    let stored = repository
        .get("newest")
        .unwrap()
        .expect("saved snapshot remains readable after restart");
    assert_eq!(stored.request_json.as_deref(), Some(saved_request));

    let recent = repository.list_recent_requests(250, 10).unwrap();
    assert_eq!(
        recent
            .iter()
            .map(|snapshot| snapshot.preview_id.as_str())
            .collect::<Vec<_>>(),
        ["newest"]
    );

    let bounded = repository.list_recent_requests(0, 1).unwrap();
    assert_eq!(bounded.len(), 1);
    assert_eq!(bounded[0].preview_id, "newest");
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
fn checkpoint_updates_active_snapshot_without_consuming_it() {
    let db = Database::open_in_memory().unwrap();
    db.deployment_preview_repository()
        .insert(&snapshot("preview-checkpoint", 0, 900, "active"))
        .unwrap();

    let repository = db.deployment_preview_repository();
    repository
        .update_active_payload("preview-checkpoint", r#"{"checkpoint":true}"#)
        .unwrap();

    let updated = repository
        .get_active("preview-checkpoint", 100)
        .unwrap()
        .expect("checkpoint must not consume its preview");
    assert_eq!(updated.payload_json, r#"{"checkpoint":true}"#);
    assert_eq!(updated.status, "active");

    repository.consume("preview-checkpoint").unwrap();
    assert!(repository
        .update_active_payload("preview-checkpoint", r#"{"late":true}"#)
        .is_err());
    assert!(repository.update_active_payload("missing", "{}").is_err());
    assert!(repository
        .update_active_payload("preview-checkpoint", " ")
        .is_err());
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
