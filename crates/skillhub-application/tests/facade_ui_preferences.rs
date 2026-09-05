use skillhub_application::LocalApplicationFacade;
use skillhub_core::{AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade};
use skillhub_storage::Database;

#[tokio::test]
async fn ui_preferences_round_trip_and_default_to_absent() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));

    let absent = facade
        .query(AppQuery::GetUiPreference(skillhub_core::GetUiPreference {
            key: "table_preferences".into(),
        }))
        .await
        .expect("get absent preference");
    assert_eq!(
        absent,
        AppQueryResult::UiPreference(skillhub_core::api::GetUiPreferenceResult {
            key: "table_preferences".into(),
            value_json: None,
        })
    );

    let saved = facade
        .execute(AppCommand::SetUiPreference(
            skillhub_core::SetUiPreference {
                key: "table_preferences".into(),
                value_json: r#"{"density":"compact"}"#.into(),
            },
        ))
        .await
        .expect("save preference");
    assert!(matches!(saved, AppCommandResult::OperationSummary(_)));

    let read = facade
        .query(AppQuery::GetUiPreference(skillhub_core::GetUiPreference {
            key: "table_preferences".into(),
        }))
        .await
        .expect("get saved preference");
    assert_eq!(
        read,
        AppQueryResult::UiPreference(skillhub_core::api::GetUiPreferenceResult {
            key: "table_preferences".into(),
            value_json: Some(r#"{"density":"compact"}"#.into()),
        })
    );
}

#[tokio::test]
async fn ui_preferences_reject_invalid_values_and_empty_keys() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));

    let error = facade
        .execute(AppCommand::SetUiPreference(
            skillhub_core::SetUiPreference {
                key: "table_preferences".into(),
                value_json: "not json".into(),
            },
        ))
        .await
        .expect_err("non-json value");
    assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);

    let error = facade
        .execute(AppCommand::SetUiPreference(
            skillhub_core::SetUiPreference {
                key: "  ".into(),
                value_json: "{}".into(),
            },
        ))
        .await
        .expect_err("empty key");
    assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);
}
