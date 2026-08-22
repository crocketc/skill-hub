use skillhub_core::{AllowedRoot, AllowedRootId, PathPolicy};

fn policy_for(path: &std::path::Path) -> (AllowedRootId, PathPolicy) {
    let root = AllowedRoot::new(path).unwrap();
    let id = root.id();
    let mut policy = PathPolicy::new();
    policy.register_root(root).unwrap();
    (id, policy)
}

#[test]
fn rejects_parent_traversal_outside_registered_root() {
    let root = tempfile::tempdir().unwrap();
    let (root_id, policy) = policy_for(root.path());
    let error = policy
        .resolve_for_create(root_id, "../outside/skill")
        .unwrap_err();
    assert_eq!(error.code.as_str(), "path.outside_allowed_root");
}

#[test]
fn accepts_a_child_path_and_returns_its_root_identity() {
    let root = tempfile::tempdir().unwrap();
    let (root_id, policy) = policy_for(root.path());
    let safe = policy.resolve_for_create(root_id, "skills/pdf").unwrap();
    assert_eq!(safe.root_id(), root_id);
}

#[test]
fn rejects_absolute_and_empty_child_paths() {
    let root = tempfile::tempdir().unwrap();
    let (root_id, policy) = policy_for(root.path());
    assert!(policy.resolve_for_create(root_id, root.path()).is_err());
    assert!(policy.resolve_for_create(root_id, "").is_err());
}

#[test]
fn existing_symlink_cannot_escape_registered_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("link")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), root.path().join("link/escape")).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(outside.path(), root.path().join("link/escape")).is_err() {
        // Creating symlinks requires a privilege that is not enabled on all Windows CI runners.
        return;
    }
    let (root_id, policy) = policy_for(root.path());
    let error = policy.resolve_existing(root_id, "link/escape").unwrap_err();
    assert_eq!(error.code.as_str(), "path.outside_allowed_root");
}

#[test]
fn create_rejects_existing_symlink_ancestor_that_escapes_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(outside.path(), root.path().join("link")).is_err() {
        return;
    }
    let (root_id, policy) = policy_for(root.path());
    let error = policy
        .resolve_for_create(root_id, "link/new-skill")
        .unwrap_err();
    assert_eq!(error.code.as_str(), "path.outside_allowed_root");
}

#[test]
fn duplicate_root_registration_keeps_original_root() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let root_id = AllowedRootId::new();
    let mut policy = PathPolicy::new();
    policy
        .register_root(AllowedRoot::with_id(root_id, first.path()).unwrap())
        .unwrap();
    assert!(policy
        .register_root(AllowedRoot::with_id(root_id, second.path()).unwrap())
        .is_err());
    let safe = policy.resolve_for_create(root_id, "original").unwrap();
    let first_path = std::fs::canonicalize(first.path()).unwrap();
    let second_path = std::fs::canonicalize(second.path()).unwrap();
    assert!(safe.as_path().starts_with(first_path));
    assert!(!safe.as_path().starts_with(second_path));
}

#[test]
fn unknown_root_id_is_rejected_without_touching_the_filesystem() {
    let root = tempfile::tempdir().unwrap();
    let policy = PathPolicy::new();
    let error = policy
        .resolve_for_create(AllowedRootId::new(), root.path().join("new"))
        .unwrap_err();
    assert_eq!(error.code.as_str(), "path.outside_allowed_root");
    assert!(!root.path().join("new").exists());
}

#[test]
fn existing_nested_path_is_canonicalized_inside_its_registered_root() {
    let root = tempfile::tempdir().unwrap();
    let nested = root.path().join("skills").join("pdf");
    std::fs::create_dir_all(&nested).unwrap();
    let (root_id, policy) = policy_for(root.path());

    let safe = policy.resolve_existing(root_id, "skills/pdf").unwrap();
    assert_eq!(safe.root_id(), root_id);
    assert_eq!(safe.as_path(), std::fs::canonicalize(nested).unwrap());
}

#[test]
fn registering_a_file_as_a_root_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("not-a-directory");
    std::fs::write(&file, b"fixture").unwrap();
    assert!(AllowedRoot::new(file).is_err());
}

#[cfg(windows)]
#[test]
fn rejects_windows_reserved_names_and_trailing_spaces_or_dots() {
    let root = tempfile::tempdir().unwrap();
    let (root_id, policy) = policy_for(root.path());
    for name in ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9", "name.", "name "] {
        assert!(policy.resolve_for_create(root_id, name).is_err(), "{name}");
    }
}
