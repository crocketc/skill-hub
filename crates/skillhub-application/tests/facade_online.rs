use std::sync::Arc;

use std::sync::Mutex;

use skillhub_adapters::app_update::github_releases::GithubReleaseProvider;
use skillhub_adapters::source::SkillsShProvider;
use skillhub_application::{ExternalUrlOpener, LocalApplicationFacade};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, AppResult, ApplicationFacade,
    BuildTrust, ErrorCode,
};
use skillhub_storage::Database;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Records the URLs passed to the platform opener without actually launching
/// a browser, so tests can assert the open path without side effects.
#[derive(Default)]
struct RecordingOpener {
    opened: Mutex<Vec<String>>,
}

impl ExternalUrlOpener for RecordingOpener {
    fn open(&self, url: &str) -> AppResult<()> {
        self.opened.lock().expect("recorder").push(url.to_owned());
        Ok(())
    }
}

async fn serve_once(body: &'static str) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listener");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("request");
        let mut request = [0_u8; 2048];
        let _ = stream.read(&mut request).await;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: max-age=600\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .await
            .expect("response");
    });
    format!("http://{address}/")
}

fn facade_with_providers(
    database: Database,
    app_update: GithubReleaseProvider,
    source_search: SkillsShProvider,
) -> LocalApplicationFacade {
    LocalApplicationFacade::new_with_providers(
        database,
        Arc::new(app_update),
        Arc::new(source_search),
    )
}

#[tokio::test]
async fn persisted_network_switch_blocks_online_queries_before_provider_access() {
    let database = Database::open_in_memory().expect("database");
    let mut preferences = database
        .desktop_settings_repository()
        .get()
        .expect("preferences");
    preferences.network_enabled = false;
    database
        .desktop_settings_repository()
        .save(&preferences)
        .expect("save preferences");
    let facade = facade_with_providers(
        database,
        GithubReleaseProvider::with_api_base("http://127.0.0.1:1/").expect("provider"),
        SkillsShProvider::new("http://127.0.0.1:1/"),
    );

    let error = facade
        .query(AppQuery::SearchOnlineSources(
            skillhub_core::SearchOnlineSources {
                query: skillhub_core::SourceSearchQuery::new("pdf"),
            },
        ))
        .await
        .expect_err("network switch must block source search");
    assert_eq!(error.code, ErrorCode::NetworkDisabled);

    let error = facade
        .query(AppQuery::CheckApplicationUpdate(
            skillhub_core::CheckApplicationUpdate {
                current_version: "0.1.0".into(),
                repository: "crocketc/skill-hub".into(),
                build_trust: BuildTrust::Unknown,
            },
        ))
        .await
        .expect_err("network switch must block update check");
    assert_eq!(error.code, ErrorCode::NetworkDisabled);
}

#[tokio::test]
async fn update_query_uses_provider_and_preserves_trust_gate() {
    let base = serve_once(
        r#"{"tag_name":"v0.2.0","html_url":"https://github.com/crocketc/skill-hub/releases/tag/v0.2.0","published_at":"2026-08-29T00:00:00Z","assets":[{"name":"SkillHub_0.2.0_x64.exe"}]}"#,
    )
    .await;
    let app_update = GithubReleaseProvider::with_api_base(&base).expect("provider");
    let source_search = SkillsShProvider::new(&base);
    let facade = facade_with_providers(
        Database::open_in_memory().expect("database"),
        app_update,
        source_search,
    );

    let result = facade
        .query(AppQuery::CheckApplicationUpdate(
            skillhub_core::CheckApplicationUpdate {
                current_version: "0.1.0".into(),
                repository: "crocketc/skill-hub".into(),
                build_trust: BuildTrust::WindowsUnsigned,
            },
        ))
        .await
        .expect("update query");
    let AppQueryResult::ApplicationUpdate(update) = result else {
        panic!("expected application update");
    };
    assert!(update.available);
    assert_eq!(update.latest_version, "0.2.0");
    assert_eq!(
        update.install_action,
        skillhub_core::InstallAction::OpenOfficialRelease
    );
}

#[tokio::test]
async fn disabled_update_policy_skips_provider_and_returns_no_update() {
    let base = "http://127.0.0.1:1/";
    let app_update = GithubReleaseProvider::with_api_base(base).expect("provider");
    let source_search = SkillsShProvider::new(base);
    let database = Database::open_in_memory().expect("database");
    database
        .application_update_repository()
        .save_policy(&skillhub_core::ApplicationUpdatePolicy {
            enabled: false,
            check_on_startup: false,
        })
        .expect("save policy");
    let facade = facade_with_providers(database, app_update, source_search);

    let result = facade
        .query(AppQuery::CheckApplicationUpdate(
            skillhub_core::CheckApplicationUpdate {
                current_version: "0.2.0".into(),
                repository: "crocketc/skill-hub".into(),
                build_trust: BuildTrust::Unknown,
            },
        ))
        .await
        .expect("disabled update query");
    let AppQueryResult::ApplicationUpdate(update) = result else {
        panic!("expected application update");
    };
    assert!(!update.available);
    assert_eq!(update.current_version, "0.2.0");
}

