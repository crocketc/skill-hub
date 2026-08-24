use std::path::{Path, PathBuf};

use skillhub_adapters::import::{
    KnownAgentDirectory, KnownProjectDirectory, OwnershipClassifier, ReadOnlySkillDirectory,
    SkillDetectionConfig, SkillDetector,
};
use skillhub_core::import::{CandidateOwnership, ImportAction};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::ProjectId;
use tempfile::tempdir;

fn write_skill(root: &Path, relative: &str, marker: &str) {
    let directory = root.join(relative);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join(marker), format!("name: {relative}\n")).unwrap();
}

fn local_source(root: &Path) -> SourceDescriptor {
    SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::LocalPath(root.to_path_buf()),
    )
}

fn git_source() -> SourceDescriptor {
    SourceDescriptor::new(
        SourceKind::Git,
        SourceLocator::GitUrl("https://github.com/example/skills".to_owned()),
    )
}

fn normalize(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

#[test]
fn repository_with_two_markers_yields_two_selectable_candidates() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("repo");
    write_skill(&root, "skills/a", "SKILL.md");
    write_skill(&root, "skills/b", "SKILL.md");

    let candidates = SkillDetector::default()
        .detect(&root, git_source())
        .unwrap();

    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.relative_root.as_str())
            .collect::<Vec<_>>(),
        ["skills/a", "skills/b"]
    );
    assert!(candidates
        .iter()
        .all(|candidate| candidate.source.kind == SourceKind::Git));
}

#[test]
fn default_detection_stops_descending_inside_a_detected_skill() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("repo");
    write_skill(&root, "outer", "SKILL.md");
    write_skill(&root, "outer/nested", "SKILL.md");

    let candidates = SkillDetector::default()
        .detect(&root, local_source(&root))
        .unwrap();

    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.relative_root.as_str())
            .collect::<Vec<_>>(),
        ["outer"]
    );
}

#[test]
fn explicit_nested_candidate_detection_keeps_inner_skill_roots() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("repo");
    write_skill(&root, "outer", "SKILL.md");
    write_skill(&root, "outer/nested", "SKILL.md");
    let detector = SkillDetector::with_config(SkillDetectionConfig {
        allow_nested_candidates: true,
        ..SkillDetectionConfig::default()
    });

    let candidates = detector.detect(&root, local_source(&root)).unwrap();

    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.relative_root.as_str())
            .collect::<Vec<_>>(),
        ["outer", "outer/nested"]
    );
}

#[test]
fn detector_uses_the_selected_marker_set_case_aware() {
    let workspace = tempdir().unwrap();
    let root = workspace.path().join("repo");
    write_skill(&root, "codex", "SKILL.md");
    write_skill(&root, "custom", "AGENT_SKILL.md");
    write_skill(&root, "wrong-case", "skill.md");
    let detector = SkillDetector::with_config(SkillDetectionConfig {
        markers: vec!["SKILL.md".into(), "AGENT_SKILL.md".into()],
        ..SkillDetectionConfig::default()
    });

    let candidates = detector.detect(&root, local_source(&root)).unwrap();

    assert_eq!(
        candidates
            .iter()
            .map(|candidate| (candidate.relative_root.as_str(), candidate.marker.as_str()))
            .collect::<Vec<_>>(),
        [("codex", "SKILL.md"), ("custom", "AGENT_SKILL.md")]
    );
}

#[test]
fn candidate_in_known_agent_directory_is_not_defaulted_to_copy() {
    let workspace = tempdir().unwrap();
    let agent_root = workspace.path().join("agent/skills");
    write_skill(&agent_root, "agent-owned-skill", "SKILL.md");
    let candidate = SkillDetector::default()
        .detect(&agent_root, local_source(&agent_root))
        .unwrap()
        .remove(0);
    let classifier = OwnershipClassifier::new().with_agent_directories([KnownAgentDirectory {
        root: agent_root.clone(),
        profile_id: "codex".into(),
        client_id: "codex-cli".into(),
        scope: "global".into(),
        read_only: false,
    }]);

    let candidate = classifier.classify(candidate).unwrap();

    assert_eq!(candidate.ownership, CandidateOwnership::KnownAgentTarget);
    assert_eq!(
        candidate.default_action,
        ImportAction::EstablishManagedRelation
    );
    assert_eq!(
        candidate.ownership_detail.as_deref(),
        Some("codex:codex-cli:global")
    );
}

#[test]
fn candidate_in_registered_project_prefers_managed_relation() {
    let workspace = tempdir().unwrap();
    let project_root = workspace.path().join("project");
    write_skill(&project_root, ".claude/skills/project-skill", "SKILL.md");
    let candidate = SkillDetector::default()
        .detect(&project_root, local_source(&project_root))
        .unwrap()
        .remove(0);
    let project_id = ProjectId::new();
    let classifier = OwnershipClassifier::new().with_project_directories([KnownProjectDirectory {
        root: project_root.clone(),
        project_id,
    }]);

    let candidate = classifier.classify(candidate).unwrap();

    assert_eq!(candidate.ownership, CandidateOwnership::RegisteredProject);
    assert_eq!(
        candidate.default_action,
        ImportAction::EstablishManagedRelation
    );
    assert_eq!(candidate.ownership_detail, Some(project_id.to_string()));
}

