use skillhub_core::agent::compatibility::{CompatibilityStatus, ImportCompatibility};
use skillhub_core::DeploymentCapability;

#[test]
fn unknown_is_not_unsupported_and_link_modes_remain_distinct() {
    let declared = DeploymentCapability {
        copy: true,
        symlink: false,
        junction: false,
        limitations: vec![
            "symlink_support_unconfirmed".into(),
            "junction_support_unconfirmed".into(),
        ],
    };
    let facts = ImportCompatibility::from_declaration(Some(&declared));
    assert_eq!(facts.copy, CompatibilityStatus::Supported);
    assert_eq!(facts.symlink, CompatibilityStatus::Unverified);
    assert_eq!(facts.junction, CompatibilityStatus::Unverified);
    assert!(facts
        .deployment()
        .limitations
        .contains(&"agent_compatibility_unverified:symbolic_link".to_owned()));
    assert_eq!(
        ImportCompatibility::from_declaration(None).copy,
        CompatibilityStatus::Unverified
    );
}

#[test]
fn confirmed_negative_and_readonly_are_not_unverified() {
    let declared = DeploymentCapability {
        copy: false,
        symlink: false,
        junction: false,
        limitations: vec!["no_stable_public_local_skill_directory".into()],
    };
    let facts = ImportCompatibility::from_declaration(Some(&declared));
    assert_eq!(facts.copy, CompatibilityStatus::Unsupported);
    assert_eq!(facts.symlink, CompatibilityStatus::Unsupported);
    assert!(!facts.deployment().copy);
}