#[tokio::test]
async fn set_update_policy_persists_and_open_release_validates_url() {
    let provider = GithubReleaseProvider::new().with_network_enabled(false);
    let source = SkillsShProvider::new("http://127.0.0.1:1/").with_network_enabled(false);
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let facade = facade_with_providers(
        Database::open(&database_path).expect("database"),
        provider,
        source,
    );

    let result = facade
        .execute(AppCommand::SetApplicationUpdatePolicy(
            skillhub_core::SetApplicationUpdatePolicy {
                enabled: false,
                check_on_startup: true,
            },
        ))
        .await
        .expect("save policy");
    assert!(matches!(
        result,
        AppCommandResult::ApplicationUpdatePolicy(policy)
            if !policy.enabled && policy.check_on_startup
    ));

    let opener = Arc::new(RecordingOpener::default());
    facade.set_external_url_opener(opener.clone());

    let result = facade
        .execute(AppCommand::OpenOfficialRelease(
            skillhub_core::OpenOfficialRelease {
                release_url: "https://github.com/crocketc/skill-hub/releases/tag/v0.2.0".into(),
            },
        ))
        .await
        .expect("open official release");
    assert!(
        matches!(result, AppCommandResult::OperationSummary(summary) if summary.message_code == "application_update.opened")
    );
    assert_eq!(
        opener.opened.lock().expect("recorder").clone(),
        vec!["https://github.com/crocketc/skill-hub/releases/tag/v0.2.0".to_owned()]
    );

    drop(facade);
    let database = Database::open(&database_path).expect("reopen database");
    assert_eq!(
        database
            .application_update_repository()
            .get_policy()
            .expect("policy"),
        skillhub_core::ApplicationUpdatePolicy {
            enabled: false,
            check_on_startup: true,
        }
    );

    let facade = LocalApplicationFacade::new_with_network_enabled(database, false);
    let error = facade
        .execute(AppCommand::OpenOfficialRelease(
            skillhub_core::OpenOfficialRelease {
                release_url: "https://evil.example/releases/tag/v0.2.0".into(),
            },
        ))
        .await
        .expect_err("untrusted release URL");
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn online_source_query_maps_provider_and_reuses_fresh_cache() {
    let base = serve_once(
        r#"{"query":"pdf","searchType":"keyword","skills":[{"id":"acme/pdf","skillId":"pdf","name":"PDF skill","installs":42,"source":"acme/pdf"}],"count":1,"duration_ms":4}"#,
    )
    .await;
    let app_update = GithubReleaseProvider::new().with_network_enabled(false);
    let source_search = SkillsShProvider::new(&base);
    let facade = facade_with_providers(
        Database::open_in_memory().expect("database"),
        app_update,
        source_search,
    );
    let query = skillhub_core::SourceSearchQuery::new("pdf");

    let first = facade
        .query(AppQuery::SearchOnlineSources(
            skillhub_core::SearchOnlineSources {
                query: query.clone(),
            },
        ))
        .await
        .expect("first source search");
    let AppQueryResult::SourceSearchPage(first) = first else {
        panic!("expected source search page");
    };
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.items[0].source_id, "acme/pdf");

    let second = facade
        .query(AppQuery::SearchOnlineSources(
            skillhub_core::SearchOnlineSources { query },
        ))
        .await
        .expect("cached source search");
    let AppQueryResult::SourceSearchPage(second) = second else {
        panic!("expected source search page");
    };
    assert_eq!(second, first);
}

#[tokio::test]
async fn network_disabled_online_query_returns_structured_error() {
    let app_update = GithubReleaseProvider::new().with_network_enabled(false);
    let source = SkillsShProvider::new("http://127.0.0.1:1/").with_network_enabled(false);
    let facade = facade_with_providers(
        Database::open_in_memory().expect("database"),
        app_update,
        source,
    );

    let error = facade
        .query(AppQuery::SearchOnlineSources(
            skillhub_core::SearchOnlineSources {
                query: skillhub_core::SourceSearchQuery::new("pdf"),
            },
        ))
        .await
        .expect_err("network disabled");
    assert_eq!(error.code, ErrorCode::NetworkDisabled);
}
