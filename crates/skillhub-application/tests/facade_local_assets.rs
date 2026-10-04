//! K9 验收回归：本地资源解析与打开命令。
//!
//! 通过公开 Facade 驱动，全部使用临时目录，绝不触碰真实用户文件。覆盖：
//! - `resolve_local_asset`：同版本资产解析为 data URL、null 取当前版本、
//!   跨版本拒绝、树外路径拒绝、不存在的资产报错；
//! - 三个打开命令：skill 不存在拒绝、path 越出物化树拒绝、合法路径调用
//!   注入的系统打开适配器（测试用假适配器断言调用参数，不真开）；
//! - `GetSkill.root_path`：暴露集中库中真实物化的可见树根路径。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use skillhub_application::{LocalApplicationFacade, LocalPathOpener};
use skillhub_core::api::{
    CreateSkill, GetSkill, ListSkills, ListVersions, ResolveLocalAsset, SaveSkillContent,
};
use skillhub_core::catalog::CatalogRepository;
use skillhub_core::{
    AppCommand, AppError, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode, SkillId,
    VersionId,
};
use skillhub_storage::{CentralLibrary, Database};

/// PNG 魔数 + 少量占位字节：内容无关紧要，字节相等断言才是关键。
const PNG_BYTES: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
];
const PNG_V2_BYTES: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFF, 0xFF, 0xFF,
];

struct LibraryFixture {
    _workspace: tempfile::TempDir,
    _library_root: tempfile::TempDir,
    facade: LocalApplicationFacade,
    skill_id: SkillId,
    version_id: VersionId,
    visible_root: PathBuf,
}

async fn library_fixture() -> LibraryFixture {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let database = Database::open(workspace.path().join("db.sqlite")).expect("database");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    let source = workspace.path().join("source");
    std::fs::create_dir_all(source.join("assets")).expect("source assets dir");
    std::fs::write(
        source.join("SKILL.md"),
        "# Notes\n\nbody referencing ![logo](assets/logo.png)\n",
    )
    .expect("write SKILL.md");
    std::fs::write(source.join("assets/logo.png"), PNG_BYTES).expect("write logo");
    std::fs::write(source.join("assets/notes.txt"), "asset text").expect("write notes");
    facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");
    let skill_id = find_skill_by_name(&facade, "Notes").await;
    let version_id = current_version(&facade, skill_id).await;
    let visible_root = visible_skill_dir(library_root.path(), skill_id);
    LibraryFixture {
        _workspace: workspace,
        _library_root: library_root,
        facade,
        skill_id,
        version_id,
        visible_root,
    }
}

