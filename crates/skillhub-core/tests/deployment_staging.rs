use skillhub_core::{DeploymentCapability, ProfileCatalog, VersionId};

fn version_id() -> VersionId {
    VersionId::parse("sha256:b356b6b4c4d5e6f7a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef01")
        .expect("version id")
}

#[test]
fn staging_dir_name_drops_the_sha256_prefix() {
    let id = version_id();
    let name = skillhub_core::deployment::deployment_tree_dir_name(&id);
    assert_eq!(
        name,
        "b356b6b4c4d5e6f7a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef01"
    );
    assert!(!name.contains(':'), "staging name must be colon-free");
}

#[test]
fn staging_dir_name_is_stable_across_calls() {
    let id = version_id();
    let first = skillhub_core::deployment::deployment_tree_dir_name(&id);
    let second = skillhub_core::deployment::deployment_tree_dir_name(&id);
    assert_eq!(first, second);
}

#[test]
fn capability_intersect_requires_both_sides_to_allow_a_mode() {
    let host = DeploymentCapability::new(false, true, true);
    let profile = DeploymentCapability::new(true, false, true);
    let combined = host.intersect(&profile);
    assert!(!combined.symlink);
    assert!(!combined.junction);
    assert!(combined.copy);
}

#[test]
fn capability_intersect_unions_limitations_without_duplicates() {
    let mut host = DeploymentCapability::new(true, true, true);
    host.limitations = vec!["no_symlink_permission".to_owned()];
    let mut profile = DeploymentCapability::new(true, false, true);
    profile.limitations = vec![
        "no_symlink_permission".to_owned(),
        "junction_support_unconfirmed".to_owned(),
    ];
    let combined = host.intersect(&profile);
    assert_eq!(
        combined.limitations,
        vec![
            "no_symlink_permission".to_owned(),
            "junction_support_unconfirmed".to_owned()
        ]
    );
}

#[test]
fn catalog_exposes_declared_deployment_capability_for_a_client() {
    let catalog = ProfileCatalog::builtin();
    let capability = catalog
        .deployment_capability_for_client("anthropic.claude-code")
        .expect("claude code client is part of the bundled catalog");
    assert!(capability.copy);
    assert!(capability.symlink);
    assert!(
        !capability.junction,
        "the profile declares junction support as unconfirmed"
    );
}

#[test]
fn catalog_lookup_misses_return_none_for_unknown_clients() {
    let catalog = ProfileCatalog::builtin();
    assert!(catalog.deployment_capability_for_client("fixture.unknown").is_none());
}
