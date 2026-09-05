use skillhub_core::project::{
    PortableSource, Project, ProjectTag, SavedProjectView, SharedProjectConfig,
    SharedSkillRequirement,
};
use skillhub_core::{ProjectId, SkillId};
use skillhub_storage::Database;

#[test]
fn project_can_belong_to_multiple_saved_filter_categories() {
    let database = Database::open_in_memory().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let project = Project::new(ProjectId::new(), "demo", directory.path());
    let project = database.project_repository().register(project).unwrap();
    database
        .project_repository()
        .set_tags(
            project.id,
            vec![ProjectTag::new("client"), ProjectTag::new("rust")],
        )
        .unwrap();

    database
        .project_repository()
        .save_view(SavedProjectView::all_tags("both", ["client", "rust"]))
        .unwrap();
    let matches = database.project_repository().matching_view("both").unwrap();
    assert_eq!(matches, vec![project.id]);
}

#[test]
fn shared_config_contains_requirements_not_absolute_paths_or_skill_content() {
    let config = SharedProjectConfig::new(
        "demo",
        vec![SharedSkillRequirement {
            skill_id: SkillId::new(),
            source: PortableSource::url("https://example.test/skill").unwrap(),
            name: "pdf-tools".into(),
            version_constraint: Some(">=1.0".into()),
            version_id: None,
            content_identity: None,
            logical_agent_id: None,
            project_subdirectory: None,
            note: Some("required for documents".into()),
        }],
    );
    let text = serde_json::to_string(&config).unwrap();
    assert!(text.contains("skill_id"));
    assert!(!text.contains("C:\\Users"));
    assert!(!text.contains("full_skill_markdown"));
    assert!(!text.contains("device_path"));
}

#[test]
fn shared_config_round_trips_through_project_directory() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open_in_memory().unwrap();
    let project = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "demo", directory.path()))
        .unwrap();
    let config = SharedProjectConfig::new(
        "demo",
        vec![SharedSkillRequirement {
            skill_id: SkillId::new(),
            source: PortableSource::catalog("local").unwrap(),
            name: "example".into(),
            version_constraint: None,
            version_id: None,
            content_identity: None,
            logical_agent_id: None,
            project_subdirectory: None,
            note: None,
        }],
    );
    database
        .project_repository()
        .write_shared_config(project.id, &config)
        .unwrap();
    assert_eq!(
        database
            .project_repository()
            .read_shared_config(project.id)
            .unwrap(),
        config
    );
    assert!(directory.path().join(".skillhub/project.json").is_file());
}

#[test]
fn duplicate_project_identity_or_path_is_rejected_without_replacing_registry() {
    let database = Database::open_in_memory().unwrap();
    let id = ProjectId::new();
    let directory = tempfile::tempdir().unwrap();
    database
        .project_repository()
        .register(Project::new(id, "demo", directory.path()))
        .unwrap();
    let duplicate_id = database
        .project_repository()
        .register(Project::new(id, "other", directory.path().join("other")))
        .unwrap_err();
    assert_eq!(duplicate_id.code, skillhub_core::ErrorCode::InvalidInput);
    let duplicate_path = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "other", directory.path()))
        .unwrap_err();
    assert_eq!(duplicate_path.code, skillhub_core::ErrorCode::InvalidInput);
    assert_eq!(database.project_repository().list().unwrap().len(), 1);
}

#[test]
fn tags_are_normalized_and_duplicate_tags_do_not_duplicate_membership() {
    let database = Database::open_in_memory().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let project = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "demo", directory.path()))
        .unwrap();
    database
        .project_repository()
        .set_tags(project.id, [" Client ", "client", "RUST"])
        .unwrap();
    let saved = database.project_repository().get(project.id).unwrap();
    assert_eq!(
        saved
            .tags
            .into_iter()
            .map(|tag| tag.name)
            .collect::<Vec<_>>(),
        ["client", "rust"]
    );
}

#[test]
fn project_registration_persists_distinct_selected_agent_targets() {
    let database = Database::open_in_memory().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::new(ProjectId::new(), "demo", directory.path());
    project.agent_ids = vec![
        " codex-cli ".into(),
        "claude-code".into(),
        "codex-cli".into(),
    ];

    let registered = database.project_repository().register(project).unwrap();

    assert_eq!(registered.agent_ids, ["claude-code", "codex-cli"]);
    assert_eq!(
        database
            .project_repository()
            .get(registered.id)
            .unwrap()
            .agent_ids,
        ["claude-code", "codex-cli"]
    );
}

