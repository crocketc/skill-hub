//! Initialization scan concurrency (M-31): handing the first-run scan to the
//! background must keep every other facade command responsive. The scan walks
//! the filesystem for a user-perceived time, so it must never hold the shared
//! database handle across the walk — otherwise `complete_onboarding`,
//! `activate_library_root` and even `GetBootstrapSnapshot` block behind it and
//! "完成初始化" appears dead while the scan runs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    api::{CompleteOnboarding, RunInitializationScan},
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, Project,
};
use skillhub_storage::{CentralLibrary, Database};

/// Skill count chosen so the deterministic filesystem walk reliably outlasts
/// the completion issued right after the scan starts; the test only asserts
/// ordering (completion returned while the walk is still running), never a
/// timing window.
const SKILL_COUNT: usize = 2_000;

struct ScanWorker {
    join: std::thread::JoinHandle<skillhub_core::AppResult<AppCommandResult>>,
    walking: Arc<AtomicBool>,
}

fn execute_scan_on_worker(facade: Arc<LocalApplicationFacade>) -> ScanWorker {
    let walking = Arc::new(AtomicBool::new(false));
    let worker_flag = Arc::clone(&walking);
    let join = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("worker runtime")
            .block_on(async {
                worker_flag.store(true, Ordering::SeqCst);
                let result = facade
                    .execute(AppCommand::RunInitializationScan(RunInitializationScan {
                        scope_ids: Vec::new(),
                    }))
                    .await;
                // The database must already be released for the result
                // persistence window; clear the flag only after the command
                // returned so the main thread can assert true ordering.
                worker_flag.store(false, Ordering::SeqCst);
                result
            })
    });
    ScanWorker { join, walking }
}

#[tokio::test(flavor = "current_thread")]
async fn completion_and_bootstrap_queries_stay_responsive_while_the_initialization_scan_walks() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database = Database::open(workspace.path().join("db.sqlite")).expect("database");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    let facade = Arc::new(LocalApplicationFacade::new_with_library(database, &library_root));

    let scan_root = workspace.path().join("sources");
    for index in 0..SKILL_COUNT {
        let skill = scan_root.join(format!("skill-{index:04}"));
        std::fs::create_dir_all(&skill).expect("skill dir");
        std::fs::write(
            skill.join("SKILL.md"),
            format!("---\nname: skill-{index:04}\ndescription: fixture\n---\n\n# skill-{index:04}\n"),
        )
        .expect("marker");
    }
    let project = Project::new(skillhub_core::ProjectId::new(), "Sources", &scan_root);
    let registered = facade
        .execute(AppCommand::RegisterProject(skillhub_core::api::RegisterProject {
            project,
        }))
        .await
        .expect("register scan project");
    assert!(matches!(registered, AppCommandResult::Project(_)));

    // Start the first-run scan exactly like the wizard does (empty scope ids
    // scan every registered target).
    let worker = execute_scan_on_worker(Arc::clone(&facade));

    // While the scan walks the fixture tree, finishing onboarding must go
    // through instead of waiting behind the scan (M-31 reproduction).
    let completed = facade
        .execute(AppCommand::CompleteOnboarding(CompleteOnboarding {
            library_path: library_root.to_string_lossy().into_owned(),
            skipped: false,
        }))
        .await
        .expect("complete_onboarding must not block behind a running initialization scan");
    assert!(matches!(completed, AppCommandResult::InitializationStatus(_)));
    assert!(
        worker.walking.load(Ordering::SeqCst),
        "completion returned only after the scan walk ended: the scan still monopolizes the shared database"
    );

    let snapshot = facade
        .query(AppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap snapshot must stay responsive during the scan");
    let AppQueryResult::BootstrapSnapshot(snapshot) = snapshot else {
        panic!("expected bootstrap snapshot");
    };
    assert_eq!(
        snapshot.initialization_state,
        skillhub_core::InitializationState::Initialized
    );
    assert!(
        worker.walking.load(Ordering::SeqCst),
        "bootstrap query returned only after the scan walk ended"
    );

    // The scan still finishes and persists its snapshot (honest completion,
    // no fabricated state): a second scan reports every fixture skill as
    // unchanged because the first snapshot was stored.
    let scanned = worker
        .join
        .join()
        .expect("scan worker")
        .expect("first scan succeeds");
    let AppCommandResult::ScanResult(first) = scanned else {
        panic!("expected scan result");
    };
    assert_eq!(first.discovered.len(), SKILL_COUNT);
    assert_eq!(first.roots.len(), 1);
    assert!(first.roots[0].ends_with("sources"));

    let rescanned = facade
        .execute(AppCommand::RunInitializationScan(RunInitializationScan {
            scope_ids: Vec::new(),
        }))
        .await
        .expect("second scan");
    let AppCommandResult::ScanResult(second) = rescanned else {
        panic!("expected scan result");
    };
    assert_eq!(second.discovered.len(), SKILL_COUNT);
    assert_eq!(second.unchanged_count, SKILL_COUNT as u32);
}
