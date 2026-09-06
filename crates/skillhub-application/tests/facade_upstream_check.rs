//! N7b：远端 git 来源的更新检测（哈希对比）。
//!
//! 前置（N7a）：仓库导入已把 UpstreamOrigin(url/branch/directory) 落库为长期
//! git 来源。本文件验证 check_source_update 对这类来源的真实远端检查：
//! 拉取仓库归档 → 定位 directory → hash_tree 对比 → UpToDate/UpdateAvailable；
//! 缺坐标的 git 来源诚实降级为 SourceUnavailable，不伪造结果。

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::Arc;

use skillhub_adapters::source::RepoDiscoveryProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    AppCommand, AppCommandResult, ApplicationFacade, CheckSourceUpdate, ImportCandidate,
    ImportDecision, PrepareImport, RelinkSource, SourceDescriptor, SourceKind, SourceLocator,
    SourceState, UpstreamOrigin,
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

fn origin() -> UpstreamOrigin {
    UpstreamOrigin {
        url: "https://github.com/anthropics/skills".into(),
        branch: "main".into(),
        directory: "pdf".into(),
    }
}

/// 单路由归档 fixture 服务器：路径前缀命中返回 zip 字节，未命中 404。
/// 请求处理在后台线程循环，直到 listener 被 drop。
fn archive_server(route: &'static str, body: Vec<u8>) -> String {
    archive_server_with_release_tag(route, body, None)
}

/// 可选提供 release tag：设置后 /releases/latest 会 302 到
/// /releases/tag/<tag>，供 AR-021 来源版本抓取使用。
fn archive_server_with_release_tag(
    route: &'static str,
    body: Vec<u8>,
    release_tag: Option<&'static str>,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address");
    let body = Arc::new(body);
    let release_tag = release_tag.map(str::to_owned);
    std::thread::spawn(move || {
        let address = address;

        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let body = Arc::clone(&body);
            let release_tag = release_tag.clone();
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                if let (Some(tag), true) =
                    (release_tag.as_deref(), path.ends_with("/releases/latest"))
                {
                    let response = format!(
                        "HTTP/1.1 302 Found
Location: http://{address}/anthropics/skills/releases/tag/{tag}
Content-Length: 0
Connection: close

"
                    );
                    let _ = stream.write_all(response.as_bytes());
                    return;
                }
                let (status, payload) =
                    if path.starts_with(route) || path.contains("/releases/tag/") {
                        (200, body.as_slice())
                    } else {
                        (404, b"not found".as_slice())
                    };
                let response = format!(
                    "HTTP/1.1 {status} Test
Content-Type: application/zip
Content-Length: {}
Connection: close

",
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

async fn check_state(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> SourceState {
    let result = facade
        .execute(AppCommand::CheckSourceUpdate(CheckSourceUpdate {
            skill_id,
        }))
        .await
        .expect("check source update");
    let AppCommandResult::UpstreamCheckResult(check) = result else {
        panic!("expected upstream check result");
    };
    check.state
}

#[tokio::test]
async fn remote_git_source_matching_content_reports_up_to_date() {
    let base = archive_server(
        "/anthropics/skills/archive/refs/heads/main.zip",
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Portable\n".to_vec(),
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
    assert_eq!(
        check_state(&facade, skill_id).await,
        SourceState::UpToDate,
        "远端内容与导入版本一致时应报告 UpToDate"
    );
}

#[tokio::test]
async fn remote_git_source_changed_content_reports_update_available() {
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
    assert_eq!(
        check_state(&facade, skill_id).await,
        SourceState::UpdateAvailable,
        "远端内容与导入版本不一致时应报告 UpdateAvailable"
    );
}

#[tokio::test]
async fn git_source_without_recorded_coordinates_reports_unavailable() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;

    // 手动 Relink 到**另一个** git 来源（不同 URL → 全新 sources 行，无坐标）
    // → 无法在远端定位 Skill 目录，诚实降级。同一 URL 会命中已有行并保留坐标。
    facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Git,
                SourceLocator::git_url("https://github.com/other-owner/other-repo"),
            ),
        }))
        .await
        .expect("relink");

    assert_eq!(
        check_state(&facade, skill_id).await,
        SourceState::SourceUnavailable,
        "缺坐标的 git 来源不应伪造更新检查结果"
    );
}

#[tokio::test]
async fn remote_check_reports_the_upstream_release_tag_as_source_version() {
    // AR-021：检查结论附带来源版本（release/tag 名），作为版本模型的
    // “来源版本”一环；抓取与内容哈希对比互不影响。
    let base = archive_server_with_release_tag(
        "/anthropics/skills/archive/refs/heads/main.zip",
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream
"
            .to_vec(),
        )]),
        Some("v2.0.0"),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));

    let skill_id = import_skill_with_upstream(
        &facade,
        "# Portable
",
    )
    .await;
    let result = facade
        .execute(AppCommand::CheckSourceUpdate(CheckSourceUpdate {
            skill_id,
        }))
        .await
        .expect("check source update");
    let AppCommandResult::UpstreamCheckResult(check) = result else {
        panic!("expected upstream check result");
    };
    assert_eq!(check.state, SourceState::UpdateAvailable);
    assert_eq!(
        check.upstream_label.as_deref(),
        Some("v2.0.0"),
        "来源版本应来自 releases 重定向的真实 tag"
    );
}
