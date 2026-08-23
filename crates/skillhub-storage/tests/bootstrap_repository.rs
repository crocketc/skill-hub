use skillhub_core::{BootstrapSnapshot, SkillId, StartupRecoveryState};
use skillhub_storage::Database;

#[test]
fn snapshot_round_trips_from_settings_before_filesystem_scan() {
    let db = Database::open_in_memory().unwrap();
    let repo = db.bootstrap_repository();
    assert!(repo.load().unwrap().is_none());
    let mut snapshot = BootstrapSnapshot::empty();
    snapshot.skill_count = 300;
    snapshot.recovery_state = StartupRecoveryState::NeedsRecovery;
    repo.save(&snapshot).unwrap();
    assert_eq!(repo.load().unwrap(), Some(snapshot));
}

#[test]
fn snapshot_build_contains_typed_cache_sections_without_localized_text() {
    let db = Database::open_in_memory().unwrap();
    let snapshot = db
        .bootstrap_repository()
        .build_snapshot((2026, 8, 23))
        .unwrap();
    assert_eq!(snapshot.skill_count, 0);
    assert_eq!(snapshot.deployment_categories.len(), 0);
    assert_eq!(snapshot.pending.total, 0);
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialized.contains("试用"));
    assert!(!serialized.contains("安全"));
}

#[test]
fn pending_query_derives_due_trial_and_unresolved_finding_from_facts() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let run = "run-1";
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill}','trial','trial',0,0);
             INSERT INTO catalog_skill_metadata (skill_id,requirements_json,trial_due) VALUES ('{skill}','[]','2026-08-01');
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version}','{skill}','hash','{{}}',0);
             INSERT INTO check_runs (id,skill_id,version_id,kind,state,started_at) VALUES ('{run}','{skill}','{version}','basic','completed',0);
             INSERT INTO check_findings (id,run_id,code,severity,disposition) VALUES ('finding-1','{run}','basic.secret','high','actionable');"
        ))
        .unwrap();
    let pending = db
        .bootstrap_repository()
        .list_pending((2026, 8, 23))
        .unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().all(|item| item.subject == skill));
}
