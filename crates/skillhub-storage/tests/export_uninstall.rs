use skillhub_core::backup::SensitiveContentDecision;
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::export::{
    ExportInput, ExportSelection, UninstallAction, UninstallService, VersionSelection,
};
use skillhub_core::{DeploymentId, SkillId, VersionId};
use skillhub_storage::export::ExportService;
use tempfile::tempdir;

fn version() -> VersionId {
    VersionId::parse(&format!("sha256:{}", "a".repeat(64))).unwrap()
}

#[test]
fn standard_export_is_neutral_and_does_not_create_agent_upload_packages() {
    let root = tempdir().unwrap();
    let skill_id = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![skill_id]),
        versions: VersionSelection::Current,
        skills: vec![skillhub_core::ExportSkill {
            skill_id,
            version_id: version(),
            content: "# Portable".into(),
            display_name: "Portable".into(),
        }],
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let export = service.create(&input, &plan, &[]).unwrap();
    assert!(export.root.join("skills").exists());
    assert!(export.root.join("manifest.json").exists());
    assert!(!export.root.join("chatgpt-upload.zip").exists());
    assert!(!export.root.join("claude-desktop-package").exists());
}

#[test]
fn sensitive_export_requires_a_choice_and_can_exclude_content() {
    let root = tempdir().unwrap();
    let skill_id = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![skill_id]),
        versions: VersionSelection::History(vec![version()]),
        skills: vec![skillhub_core::ExportSkill {
            skill_id,
            version_id: version(),
            content: "OPENAI_API_KEY=sk-live-secret".into(),
            display_name: "Sensitive".into(),
        }],
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    assert_eq!(plan.sensitive_items.len(), 1);
    assert!(service.create(&input, &plan, &[]).is_err());
    let export = service
        .create(
            &input,
            &plan,
            &[(skill_id, SensitiveContentDecision::ExcludeSkill)],
        )
        .unwrap();
    assert!(!export
        .root
        .join("skills")
        .join(skill_id.to_string())
        .join("SKILL.md")
        .exists());
}

#[test]
fn uninstall_preparation_lists_targets_and_preserves_central_library() {
    let deployment = DeploymentRecord {
        id: DeploymentId::new(),
        skill_id: SkillId::new(),
        version_id: version(),
        target_id: "target".into(),
        state: DeploymentState::Deployed,
        mode: DeploymentMode::ManagedCopy,
        managed: true,
        runtime_name: "portable".into(),
        expected_hash: "hash".into(),
        observed_hash: Some("hash".into()),
    };
    let impact = UninstallService::prepare(vec![deployment]);
    assert_eq!(impact.deployments.len(), 1);
    assert!(impact.actions.contains(&UninstallAction::UndeployAll));
    assert!(impact
        .actions
        .contains(&UninstallAction::LeaveTargetsIndependent));
    assert!(impact.preserves_central_library);
}
