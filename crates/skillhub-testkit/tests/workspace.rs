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
