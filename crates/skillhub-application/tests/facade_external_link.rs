//! External link opening is a host capability: the facade validates the URL,
//! then hands it to the opener the desktop shell registered. Without an opener
//! the command must fail loudly instead of reporting a success nobody can see.

use std::sync::{Arc, Mutex};

use skillhub_application::{ExternalUrlOpener, LocalApplicationFacade, SystemExternalUrlOpener};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, AppResult, ApplicationFacade,
    ErrorCode, OpenExternalUrl, OpenOfficialRelease,
};
use skillhub_storage::Database;

/// Test double: records the URLs that reached the platform opener.
#[derive(Default)]
struct RecordingExternalUrlOpener {
    opened: Mutex<Vec<String>>,
}

impl RecordingExternalUrlOpener {
    fn opened(&self) -> Vec<String> {
        self.opened.lock().expect("recorder").clone()
    }
}

impl ExternalUrlOpener for RecordingExternalUrlOpener {
    fn open(&self, url: &str) -> AppResult<()> {
        self.opened.lock().expect("recorder").push(url.to_owned());
        Ok(())
    }
}

fn message_code(result: AppCommandResult) -> String {
    match result {
        AppCommandResult::OperationSummary(summary) => summary.message_code,
        other => panic!("unexpected result: {other:?}"),
    }
}

fn facade_with(opener: Arc<RecordingExternalUrlOpener>) -> LocalApplicationFacade {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));
    facade.set_external_url_opener(opener);
    facade
}

#[tokio::test]
async fn validated_https_link_is_handed_to_the_registered_opener() {
    let opener = Arc::new(RecordingExternalUrlOpener::default());
    let facade = facade_with(opener.clone());

    let result = facade
        .execute(AppCommand::OpenExternalUrl(OpenExternalUrl {
            url: "https://github.com/anthropics/skills/blob/main/pdf/SKILL.md".to_owned(),
        }))
        .await
        .expect("allowlisted link must open");

    assert_eq!(message_code(result), "external_link.opened");
    assert_eq!(
        opener.opened(),
        vec!["https://github.com/anthropics/skills/blob/main/pdf/SKILL.md".to_owned()]
    );
}

#[tokio::test]
async fn links_outside_the_allowlist_are_rejected_before_the_opener_runs() {
    let opener = Arc::new(RecordingExternalUrlOpener::default());
    let facade = facade_with(opener.clone());

    let error = facade
        .execute(AppCommand::OpenExternalUrl(OpenExternalUrl {
            url: "https://example.com/readme".to_owned(),
        }))
        .await
        .expect_err("non allowlisted host must be refused");

    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(opener.opened().is_empty());
}

#[tokio::test]
async fn non_https_schemes_are_rejected_before_the_opener_runs() {
    let opener = Arc::new(RecordingExternalUrlOpener::default());
    let facade = facade_with(opener.clone());

    let error = facade
        .execute(AppCommand::OpenExternalUrl(OpenExternalUrl {
            url: "file:///C:/Users/secret/SKILL.md".to_owned(),
        }))
        .await
        .expect_err("file urls must never reach the platform browser");

    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(opener.opened().is_empty());
}

#[tokio::test]
async fn without_a_registered_opener_the_command_is_refused() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));

    let error = facade
        .execute(AppCommand::OpenExternalUrl(OpenExternalUrl {
            url: "https://github.com/anthropics/skills".to_owned(),
        }))
        .await
        .expect_err("no opener means the link cannot be opened");

    assert_eq!(error.code, ErrorCode::ExternalLinkOpenerUnavailable);
}

#[tokio::test]
async fn the_official_release_page_actually_opens() {
    let opener = Arc::new(RecordingExternalUrlOpener::default());
    let facade = facade_with(opener.clone());

    let result = facade
        .execute(AppCommand::OpenOfficialRelease(OpenOfficialRelease {
            release_url: "https://github.com/crocketc/skill-hub/releases".to_owned(),
        }))
        .await
        .expect("official release page must open");

    assert_eq!(message_code(result), "application_update.opened");
    assert_eq!(
        opener.opened(),
        vec!["https://github.com/crocketc/skill-hub/releases".to_owned()]
    );
}

#[tokio::test]
async fn a_non_official_release_page_is_still_refused() {
    let opener = Arc::new(RecordingExternalUrlOpener::default());
    let facade = facade_with(opener.clone());

    let error = facade
        .execute(AppCommand::OpenOfficialRelease(OpenOfficialRelease {
            release_url: "https://example.com/releases".to_owned(),
        }))
        .await
        .expect_err("release url validation must stay enforced");

    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(opener.opened().is_empty());
}

#[tokio::test]
async fn the_facade_still_answers_queries_after_an_open_attempt() {
    let facade = facade_with(Arc::new(RecordingExternalUrlOpener::default()));

    facade
        .execute(AppCommand::OpenExternalUrl(OpenExternalUrl {
            url: "https://skills.sh/anthropics/pdf".to_owned(),
        }))
        .await
        .expect("skills.sh is allowlisted");

    let result = facade
        .query(AppQuery::GetDesktopPreferences)
        .await
        .expect("unrelated queries keep working");
    assert!(matches!(result, AppQueryResult::DesktopPreferences(_)));
}

/// The production opener is the system one; it is only launched by the desktop
/// shell, so this test only pins that it can be registered behind the port.
#[tokio::test]
async fn the_system_opener_can_be_registered() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));
    facade.set_external_url_opener(Arc::new(SystemExternalUrlOpener::default()));

    let error = facade
        .execute(AppCommand::OpenExternalUrl(OpenExternalUrl {
            url: "https://example.com/x".to_owned(),
        }))
        .await
        .expect_err("validation still runs before the system opener");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    let _guard: Mutex<Vec<String>> = Mutex::new(Vec::new());
}
