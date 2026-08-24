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
    let resolved = run.set_disposition("finding-1", FindingDisposition::Acknowledged);

    assert_eq!(derive_check_state(&resolved), CheckState::Passed);
}

#[test]
fn running_and_failed_execution_states_are_distinct_from_findings() {
    let running = CheckRun::running("running", SkillId::new(), version_id(), CheckKind::Basic);
    assert_eq!(derive_check_state(&running), CheckState::Running);

    let mut failed = basic_failed_run();
    failed.phase = CheckRunPhase::Failed;
    failed.failure_reason = Some("scanner.io_error".to_owned());
    failed.findings.clear();
    assert_eq!(derive_check_state(&failed), CheckState::Failed);
}

#[test]
fn only_actionable_findings_keep_a_completed_run_failed() {
    let mut run = basic_failed_run();
    run.findings[0].disposition = FindingDisposition::Dismissed;

    assert_eq!(derive_check_state(&run), CheckState::Passed);
}
