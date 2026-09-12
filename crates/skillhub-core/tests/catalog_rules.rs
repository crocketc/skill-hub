use skillhub_core::catalog::{parse_declared_requirements, CallPolicy, RequirementKind};
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

#[test]
fn call_policy_supports_all_invocation_actor_combinations() {
    let policies = [
        CallPolicy::AutomaticAndManual,
        CallPolicy::ManualOnly,
        CallPolicy::ModelOnly,
        CallPolicy::Disabled,
    ];

    assert_eq!(policies.len(), 4);
    assert_ne!(CallPolicy::ModelOnly, CallPolicy::ManualOnly);
    assert_ne!(CallPolicy::Disabled, CallPolicy::AutomaticAndManual);
}

#[test]
fn user_purpose_is_independent_metadata_not_a_description_alias() {
    let mut skill = Skill::new(SkillId::new(), "pdf").with_description("Extracts tables");
    skill
        .set_metadata(
            Some("PDF helper".to_owned()),
            Some("keep near docs".to_owned()),
            std::collections::BTreeSet::from(["documents".to_owned()]),
            Some("Example Author".to_owned()),
            Some("MIT".to_owned()),
            Some("用于 PDF 表格提取".to_owned()),
        )
        .expect("metadata update validates");
    // 用途是用户独立撰写的字段，不得用原文或译文冒充。
    assert_eq!(skill.user_purpose(), Some("用于 PDF 表格提取"));
    assert_eq!(skill.original_description(), "Extracts tables");
    assert_eq!(skill.note(), Some("keep near docs"));

    skill
        .set_metadata(
            None,
            Some("keep near docs".to_owned()),
            std::collections::BTreeSet::from(["documents".to_owned()]),
            Some("Example Author".to_owned()),
            Some("MIT".to_owned()),
            None,
        )
        .expect("clearing purpose validates");
    assert_eq!(skill.user_purpose(), None);
    // 未提供 display_name 时显示名保持不变。
    assert_eq!(skill.display_name(), "PDF helper");
}

#[test]
fn set_metadata_alias_updates_display_name_without_touching_runtime_name() {
    // M-21：抽屉别名编辑走 set_metadata；runtime 原名是稳定身份，
    // 只能由 rename_skill 修改——别名路径不得覆写原名。
    let mut skill = Skill::from_parts(
        SkillId::new(),
        "PDF Reader".to_owned(),
        "pdf-reader".to_owned(),
        "Extract tables".to_owned(),
        None,
        None,
        None,
        Default::default(),
        None,
        None,
        CallPolicy::AutomaticAndManual,
        SkillLifecycle::Normal,
        Vec::new(),
        None,
    )
    .expect("skill builds");

    skill
        .set_metadata(
            Some("PDF 助手".to_owned()),
            None,
            Default::default(),
            None,
            None,
            None,
        )
        .expect("alias update validates");

    assert_eq!(skill.display_name(), "PDF 助手");
    // 缺陷回归线：set_metadata 不得触碰 runtime_name。
    assert_eq!(skill.runtime_name(), "pdf-reader");
}
