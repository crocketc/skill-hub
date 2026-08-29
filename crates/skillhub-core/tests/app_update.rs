use skillhub_core::{
    AppCommand, AppQuery, BuildTrust, CheckApplicationUpdate, OpenOfficialRelease,
    SetApplicationUpdatePolicy,
};

#[test]
fn application_update_contracts_are_typed_and_manual_by_default() {
    let query = AppQuery::CheckApplicationUpdate(CheckApplicationUpdate {
        current_version: "0.1.0".to_owned(),
        repository: "crocketc/skill-hub".to_owned(),
        build_trust: BuildTrust::WindowsUnsigned,
    });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "check_application_update"
    );

    let open = AppCommand::OpenOfficialRelease(OpenOfficialRelease {
        release_url: "https://github.com/crocketc/skill-hub/releases".to_owned(),
    });
    assert_eq!(
        serde_json::to_value(open).unwrap()["type"],
        "open_official_release"
    );

    let policy = AppCommand::SetApplicationUpdatePolicy(SetApplicationUpdatePolicy {
        enabled: true,
        check_on_startup: false,
    });
    assert_eq!(
        serde_json::to_value(policy).unwrap()["type"],
        "set_application_update_policy"
    );
}
