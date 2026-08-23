use skillhub_core::catalog::Skill;
use skillhub_core::pending::{derive_pending, FindingRecord, PendingKind};
use skillhub_core::{SkillId, StartupRecoveryState};

#[test]
fn due_trial_and_unresolved_finding_are_derived_without_status_text() {
    let trial = Skill::new(SkillId::new(), "trial").with_trial_due(2026, 8, 1);
    let unsafe_skill = Skill::new(SkillId::new(), "unsafe");
    let findings = vec![FindingRecord::unresolved(
        unsafe_skill.id(),
        "basic.secret_detected",
    )];

    let pending = derive_pending(
        &[trial.clone(), unsafe_skill.clone()],
        &findings,
        (2026, 8, 23),
    );

    assert!(pending
        .iter()
        .any(|item| item.subject == trial.id() && item.kind == PendingKind::TrialDue));
    assert!(pending.iter().any(|item| {
        item.subject == unsafe_skill.id() && item.kind == PendingKind::SecurityFinding
    }));
    assert!(pending.iter().all(|item| item.message_code.is_some()));
}

#[test]
fn pending_order_is_deterministic_and_uses_typed_kinds() {
    let first = Skill::new(SkillId::new(), "first").with_trial_due(2026, 8, 1);
    let second = Skill::new(SkillId::new(), "second").with_trial_due(2026, 8, 1);
    let findings = vec![FindingRecord::unresolved(first.id(), "basic.command")];
    let mut skills = vec![second, first];
    skills.sort_by_key(|skill| skill.id().to_string());
    let pending = derive_pending(&skills, &findings, (2026, 8, 23));

    let mut sorted = pending.clone();
    sorted.sort();
    assert_eq!(pending, sorted);
    let serialized = serde_json::to_string(&pending).unwrap();
    assert!(!serialized.contains("试用"));
    assert!(!serialized.contains("安全"));
}

#[test]
fn bootstrap_snapshot_is_cacheable_before_scanning_and_has_no_localized_sentences() {
    let snapshot = skillhub_core::BootstrapSnapshot::empty();
    assert_eq!(snapshot.skill_count, 0);
    assert_eq!(snapshot.pending.total, 0);
    assert_eq!(snapshot.recovery_state, StartupRecoveryState::Clean);
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialized.contains("试用"));
    assert!(!serialized.contains("安全"));
}

#[test]
fn startup_snapshot_supports_three_hundred_skills_in_memory() {
    let skills: Vec<_> = (0..300)
        .map(|index| Skill::new(SkillId::new(), format!("skill-{index}")))
        .collect();
    let started = std::time::Instant::now();
    let pending = derive_pending(&skills, &[], (2026, 8, 23));
    assert!(pending.is_empty());
    assert!(started.elapsed() < std::time::Duration::from_millis(100));
}
