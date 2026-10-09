use std::path::Path;

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    AgentRootObservation, ClientInstance, ClientKind, ClientPresence, DirectoryObservationStatus,
    DirectoryPrecedence, DiscoverySnapshot, LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::GetUsageEnvironmentStatistics;
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryNodeFact, DirectoryRecognition, DirectoryRole,
    FileRepresentation, OwnershipState, RelationshipType, UsageEnvironmentStatistics,
};
use skillhub_core::{
    AppQuery, AppQueryResult, ApplicationFacade, DeploymentRelationFact, ProjectId,
};
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_A: &str = "agent.statistics-a";
const CLIENT_B: &str = "agent.statistics-b";
const PROFILE: &str = "statistics-fixture";

struct Fixture {
    _workspace: tempfile::TempDir,
    facade: LocalApplicationFacade,
}

fn fixture() -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let database = Database::open(workspace.path().join("skillhub.sqlite")).expect("database");
    let clients = [CLIENT_A, CLIENT_B]
        .into_iter()
        .map(|client_id| ClientInstance {
            profile_id: PROFILE.into(),
            client_id: client_id.into(),
            kind: ClientKind::Cli,
            display_name: format!("Fixture {client_id}"),
            supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
            client_presence: ClientPresence::Unknown,
        })
        .collect();
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-10-09T00:00:00Z".into(),
            instances: clients,
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

fn write_skill(directory: &Path, name: &str, body: &str) {
    std::fs::create_dir_all(directory).expect("skill directory");
    std::fs::write(
        directory.join("SKILL.md"),
        format!("---\nname: {name}\n---\n{body}\n"),
    )
    .expect("skill file");
}

fn add_directory(
    fixture: &Fixture,
    node_id: &str,
    path: &Path,
    role: DirectoryRole,
    client_ids: &[&str],
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
            profile_id: Some(PROFILE.into()),
            agent_client_id: (role != DirectoryRole::SharedDirectory)
                .then(|| client_ids.first().copied().unwrap_or(CLIENT_A).into()),
            exists: true,
            observed_at: 1,
            scan_source: Some("statistics-fixture".into()),
        })
        .expect("directory node");
    for client_id in client_ids {
        database
            .relationship_repository()
            .upsert_capability(&AgentDirectoryCapabilityFact {
                agent_client_id: (*client_id).into(),
                directory_node_id: node_id.into(),
                recognition: DirectoryRecognition::Supported,
                precedence: skillhub_core::agent::DirectoryPrecedence::Preferred,
                evidence_reference: Some("fixture".into()),
                researched_at: Some("2026-10-09".into()),
                applicable_platforms: vec!["macos".into(), "windows".into()],
            })
            .expect("directory capability");
    }
}

fn add_builtin_directory(fixture: &Fixture, path: &Path) {
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    let mut snapshot = database
        .agent_repository()
        .load()
        .expect("load discovery")
        .expect("discovery snapshot");
    let root_id = "statistics-builtin-root";
    snapshot.agent_roots.push(AgentRootObservation {
        id: root_id.into(),
        profile_id: PROFILE.into(),
        client_id: CLIENT_A.into(),
        scope: TargetScope::Global,
        path: path
            .parent()
            .expect("builtin parent")
            .to_string_lossy()
            .into_owned(),
        status: DirectoryObservationStatus::Existing,
        exists: true,
        readable: true,
        writable: false,
        physical_id: Some("statistics-builtin-root-physical".into()),
        physical_identity_verified: true,
    });
    snapshot.logical_targets.push(LogicalTarget {
        id: "statistics-builtin-target".into(),
        profile_id: PROFILE.into(),
        client_id: CLIENT_A.into(),
        scope: TargetScope::Global,
        path: path.to_string_lossy().into_owned(),
        agent_root_id: root_id.into(),
        marker: "SKILL.md".into(),
        precedence: DirectoryPrecedence::MayCoexist,
        shared_reference: false,
        builtin: true,
        exists: true,
        readable: true,
        writable: false,
        available: true,
        physical_id: skillhub_core::physical_id_for_path(path).expect("builtin identity"),
        status: DirectoryObservationStatus::Existing,
        physical_identity_verified: true,
    });
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save builtin target");
}

