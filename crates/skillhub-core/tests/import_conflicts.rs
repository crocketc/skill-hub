use skillhub_core::import::{
    analyze_import, CandidateOwnership, DuplicateKind, ExistingSkillRecord, ImportCandidate,
    ImportDecision, MatchBasis,
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

fn existing(
    runtime_name: &str,
    tree_hash: &str,
    ownership: CandidateOwnership,
) -> ExistingSkillRecord {
    ExistingSkillRecord {
        skill_id: SkillId::new(),
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
    );
    assert_eq!(exact.duplicate_kind, Some(DuplicateKind::ExactContent));
    assert!(exact.actions.contains(&ImportDecision::ReuseExisting));

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
    let analysis = analyze_import(candidate, Some(&hash), &[builtin]);
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
    let analysis = analyze_import(candidate, Some(&hash), &[search_match, source_match]);
    assert_eq!(analysis.matches[0].basis, MatchBasis::SourceLocator);
    assert_eq!(analysis.matches[1].basis, MatchBasis::FtsBm25);
}
