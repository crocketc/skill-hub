use skillhub_testkit::{FaultInjector, FaultPoint};

#[test]
fn named_faults_are_deterministic_and_one_shot() {
    let faults = FaultInjector::new();
    faults.fail_once(FaultPoint::AfterPrepare);
    faults.fail_once("after_first_target");
    faults.fail_once("before_verify");

    assert!(faults.after_prepare());
    assert!(!faults.after_prepare());
    assert!(faults.after_first_target());
    assert!(!faults.after_first_target());
    assert!(faults.before_verify());
    assert!(!faults.before_verify());
}

#[test]
fn check_reports_the_named_fault_once() {
    let faults = FaultInjector::new();
    faults.fail_once("after_prepare");
    assert_eq!(
        faults.check("after_prepare").unwrap_err().point(),
        "after_prepare"
    );
    assert!(faults.check("after_prepare").is_ok());
}
