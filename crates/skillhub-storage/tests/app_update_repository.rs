use skillhub_core::{
    ApplicationUpdate, ApplicationUpdatePolicy, BuildTrust, CheckApplicationUpdate, InstallAction,
    UpdateArtifact, UpdateManifest, UpdateState,
};
use skillhub_storage::Database;

fn fixture_update(current: &str, latest: &str) -> ApplicationUpdate {
    ApplicationUpdate {
        available: true,
        current_version: current.to_owned(),
        latest_version: latest.to_owned(),
        release_url: format!("https://github.com/crocketc/skill-hub/releases/tag/v{latest}"),
        asset_name: Some("SkillHub.zip".to_owned()),
        published_at: Some("2026-08-31T00:00:00Z".to_owned()),
        install_action: InstallAction::InstallVerifiedAsset,
    }
}

fn fixture_artifact() -> UpdateArtifact {
    UpdateArtifact {
        target: "windows-x86_64".to_owned(),
        url: "https://github.com/crocketc/skill-hub/releases/download/v0.2.0/skillhub.zip"
            .to_owned(),
        size: 42,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
        signature: "signature".to_owned(),
    }
}

fn fixture_manifest() -> UpdateManifest {
    UpdateManifest {
        version: "0.2.0".to_owned(),
        notes: "Release notes".to_owned(),
        published_at: Some("2026-08-31T00:00:00Z".to_owned()),
        artifacts: vec![fixture_artifact()],
    }
}

#[test]
fn policy_check_metadata_and_pending_update_round_trip_without_package_bytes() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.application_update_repository();
    let policy = ApplicationUpdatePolicy {
        enabled: false,
        check_on_startup: true,
    };
    repository.save_policy(&policy).unwrap();
    assert_eq!(repository.get_policy().unwrap(), policy);

    let request = CheckApplicationUpdate {
        current_version: "0.1.0".to_owned(),
        repository: "crocketc/skill-hub".to_owned(),
        build_trust: BuildTrust::WindowsTrusted,
    };
    let update = fixture_update("0.1.0", "0.2.0");
    repository.save_check(&request, &update, 1_000).unwrap();
    assert_eq!(
        repository
            .fresh_check(&request, 1_000 + 86_399, 86_400)
            .unwrap(),
        Some(update.clone())
    );
    assert_eq!(
        repository
            .fresh_check(&request, 1_000 + 86_400, 86_400)
            .unwrap(),
        None
    );

    repository
        .record_ready(
            "0.1.0",
            &fixture_manifest(),
            &fixture_artifact(),
            "C:/staging/skillhub.zip",
            Some("0.1.0"),
            1_100,
        )
        .unwrap();
    let pending = repository.get_pending().unwrap();
    assert_eq!(pending.current_version, "0.1.0");
    assert_eq!(pending.target_version, "0.2.0");
    assert_eq!(
        pending.staging_path.as_deref(),
        Some("C:/staging/skillhub.zip")
    );
    assert_eq!(pending.rollback_point.as_deref(), Some("0.1.0"));
    assert_eq!(pending.state, UpdateState::ReadyToInstall);
    assert_eq!(pending.attempts, 0);

    let stored_json: String = database
        .connection_for_test()
        .query_row(
            "SELECT value_json FROM settings WHERE key='application_update_pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!stored_json.contains("package_bytes"));
}

#[test]
fn rollback_marker_is_consumed_once_and_keeps_pending_attempt_history() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.application_update_repository();
    repository
        .record_ready(
            "0.1.0",
            &fixture_manifest(),
            &fixture_artifact(),
            "C:/staging/skillhub.zip",
            Some("0.1.0"),
            1_100,
        )
        .unwrap();

    let first = repository.consume_rollback_marker(1_200).unwrap().unwrap();
    assert_eq!(first.rollback_point.as_deref(), Some("0.1.0"));
    assert_eq!(first.attempts, 1);
    assert_eq!(first.state, UpdateState::RolledBack);
    let after_first = repository.get_pending().unwrap();
    assert_eq!(after_first.rollback_point, None);
    assert_eq!(after_first.attempts, 1);

    assert_eq!(repository.consume_rollback_marker(1_300).unwrap(), None);
    assert_eq!(repository.get_pending().unwrap().attempts, 1);
}
