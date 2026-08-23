use skillhub_core::catalog::{
    CombinationMember, Skill, SkillCombination, SkillLifecycle, TrialState,
};
use skillhub_core::SkillId;

#[test]
fn trial_is_a_label_with_due_date_not_a_lifecycle_state() {
    let skill = Skill::new(SkillId::new(), "pdf").with_trial_due(2026, 9, 1);
    assert_eq!(skill.lifecycle(), SkillLifecycle::Normal);
    assert!(skill.tags().contains("temporary_trial"));
    assert_eq!(skill.trial_state((2026, 9, 2)), TrialState::Due);
}

#[test]
fn combinations_cannot_contain_other_combinations() {
    let result = SkillCombination::create(
        "writing",
        vec![CombinationMember::Combination(
            SkillCombination::id_for_test(),
        )],
    );
    assert_eq!(
        result.unwrap_err().code.as_str(),
        "combination.nesting_not_allowed"
    );
}