#[test]
fn central_library_skill_is_classified_as_existing_managed_content() {
    let workspace = tempdir().unwrap();
    let library_root = workspace.path().join("SkillHub");
    let skills_dir = library_root.join("skills");
    write_skill(&skills_dir, "pdf--abc123", "SKILL.md");
    let candidate = SkillDetector::default()
        .detect(&skills_dir, local_source(&skills_dir))
        .unwrap()
        .remove(0);
    let classifier = OwnershipClassifier::new().with_central_library_root(library_root);

    let candidate = classifier.classify(candidate).unwrap();

    assert_eq!(candidate.ownership, CandidateOwnership::CentralLibrary);
    assert_eq!(
        candidate.default_action,
        ImportAction::UseExistingManagedSkill
    );
}

#[test]
fn readonly_builtin_or_plugin_can_only_be_copied_as_independent_content() {
    let workspace = tempdir().unwrap();
    let plugin_root = workspace.path().join("agent/plugins/builtin");
    write_skill(&plugin_root, "reviewer", "SKILL.md");
    let candidate = SkillDetector::default()
        .detect(&plugin_root, local_source(&plugin_root))
        .unwrap()
        .remove(0);
    let classifier =
        OwnershipClassifier::new().with_read_only_directories([ReadOnlySkillDirectory {
            root: plugin_root,
            owner: "agent.plugin".into(),
        }]);

    let candidate = classifier.classify(candidate).unwrap();

    assert_eq!(
        candidate.ownership,
        CandidateOwnership::ReadOnlyBuiltinOrPlugin
    );
    assert_eq!(
        candidate.default_action,
        ImportAction::CopyAsIndependentManagedSkill
    );
    assert_eq!(candidate.ownership_detail.as_deref(), Some("agent.plugin"));
}

#[test]
fn arbitrary_local_directory_defaults_to_copy_without_taking_ownership() {
    let workspace = tempdir().unwrap();
    let source_root = workspace.path().join("Downloads/source");
    write_skill(&source_root, "notes", "SKILL.md");
    let candidate = SkillDetector::default()
        .detect(&source_root, local_source(&source_root))
        .unwrap()
        .remove(0);

    let candidate = OwnershipClassifier::new().classify(candidate).unwrap();

    assert_eq!(
        candidate.ownership,
        CandidateOwnership::ArbitraryLocalDirectory
    );
    assert_eq!(candidate.default_action, ImportAction::CopyIntoLibrary);
    assert!(candidate.ownership_detail.is_none());
}

#[test]
fn downloaded_source_is_not_treated_as_a_local_owned_directory() {
    let workspace = tempdir().unwrap();
    let acquired_root = workspace.path().join("acquired");
    write_skill(&acquired_root, "pdf", "SKILL.md");
    let candidate = SkillDetector::default()
        .detect(&acquired_root, git_source())
        .unwrap()
        .remove(0);

    let candidate = OwnershipClassifier::new().classify(candidate).unwrap();

    assert_eq!(candidate.ownership, CandidateOwnership::DownloadedSource);
    assert_eq!(candidate.default_action, ImportAction::CopyIntoLibrary);
    assert_eq!(
        candidate.source.locator,
        SourceLocator::GitUrl("https://github.com/example/skills".to_owned())
    );
}

#[test]
fn classifier_uses_deepest_registered_root_when_roots_overlap() {
    let workspace = tempdir().unwrap();
    let agent_root = workspace.path().join("agent/skills");
    let plugin_root = agent_root.join("plugins");
    write_skill(&plugin_root, "builtin", "SKILL.md");
    let candidate = SkillDetector::default()
        .detect(&agent_root, local_source(&agent_root))
        .unwrap()
        .remove(0);
    let classifier = OwnershipClassifier::new()
        .with_agent_directories([KnownAgentDirectory {
            root: agent_root,
            profile_id: "codex".into(),
            client_id: "codex-cli".into(),
            scope: "global".into(),
            read_only: false,
        }])
        .with_read_only_directories([ReadOnlySkillDirectory {
            root: plugin_root,
            owner: "plugin".into(),
        }]);

    let candidate = classifier.classify(candidate).unwrap();

    assert_eq!(
        candidate.ownership,
        CandidateOwnership::ReadOnlyBuiltinOrPlugin
    );
    assert!(
        normalize(PathBuf::from(candidate.absolute_root)).ends_with("agent/skills/plugins/builtin")
    );
}
