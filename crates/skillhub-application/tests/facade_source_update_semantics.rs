//! AR-020 / AR-017：来源更新的语义修正。
//!
//! AR-020：本地创建、仅有本地目录来源的 Skill 没有"上游"概念，不得被
//! 识别为可检查更新（此前会把用户自己的目录当上游报"发现更新"）。
//! 只有登记了 UpstreamOrigin 坐标的 git 来源才是可检查的上游。
//!
//! AR-017：git 来源（远端坐标）的"采用上游版本"必须真实下载远端内容并
//! 创建新版本，而不是被"remote source acquisition is not configured"拒绝。

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::Arc;

use skillhub_adapters::source::RepoDiscoveryProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    api::CreateSkill, AppCommand, AppCommandResult, ApplicationFacade, ApplySourceUpdate,
    CheckSourceUpdate, ErrorCode, ImportCandidate, ImportDecision, PrepareImport, SourceDescriptor,
    SourceKind, SourceLocator, SourceState, UpdateDecision, UpstreamOrigin,
};
use skillhub_storage::{CentralLibrary, Database};

fn facade_with_library(
    database_path: &std::path::Path,
    library_root: &std::path::Path,
) -> LocalApplicationFacade {
    let database = Database::open(database_path).expect("database");
    CentralLibrary::initialize(library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, library_root)
}

/// 单路由归档 fixture 服务器：路径前缀命中返回 zip 字节，未命中 404。
fn archive_server(route: &'static str, body: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address");
    let body = Arc::new(body);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let body = Arc::clone(&body);
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                let (status, payload) = if path.starts_with(route) {
                    (200, body.as_slice())
                } else {
                    (404, b"not found".as_slice())
                };
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(payload);
            });
        }
    });
    format!("http://{address}")
}

fn repo_zip(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        for (name, body) in entries {
            zip.start_file(name, SimpleFileOptions::default())
                .expect("zip entry");
            zip.write_all(&body).expect("zip body");
        }
        zip.finish().expect("zip finish");
    }
    cursor.into_inner()
}

fn origin() -> UpstreamOrigin {
    UpstreamOrigin {
        url: "https://github.com/anthropics/skills".into(),
        branch: "main".into(),
        directory: "pdf".into(),
    }
}

async fn import_skill_with_upstream(
    facade: &LocalApplicationFacade,
    content: &str,
) -> skillhub_core::SkillId {
    let source = tempfile::tempdir().expect("source");
    std::fs::create_dir_all(source.path()).expect("create source dir");
    std::fs::write(source.path().join("SKILL.md"), content).expect("write skill");
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    )
    .with_upstream(origin());

    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary.items[0].skill_id.expect("imported skill id")
}

async fn create_local_skill(
    facade: &LocalApplicationFacade,
    source: &std::path::Path,
) -> skillhub_core::SkillId {
    let _created = facade
        .execute(AppCommand::CreateSkill(CreateSkill {
            name: "Notes".into(),
            source_path: source.to_string_lossy().into_owned(),
        }))
        .await
        .expect("create skill");
    match facade
        .query(AppQuery::ListSkills(skillhub_core::api::ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("skills")
    {
        AppQueryResult::SkillPage(page) => page.items[0].skill_id,
        _ => panic!("expected skill page"),
    }
}

use skillhub_core::{AppQuery, AppQueryResult};

#[tokio::test]
async fn locally_created_skill_without_upstream_is_not_reported_as_updatable() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    let authoring = tempfile::tempdir().expect("authoring dir");
    std::fs::write(authoring.path().join("SKILL.md"), "# Mine\n").expect("write skill");

    let skill_id = create_local_skill(&facade, authoring.path()).await;

    let result = facade
        .execute(AppCommand::CheckSourceUpdate(CheckSourceUpdate {
            skill_id,
        }))
        .await
        .expect("check must succeed");
    let AppCommandResult::UpstreamCheckResult(check) = result else {
        panic!("expected upstream check result");
    };
    assert_eq!(
        check.state,
        SourceState::NoUpstream,
        "本地目录来源不是上游：不得报告 UpdateAvailable"
    );

    let error = facade
        .execute(AppCommand::ApplySourceUpdate(ApplySourceUpdate {
            skill_id,
            decision: UpdateDecision::TakeUpstream,
        }))
        .await
        .expect_err("apply without upstream must fail");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error.params.get("reason").and_then(|value| value.as_str()),
        Some("no_upstream_source"),
        "失败原因必须可读、可定位，而不是笼统冲突"
    );
}

#[tokio::test]
async fn take_upstream_on_git_source_downloads_remote_content_into_new_version() {
    let base = archive_server(
        "/anthropics/skills/archive/refs/heads/main.zip",
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream\n".to_vec(),
        )]),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));

    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let applied = facade
        .execute(AppCommand::ApplySourceUpdate(ApplySourceUpdate {
            skill_id,
            decision: UpdateDecision::TakeUpstream,
        }))
        .await
        .expect("take upstream must download and apply for a git source");
    let AppCommandResult::AppliedSourceUpdate(applied) = applied else {
        panic!("expected applied source update");
    };
    assert!(applied.new_version.is_some(), "采用上游必须创建新版本");

    // 经真实读查询断言当前版本内容来自下载的远端目录。
    let content = facade
        .query(AppQuery::ReadMarkdownFile(
            skillhub_core::api::ReadMarkdownFile {
                skill_id,
                path: "SKILL.md".into(),
            },
        ))
        .await
        .expect("read current markdown");
    let AppQueryResult::MarkdownFile(content) = content else {
        panic!("expected markdown content");
    };
    assert_eq!(
        content.markdown, "# Changed upstream\n",
        "新版本内容必须来自真实下载的远端目录"
    );
}
