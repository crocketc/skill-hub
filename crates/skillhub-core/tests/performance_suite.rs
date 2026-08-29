#[path = "performance/backup_restore.rs"]
mod backup_restore;
#[path = "performance/batch_deploy.rs"]
mod batch_deploy;
#[path = "performance/full_scan.rs"]
mod full_scan;
#[path = "performance/generate_fixture.rs"]
mod generate_fixture;
#[path = "performance/search.rs"]
mod search;
#[path = "performance/startup.rs"]
mod startup;

use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Serialize)]
struct PerformanceReport {
    schema_version: u32,
    fixture_seed: u64,
    skill_count: usize,
    interactive_ms: u128,
    full_scan_ms: u128,
    search_ms: u128,
    backup_restore_ms: u128,
    batch_deploy_ms: u128,
}

#[test]
fn cached_bootstrap_for_100_skills_meets_reference_threshold() {
    let fixture = generate_fixture::generate(100);
    let started = Instant::now();
    let count = startup::cached_bootstrap(&fixture);
    let interactive_ms = started.elapsed().as_millis();
    assert_eq!(count, 100);
    assert!(interactive_ms <= 5_000);
}

#[test]
fn three_hundred_skill_suite_emits_machine_readable_report_without_paths() {
    let fixture = generate_fixture::generate(300);
    let started = Instant::now();
    let report = PerformanceReport {
        schema_version: 1,
        fixture_seed: fixture.seed,
        skill_count: fixture.skills.len(),
        interactive_ms: started.elapsed().as_millis(),
        full_scan_ms: full_scan::measure(&fixture),
        search_ms: search::measure(&fixture),
        backup_restore_ms: backup_restore::measure(&fixture),
        batch_deploy_ms: batch_deploy::measure(&fixture),
    };
    assert_eq!(report.skill_count, 300);
    let json = serde_json::to_string(&report).unwrap();
    println!("{json}");
    assert!(!json.contains("C:\\"));
    assert!(!json.contains("/Users/"));
}