#[test]
fn project_registration_requires_real_directory_and_persists_canonical_physical_identity() {
    let database = Database::open_in_memory().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let alias = format!(
        "{}{}",
        directory.path().display(),
        std::path::MAIN_SEPARATOR
    );
    let project = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "demo", alias))
        .unwrap();
    assert_eq!(
        project.device_path,
        directory.path().canonicalize().unwrap().to_string_lossy()
    );
    assert!(!project.physical_id.is_empty());
    assert!(project.physical_id.starts_with("fs:"));
    let alias_duplicate = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "alias", directory.path()))
        .unwrap_err();
    assert_eq!(alias_duplicate.code, skillhub_core::ErrorCode::InvalidInput);

    let relative = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "relative", "relative/path"))
        .unwrap_err();
    assert_eq!(relative.code, skillhub_core::ErrorCode::InvalidInput);
    let missing = database
        .project_repository()
        .register(Project::new(
            ProjectId::new(),
            "missing",
            directory.path().join("missing"),
        ))
        .unwrap_err();
    assert_eq!(missing.code, skillhub_core::ErrorCode::InvalidInput);
}

#[cfg(unix)]
#[test]
fn project_registration_allows_platform_symlink_ancestors_but_not_a_symlink_directory() {
    let database = Database::open_in_memory().unwrap();
    let real_parent = tempfile::tempdir().unwrap();
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("alias");
    std::os::unix::fs::symlink(real_parent.path(), &alias).unwrap();
    let project_path = alias.join("project");
    std::fs::create_dir(&project_path).unwrap();

    let project = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "via-alias", &project_path))
        .unwrap();
    assert_eq!(
        project.device_path,
        project_path.canonicalize().unwrap().to_string_lossy()
    );

    let symlink_project = alias_parent.path().join("project-link");
    std::os::unix::fs::symlink(&project_path, &symlink_project).unwrap();
    let error = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "symlink", &symlink_project))
        .unwrap_err();
    assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);
}

#[test]
fn shared_config_rejects_paths_urls_with_userinfo_and_secret_like_values() {
    for source in [
        PortableSource::try_from("https://user:password@example.test/skill"),
        PortableSource::try_from("C:\\Users\\alice\\skill"),
        PortableSource::try_from("token=secret-value"),
        PortableSource::try_from("https://example.test/skill?token=secret-value"),
        PortableSource::try_from("https://example.test/skill?ref=ok#credential=bad"),
        PortableSource::try_from("https://example.test/skill#t%6fken=abc123"),
    ] {
        assert!(source.is_err());
    }

    let ordinary = PortableSource::url("https://example.test/skill?ref=docs#readme").unwrap();
    assert_eq!(
        ordinary.as_str(),
        "https://example.test/skill?ref=docs#readme"
    );

    let config = SharedProjectConfig::new(
        "/Users/alice/project",
        vec![SharedSkillRequirement {
            skill_id: SkillId::new(),
            source: PortableSource::catalog("catalog").unwrap(),
            name: "example".into(),
            version_constraint: Some("=1.2.3".into()),
            version_id: Some(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .parse()
                    .unwrap(),
            ),
            content_identity: Some("sha256:abc".into()),
            logical_agent_id: Some("openai.codex-cli".into()),
            project_subdirectory: Some("packages/demo".into()),
            note: Some("Authorization: Bearer secret".into()),
        }],
    );
    assert!(config.validate().is_err());
    assert!(serde_json::to_string(&config).is_err());
}

#[test]
fn saved_view_normalizes_direct_all_and_any_tag_input_and_matches_combined_filter() {
    let database = Database::open_in_memory().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let project = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "demo", directory.path()))
        .unwrap();
    database
        .project_repository()
        .set_tags(project.id, ["client", "rust"])
        .unwrap();
    let view = SavedProjectView {
        id: "combined".into(),
        name: "Combined".into(),
        all_tags: vec![" Client ".into()],
        any_tags: vec![" PYTHON ".into(), "rust".into(), "rust".into()],
    };
    let saved = database.project_repository().save_view(view).unwrap();
    assert_eq!(saved.all_tags, vec!["client"]);
    assert_eq!(saved.any_tags, vec!["python", "rust"]);
    assert_eq!(
        database
            .project_repository()
            .matching_view("combined")
            .unwrap(),
        vec![project.id]
    );
}
