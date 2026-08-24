use skillhub_core::check::{CheckKind, CheckRepository, CheckRun, Finding, FindingDisposition};
use skillhub_core::{ErrorCode, Severity, SkillId, VersionId};
use skillhub_storage::Database;
use std::collections::BTreeSet;

fn version_id() -> VersionId {
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        .parse()
        .unwrap()
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
    fn clone(_: *const ()) -> RawWaker {
        raw_waker()
    }
    fn wake(_: *const ()) {}
    fn raw_waker() -> RawWaker {
        RawWaker::new(
            std::ptr::null(),
            &RawWakerVTable::new(clone, wake, wake, wake),
        )
    }
    let waker = unsafe { Waker::from_raw(raw_waker()) };
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

fn seed_skill_and_version(db: &Database, skill: SkillId, version: &VersionId) {
    db.connection_for_test()
        .execute(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES (?1,'check','check',0,0)",
            [skill.to_string()],
        )
        .unwrap();
    db.connection_for_test()
        .execute(
            "INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES (?1,?2,'hash','{}',0)",
            rusqlite::params![version.to_string(), skill.to_string()],
        )
        .unwrap();
}

#[test]
fn check_run_and_findings_round_trip_without_merging_check_kinds() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = version_id();
    seed_skill_and_version(&db, skill, &version);
    let mut run = CheckRun::completed(
        "basic-run",
        skill,
        version.clone(),
        CheckKind::Basic,
        vec![Finding::at(
            "finding-1",
            "security.secret",
            Severity::Warning,
            "SKILL.md",
            7,
            Some(8),
        )],
    );
    run.ruleset_id = Some("basic-v1".to_owned());
    run.coverage_inputs = serde_json::json!({"files": ["SKILL.md"]});
    run.findings[0].evidence_hash = Some("sha256:evidence".to_owned());
    run.findings[0].message_params.insert(
        "name".to_owned(),
        serde_json::Value::String("token".to_owned()),
    );

    let repository = db.check_repository();
    block_on(repository.insert(&run)).unwrap();
    let loaded = block_on(repository.get("basic-run")).unwrap().unwrap();
    assert_eq!(loaded, run);
    assert_eq!(loaded.state(), skillhub_core::check::CheckState::Failed);

    let llm = CheckRun::completed("llm-run", skill, version.clone(), CheckKind::Llm, vec![]);
    block_on(repository.insert(&llm)).unwrap();
    assert_eq!(
        block_on(repository.list_for_version(skill, &version, CheckKind::Basic))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        block_on(repository.list_for_version(skill, &version, CheckKind::Llm))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn updating_a_finding_disposition_rederives_a_passed_result() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = version_id();
    seed_skill_and_version(&db, skill, &version);
    let run = CheckRun::completed(
        "basic-run",
        skill,
        version,
        CheckKind::Basic,
        vec![Finding::new(
            "finding-1",
            "security.secret",
            Severity::Error,
        )],
    );
    let repository = db.check_repository();
    block_on(repository.insert(&run)).unwrap();
    let resolved = run.set_disposition("finding-1", FindingDisposition::Acknowledged);
    let resolved = resolved.unwrap();
    block_on(repository.update(&resolved)).unwrap();

    let loaded = block_on(repository.get("basic-run")).unwrap().unwrap();
    assert_eq!(
        loaded.findings[0].disposition,
        FindingDisposition::Acknowledged
    );
    assert_eq!(loaded.state(), skillhub_core::check::CheckState::Passed);
}

#[test]
fn current_run_uses_newest_generation_and_not_checked_round_trips() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = version_id();
    seed_skill_and_version(&db, skill, &version);
    let mut stale = CheckRun::completed(
        "stale",
        skill,
        version.clone(),
        CheckKind::Basic,
        vec![Finding::new(
            "old-finding",
            "security.secret",
            Severity::Error,
        )],
    );
    stale.generation = 1;
    stale.started_at = 10;
    let mut current = CheckRun::not_checked("current", skill, version.clone(), CheckKind::Basic);
    current.generation = 2;
    current.started_at = 20;
    let repository = db.check_repository();
    block_on(repository.insert(&stale)).unwrap();
    block_on(repository.insert(&current)).unwrap();

    assert_eq!(
        block_on(repository.current_for_version(skill, &version, CheckKind::Basic))
            .unwrap()
            .unwrap()
            .id,
        "current"
    );
    assert_eq!(
        block_on(repository.get("current"))
            .unwrap()
            .unwrap()
            .state(),
        skillhub_core::check::CheckState::NotChecked
    );
}

#[test]
fn custom_allowed_dispositions_and_failure_code_round_trip() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = version_id();
    seed_skill_and_version(&db, skill, &version);
    let mut finding = Finding::new("finding", "security.secret", Severity::Error);
    finding.allowed_dispositions = [FindingDisposition::Dismissed].into_iter().collect();
    let mut run = CheckRun::completed("failed", skill, version, CheckKind::Basic, vec![finding]);
    run.failure_code = Some("scanner.io_error".to_owned());
    let repository = db.check_repository();
    block_on(repository.insert(&run)).unwrap();
    let loaded = block_on(repository.get("failed")).unwrap().unwrap();
    assert_eq!(loaded.failure_code.as_deref(), Some("scanner.io_error"));
    assert_eq!(
        loaded.findings[0].allowed_dispositions,
        [FindingDisposition::Dismissed]
            .into_iter()
            .collect::<BTreeSet<_>>()
    );
    let error = run
        .set_disposition("missing", FindingDisposition::Dismissed)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

#[test]
fn pending_findings_only_come_from_the_current_run() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = version_id();
    seed_skill_and_version(&db, skill, &version);
    let mut stale = CheckRun::completed(
        "stale-pending",
        skill,
        version.clone(),
        CheckKind::Basic,
        vec![Finding::new("old", "security.secret", Severity::Error)],
    );
    stale.started_at = 10;
    let mut current =
        CheckRun::completed("clean-current", skill, version, CheckKind::Basic, vec![]);
    current.started_at = 20;
    let repository = db.check_repository();
    block_on(repository.insert(&stale)).unwrap();
    block_on(repository.insert(&current)).unwrap();

    assert!(db
        .bootstrap_repository()
        .list_pending((2026, 8, 24))
        .unwrap()
        .is_empty());
}
