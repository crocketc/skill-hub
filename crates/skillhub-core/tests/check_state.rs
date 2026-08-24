use skillhub_core::check::{
    derive_check_state, CheckKind, CheckProjection, CheckRun, CheckRunPhase, CheckState, Finding,
    FindingDisposition,
};
use skillhub_core::{Severity, SkillId, VersionId};

fn version_id() -> VersionId {
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        .parse()
        .unwrap()
}

fn basic_failed_run() -> CheckRun {
    CheckRun::completed(
        "basic-run",
        SkillId::new(),
        version_id(),
        CheckKind::Basic,
        vec![Finding::new(
            "finding-1",
            "security.destructive_command",
            Severity::Error,
        )],
    )
}

fn llm_passed_run() -> CheckRun {
    CheckRun::completed(
        "llm-run",
        SkillId::new(),
        version_id(),
        CheckKind::Llm,
        vec![],
    )
}

#[test]
fn basic_and_llm_runs_never_overwrite_each_other() {
    let mut state = CheckProjection::default();
    state.apply(basic_failed_run());
    state.apply(llm_passed_run());

    assert_eq!(state.basic.state, CheckState::Failed);
    assert_eq!(state.llm.state, CheckState::Passed);
}

#[test]
fn resolving_the_last_actionable_finding_changes_result_to_passed() {
    let run = basic_failed_run();
    let resolved = run
        .set_disposition("finding-1", FindingDisposition::Acknowledged)
        .unwrap();

    assert_eq!(derive_check_state(&resolved), CheckState::Passed);
}

#[test]
fn running_and_failed_execution_states_are_distinct_from_findings() {
    let running = CheckRun::running("running", SkillId::new(), version_id(), CheckKind::Basic);
    assert_eq!(derive_check_state(&running), CheckState::Running);

    let mut failed = basic_failed_run();
    failed.phase = CheckRunPhase::Failed;
    failed.failure_code = Some("scanner.io_error".to_owned());
    failed.findings.clear();
    assert_eq!(derive_check_state(&failed), CheckState::Failed);
}

#[test]
fn only_actionable_findings_keep_a_completed_run_failed() {
    let mut run = basic_failed_run();
    run.findings[0].disposition = FindingDisposition::Dismissed;

    assert_eq!(derive_check_state(&run), CheckState::Passed);
}

#[test]
fn an_older_run_cannot_replace_a_newer_generation_for_the_same_kind() {
    let mut state = CheckProjection::default();
    let mut old = llm_passed_run();
    old.generation = 1;
    old.started_at = 20;
    let mut current = basic_failed_run();
    current.generation = 2;
    current.started_at = 30;
    state.apply(current.clone());

    let mut stale = current
        .set_disposition("finding-1", FindingDisposition::Acknowledged)
        .unwrap();
    stale.generation = 1;
    stale.started_at = 10;
    state.apply(stale);
    assert_eq!(state.basic.run.as_ref().unwrap().generation, 2);

    state.apply(old);
    assert_eq!(state.llm.state, CheckState::Passed);
}

#[test]
fn a_not_checked_run_derives_not_checked_and_custom_dispositions_are_validated() {
    let run = CheckRun::not_checked(
        "not-checked",
        SkillId::new(),
        version_id(),
        CheckKind::Basic,
    );
    assert_eq!(derive_check_state(&run), CheckState::NotChecked);

    let mut finding = Finding::new("finding", "security.secret", Severity::Warning);
    finding.allowed_dispositions = [FindingDisposition::Dismissed].into_iter().collect();
    let run = CheckRun::completed(
        "run",
        SkillId::new(),
        version_id(),
        CheckKind::Basic,
        vec![finding],
    );
    assert!(run
        .set_disposition("finding", FindingDisposition::Acknowledged)
        .is_err());
    assert!(run
        .set_disposition("missing", FindingDisposition::Dismissed)
        .is_err());
}
