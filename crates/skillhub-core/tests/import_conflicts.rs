use skillhub_core::deployment::reconcile::RelationTargetFact;
use skillhub_core::import::{
    analyze_import, CandidateOwnership, DuplicateKind, ExistingSkillRecord, ImportCandidate,
    ImportDecision, ImportGovernanceAction, ImportGovernanceClassification, ImportSourceFacts,
    MatchBasis,
};
use skillhub_core::relationship::classifier::classify_observed_relation;
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryRecognition, DirectoryRole, FileRepresentation,
    RelationshipType,
};
use skillhub_core::search::SearchField;
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::SkillId;

fn make_candidate(runtime_name: &str, source: SourceDescriptor) -> (ImportCandidate, String) {
    (
        ImportCandidate::detected(source, "C:/incoming/pdf", ".", "SKILL.md", runtime_name),
        "sha256:incoming".to_owned(),
    )
}

fn plain_facts(role: Option<DirectoryRole>) -> ImportSourceFacts {
    ImportSourceFacts {
        directory_role: role,
        source_is_link: false,
        observed_copy_verified: false,
        affected_agents: Vec::new(),
    }
}

fn existing(
    runtime_name: &str,
    tree_hash: &str,
    ownership: CandidateOwnership,
) -> ExistingSkillRecord {
    ExistingSkillRecord {
        skill_id: SkillId::new(),
        display_name: runtime_name.to_owned(),
        runtime_name: runtime_name.to_owned(),
        tree_hash: Some(tree_hash.to_owned()),
        source: None,
        ownership,
        fts_similarity_basis_points: None,
        matched_fields: Vec::new(),
    }
}

#[test]
fn exact_content_and_same_name_different_content_are_distinct_results() {
    let source = SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::local_path("C:/incoming/pdf"),
    );
    let (candidate, _) = make_candidate("pdf", source.clone());
    let hash = "sha256:identical".to_owned();
    let exact = analyze_import(
        candidate,
        Some(&hash),
        &[existing(
            "pdf",
            "sha256:identical",
            CandidateOwnership::CentralLibrary,
        )],
        &plain_facts(None),
    );
    assert_eq!(exact.duplicate_kind, Some(DuplicateKind::ExactContent));
    assert!(exact.actions.contains(&ImportDecision::ReuseExisting));
    // M-14：完全重复同样产生需要处理的冲突（名称/路径可辨），由用户决策。
    assert!(exact
        .conflicts
        .iter()
        .any(|conflict| conflict.kind == DuplicateKind::ExactContent && conflict.requires_choice));

    let (candidate, _) = make_candidate("pdf", source);
    let hash = "sha256:changed".to_owned();
    let changed = analyze_import(
        candidate,
        Some(&hash),
        &[existing(
            "pdf",
            "sha256:original",
            CandidateOwnership::CentralLibrary,
        )],
        &plain_facts(None),
    );
    assert_eq!(
        changed.duplicate_kind,
        Some(DuplicateKind::SameRuntimeNameDifferentContent)
    );
    assert!(changed.actions.contains(&ImportDecision::KeepIndependent));
    assert!(changed
        .conflicts
        .iter()
        .any(|conflict| conflict.requires_choice));
}

#[test]
fn duplicate_analysis_includes_read_only_builtin_and_plugin_skills() {
    let source = SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::local_path("C:/incoming/pdf"),
    );
    let (candidate, hash) = make_candidate("pdf", source);
    let builtin = existing(
        "pdf",
        "sha256:incoming",
        CandidateOwnership::ReadOnlyBuiltinOrPlugin,
    );
    let analysis = analyze_import(candidate, Some(&hash), &[builtin], &plain_facts(None));
    assert_eq!(
        analysis.matches[0].ownership,
        CandidateOwnership::ReadOnlyBuiltinOrPlugin
    );
    assert!(analysis
        .actions
        .contains(&ImportDecision::CopyAsIndependentManagedSkill));
    assert_eq!(analysis.matches[0].basis, MatchBasis::CanonicalTreeHash);
}

