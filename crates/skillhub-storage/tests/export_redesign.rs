//! AR-025：标准导出重设计。
//!
//! 用户验收要求：
//! 1) 目录名用 Skill 原始（显示）名称，不再用内部 ID；
//! 2) 导出内容是每个 Skill 文件夹的全部内容，不只是 SKILL.md；
//! 3) 无论哪种格式，整体导出始终是一个外层压缩包——
//!    Folder 模式解压后是多个完整 Skill 文件夹；
//!    Zip 模式解压后是多个独立的 Skill ZIP（根目录即 SKILL.md，
//!    供 Trae/Cline 等 IDE 型 Agent 直接导入）。

use skillhub_core::backup::SensitiveContentDecision;
use skillhub_core::export::{
    ExportFile, ExportFormat, ExportInput, ExportSelection, VersionSelection,
};
use skillhub_core::{SkillId, VersionId};
use skillhub_storage::export::ExportService;
use tempfile::tempdir;

fn version() -> VersionId {
    VersionId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap()
}

fn sample_files() -> Vec<ExportFile> {
    vec![
        ExportFile {
            path: "SKILL.md".into(),
            data_base64: "IyBQREYgSGVscGVy".into(), // "# PDF Helper"
        },
        ExportFile {
            path: "scripts/run.py".into(),
            data_base64: "cHJpbnQoJ2hpJyk=".into(), // print('hi')
        },
    ]
}

#[test]
fn folder_mode_produces_outer_zip_with_full_skill_folders_named_by_display_name() {
    let root = tempdir().unwrap();
    let skill_id = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![skill_id]),
        versions: VersionSelection::Current,
        skills: vec![skillhub_core::ExportSkill {
            skill_id,
            version_id: version(),
            content: "# PDF Helper".into(),
            display_name: "PDF Helper".into(),
            files: sample_files(),
        }],
        format: ExportFormat::Folder,
        output_dir: None,
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let export = service.create(&input, &plan, &[]).unwrap();

    // 外层永远是压缩包。
    assert_eq!(
        export.root.extension().and_then(|name| name.to_str()),
        Some("zip"),
        "整体导出必须是一个外层压缩包"
    );
    let file = std::fs::File::open(&export.root).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    assert!(
        archive.by_name("skills/pdf-helper/SKILL.md").is_ok(),
        "解压后应是完整 Skill 文件夹且用显示名命名"
    );
    assert!(
        archive.by_name("skills/pdf-helper/scripts/run.py").is_ok(),
        "SKILL.md 之外的文件也必须包含在导出里"
    );
    assert!(
        archive
            .by_name(&format!("skills/{skill_id}/SKILL.md"))
            .is_err(),
        "内部 ID 不得作为导出目录名"
    );
    let readme = archive.by_name("skills/pdf-helper/SKILL.md").unwrap();
    assert_eq!(std::io::read_to_string(readme).unwrap(), "# PDF Helper");
}

#[test]
fn zip_mode_wraps_each_skill_as_an_individual_importable_archive() {
    let root = tempdir().unwrap();
    let skill_id = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![skill_id]),
        versions: VersionSelection::Current,
        skills: vec![skillhub_core::ExportSkill {
            skill_id,
            version_id: version(),
            content: "# Zipped".into(),
            display_name: "Zipped Skill".into(),
            files: sample_files(),
        }],
        format: ExportFormat::Zip,
        output_dir: None,
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let export = service.create(&input, &plan, &[]).unwrap();

    let file = std::fs::File::open(&export.root).unwrap();
    let mut outer = zip::ZipArchive::new(file).unwrap();
    let inner_path = "skills/zipped-skill.zip";
    let mut inner = outer.by_name(inner_path).unwrap();
    let mut inner_bytes = Vec::new();
    std::io::Read::read_to_end(&mut inner, &mut inner_bytes).unwrap();
    let mut inner_archive = zip::ZipArchive::new(std::io::Cursor::new(inner_bytes)).unwrap();
    assert!(
        inner_archive.by_name("SKILL.md").is_ok(),
        "独立 Skill ZIP 的根目录应可直接被 IDE Agent 导入"
    );
    assert!(inner_archive.by_name("scripts/run.py").is_ok());
}

#[test]
fn legacy_skill_without_files_still_exports_skill_markdown() {
    let root = tempdir().unwrap();
    let skill_id = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![skill_id]),
        versions: VersionSelection::Current,
        skills: vec![skillhub_core::ExportSkill {
            skill_id,
            version_id: version(),
            content: "# Legacy".into(),
            display_name: "Legacy".into(),
            files: Vec::new(),
        }],
        format: ExportFormat::Folder,
        output_dir: None,
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let export = service.create(&input, &plan, &[]).unwrap();
    let file = std::fs::File::open(&export.root).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let readme = archive.by_name("skills/legacy/SKILL.md").unwrap();
    assert_eq!(std::io::read_to_string(readme).unwrap(), "# Legacy");
}

#[test]
fn display_name_collisions_get_deterministic_distinct_folders() {
    let root = tempdir().unwrap();
    let first = SkillId::new();
    let second = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![first, second]),
        versions: VersionSelection::Current,
        skills: vec![
            skillhub_core::ExportSkill {
                skill_id: first,
                version_id: version(),
                content: "# One".into(),
                display_name: "Same Name".into(),
                files: Vec::new(),
            },
            skillhub_core::ExportSkill {
                skill_id: second,
                version_id: version(),
                content: "# Two".into(),
                display_name: "Same Name".into(),
                files: Vec::new(),
            },
        ],
        format: ExportFormat::Folder,
        output_dir: None,
    };
    let service = ExportService::new(root.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let export = service.create(&input, &plan, &[]).unwrap();
    let file = std::fs::File::open(&export.root).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    assert!(archive.by_name("skills/same-name/SKILL.md").is_ok());
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|entry| entry.name().to_owned())
        })
        .filter(|name| name.starts_with("skills/") && name.ends_with("/SKILL.md"))
        .collect();
    assert_eq!(
        names.len(),
        2,
        "同名 Skill 都必须导出且目录互不相同: {names:?}"
    );
    assert_ne!(names[0], names[1]);
}

#[test]
fn excluded_skill_is_omitted_from_the_outer_package() {
    let root = tempdir().unwrap();
    let skill_id = SkillId::new();
    let input = ExportInput {
        selection: ExportSelection::Skills(vec![skill_id]),
        versions: VersionSelection::Current,
        skills: vec![skillhub_core::ExportSkill {
            skill_id,
            version_id: version(),
            content: "OPENAI_API_KEY=sk-live-secret".into(),
            display_name: "Sensitive".into(),
            files: sample_files(),
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
