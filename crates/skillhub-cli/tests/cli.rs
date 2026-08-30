use std::fs;
use std::path::Path;

use skillhub_cli::args::CliArgs;
use skillhub_cli::commands;
use skillhub_cli::output::JsonEnvelope;
use skillhub_cli::runtime;
use skillhub_cli_test_support::parse;
use skillhub_core::backup::{BackupInput, BackupScope};
use skillhub_core::catalog::Skill;
use skillhub_core::search::SearchDocument;
use skillhub_core::{LibraryPaths, SkillId};
use skillhub_storage::{backup::BackupService, CentralLibrary, Database, VersionStore};

#[test]
fn json_output_uses_codes_and_ids_not_localized_sentences() {
    let envelope = JsonEnvelope::pending("status");
    let json = serde_json::to_value(envelope).unwrap();
    assert!(json["schema_version"].is_number());
    assert!(json["result_code"].is_string());
    assert!(!json.to_string().contains("部署成功"));
}

#[test]
fn supported_commands_are_explicit_and_no_arbitrary_exec_exists() {
    assert!(parse(["status", "--json"]).is_ok());
    assert!(parse(["exec", "whoami"]).is_err());
}

#[test]
fn non_interactive_high_risk_command_requires_explicit_authorization() {
    let error = parse(["undeploy", "--non-interactive", "--yes"]).unwrap_err();
    assert!(error.contains("--authorize-high-risk"));
}

#[test]
fn explicit_runtime_paths_are_retained_for_local_facade_bootstrap() {
    let args = parse([
        "status",
        "--database",
        "C:/tmp/skillhub.sqlite",
        "--library",
        "C:/tmp/SkillHub",
    ])
    .unwrap();

    assert_eq!(
        args.database.as_deref(),
        Some(Path::new("C:/tmp/skillhub.sqlite"))
    );
    assert_eq!(args.library.as_deref(), Some(Path::new("C:/tmp/SkillHub")));
}

#[test]
fn missing_database_returns_actionable_configuration_error() {
    let temp = tempfile::tempdir().unwrap();
    let args = parse([
        "status",
        "--database",
        temp.path().join("missing.sqlite").to_str().unwrap(),
        "--library",
        temp.path().join("SkillHub").to_str().unwrap(),
    ])
    .unwrap();

    let error = match runtime::open(&args) {
        Ok(_) => panic!("missing database unexpectedly opened"),
        Err(error) => error,
    };
    assert_eq!(error.code.as_str(), "cli.not_configured");
    assert!(error.params["detail"]
        .as_str()
        .unwrap()
        .contains("database"));
    assert!(!error.actions.is_empty());
}

#[test]
fn safe_commands_use_the_real_local_application_facade() {
    let temp = tempfile::tempdir().unwrap();
    let library_root = temp.path().join("SkillHub");
    let database_path = temp.path().join("skillhub.sqlite");
    CentralLibrary::initialize(&library_root).unwrap();
    let database = Database::open(&database_path).unwrap();
    let skill_id = SkillId::new();
    let skill = Skill::new(skill_id, "Local Search Skill").with_description("local facade");
    database
        .catalog_repository()
        .unwrap()
        .insert_sync(&skill)
        .unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("SKILL.md"), "# Local Search Skill\n").unwrap();
    let store = VersionStore::new(LibraryPaths::from_root(&library_root));
    let version = store.capture(skill_id, &source).unwrap();
    store.set_current(skill_id, &version.id).unwrap();
    let document = SearchDocument {
        skill_id,
        display_name: "Local Search Skill".into(),
        runtime_name: "Local Search Skill".into(),
        original_description: "local facade".into(),
        translated_description: None,
        user_note: None,
        tags: Vec::new(),
        author: None,
        license: None,
        requirements: Vec::new(),
        markdown: "# Local Search Skill".into(),
    };
    database
        .search_repository()
        .reindex_skill(&document)
        .unwrap();
    drop(database);

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let database = database_path.to_string_lossy().into_owned();
    let library = library_root.to_string_lossy().into_owned();
    let cases = vec![
        vec![
            "list".into(),
            "--database".into(),
            database.clone(),
            "--library".into(),
            library.clone(),
        ],
        vec![
            "search".into(),
            "--query".into(),
            "Local".into(),
            "--database".into(),
            database.clone(),
            "--library".into(),
            library.clone(),
        ],
        vec![
            "status".into(),
            "--database".into(),
            database.clone(),
            "--library".into(),
            library.clone(),
        ],
        vec![
            "pending".into(),
            "--database".into(),
            database.clone(),
            "--library".into(),
            library.clone(),
        ],
        vec![
            "check".into(),
            "--skill".into(),
            skill_id.to_string(),
            "--version".into(),
            version.id.to_string(),
            "--database".into(),
            database,
            "--library".into(),
            library,
        ],
    ];
    for values in cases {
        let args = CliArgs::parse(values).unwrap();
        let facade = runtime::open(&args).unwrap();
        let payload = runtime.block_on(commands::run(&args, &facade)).unwrap();
        assert!(
            !payload.is_null(),
            "{} returned a null payload",
            args.command
        );
    }
}

#[test]
fn backup_verify_routes_through_the_facade_command() {
    let temp = tempfile::tempdir().unwrap();
    let library = temp.path().join("SkillHub");
    let database = temp.path().join("skillhub.sqlite");
    CentralLibrary::initialize(&library).unwrap();
    drop(Database::open(&database).unwrap());
    let service = BackupService::new(temp.path().to_path_buf());
    let input = BackupInput::new(BackupScope::Full, "{}", Vec::new());
    let plan = service.prepare(&input).unwrap();
    let package = service.create(&input, &plan, &[]).unwrap();
    let args = parse([
        "backup",
        "verify",
        "--path",
        package.root.to_str().unwrap(),
        "--database",
        database.to_str().unwrap(),
        "--library",
        library.to_str().unwrap(),
    ])
    .unwrap();
    assert!(matches!(
        args.backup_action,
        Some(skillhub_cli::args::BackupAction::Verify)
    ));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let facade = runtime::open(&args).unwrap();
    let payload = runtime.block_on(commands::run(&args, &facade)).unwrap();
    assert_eq!(payload["type"], "backup_manifest");
    assert!(payload["payload"]["entries"].is_array());
}

mod skillhub_cli_test_support {
    pub fn parse<const N: usize>(args: [&str; N]) -> Result<skillhub_cli::args::CliArgs, String> {
        skillhub_cli::args::CliArgs::parse(args)
    }
}
