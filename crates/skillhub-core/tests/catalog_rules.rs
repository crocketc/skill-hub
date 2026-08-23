use skillhub_core::catalog::{parse_declared_requirements, RequirementKind};
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

#[test]
fn declared_requirements_cover_runtime_types_and_explicitness() {
    let parsed = parse_declared_requirements(
        "Requires Python>=3.11, ffmpeg 6.0 and MCP\nUses node and OPENAI_API_KEY",
    );
    assert!(parsed.iter().any(|r| r.kind == RequirementKind::Python
        && r.explicit
        && r.version.as_deref() == Some("3.11")));
    assert!(parsed.iter().any(|r| r.kind == RequirementKind::Ffmpeg));
    assert!(parsed.iter().any(|r| r.kind == RequirementKind::Mcp));
    assert!(parsed
        .iter()
        .any(|r| r.kind == RequirementKind::EnvironmentVariable));
    assert!(parsed
        .iter()
        .any(|r| r.kind == RequirementKind::OtherTool && !r.explicit));
}
