use std::path::Path;

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DiscoverySnapshot, OperatingSystem,
};
use skillhub_core::api::GetUsageEnvironmentProblems;
use skillhub_core::project::Project;
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryNodeFact, DirectoryRecognition, DirectoryRole,
    EnvironmentProblemKind, UsageEnvironmentKey, UsageEnvironmentProbeLimitationReason,
};
use skillhub_core::{AppQuery, AppQueryResult, ApplicationFacade, ProjectId};
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_ID: &str = "agent.environment-fixture";
const PROFILE_ID: &str = "environment-fixture";

struct Fixture {
    _workspace: tempfile::TempDir,
    facade: LocalApplicationFacade,
}

fn fixture() -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let database = Database::open(workspace.path().join("skillhub.sqlite")).expect("database");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-10-09T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: PROFILE_ID.into(),
                client_id: CLIENT_ID.into(),
                kind: ClientKind::Cli,
                display_name: "Environment Fixture Agent".into(),
                supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            agent_roots: Vec::new(),
            logical_targets: Vec::new(),
            physical_targets: Vec::new(),
        })
        .expect("discovery snapshot");
    Fixture {
        _workspace: workspace,
        facade: LocalApplicationFacade::new_with_library(database, &library_root),
    }
}

fn write_skill(directory: &Path, body: &str) {
    std::fs::create_dir_all(directory).expect("skill directory");
    std::fs::write(directory.join("SKILL.md"), body).expect("skill file");
}

fn add_directory(
    fixture: &Fixture,
    node_id: &str,
    path: &Path,
    role: DirectoryRole,
    recognition: DirectoryRecognition,
) {
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    database
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: node_id.into(),
            path: path.to_string_lossy().into_owned(),
            path_key: String::new(),
            role,
            profile_id: Some(PROFILE_ID.into()),
            agent_client_id: Some(CLIENT_ID.into()),
            exists: true,
            observed_at: 1,
            scan_source: Some("environment-fixture".into()),
        })
        .expect("directory node");
    database
        .relationship_repository()
        .upsert_capability(&AgentDirectoryCapabilityFact {
            agent_client_id: CLIENT_ID.into(),
            directory_node_id: node_id.into(),
            recognition,
            precedence: skillhub_core::agent::DirectoryPrecedence::Preferred,
            evidence_reference: Some("fixture".into()),
            researched_at: Some("2026-10-09".into()),
            applicable_platforms: vec!["macos".into(), "windows".into()],
        })
        .expect("directory capability");
}

async fn usage_problems(
    fixture: &Fixture,
) -> skillhub_core::relationship::EnvironmentProblemAnalysis {
    let result = fixture
        .facade
        .query(AppQuery::GetUsageEnvironmentProblems(
            GetUsageEnvironmentProblems,
        ))
        .await
        .expect("environment problem query");
    let AppQueryResult::UsageEnvironmentProblems(analysis) = result else {
        panic!("expected environment problem analysis");
    };
    analysis
}

#[tokio::test]
async fn query_detects_unimported_skills_in_confirmed_directories_read_only() {
    let fixture = fixture();
    let first = fixture._workspace.path().join("agent/first/skills");
    let second = fixture._workspace.path().join("agent/second/skills");
    write_skill(
        &first.join("formatter"),
        "---\nname: formatter\n---\nfirst body\n",
    );
    write_skill(
        &second.join("formatter"),
        "---\nname: formatter\n---\nsecond body\n",
    );
    add_directory(
        &fixture,
        "agent-first",
        &first,
        DirectoryRole::AgentNative,
        DirectoryRecognition::Supported,
    );
    add_directory(
        &fixture,
        "agent-second",
        &second,
        DirectoryRole::AgentNative,
        DirectoryRecognition::Supported,
    );
    let database = fixture.facade.database_for_tests();
    let before_revision = database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .relationship_revision()
        .expect("revision before scan");

    let analysis = usage_problems(&fixture).await;

    assert_eq!(analysis.problems.len(), 1);
    assert_eq!(
        analysis.problems[0].kind,
        EnvironmentProblemKind::NameConflict
    );
    assert_eq!(analysis.problems[0].entries.len(), 2);
    assert!(analysis.problems[0]
        .entries
        .iter()
        .all(|entry| entry.skill_id.is_none()));
    assert!(analysis.problems[0].entries.iter().all(|entry| {
        entry
            .content_fingerprint
            .as_deref()
            .is_some_and(|fingerprint| fingerprint.starts_with("sha256:"))
    }));
    let after_revision = database
        .lock()
        .expect("database lock")
        .relationship_repository()
        .relationship_revision()
        .expect("revision after scan");
    assert_eq!(
        before_revision, after_revision,
        "a scan must not write facts"
    );
}

#[tokio::test]
async fn unknown_directory_is_reported_as_limited_without_scanning_it() {
    let fixture = fixture();
    let supported = fixture._workspace.path().join("agent/supported/skills");
    let unknown = fixture._workspace.path().join("agent/unknown/skills");
    write_skill(
        &supported.join("formatter"),
        "---\nname: formatter\n---\nsupported body\n",
    );
    write_skill(
        &unknown.join("formatter"),
        "---\nname: formatter\n---\nunknown body\n",
    );
    add_directory(
        &fixture,
        "supported-dir",
        &supported,
        DirectoryRole::AgentNative,
        DirectoryRecognition::Supported,
    );
    add_directory(
        &fixture,
        "unknown-dir",
        &unknown,
        DirectoryRole::AgentNative,
        DirectoryRecognition::Unknown,
    );

    let analysis = usage_problems(&fixture).await;

    assert!(analysis.problems.is_empty());
    assert!(analysis.probe_limitations.iter().any(|limitation| {
        limitation.reason == UsageEnvironmentProbeLimitationReason::RecognitionNotConfirmed
            && limitation.directory_id.as_deref() == Some("unknown-dir")
    }));
}

#[tokio::test]
async fn project_duplicate_is_scoped_to_that_registered_agent_project() {
    let fixture = fixture();
    let agent_directory = fixture._workspace.path().join("agent/skills");
    write_skill(
        &agent_directory.join("formatter"),
        "---\nname: formatter\n---\nagent body\n",
    );
    add_directory(
        &fixture,
        "agent-dir",
        &agent_directory,
        DirectoryRole::AgentNative,
        DirectoryRecognition::Supported,
    );

    let project_root = fixture._workspace.path().join("project");
    let project_directory = project_root.join(".agents/skills");
    write_skill(
        &project_directory.join("formatter"),
        "---\nname: formatter\n---\nproject body\n",
    );
    let project_id = ProjectId::new();
    let database = fixture.facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .project_repository()
        .register(Project::new(project_id, "Fixture Project", &project_root))
        .expect("register project");
    add_directory(
        &fixture,
        "project-dir",
        &project_directory,
        DirectoryRole::Project,
        DirectoryRecognition::Supported,
    );

    let analysis = usage_problems(&fixture).await;

    assert_eq!(analysis.problems.len(), 1);
    assert_eq!(
        analysis.problems[0].kind,
        EnvironmentProblemKind::NameConflict
    );
    assert_eq!(analysis.problems[0].entries.len(), 2);
    assert_eq!(
        analysis.problems[0].environment_results,
        vec![
            skillhub_core::relationship::EnvironmentProblemEnvironmentResult {
                environment: UsageEnvironmentKey {
                    agent_client_id: CLIENT_ID.into(),
                    project_id: Some(project_id),
                },
                closed: false,
                relationship_revision: analysis.problems[0].environment_results[0]
                    .relationship_revision
                    .clone(),
            }
        ]
    );
}
