use skillhub_core::project::{
    Project, ProjectTag, SavedProjectView, SharedProjectConfig, SharedSkillRequirement,
};
use skillhub_core::{ProjectId, SkillId};
use skillhub_storage::Database;

#[test]
fn project_can_belong_to_multiple_saved_filter_categories() {
    let database = Database::open_in_memory().unwrap();
    let project = Project::new(ProjectId::new(), "demo", "C:/work/demo");
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
            source: "https://example.test/skill".into(),
            name: "pdf-tools".into(),
            version_constraint: Some(">=1.0".into()),
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
            source: "local".into(),
            name: "example".into(),
            version_constraint: None,
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
    database
        .project_repository()
        .register(Project::new(id, "demo", "C:/work/demo"))
        .unwrap();
    let duplicate_id = database
        .project_repository()
        .register(Project::new(id, "other", "C:/work/other"))
        .unwrap_err();
    assert_eq!(duplicate_id.code, skillhub_core::ErrorCode::InvalidInput);
    let duplicate_path = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "other", "C:/work/demo"))
        .unwrap_err();
    assert_eq!(duplicate_path.code, skillhub_core::ErrorCode::InvalidInput);
    assert_eq!(database.project_repository().list().unwrap().len(), 1);
}

#[test]
fn tags_are_normalized_and_duplicate_tags_do_not_duplicate_membership() {
    let database = Database::open_in_memory().unwrap();
    let project = database
        .project_repository()
        .register(Project::new(ProjectId::new(), "demo", "C:/work/demo"))
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