#[test]
fn source_and_search_matches_are_ordered_after_identity_and_name() {
    let source = SourceDescriptor::new(
        SourceKind::Git,
        SourceLocator::git_url("https://github.com/example/pdf"),
    );
    let (candidate, hash) = make_candidate("pdf", source.clone());
    let mut source_match = existing("other", "sha256:other", CandidateOwnership::CentralLibrary);
    source_match.source = Some(source);
    let mut search_match = existing(
        "related",
        "sha256:related",
        CandidateOwnership::CentralLibrary,
    );
    search_match.fts_similarity_basis_points = Some(8_000);
    search_match.matched_fields = vec![SearchField::OriginalDescription];
    let analysis = analyze_import(
        candidate,
        Some(&hash),
        &[search_match, source_match],
        &plain_facts(None),
    );
    assert_eq!(analysis.matches[0].basis, MatchBasis::SourceLocator);
    assert_eq!(analysis.matches[1].basis, MatchBasis::FtsBm25);
}

#[test]
fn unknown_or_diverged_identity_never_becomes_a_confirmed_skill_relation() {
    let fact = RelationTargetFact::directory(
        "native",
        "/tmp/agent/skills",
        "agent",
        DirectoryRole::AgentNative,
    )
    .with_match_state(skillhub_core::ObservedMatchState::Diverged)
    .with_file_representation(FileRepresentation::Copy);

    let relation = classify_observed_relation(
        "/tmp/agent/skills/demo",
        &[fact],
        &[AgentDirectoryCapabilityFact {
            agent_client_id: "agent".into(),
            directory_node_id: "native".into(),
            recognition: DirectoryRecognition::Supported,
            precedence: skillhub_core::DirectoryPrecedence::Preferred,
            evidence_reference: None,
            researched_at: None,
            applicable_platforms: vec![],
        }],
    );

    assert_eq!(relation.relationship, RelationshipType::ObservedCopy);
    assert_eq!(relation.skill_id, None);
}

#[test]
fn governance_groups_follow_the_six_relationship_categories() {
    let source = SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::local_path("C:/incoming/pdf"),
    );

    // 完全重复：与库内现有 Skill 内容一致，默认保留原件，可建待办。
    let (candidate, hash) = make_candidate("pdf", source.clone());
    let exact = analyze_import(
        candidate,
        Some(&hash),
        &[existing(
            "pdf",
            "sha256:incoming",
            CandidateOwnership::CentralLibrary,
        )],
        &plain_facts(None),
    );
    assert_eq!(exact.governance_groups.len(), 1);
    let exact_group = &exact.governance_groups[0];
    assert_eq!(
        exact_group.classification,
        ImportGovernanceClassification::ExactDuplicate
    );
    assert_eq!(
        exact_group.default_action,
        ImportGovernanceAction::PreserveOriginal
    );
    assert!(exact_group
        .available_actions
        .contains(&ImportGovernanceAction::CreateTodo));

    // 同名不同内容：默认进入待判断待办。
    let (candidate, hash) = make_candidate("pdf", source.clone());
    let changed = analyze_import(
        candidate,
        Some(&hash),
        &[existing(
            "pdf",
            "sha256:original",
            CandidateOwnership::CentralLibrary,
        )],
        &plain_facts(None),
    );
    assert_eq!(
        changed.governance_groups[0].classification,
        ImportGovernanceClassification::SameNameDifferentContent
    );
    assert_eq!(
        changed.governance_groups[0].default_action,
        ImportGovernanceAction::CreateTodo
    );

    // 内容一致的复制副本：来源路径本身是已验证的观察副本。
    let (candidate, hash) = make_candidate("pdf", source.clone());
    let observed_copy = ImportSourceFacts {
        observed_copy_verified: true,
        ..plain_facts(None)
    };
    let copy = analyze_import(candidate, Some(&hash), &[], &observed_copy);
    assert_eq!(
        copy.governance_groups[0].classification,
        ImportGovernanceClassification::ContentIdenticalCopy
    );

    // 通用目录直接读取：来源登记为共享目录且自身不是链接。
    let (candidate, hash) = make_candidate("pdf", source.clone());
    let shared_read = analyze_import(
        candidate,
        Some(&hash),
        &[],
        &plain_facts(Some(DirectoryRole::SharedDirectory)),
    );
    assert_eq!(
        shared_read.governance_groups[0].classification,
        ImportGovernanceClassification::SharedDirectoryRead
    );

    // 通用目录链接引用：来源路径自身是符号链接/目录联结。
    let (candidate, hash) = make_candidate("pdf", source.clone());
    let shared_reference = ImportSourceFacts {
        source_is_link: true,
        ..plain_facts(Some(DirectoryRole::SharedDirectory))
    };
    let reference = analyze_import(candidate, Some(&hash), &[], &shared_reference);
    assert_eq!(
        reference.governance_groups[0].classification,
        ImportGovernanceClassification::SharedDirectoryReference
    );

    // 识别未知：目录未登记且所有权不明，默认生成待办。
    let (candidate, hash) = make_candidate("pdf", source);
    let unknown = analyze_import(candidate, Some(&hash), &[], &plain_facts(None));
    assert_eq!(
        unknown.governance_groups[0].classification,
        ImportGovernanceClassification::UnrecognizedSource
    );
    assert_eq!(
        unknown.governance_groups[0].default_action,
        ImportGovernanceAction::CreateTodo
    );
}