async fn statistics(
    fixture: &Fixture,
) -> skillhub_core::relationship::UsageEnvironmentStatisticsSummary {
    let result = fixture
        .facade
        .query(AppQuery::GetUsageEnvironmentStatistics(
            GetUsageEnvironmentStatistics,
        ))
        .await
        .expect("usage environment statistics query");
    let AppQueryResult::UsageEnvironmentStatistics(statistics) = result else {
        panic!("expected usage environment statistics");
    };
    statistics
}

fn environment<'a>(
    statistics: &'a skillhub_core::relationship::UsageEnvironmentStatisticsSummary,
    client_id: &str,
    project_id: Option<ProjectId>,
) -> &'a UsageEnvironmentStatistics {
    statistics
        .environments
        .iter()
        .find(|stats| {
            stats.environment.agent_client_id == client_id
                && stats.environment.project_id == project_id
        })
        .expect("environment statistics")
}

#[tokio::test]
async fn agent_includes_shared_builtin_workspace() {
    let fixture = fixture();
    let own = fixture._workspace.path().join("agent/own");
    let shared = fixture._workspace.path().join("shared");
    let builtin = fixture._workspace.path().join("agent/builtin");
    let workspace = fixture._workspace.path().join("workspace/.agents/skills");
    write_skill(&own.join("own-skill"), "own-skill", "own body");
    write_skill(&shared.join("shared-skill"), "shared-skill", "shared body");
    write_skill(
        &builtin.join("builtin-skill"),
        "builtin-skill",
        "builtin body",
    );
    write_skill(
        &workspace.join("workspace-skill"),
        "workspace-skill",
        "workspace body",
    );
    add_directory(
        &fixture,
        "own-dir",
        &own,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );
    add_directory(
        &fixture,
        "shared-dir",
        &shared,
        DirectoryRole::SharedDirectory,
        &[CLIENT_A, CLIENT_B],
    );
    add_builtin_directory(&fixture, &builtin);
    add_directory(
        &fixture,
        "builtin-dir",
        &builtin,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );
    add_directory(
        &fixture,
        "workspace-dir",
        &workspace,
        DirectoryRole::Project,
        &[CLIENT_A],
    );
    let before = statistics(&fixture).await;
    assert_eq!(
        environment(&before, CLIENT_A, None).discovered_item_count,
        4
    );
    assert_eq!(environment(&before, CLIENT_A, None).shared_item_count, 1);
    assert_eq!(environment(&before, CLIENT_A, None).builtin_item_count, 1);
}

#[tokio::test]
async fn physical_shared_counted_once() {
    let fixture = fixture();
    let shared = fixture._workspace.path().join("shared");
    write_skill(&shared.join("shared-skill"), "shared-skill", "shared body");
    add_directory(
        &fixture,
        "shared-dir",
        &shared,
        DirectoryRole::SharedDirectory,
        &[CLIENT_A, CLIENT_B],
    );
    let path = shared.join("shared-skill");
    let database = fixture.facade.database_for_tests();
    let database = database.lock().expect("database lock");
    for (index, client_id) in [CLIENT_A, CLIENT_B].into_iter().enumerate() {
        database
            .relationship_repository()
            .upsert_deployment_relation(&DeploymentRelationFact {
                relation_id: format!("shared-use-{index}"),
                skill_id: None,
                agent_client_id: client_id.into(),
                path: path.to_string_lossy().into_owned(),
                path_key: String::new(),
                directory_node_id: Some("shared-dir".into()),
                relationship: RelationshipType::SharedDirectoryRead,
                file_representation: FileRepresentation::Directory,
                ownership: OwnershipState::SharedReference,
                link_target_path: None,
                link_target_path_key: None,
                link_target_directory_id: None,
                content_fingerprint: "sha256:shared".into(),
                origin: ObservedOrigin::Scan,
                match_state: ObservedMatchState::NameOnly,
                health_reasons: Some(Vec::new()),
                active: true,
                observed_at: 1,
                released_at: None,
            })
            .expect("shared usage relation");
    }
    drop(database);

    let statistics = statistics(&fixture).await;
    assert_eq!(statistics.physical_usage_count, 1);
    assert_eq!(
        environment(&statistics, CLIENT_A, None).shared_item_count,
        1
    );
    assert_eq!(
        environment(&statistics, CLIENT_B, None).shared_item_count,
        1
    );
}

