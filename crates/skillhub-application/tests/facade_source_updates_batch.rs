//! N8：批量来源更新检查（check_source_updates 查询）。
//!
//! 单 Skill 检测（N7b）已支持本地与远端 git 来源。本文件验证批量查询：
//! 逐 Skill 复用单条检测并按项返回状态；任何单条失败（未知 Skill、
//! 网络关闭、来源缺失）诚实降级为 SourceUnavailable，绝不掩盖批次中
//! 其余 Skill 的结果，也不让整批失败。

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::Arc;

use skillhub_adapters::source::RepoDiscoveryProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::CheckSourceUpdates;
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ImportCandidate,
    ImportDecision, PrepareImport, SourceDescriptor, SourceKind, SourceLocator, SourceState,
    UpstreamOrigin,
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

async fn import_skill_with_upstream(
    facade: &LocalApplicationFacade,
    name: &str,
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
        name,
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

async fn batch_check(
    facade: &LocalApplicationFacade,
    skill_ids: Vec<skillhub_core::SkillId>,
) -> Vec<(skillhub_core::SkillId, SourceState)> {
    let result = facade
        .query(AppQuery::CheckSourceUpdates(CheckSourceUpdates {
            skill_ids,
        }))
        .await
        .expect("batch source update check");
    let AppQueryResult::SourceUpdateChecks(outcomes) = result else {
        panic!("expected source_update_checks result");
    };
    outcomes
        .into_iter()
        .map(|outcome| (outcome.skill_id, outcome.state))
        .collect()
}

#[tokio::test]
async fn batch_check_reports_states_per_skill() {
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

    let up_to_date = import_skill_with_upstream(&facade, "notes-up-to-date", "# Portable\n").await;
    let changed = import_skill_with_upstream(&facade, "notes-changed", "# Local edits\n").await;

    let outcomes = batch_check(&facade, vec![up_to_date.clone(), changed.clone()]).await;
    assert_eq!(outcomes.len(), 2, "每个 Skill 一条结果");
    let states: std::collections::HashMap<_, _> = outcomes.into_iter().collect();
    assert_eq!(
        states.get(&up_to_date),
        Some(&SourceState::UpToDate),
        "远端内容一致的 Skill 应报告 UpToDate"
    );
    assert_eq!(
        states.get(&changed),
        Some(&SourceState::UpdateAvailable),
        "远端内容变化的 Skill 应报告 UpdateAvailable"
    );
}

#[tokio::test]
async fn batch_check_degrades_unknown_skill_without_failing_batch() {
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

    let known = import_skill_with_upstream(&facade, "notes-known", "# Portable\n").await;
    let unknown = skillhub_core::SkillId::new();

    let outcomes = batch_check(&facade, vec![known.clone(), unknown.clone()]).await;
    assert_eq!(outcomes.len(), 2, "未知 Skill 也应有一条诚实结果");
    let states: std::collections::HashMap<_, _> = outcomes.into_iter().collect();
    assert_eq!(
        states.get(&known),
        Some(&SourceState::UpToDate),
        "未知 Skill 不应掩盖批次中其余结果"
    );
    assert_eq!(
        states.get(&unknown),
        Some(&SourceState::SourceUnavailable),
        "未知 Skill 应诚实降级为 SourceUnavailable"
    );
}

#[tokio::test]
async fn batch_check_empty_selection_returns_empty_report() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    assert!(batch_check(&facade, vec![]).await.is_empty());
}
