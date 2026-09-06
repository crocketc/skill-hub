use skillhub_core::backup::SensitiveContentDecision;
use skillhub_core::deployment::{DeploymentMode, DeploymentRecord, DeploymentState};
use skillhub_core::export::{
    ExportFormat, ExportInput, ExportSelection, UninstallAction, UninstallService, VersionSelection,
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
            files: Vec::new(),
        }],
        format: ExportFormat::Folder,
        output_dir: None,
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let export = service.create(&input, &plan, &[]).unwrap();
    // AR-025：Folder 模式同样产出外层压缩包，解压后是完整 Skill 文件夹。
    let file = std::fs::File::open(&export.root).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    assert!(archive.by_name("skills/portable/SKILL.md").is_ok());
    assert!(archive.by_name("manifest.json").is_ok());
    assert!(archive.by_name("chatgpt-upload.zip").is_err());
    assert!(archive.by_name("claude-desktop-package").is_err());
}

#[test]
fn zip_export_packages_manifest_and_skills_into_a_single_archive() {
    let root = tempdir().unwrap();
    let skill_id = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![skill_id]),
        versions: VersionSelection::Current,
        skills: vec![skillhub_core::ExportSkill {
            skill_id,
            version_id: version(),
            content: "# Zipped".into(),
            display_name: "Zipped".into(),
            files: Vec::new(),
        }],
        format: ExportFormat::Zip,
        output_dir: None,
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let export = service.create(&input, &plan, &[]).unwrap();

    assert_eq!(
        export.root.extension().and_then(|name| name.to_str()),
        Some("zip")
    );
    assert!(!export.root.join("skills").exists());
    let file = std::fs::File::open(&export.root).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let manifest = archive.by_name("manifest.json").unwrap();
    let manifest: serde_json::Value = serde_json::from_reader(manifest).unwrap();
    assert_eq!(manifest["kind"], "skillhub_standard_export");
    // AR-025：Zip 模式外层包含独立的 Skill ZIP（显示名命名）。
    let mut inner = archive.by_name("skills/zipped.zip").unwrap();
    let mut inner_bytes = Vec::new();
    std::io::Read::read_to_end(&mut inner, &mut inner_bytes).unwrap();
    let mut inner_archive = zip::ZipArchive::new(std::io::Cursor::new(inner_bytes)).unwrap();
    let content = std::io::read_to_string(inner_archive.by_name("SKILL.md").unwrap()).unwrap();
    assert_eq!(content, "# Zipped");
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
            files: Vec::new(),
        }],
        format: ExportFormat::Folder,
        output_dir: None,
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
    let file = std::fs::File::open(&export.root).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|entry| entry.name().to_owned())
        })
        .collect();
    assert!(
        !names.iter().any(|name| name.starts_with("skills/")),
        "被排除的 Skill 不得出现在外层包中: {names:?}"
    );
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
