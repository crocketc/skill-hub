#[test]
fn temp_workspace_never_uses_real_user_directories() {
    let workspace = skillhub_testkit::TempWorkspace::new().unwrap();
    assert!(workspace.central_root().starts_with(workspace.root()));
    assert!(workspace.agent_root("codex").starts_with(workspace.root()));
    assert!(workspace.project_root("demo").starts_with(workspace.root()));
}

#[test]
fn named_roots_are_created_without_allowing_path_escape() {
    let workspace = skillhub_testkit::TempWorkspace::new().unwrap();
    let agent = workspace.agent_root("../outside\\agent");
    let project = workspace.project_root("..");

    assert!(agent.starts_with(workspace.root()));
    assert!(project.starts_with(workspace.root()));
    assert!(agent.is_dir());
    assert!(project.is_dir());
}

#[test]
fn named_roots_sanitize_cross_platform_device_and_trailing_names() {
    let workspace = skillhub_testkit::TempWorkspace::new().unwrap();
    for name in ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9", "name.", "name "] {
        let root = workspace.try_agent_root(name).unwrap();
        assert!(root.starts_with(workspace.root()));
        assert!(root.is_dir(), "{name}");
        assert_ne!(root.file_name().and_then(|part| part.to_str()), Some(name));
    }
}

#[test]
fn fixture_copy_is_confined_to_workspace() {
    let source = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("fixture.txt"), "fixture").unwrap();
    let workspace = skillhub_testkit::TempWorkspace::new().unwrap();

    let destination = workspace
        .copy_fixture(
            source.path(),
            workspace.central_root().join("copied-fixture"),
        )
        .unwrap();
    assert!(destination.starts_with(workspace.root()));
    assert_eq!(
        std::fs::read_to_string(destination.join("fixture.txt")).unwrap(),
        "fixture"
    );
    assert!(workspace.copy_fixture(source.path(), "../outside").is_err());
}

#[test]
fn fixture_copy_rejects_nested_destination_symlink_escape() {
    let source = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(source.path().join("nested")).unwrap();
    std::fs::write(source.path().join("nested/fixture.txt"), "fixture").unwrap();
    let external = tempfile::tempdir().unwrap();
    let workspace = skillhub_testkit::TempWorkspace::new().unwrap();
    let destination = workspace.central_root().join("nested-copy");
    std::fs::create_dir_all(&destination).unwrap();

    #[cfg(unix)]
    std::os::unix::fs::symlink(external.path(), destination.join("nested")).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(external.path(), destination.join("nested")).is_err() {
        return;
    }

    assert!(workspace.copy_fixture(source.path(), &destination).is_err());
    assert!(!external.path().join("nested/fixture.txt").exists());
}