#[tokio::test]
async fn role_cards_do_not_inflate_agent_count() {
    let fixture = fixture();
    let user = fixture._workspace.path().join("agent/user");
    let builtin = fixture._workspace.path().join("agent/builtin");
    write_skill(&user.join("user-skill"), "user-skill", "user body");
    write_skill(
        &builtin.join("builtin-skill"),
        "builtin-skill",
        "builtin body",
    );
    add_directory(
        &fixture,
        "user-dir",
        &user,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );
    add_directory(
        &fixture,
        "builtin-dir",
        &builtin,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );

    let statistics = statistics(&fixture).await;

    assert_eq!(statistics.real_agent_count, 2);
}

#[tokio::test]
async fn shared_object_is_single() {
    let fixture = fixture();
    let shared = fixture._workspace.path().join("shared");
    add_directory(
        &fixture,
        "shared-dir",
        &shared,
        DirectoryRole::SharedDirectory,
        &[CLIENT_A, CLIENT_B],
    );

    let statistics = statistics(&fixture).await;

    assert_eq!(statistics.shared_directory_count, 1);
}

#[tokio::test]
async fn duplicates_remain_in_discovered_count() {
    let fixture = fixture();
    let first = fixture._workspace.path().join("agent/first");
    let second = fixture._workspace.path().join("agent/second");
    let same_skill = fixture._workspace.path().join("agent/same-skill");
    write_skill(&first.join("formatter"), "formatter", "first body");
    write_skill(&second.join("formatter"), "formatter", "second body");
    write_skill(&same_skill.join("formatter"), "formatter", "first body");
    add_directory(
        &fixture,
        "first-dir",
        &first,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );
    add_directory(
        &fixture,
        "second-dir",
        &second,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );
    add_directory(
        &fixture,
        "same-skill-dir",
        &same_skill,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );

    let statistics = statistics(&fixture).await;
    let agent = environment(&statistics, CLIENT_A, None);

    assert_eq!(agent.discovered_item_count, 3);
    assert_eq!(agent.same_skill_problem_count, 1);
    assert_eq!(agent.name_problem_count, 1);
}

#[tokio::test]
async fn hermes_openclaw_scope_is_workspace() {
    let fixture = fixture();
    let workspace = fixture._workspace.path().join("workspace/.agents/skills");
    std::fs::create_dir_all(&workspace).expect("workspace skills");
    let target_path = workspace.parent().expect("workspace root");
    let database = fixture.facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "2".into(),
            observed_at: "2026-10-09T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: PROFILE.into(),
                client_id: CLIENT_A.into(),
                kind: ClientKind::Cli,
                display_name: "Fixture workspace Agent".into(),
                supported_os: vec![OperatingSystem::Macos],
                client_presence: ClientPresence::Unknown,
            }],
            agent_roots: Vec::new(),
            logical_targets: vec![LogicalTarget {
                id: "workspace-skills".into(),
                profile_id: PROFILE.into(),
                client_id: CLIENT_A.into(),
                scope: TargetScope::Project,
                path: workspace.to_string_lossy().into_owned(),
                agent_root_id: "workspace-root".into(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: "workspace-physical".into(),
                status: skillhub_core::agent::DirectoryObservationStatus::Existing,
                physical_identity_verified: true,
            }],
            physical_targets: Vec::new(),
        })
        .expect("save workspace-scope discovery");
    add_directory(
        &fixture,
        "workspace-dir",
        &workspace,
        DirectoryRole::AgentNative,
        &[CLIENT_A],
    );
    assert!(target_path.exists());

    let statistics = statistics(&fixture).await;

    assert_eq!(statistics.project_count, 0);
    assert!(statistics
        .environments
        .iter()
        .all(|stats| stats.environment.project_id.is_none()));
}
