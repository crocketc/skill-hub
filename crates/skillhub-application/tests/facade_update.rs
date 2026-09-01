use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Signature of the 4 bytes `b"test"` made with the Tauri test keypair whose
/// public half matches `skillhub_core::DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY`.
const TEST_TAURI_SIGNATURE: &str = "untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

static TEST_UPDATE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn unique_update_token(label: &str) -> String {
    let sequence = TEST_UPDATE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{label}-{}-{sequence}", std::process::id())
}

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

async fn serve_release_and_manifest() -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}/");
    let manifest = format!(
        r#"{{"tag_name":"v0.2.0","body":"Release notes","published_at":"2026-08-31T00:00:00Z","assets":[{{"name":"SkillHub_0.2.0_x64.nsis.zip","browser_download_url":"{base}SkillHub_0.2.0_x64.nsis.zip","size":4,"digest":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","label":"target=windows-x86_64;signature=verified"}}]}}"#
    );
    let release = r#"{"tag_name":"v0.2.0","html_url":"https://github.com/crocketc/skill-hub/releases/tag/v0.2.0","published_at":"2026-08-31T00:00:00Z","assets":[{"name":"SkillHub_0.2.0_x64.exe"}]}"#.to_owned();
    tokio::spawn(async move {
        for body in [release, manifest] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    base
}

async fn serve_bytes_once(body: &'static [u8]) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 2048];
        let _ = stream.read(&mut request).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
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

fn fixture_manifest_with_version_and_artifact(
    version: &str,
    artifact: UpdateArtifact,
) -> UpdateManifest {
    UpdateManifest {
        version: version.to_owned(),
        notes: "Release notes".to_owned(),
        published_at: Some("2026-08-31T00:00:00Z".to_owned()),
        artifacts: vec![artifact],
    }
}

async fn prepare_update(facade: &LocalApplicationFacade) {
    prepare_update_with_manifest(facade, fixture_manifest()).await;
}

async fn prepare_update_with_manifest(facade: &LocalApplicationFacade, manifest: UpdateManifest) {
    let result = facade
        .execute(AppCommand::PrepareApplicationUpdate(
            skillhub_core::PrepareApplicationUpdate {
                current_version: "0.1.0".to_owned(),
                manifest,
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

fn snapshot_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(base: &Path, path: &Path, snapshot: &mut BTreeMap<String, Vec<u8>>) {
        let mut entries = std::fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        entries.sort();
        for entry in entries {
            if entry.is_dir() {
                visit(base, &entry, snapshot);
            } else {
                let relative = entry
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                snapshot.insert(relative, std::fs::read(&entry).unwrap());
            }
        }
    }
    let mut snapshot = BTreeMap::new();
    visit(root, root, &mut snapshot);
    snapshot
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
async fn update_check_exposes_manifest_for_in_app_download() {
    let api_base = serve_release_and_manifest().await;
    let provider =
        GithubReleaseProvider::with_download_base_for_tests(&api_base, &api_base).unwrap();
    let facade = facade_with_app_update(Database::open_in_memory().unwrap(), provider);

    let result = facade
        .query(AppQuery::CheckApplicationUpdate(
            skillhub_core::CheckApplicationUpdate {
                current_version: "0.1.0".to_owned(),
                repository: "crocketc/skill-hub".to_owned(),
                build_trust: BuildTrust::WindowsUnsigned,
            },
        ))
        .await
        .unwrap();
    let AppQueryResult::ApplicationUpdate(update) = result else {
        panic!("expected application update");
    };

    let serialized = serde_json::to_value(update).unwrap();
    assert_eq!(serialized["manifest"]["version"], "0.2.0");
    assert_eq!(
        serialized["manifest"]["artifacts"][0]["target"],
        "windows-x86_64"
    );
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
async fn download_writes_verified_package_to_staging_and_marks_ready() {
    let download_base = serve_bytes_once(b"test").await;
    let unique = unique_update_token("verified");
    let version = format!("0.2.1-test{unique}");
    let mut artifact = fixture_artifact();
    artifact.url = format!("{download_base}skillhub-{unique}.zip");
    artifact.size = 4;
    artifact.sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_owned();
    artifact.signature = TEST_TAURI_SIGNATURE.to_owned();
    let provider =
        GithubReleaseProvider::with_download_base_for_tests(&download_base, &download_base)
            .unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let database_path = workspace.path().join("skillhub.sqlite");
    let facade = facade_with_app_update(Database::open(&database_path).unwrap(), provider);
    prepare_update_with_manifest(
        &facade,
        fixture_manifest_with_version_and_artifact(&version, artifact.clone()),
    )
    .await;
    let staging_path = Database::open(&database_path)
        .unwrap()
        .application_update_repository()
        .get_pending()
        .unwrap()
        .staging_path
        .unwrap();

    let result = facade
        .execute(AppCommand::DownloadApplicationUpdate(
            skillhub_core::DownloadApplicationUpdate { artifact },
        ))
        .await
        .unwrap();
    let downloaded = match result {
        AppCommandResult::DownloadedApplicationUpdate(downloaded) => downloaded,
        other => panic!("expected downloaded application update, got {other:?}"),
    };
    assert_eq!(downloaded.state, UpdateState::ReadyToInstall);
    let package = std::fs::read(&staging_path).expect("staged update package");
    assert_eq!(package, b"test");
    drop(facade);

    let pending = Database::open(&database_path)
        .unwrap()
        .application_update_repository()
        .get_pending()
        .unwrap();
    assert_eq!(pending.state, UpdateState::ReadyToInstall);
    assert_eq!(pending.rollback_point, Some("0.1.0".to_owned()));
}

#[tokio::test]
async fn download_rejects_forged_signature_and_cleans_up_staged_file() {
    let download_base = serve_bytes_once(b"test").await;
    let unique = unique_update_token("forged");
    let version = format!("0.2.1-test{unique}");
    let mut artifact = fixture_artifact();
    artifact.url = format!("{download_base}skillhub-{unique}.zip");
    artifact.size = 4;
    artifact.sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_owned();
    artifact.signature = TEST_TAURI_SIGNATURE.replace("SSbXxwA=", "SSbXxwB=");
    let provider =
        GithubReleaseProvider::with_download_base_for_tests(&download_base, &download_base)
            .unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let database_path = workspace.path().join("skillhub.sqlite");
    let facade = facade_with_app_update(Database::open(&database_path).unwrap(), provider);
    prepare_update_with_manifest(
        &facade,
        fixture_manifest_with_version_and_artifact(&version, artifact.clone()),
    )
    .await;
    let staging_path = Database::open(&database_path)
        .unwrap()
        .application_update_repository()
        .get_pending()
        .unwrap()
        .staging_path
        .unwrap();

    let error = facade
        .execute(AppCommand::DownloadApplicationUpdate(
            skillhub_core::DownloadApplicationUpdate { artifact },
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplicationUpdateSignatureInvalid);
    assert!(!Path::new(&staging_path).exists());
    drop(facade);

    let pending = Database::open(&database_path)
        .unwrap()
        .application_update_repository()
        .get_pending()
        .unwrap();
    assert_eq!(pending.state, UpdateState::Failed);
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
    assert_eq!(pending.state, UpdateState::ReadyToInstall);
}

#[tokio::test]
async fn install_with_injected_installer_launches_platform_install_and_keeps_rollback_marker() {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use skillhub_application::ApplicationUpdateInstaller;

    struct RecordingInstaller {
        package_paths: Mutex<Vec<PathBuf>>,
    }

    #[async_trait::async_trait]
    impl ApplicationUpdateInstaller for RecordingInstaller {
        async fn install(&self, package_path: &Path) -> skillhub_core::AppResult<()> {
            self.package_paths
                .lock()
                .expect("package paths mutex")
                .push(package_path.to_path_buf());
            Ok(())
        }
    }

    let workspace = tempfile::tempdir().unwrap();
    let database_path = workspace.path().join("skillhub.sqlite");
    let facade = facade_with_app_update(
        Database::open(&database_path).unwrap(),
        GithubReleaseProvider::new().with_network_enabled(false),
    );
    prepare_update(&facade).await;
    let staging_path: PathBuf = Database::open(&database_path)
        .unwrap()
        .application_update_repository()
        .get_pending()
        .unwrap()
        .staging_path
        .unwrap()
        .into();
    std::fs::create_dir_all(staging_path.parent().unwrap()).unwrap();
    std::fs::write(&staging_path, b"verified update package").unwrap();
    let installer = Arc::new(RecordingInstaller {
        package_paths: Mutex::new(Vec::new()),
    });
    facade.set_application_update_installer(installer.clone());

    facade
        .execute(AppCommand::InstallApplicationUpdate(
            skillhub_core::InstallApplicationUpdate,
        ))
        .await
        .unwrap();

    assert_eq!(
        installer
            .package_paths
            .lock()
            .expect("package paths mutex")
            .as_slice(),
        &[staging_path]
    );
    drop(facade);

    let pending = Database::open(&database_path)
        .unwrap()
        .application_update_repository()
        .get_pending()
        .unwrap();
    assert_eq!(pending.state, UpdateState::ReadyToInstall);
    assert_eq!(pending.rollback_point, Some("0.1.0".to_owned()));
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
    let central_library = workspace.path().join("central-library");
    let user_skill = workspace.path().join("user-skill");
    std::fs::create_dir_all(central_library.join("skills/demo")).unwrap();
    std::fs::create_dir_all(&user_skill).unwrap();
    std::fs::write(central_library.join("skills/demo/SKILL.md"), b"central").unwrap();
    std::fs::write(user_skill.join("SKILL.md"), b"user").unwrap();
    let central_before = snapshot_tree(&central_library);
    let user_before = snapshot_tree(&user_skill);
    let database = Database::open(&database_path).unwrap();
    let skill_id = SkillId::new();
    database
        .catalog_repository()
        .unwrap()
        .insert_sync(&Skill::new(skill_id, "demo"))
        .unwrap();
    let facade = LocalApplicationFacade::new_with_library(database, &central_library);
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
    assert_eq!(snapshot_tree(&central_library), central_before);
    assert_eq!(snapshot_tree(&user_skill), user_before);
}
