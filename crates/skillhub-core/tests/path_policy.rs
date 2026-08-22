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
