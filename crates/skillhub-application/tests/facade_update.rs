use std::sync::Arc;

use skillhub_adapters::app_update::github_releases::GithubReleaseProvider;
use skillhub_adapters::source::SkillsShProvider;
use skillhub_application::{LocalApplicationFacade, RollbackState};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, BuildTrust,
    ErrorCode, InstallAction, SkillId, UpdateArtifact, UpdateManifest, UpdatePlatform, UpdateState,
};
use skillhub_storage::Database;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn serve_once(body: &'static str) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 2048];
        let _ = stream.read(&mut request).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    format!("http://{address}/")
}

fn facade_with_app_update(
    database: Database,
    provider: GithubReleaseProvider,
) -> LocalApplicationFacade {
    LocalApplicationFacade::new_with_providers(
        database,
        Arc::new(provider),
        Arc::new(SkillsShProvider::new("http://127.0.0.1:1/").with_network_enabled(false)),
    )
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

async fn prepare_update(facade: &LocalApplicationFacade) {
    let result = facade
        .execute(AppCommand::PrepareApplicationUpdate(
            skillhub_core::PrepareApplicationUpdate {
                current_version: "0.1.0".to_owned(),
                manifest: fixture_manifest(),
                platform: UpdatePlatform {
                    target: "windows".to_owned(),
                    arch: "x86_64".to_owned(),
                },
            },
        ))
        .await
        .unwrap();
    assert!(matches!(
        result,
        AppCommandResult::PreparedApplicationUpdate(prepared)
            if prepared.state == UpdateState::ReadyToInstall
    ));
}

#[tokio::test]
async fn disabled_policy_does_not_access_network() {
    let database = Database::open_in_memory().unwrap();
    database
        .application_update_repository()
        .save_policy(&skillhub_core::ApplicationUpdatePolicy {
            enabled: false,
            check_on_startup: false,
        })
        .unwrap();
    let provider = GithubReleaseProvider::with_api_base("http://127.0.0.1:1/").unwrap();
    let facade = facade_with_app_update(database, provider);

    let result = facade
        .query(AppQuery::CheckApplicationUpdate(
            skillhub_core::CheckApplicationUpdate {
                current_version: "0.1.0".to_owned(),
                repository: "crocketc/skill-hub".to_owned(),
                build_trust: BuildTrust::Unknown,
            },
        ))
        .await
        .unwrap();

    assert!(matches!(
        result,
        AppQueryResult::ApplicationUpdate(update)
            if !update.available && update.current_version == "0.1.0"
    ));
}

#[tokio::test]
async fn update_check_uses_fresh_24_hour_cache() {
    let base = serve_once(
        r#"{"tag_name":"v0.2.0","html_url":"https://github.com/crocketc/skill-hub/releases/tag/v0.2.0","published_at":"2026-08-31T00:00:00Z","assets":[{"name":"SkillHub.zip"}]}"#,
    )
    .await;
    let provider = GithubReleaseProvider::with_api_base(&base).unwrap();
    let facade = facade_with_app_update(Database::open_in_memory().unwrap(), provider);
    let request = skillhub_core::CheckApplicationUpdate {
        current_version: "0.1.0".to_owned(),
        repository: "crocketc/skill-hub".to_owned(),
        build_trust: BuildTrust::WindowsTrusted,
    };

    let first = facade
        .query(AppQuery::CheckApplicationUpdate(request.clone()))
        .await
        .unwrap();
    let second = facade
        .query(AppQuery::CheckApplicationUpdate(request))
        .await
        .unwrap();

    assert_eq!(first, second);
    assert!(matches!(
        second,
        AppQueryResult::ApplicationUpdate(update)
            if update.available && update.install_action == InstallAction::InstallVerifiedAsset
    ));
}

#[tokio::test]
async fn prepared_download_is_queryable_without_storing_package_body() {
    let workspace = tempfile::tempdir().unwrap();
    let database_path = workspace.path().join("skillhub.sqlite");
    let facade = facade_with_app_update(
        Database::open(&database_path).unwrap(),
        GithubReleaseProvider::new().with_network_enabled(false),
    );

    prepare_update(&facade).await;
    drop(facade);

    let database = Database::open(&database_path).unwrap();
    let pending = database
        .application_update_repository()
        .get_pending()
        .unwrap();
    assert_eq!(pending.current_version, "0.1.0");
    assert_eq!(pending.target_version, "0.2.0");
    assert_eq!(pending.artifact.target, "windows-x86_64");
    assert!(pending.staging_path.as_deref().unwrap().contains("0.2.0"));
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

#[tokio::test]
async fn install_blocked_keeps_current_version_unchanged() {
    let workspace = tempfile::tempdir().unwrap();
    let database_path = workspace.path().join("skillhub.sqlite");
    let facade = facade_with_app_update(
        Database::open(&database_path).unwrap(),
        GithubReleaseProvider::new().with_network_enabled(false),
    );
    prepare_update(&facade).await;

    let error = facade
        .execute(AppCommand::InstallApplicationUpdate(
            skillhub_core::InstallApplicationUpdate,
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplicationUpdateInstallBlocked);
    drop(facade);

    let database = Database::open(&database_path).unwrap();
    let pending = database
        .application_update_repository()
        .get_pending()
        .unwrap();
    assert_eq!(pending.current_version, "0.1.0");
    assert_eq!(pending.target_version, "0.2.0");
}

#[tokio::test]
async fn network_disabled_update_query_returns_structured_error() {
    let facade = facade_with_app_update(
        Database::open_in_memory().unwrap(),
        GithubReleaseProvider::new().with_network_enabled(false),
    );

    let error = facade
        .query(AppQuery::CheckApplicationUpdate(
            skillhub_core::CheckApplicationUpdate {
                current_version: "0.1.0".to_owned(),
                repository: "crocketc/skill-hub".to_owned(),
                build_trust: BuildTrust::Unknown,
            },
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::NetworkDisabled);
}

#[tokio::test]
async fn startup_failure_rolls_back_once_without_touching_skill_data() {
    let workspace = tempfile::tempdir().unwrap();
    let database_path = workspace.path().join("skillhub.sqlite");
    let database = Database::open(&database_path).unwrap();
    let skill_id = SkillId::new();
    database
        .catalog_repository()
        .unwrap()
        .insert_sync(&Skill::new(skill_id, "demo"))
        .unwrap();
    let facade = facade_with_app_update(
        database,
        GithubReleaseProvider::new().with_network_enabled(false),
    );
    prepare_update(&facade).await;

    let result = facade.rollback_if_unhealthy().await.unwrap();
    assert_eq!(result.state, RollbackState::RolledBack);
    let repeated = facade.rollback_if_unhealthy().await.unwrap();
    assert_eq!(repeated.state, RollbackState::NoRollback);
    drop(facade);

    let database = Database::open(&database_path).unwrap();
    assert_eq!(
        database
            .application_update_repository()
            .get_pending()
            .unwrap()
            .attempts,
        1
    );
    assert_eq!(
        database
            .application_update_repository()
            .get_pending()
            .unwrap()
            .rollback_point,
        None
    );
    assert!(database
        .catalog_repository()
        .unwrap()
        .get_sync(skill_id)
        .unwrap()
        .is_some());
}
