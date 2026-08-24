use skillhub_core::check::{CheckKind, CheckRepository, CheckRun, Finding, FindingDisposition};
use skillhub_core::{Severity, SkillId, VersionId};
use skillhub_storage::Database;

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
    block_on(repository.update(&resolved)).unwrap();

    let loaded = block_on(repository.get("basic-run")).unwrap().unwrap();
    assert_eq!(
        loaded.findings[0].disposition,
        FindingDisposition::Acknowledged
    );
    assert_eq!(loaded.state(), skillhub_core::check::CheckState::Passed);
}
