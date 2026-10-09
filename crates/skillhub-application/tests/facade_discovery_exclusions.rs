use std::path::{Path, PathBuf};

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, PhysicalTarget, TargetScope,
};
use skillhub_core::api::{DiscoverImportCandidates, RunInitializationScan};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, CreateIgnoreRule,
    IgnoreSubject,
};
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_ID: &str = "agent.discovery-exclusion-fixture";

struct Fixture {
    _workspace: tempfile::TempDir,
    database_path: PathBuf,
    library_root: PathBuf,
    agent_skills: PathBuf,
    alpha: PathBuf,
    facade: LocalApplicationFacade,
}

fn write_skill(path: &Path, name: &str) {
    std::fs::create_dir_all(path).expect("skill directory");
    std::fs::write(
        path.join("SKILL.md"),
        format!("---\nname: {name}\n---\n\n{name} fixture\n"),
    )
    .expect("write skill marker");
}

fn canonical_text(path: &Path) -> String {
    std::fs::canonicalize(path)
        .expect("canonical fixture path")
        .to_string_lossy()
        .into_owned()
}

fn fixture() -> Fixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");

    let agent_skills = workspace.path().join("agent/skills");
    let alpha = agent_skills.join("alpha");
    let beta = agent_skills.join("beta");
    std::fs::create_dir_all(&agent_skills).expect("Agent skills directory");
    write_skill(&alpha, "alpha");
    write_skill(&beta, "beta");

    let database = Database::open(&database_path).expect("database");
    let physical_id =
        skillhub_core::physical_id_for_path(&agent_skills).expect("Agent directory identity");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-10-09T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: "discovery-exclusion-fixture".into(),
                client_id: CLIENT_ID.into(),
                kind: ClientKind::Cli,
                display_name: "Discovery Exclusion Fixture".into(),
                supported_os: vec![OperatingSystem::Macos, OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: vec![LogicalTarget {
                id: "target-discovery-exclusion".into(),
                profile_id: "discovery-exclusion-fixture".into(),
                client_id: CLIENT_ID.into(),
                scope: TargetScope::Global,
                path: agent_skills.to_string_lossy().into_owned(),
                agent_root_id: "discovery-exclusion-root".into(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: physical_id.clone(),
                status: skillhub_core::agent::DirectoryObservationStatus::Existing,
                physical_identity_verified: true,
            }],
            physical_targets: vec![PhysicalTarget {
                id: physical_id,
                path: agent_skills.to_string_lossy().into_owned(),
                exists: true,
                readable: true,
                writable: true,
                case_behavior: "unknown".into(),
                logical_target_ids: vec!["target-discovery-exclusion".into()],
            }],
            agent_roots: Vec::new(),
        })
        .expect("register Agent directory");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);

    Fixture {
        _workspace: workspace,
        database_path,
        library_root,
        agent_skills,
        alpha,
        facade,
    }
}

async fn discover(facade: &LocalApplicationFacade, root: &Path) -> Vec<String> {
    let result = facade
        .query(AppQuery::DiscoverImportCandidates(
            DiscoverImportCandidates {
                source: SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root)),
            },
        ))
        .await
        .expect("discover import candidates");
    let AppQueryResult::ImportCandidates(candidates) = result else {
        panic!("expected import candidates");
    };
    candidates
        .into_iter()
        .map(|candidate| candidate.absolute_root)
        .collect()
}

#[tokio::test]
async fn exact_path_exclusion_filters_import_recommendations_but_keeps_scan_observations() {
    let fixture = fixture();
    let initial = fixture
        .facade
        .execute(AppCommand::RunInitializationScan(RunInitializationScan {
            scope_ids: Vec::new(),
        }))
        .await
        .expect("initial scan");
    let AppCommandResult::ScanResult(initial) = initial else {
        panic!("expected scan result");
    };
    assert_eq!(initial.discovered.len(), 2);

    fixture
        .facade
        .execute(AppCommand::CreateIgnoreRule(CreateIgnoreRule {
            subject: IgnoreSubject::exact_path(canonical_text(&fixture.alpha)).expect("exact path"),
            reason: "discovery-exclude".into(),
            defer_until: None,
        }))
        .await
        .expect("persist exact path exclusion");

    let candidates = discover(&fixture.facade, &fixture.agent_skills).await;
    assert_eq!(
        candidates,
        vec![canonical_text(&fixture.agent_skills.join("beta"))]
    );

    let rescanned = fixture
        .facade
        .execute(AppCommand::RunInitializationScan(RunInitializationScan {
            scope_ids: Vec::new(),
        }))
        .await
        .expect("rescan after exclusion");
    let AppCommandResult::ScanResult(rescanned) = rescanned else {
        panic!("expected scan result");
    };
    assert_eq!(
        rescanned.discovered.len(),
        2,
        "exclusion preserves observations"
    );

    drop(fixture.facade);
    let restarted = LocalApplicationFacade::new_with_library(
        Database::open(&fixture.database_path).expect("reopen database"),
        &fixture.library_root,
    );
    assert_eq!(
        discover(&restarted, &fixture.agent_skills).await,
        vec![canonical_text(&fixture.agent_skills.join("beta"))]
    );
}
