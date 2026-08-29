use skillhub_adapters::llm::duplicate_prompt::build_duplicate_request;
use skillhub_core::duplicate::DuplicateCandidate;
use skillhub_core::SkillId;

#[test]
fn duplicate_prompt_is_fixed_and_contains_only_candidate_facts() {
    let candidate = DuplicateCandidate {
        skill_id: SkillId::new(),
        name: "PDF".into(),
        description: "extract text".into(),
        trigger: "PDF input".into(),
        permissions: vec!["read".into()],
        source: "local".into(),
        basic_check_state: "passed".into(),
        locally_modified: false,
    };
    let request = build_duplicate_request(&[candidate]).unwrap();
    assert!(request.input.contains("skill_id"));
    assert!(request.input.contains("Do not modify or delete"));
}