#[test]
fn plain_conflict_free_imports_from_known_sources_need_no_governance_group() {
    let source = SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::local_path("C:/incoming/pdf"),
    );
    for ownership in [
        CandidateOwnership::KnownAgentTarget,
        CandidateOwnership::RegisteredProject,
        CandidateOwnership::ReadOnlyBuiltinOrPlugin,
    ] {
        let (mut candidate, hash) = make_candidate("pdf", source.clone());
        candidate.ownership = ownership;
        let analysis = analyze_import(candidate, Some(&hash), &[], &plain_facts(None));
        assert!(
            analysis.governance_groups.is_empty(),
            "{ownership:?} with a known source needs no governance confirmation"
        );
    }

    // 已登记的 Agent 原生/项目目录节点同样视为关系明确。
    for role in [DirectoryRole::AgentNative, DirectoryRole::Project] {
        let (candidate, hash) = make_candidate("pdf", source.clone());
        let analysis = analyze_import(candidate, Some(&hash), &[], &plain_facts(Some(role)));
        assert!(
            analysis.governance_groups.is_empty(),
            "registered {role:?} directory needs no governance confirmation"
        );
    }
}

#[test]
fn governance_classification_prefers_conflicts_then_verified_copies() {
    let source = SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::local_path("C:/incoming/pdf"),
    );
    let shared_copy = ImportSourceFacts {
        directory_role: Some(DirectoryRole::SharedDirectory),
        source_is_link: false,
        observed_copy_verified: true,
        affected_agents: vec!["trae.code".to_owned()],
    };

    // 内容一致的复制副本比共享目录读取更具体：来源本体是已验证副本。
    let (candidate, hash) = make_candidate("pdf", source.clone());
    let copy = analyze_import(candidate, Some(&hash), &[], &shared_copy);
    assert_eq!(
        copy.governance_groups[0].classification,
        ImportGovernanceClassification::ContentIdenticalCopy
    );

    // 已验证的观察副本比完全重复更具体：候选是已确认的副本实例，
    // 治理层关注"保留副本/转管理链接"，内容决策仍在候选动作里。
    let (candidate, hash) = make_candidate("pdf", source);
    let exact = analyze_import(
        candidate,
        Some(&hash),
        &[existing(
            "pdf",
            "sha256:incoming",
            CandidateOwnership::CentralLibrary,
        )],
        &shared_copy,
    );
    assert_eq!(
        exact.governance_groups[0].classification,
        ImportGovernanceClassification::ContentIdenticalCopy
    );
}

#[test]
fn governance_members_carry_structured_impact_facts() {
    let source = SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::local_path("C:/incoming/pdf"),
    );
    let (candidate, hash) = make_candidate("pdf", source);
    let facts = ImportSourceFacts {
        directory_role: Some(DirectoryRole::SharedDirectory),
        source_is_link: false,
        observed_copy_verified: false,
        affected_agents: vec!["trae.code".to_owned(), "agent-skills".to_owned()],
    };
    let analysis = analyze_import(candidate, Some(&hash), &[], &facts);
    let group = &analysis.governance_groups[0];
    assert_eq!(group.members.len(), 1);
    let member = &group.members[0];
    assert_eq!(member.display_name, "pdf");
    assert_eq!(member.source_path, "C:/incoming/pdf");
    assert_eq!(member.affected_agents, ["trae.code", "agent-skills"]);
}
