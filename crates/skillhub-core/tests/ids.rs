use skillhub_core::{OperationId, SkillId, VersionId};

#[test]
fn identifiers_round_trip_through_json_without_losing_type() {
    let skill = SkillId::new();
    let operation = OperationId::new();
    let version = VersionId::parse("sha256:abc123").unwrap();

    assert_eq!(
        serde_json::from_str::<SkillId>(&serde_json::to_string(&skill).unwrap()).unwrap(),
        skill
    );
    assert_eq!(
        serde_json::from_str::<OperationId>(&serde_json::to_string(&operation).unwrap()).unwrap(),
        operation
    );
    assert_eq!(version.as_str(), "sha256:abc123");
    assert!(VersionId::parse("abc123").is_err());
}
