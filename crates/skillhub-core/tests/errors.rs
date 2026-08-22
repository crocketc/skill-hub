use skillhub_core::{AppError, ErrorCode, RecoveryAction, Severity};

#[test]
fn error_serialization_contains_codes_not_localized_sentences() {
    let error = AppError::new(ErrorCode::TargetExists, Severity::Warning)
        .with_param("runtime_name", "pdf")
        .with_action(RecoveryAction::ChooseAnotherName);
    let json = serde_json::to_value(error).unwrap();
    assert_eq!(json["code"], "deployment.target_exists");
    assert_eq!(json["params"]["runtime_name"], "pdf");
    assert_eq!(json["actions"][0], "choose_another_name");
    assert!(json.to_string().find("目标已存在").is_none());
}

#[test]
fn all_foundation_error_codes_have_stable_wire_names() {
    let cases = [
        (ErrorCode::InvalidInput, "input.invalid"),
        (
            ErrorCode::PathOutsideAllowedRoots,
            "path.outside_allowed_root",
        ),
        (ErrorCode::ObjectNotFound, "object.not_found"),
        (ErrorCode::TargetExists, "deployment.target_exists"),
        (ErrorCode::OwnershipUnknown, "target.ownership_unknown"),
        (ErrorCode::CheckBlocked, "deployment.security_check_blocked"),
        (ErrorCode::OperationConflict, "operation.conflict"),
        (ErrorCode::CredentialUnavailable, "credential.unavailable"),
        (ErrorCode::MigrationRequired, "migration.required"),
        (ErrorCode::InternalError, "internal.error"),
    ];

    for (code, expected) in cases {
        assert_eq!(code.as_str(), expected);
        assert_eq!(serde_json::to_value(code).unwrap(), expected);
    }
}

#[test]
fn app_error_round_trips_without_losing_structured_data() {
    let error = AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("field", "name")
        .with_action(RecoveryAction::Retry)
        .with_action(RecoveryAction::Acknowledge);
    let decoded: AppError =
        serde_json::from_value(serde_json::to_value(error.clone()).unwrap()).unwrap();
    assert_eq!(decoded, error);
}