async fn find_skill_by_name(facade: &LocalApplicationFacade, name: &str) -> SkillId {
    let result = facade
        .query(AppQuery::ListSkills(ListSkills {
            text: name.into(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list skills");
    let AppQueryResult::SkillPage(page) = result else {
        panic!("expected skill list page");
    };
    page.items
        .into_iter()
        .find(|item| item.display_name == name)
        .expect("created skill in library")
        .skill_id
}

async fn current_version(facade: &LocalApplicationFacade, skill_id: SkillId) -> VersionId {
    let result = facade
        .query(AppQuery::ListVersions(ListVersions { skill_id }))
        .await
        .expect("list versions");
    let AppQueryResult::Versions(versions) = result else {
        panic!("expected versions");
    };
    versions
        .into_iter()
        .find(|version| version.current)
        .expect("current version")
        .version_id
}

/// 可见树目录名形如 `<readable>--<skill_id>`；按后缀定位，不复制改写规则。
fn visible_skill_dir(library_root: &Path, skill_id: SkillId) -> PathBuf {
    let suffix = format!("--{skill_id}");
    std::fs::read_dir(library_root.join("skills"))
        .expect("skills directory")
        .into_iter()
        .find_map(|entry| {
            let path = entry.expect("skills entry").path();
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .filter(|name| name.ends_with(&suffix))
                .map(|_| path)
        })
        .expect("visible skill directory")
}

async fn resolve_asset(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
    markdown_path: &str,
    asset_path: &str,
    version_id: Option<VersionId>,
) -> Result<skillhub_core::api::LocalAssetResolution, AppError> {
    let result = facade
        .query(AppQuery::ResolveLocalAsset(ResolveLocalAsset {
            skill_id,
            markdown_path: markdown_path.into(),
            asset_path: asset_path.into(),
            version_id,
        }))
        .await;
    match result {
        Ok(AppQueryResult::LocalAsset(resolution)) => Ok(resolution),
        Ok(other) => panic!("unexpected result: {other:?}"),
        Err(error) => Err(error),
    }
}

async fn get_skill(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> skillhub_core::api::SkillResult {
    let result = facade
        .query(AppQuery::GetSkill(GetSkill { skill_id }))
        .await
        .expect("get skill");
    let AppQueryResult::Skill(skill) = result else {
        panic!("expected skill result");
    };
    skill
}

#[tokio::test]
async fn resolve_local_asset_returns_a_data_url_for_a_same_version_asset() {
    let fixture = library_fixture().await;
    let version_id = fixture.version_id;
    let resolution = resolve_asset(
        &fixture.facade,
        fixture.skill_id,
        "SKILL.md",
        "assets/logo.png",
        Some(version_id.clone()),
    )
    .await
    .expect("same-version asset resolves");
    assert_eq!(resolution.skill_id, fixture.skill_id);
    assert_eq!(resolution.version_id, version_id);
    assert_eq!(resolution.markdown_path, "SKILL.md");
    assert_eq!(resolution.asset_path, "assets/logo.png");
    assert_eq!(resolution.media_type, "image/png");
    let expected = format!("data:image/png;base64,{}", STANDARD.encode(PNG_BYTES));
    assert_eq!(resolution.data_url, expected);
}

#[tokio::test]
async fn resolve_local_asset_uses_the_current_version_when_version_id_is_null() {
    let fixture = library_fixture().await;
    let resolution = resolve_asset(
        &fixture.facade,
        fixture.skill_id,
        "SKILL.md",
        "assets/logo.png",
        None,
    )
    .await
    .expect("current-version asset resolves");
    assert_eq!(resolution.version_id, fixture.version_id);
    let expected = format!("data:image/png;base64,{}", STANDARD.encode(PNG_BYTES));
    assert_eq!(resolution.data_url, expected);
}

#[tokio::test]
async fn resolve_local_asset_never_mixes_versions() {
    let fixture = library_fixture().await;
    let v2_source = fixture._workspace.path().join("source-v2");
    std::fs::create_dir_all(v2_source.join("assets")).expect("v2 assets dir");
    std::fs::write(v2_source.join("SKILL.md"), "# Notes rewritten\n").expect("write v2 body");
    std::fs::write(v2_source.join("assets/logo-v2.png"), PNG_V2_BYTES)
        .expect("write v2-only asset");
    fixture
        .facade
        .execute(AppCommand::SaveSkillContent(SaveSkillContent {
            skill_id: fixture.skill_id,
            source_path: v2_source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("save v2 content");

    // 请求 v2（保存后的当前版本）但资产只存在于 v1：跨版本混读必须
    // 拒绝，而不是用其他版本"尽力解析"。
    let v2_version_id = current_version(&fixture.facade, fixture.skill_id).await;
    assert_ne!(v2_version_id, fixture.version_id);
    let error = resolve_asset(
        &fixture.facade,
        fixture.skill_id,
        "SKILL.md",
        "assets/logo.png",
        Some(v2_version_id),
    )
    .await
    .expect_err("asset missing in the requested version must be refused");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);

    // 当前版本已切换到 v2（v2 无该资产），null 解析跟随当前版本，应报
    // 资产缺失而不是悄悄回退到 v1。
    let error = resolve_asset(
        &fixture.facade,
        fixture.skill_id,
        "SKILL.md",
        "assets/logo.png",
        None,
    )
    .await
    .expect_err("null version_id must follow the current version");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);

    // 显式历史读取仍然完整可用：Markdown 与资产都来自同一个 v1 清单。
    let historical = resolve_asset(
        &fixture.facade,
        fixture.skill_id,
        "SKILL.md",
        "assets/logo.png",
        Some(fixture.version_id.clone()),
    )
    .await
    .expect("explicit same-version historical read keeps working");
    assert_eq!(historical.version_id, fixture.version_id);
    let expected = format!("data:image/png;base64,{}", STANDARD.encode(PNG_BYTES));
    assert_eq!(historical.data_url, expected);
}

#[tokio::test]
async fn resolve_local_asset_rejects_paths_outside_the_version_tree() {
    let fixture = library_fixture().await;
    let outside = fixture._workspace.path().join("outside.png");
    std::fs::write(&outside, PNG_V2_BYTES).expect("write outside file");

    for asset_path in [
        "../outside.png".to_owned(),
        outside.to_string_lossy().into_owned(),
        "/etc/passwd".to_owned(),
        "assets/../../outside.png".to_owned(),
    ] {
        let error = resolve_asset(
            &fixture.facade,
            fixture.skill_id,
            "SKILL.md",
            &asset_path,
            None,
        )
        .await
        .expect_err("asset outside the version tree must be refused");
        assert_eq!(error.code, ErrorCode::InvalidInput, "asset {asset_path:?}");
    }

    for markdown_path in ["../SKILL.md", "assets/logo.png"] {
        let error = resolve_asset(
            &fixture.facade,
            fixture.skill_id,
            markdown_path,
            "assets/logo.png",
            None,
        )
        .await
        .expect_err("markdown path outside the version tree must be refused");
        assert_eq!(
            error.code,
            ErrorCode::InvalidInput,
            "markdown {markdown_path:?}"
        );
    }
}

#[tokio::test]
async fn resolve_local_asset_reports_missing_assets() {
    let fixture = library_fixture().await;
    let error = resolve_asset(
        &fixture.facade,
        fixture.skill_id,
        "SKILL.md",
        "assets/missing.png",
        None,
    )
    .await
    .expect_err("missing asset must be reported");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);

    let error = resolve_asset(
        &fixture.facade,
        SkillId::new(),
        "SKILL.md",
        "assets/logo.png",
        None,
    )
    .await
    .expect_err("unknown skill must be reported");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

#[derive(Default)]
struct RecordingOpener {
    calls: std::sync::Mutex<Vec<(&'static str, String)>>,
}

impl RecordingOpener {
    fn calls(&self) -> Vec<(&'static str, String)> {
        self.calls.lock().expect("opener calls lock").clone()
    }

    fn record(&self, method: &'static str, path: &str) {
        self.calls
            .lock()
            .expect("opener calls lock")
            .push((method, path.to_owned()));
    }
}

impl LocalPathOpener for RecordingOpener {
    fn open_default(&self, path: &str) -> skillhub_core::AppResult<()> {
        self.record("open_default", path);
        Ok(())
    }

    fn open_folder(&self, path: &str) -> skillhub_core::AppResult<()> {
        self.record("open_folder", path);
        Ok(())
    }

    fn choose_application(&self, path: &str) -> skillhub_core::AppResult<()> {
        self.record("choose_application", path);
        Ok(())
    }
}

#[tokio::test]
async fn open_commands_require_an_existing_skill() {
    let fixture = library_fixture().await;
    let opener = Arc::new(RecordingOpener::default());
    fixture.facade.set_local_path_opener(opener.clone());
    let inside = fixture.visible_root.join("SKILL.md");
    let path = inside.to_string_lossy().into_owned();

    let commands = [
        AppCommand::OpenDefaultApplication(skillhub_core::OpenDefaultApplication {
            skill_id: SkillId::new(),
            path: path.clone(),
        }),
        AppCommand::OpenSkillFolder(skillhub_core::OpenSkillFolder {
            skill_id: SkillId::new(),
            path: path.clone(),
        }),
        AppCommand::ChooseExternalApplication(skillhub_core::ChooseExternalApplication {
            skill_id: SkillId::new(),
            path,
        }),
    ];
    for command in commands {
        let error = fixture
            .facade
            .execute(command)
            .await
            .expect_err("unknown skill must be refused");
        assert_eq!(error.code, ErrorCode::ObjectNotFound);
    }
    assert!(
        opener.calls().is_empty(),
        "no opener call may happen for an unknown skill"
    );
}

#[tokio::test]
async fn open_commands_reject_paths_outside_the_visible_skill_tree() {
    let fixture = library_fixture().await;
    let opener = Arc::new(RecordingOpener::default());
    fixture.facade.set_local_path_opener(opener.clone());
    let library_root = fixture._library_root.path().to_path_buf();

    let outside_paths = [
        // 库根本身存在，但不属于这个 Skill 的物化树。
        library_root.to_string_lossy().into_owned(),
        // 可见树的父目录。
        library_root.join("skills").to_string_lossy().into_owned(),
        // 真实存在但不属于任何 Skill 的工作区文件。
        fixture
            ._workspace
            .path()
            .join("source/SKILL.md")
            .to_string_lossy()
            .into_owned(),
        // 树内但不存在的路径。
        fixture
            .visible_root
            .join("ghost.txt")
            .to_string_lossy()
            .into_owned(),
    ];
    for path in outside_paths {
        let error = fixture
            .facade
            .execute(AppCommand::OpenDefaultApplication(
                skillhub_core::OpenDefaultApplication {
                    skill_id: fixture.skill_id,
                    path: path.clone(),
                },
            ))
            .await
            .expect_err("path outside the visible tree must be refused");
        assert_eq!(error.code, ErrorCode::InvalidInput, "path {path:?}");
    }
    assert!(
        opener.calls().is_empty(),
        "no opener call may happen for a refused path"
    );
}

#[tokio::test]
async fn open_commands_invoke_the_injected_opener_with_the_validated_path() {
    let fixture = library_fixture().await;
    let opener = Arc::new(RecordingOpener::default());
    fixture.facade.set_local_path_opener(opener.clone());

    let markdown = fixture.visible_root.join("SKILL.md");
    let folder = fixture.visible_root.join("assets");
    let asset = folder.join("logo.png");

    fixture
        .facade
        .execute(AppCommand::OpenDefaultApplication(
            skillhub_core::OpenDefaultApplication {
                skill_id: fixture.skill_id,
                path: markdown.to_string_lossy().into_owned(),
            },
        ))
        .await
        .expect("open default application");
    fixture
        .facade
        .execute(AppCommand::OpenSkillFolder(
            skillhub_core::OpenSkillFolder {
                skill_id: fixture.skill_id,
                path: folder.to_string_lossy().into_owned(),
            },
        ))
        .await
        .expect("open skill folder");
    fixture
        .facade
        .execute(AppCommand::ChooseExternalApplication(
            skillhub_core::ChooseExternalApplication {
                skill_id: fixture.skill_id,
                path: asset.to_string_lossy().into_owned(),
            },
        ))
        .await
        .expect("choose external application");

    assert_eq!(
        opener.calls(),
        vec![
            ("open_default", markdown.to_string_lossy().into_owned()),
            ("open_folder", folder.to_string_lossy().into_owned()),
            ("choose_application", asset.to_string_lossy().into_owned()),
        ]
    );
}

#[tokio::test]
async fn get_skill_reports_the_real_materialized_root_path() {
    let fixture = library_fixture().await;
    let skill = get_skill(&fixture.facade, fixture.skill_id).await;
    let root_path = skill
        .root_path
        .expect("materialized skill reports a root path");
    assert_eq!(Path::new(&root_path), fixture.visible_root.as_path());
    assert!(
        Path::new(&root_path).is_dir(),
        "root path must be the real visible directory"
    );
}

#[tokio::test]
async fn get_skill_reports_no_root_path_without_a_materialized_tree() {
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = tempfile::tempdir().expect("library root");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let database = Database::open(workspace.path().join("db.sqlite")).expect("database");
    let skill = skillhub_core::catalog::Skill::new(SkillId::new(), "Catalog only");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());

    let view = get_skill(&facade, skill.id()).await;
    assert!(
        view.root_path.is_none(),
        "a skill without a materialized tree must not invent a root path"
    );
}
