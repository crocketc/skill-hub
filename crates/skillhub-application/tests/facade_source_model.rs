//! P1-05 来源模型 + 整仓下载上游修复：
//!
//! 1. 来源角色三态：本地导入 = local_only；仓库导入（确认坐标）= verified_upstream；
//!    联网搜索只产生待确认候选（search_candidates 表），绝不写 sources/skill_sources。
//! 2. 整仓下载（branch/directory 为空）不再盖章无效上游坐标——诚实缺省。
//! 3. 新增 mutation 命令全部写持久操作日志（save/confirm/dismiss_search_candidate）。
//!
//! 所有断言都走公开 facade（ApplicationFacade）或只读重开数据库，不手工伪造记录。

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::Arc;

use skillhub_adapters::source::RepoDiscoveryProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    CheckSourceUpdates, ConfirmSearchCandidate, DismissSearchCandidate, ListSearchCandidates,
    SaveSearchCandidates,
};
use skillhub_core::source::{DiscoverableRepoSkill, SourceSearchHit, SourceSearchPage};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, DownloadRepoSkill,
    ErrorCode, ImportCandidate, ImportDecision, OperationPhase, PrepareImport,
    SearchCandidateStatus, SearchHitOrigin, SourceDescriptor, SourceKind, SourceLocator,
    SourceRole, UpstreamOrigin,
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

fn write_skill_source(root: &std::path::Path) {
    std::fs::create_dir_all(root).expect("create source dir");
    std::fs::write(root.join("SKILL.md"), "# Notes\n").expect("write skill");
}

fn origin() -> UpstreamOrigin {
    UpstreamOrigin {
        url: "https://github.com/anthropics/skills".into(),
        branch: "main".into(),
        directory: "pdf".into(),
    }
}

async fn commit_candidate(
    facade: &LocalApplicationFacade,
    candidate: ImportCandidate,
) -> skillhub_core::SkillId {
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

fn local_candidate(root: &std::path::Path) -> ImportCandidate {
    ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root)),
        root.to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
    )
}

fn search_hit(source_id: &str) -> SourceSearchHit {
    SourceSearchHit {
        source_id: source_id.into(),
        name: format!("{source_id} skill"),
        source: SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url(format!("https://github.com/{source_id}")),
        ),
        install_url: Some(format!("https://skills.sh/skills/{source_id}/install")),
        page_url: format!("https://skills.sh/skills/{source_id}"),
        installs: 42,
        is_duplicate: false,
        via: SearchHitOrigin::OriginalQuery,
    }
}

fn search_page(source_ids: &[&str]) -> SourceSearchPage {
    SourceSearchPage {
        items: source_ids.iter().map(|id| search_hit(id)).collect(),
        query: "pdf".into(),
        count: u32::try_from(source_ids.len()).unwrap_or(u32::MAX),
        search_type: Some("keyword".into()),
        duration_ms: Some(10),
        cache_max_age_seconds: Some(600),
        ai_assisted: false,
        expanded_query: None,
    }
}

fn get_skill_source(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> Option<skillhub_core::SourceRecord> {
    // get_skill_source 已从 IPC 契约退役；行为测试改走 facade 诊断入口观测。
    facade
        .skill_source_for_tests(skill_id)
        .expect("get skill source")
}

async fn list_candidates(
    facade: &LocalApplicationFacade,
) -> Vec<skillhub_core::SearchCandidateRecord> {
    let result = facade
        .query(AppQuery::ListSearchCandidates(ListSearchCandidates))
        .await
        .expect("list search candidates");
    let AppQueryResult::SearchCandidates(candidates) = result else {
        panic!("expected search candidates");
    };
    candidates
}

async fn recent_operations(
    facade: &LocalApplicationFacade,
) -> Vec<skillhub_core::RecentOperationSummary> {
    let result = facade
        .query(AppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap snapshot");
    let AppQueryResult::BootstrapSnapshot(snapshot) = result else {
        panic!("expected bootstrap snapshot");
    };
    snapshot.recent_operations
}

#[tokio::test]
async fn local_imports_report_local_only_without_upstream() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    let source = tempfile::tempdir().expect("source");
    write_skill_source(source.path());

    let skill_id = commit_candidate(&facade, local_candidate(source.path())).await;

    let record =
        get_skill_source(&facade, skill_id).expect("source record must exist after import");
    assert_eq!(record.role, SourceRole::LocalOnly);
    assert_eq!(record.source.kind, SourceKind::Local);
    assert!(record.upstream.is_none());
}

#[tokio::test]
async fn confirmed_repo_imports_report_verified_upstream() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    let source = tempfile::tempdir().expect("source");
    write_skill_source(source.path());
    facade.register_upstream_origin(source.path().to_string_lossy(), origin());

    let skill_id = {
        let mut candidate = local_candidate(source.path());
        candidate.upstream = Some(origin());
        commit_candidate(&facade, candidate).await
    };

    let record =
        get_skill_source(&facade, skill_id).expect("source record must exist after import");
    assert_eq!(record.role, SourceRole::VerifiedUpstream);
    let upstream = record.upstream.expect("upstream coordinates");
    assert_eq!(upstream.url, "https://github.com/anthropics/skills");
    assert_eq!(upstream.branch, "main");
    assert_eq!(upstream.directory, "pdf");
}

#[tokio::test]
async fn skill_source_diagnostic_rejects_unknown_skills() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    let error = facade
        .skill_source_for_tests(skillhub_core::SkillId::new())
        .expect_err("unknown skill must be rejected");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

/// 整仓下载（repo_branch/directory 哨兵为空）没有可验证定位坐标：
/// 不再注册无效上游，导入候选保持 upstream=None（诚实缺省）。
#[tokio::test]
async fn whole_repo_downloads_do_not_stamp_invalid_upstream_coordinates() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address");
    let zip = repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Whole repo\n".to_vec(),
    )]);
    let zip = Arc::new(zip);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let zip = Arc::clone(&zip);
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                let (status, payload) =
                    if path.starts_with("/anthropics/skills/archive/refs/heads/") {
                        (200, zip.as_slice())
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

    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&format!("http://{address}")),
    ));

    let downloaded = facade
        .execute(AppCommand::DownloadRepoSkill(DownloadRepoSkill {
            skill: DiscoverableRepoSkill {
                key: "anthropics/skills:".into(),
                name: "skills".into(),
                description: String::new(),
                directory: String::new(),
                readme_url: None,
                repo_owner: "anthropics".into(),
                repo_name: "skills".into(),
                repo_branch: String::new(),
            },
        }))
        .await
        .expect("whole repo download");
    let AppCommandResult::DownloadedRepoSkill(downloaded) = downloaded else {
        panic!("expected downloaded repo skill");
    };

    let result = facade
        .query(AppQuery::DiscoverImportCandidates(
            skillhub_core::DiscoverImportCandidates {
                source: SourceDescriptor::new(
                    SourceKind::Local,
                    SourceLocator::local_path(downloaded.local_path.clone()),
                ),
            },
        ))
        .await
        .expect("import candidates");
    let AppQueryResult::ImportCandidates(candidates) = result else {
        panic!("expected import candidates");
    };
    assert!(!candidates.is_empty(), "下载产物必须能扫出候选");
    for candidate in &candidates {
        assert!(
            candidate.upstream.is_none(),
            "整仓下载没有可验证坐标，不得盖章无效上游"
        );
    }
}

/// 保存候选只写候选表；拒绝只是候选状态；来源记录始终为零。
#[tokio::test]
async fn saved_candidates_never_touch_sources_and_survive_dismissal() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let facade = facade_with_library(&database_path, &workspace.path().join("library"));

    let saved = facade
        .execute(AppCommand::SaveSearchCandidates(SaveSearchCandidates {
            page: search_page(&["acme/pdf", "acme/docx"]),
        }))
        .await
        .expect("save search candidates");
    let AppCommandResult::SearchCandidates(saved) = saved else {
        panic!("expected saved candidates");
    };
    assert_eq!(saved.len(), 2);
    assert!(saved
        .iter()
        .all(|candidate| candidate.status == SearchCandidateStatus::Pending));
    assert!(saved
        .iter()
        .all(|candidate| candidate.provider == "skills_sh"));

    let listed = list_candidates(&facade).await;
    assert_eq!(listed.len(), 2);

    {
        // 只读重开：候选绝不进入 sources/skill_sources/catalog。
        let reader = Database::open(&database_path).expect("reader database");
        for (table, expected) in [("sources", 0_i64), ("skill_sources", 0), ("skills", 0)] {
            let count: i64 = reader
                .connection_for_test()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, expected, "{table} 必须没有候选产生的行");
        }
    }

    let dismiss_id = listed[0].id.clone();
    facade
        .execute(AppCommand::DismissSearchCandidate(DismissSearchCandidate {
            candidate_id: dismiss_id.clone(),
        }))
        .await
        .expect("dismiss candidate");

    let listed = list_candidates(&facade).await;
    assert_eq!(
        listed
            .iter()
            .find(|candidate| candidate.id == dismiss_id)
            .expect("dismissed candidate")
            .status,
        SearchCandidateStatus::Dismissed
    );

    // 重新搜索同一结果：dismissed 不被重置，未处理过的仍是 pending。
    facade
        .execute(AppCommand::SaveSearchCandidates(SaveSearchCandidates {
            page: search_page(&["acme/pdf", "acme/docx"]),
        }))
        .await
        .expect("re-save search candidates");
    let listed = list_candidates(&facade).await;
    assert_eq!(listed.len(), 2, "重复保存不得产生重复候选");
    assert_eq!(
        listed
            .iter()
            .find(|candidate| candidate.id == dismiss_id)
            .expect("dismissed candidate")
            .status,
        SearchCandidateStatus::Dismissed,
        "再次搜索不得把已拒绝的候选重置回 pending"
    );
    assert_eq!(
        listed
            .iter()
            .find(|candidate| candidate.id != dismiss_id)
            .expect("untouched candidate")
            .status,
        SearchCandidateStatus::Pending
    );

    {
        let reader = Database::open(&database_path).expect("reader database");
        let count: i64 = reader
            .connection_for_test()
            .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

/// 确认候选只登记意向：来源记录仍为零；确认/拒绝的转换与错误路径。
#[tokio::test]
async fn confirming_a_candidate_only_records_intent() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let facade = facade_with_library(&database_path, &workspace.path().join("library"));

    let saved = facade
        .execute(AppCommand::SaveSearchCandidates(SaveSearchCandidates {
            page: search_page(&["acme/pdf"]),
        }))
        .await
        .expect("save search candidates");
    let AppCommandResult::SearchCandidates(saved) = saved else {
        panic!("expected saved candidates");
    };
    let id = saved[0].id.clone();

    facade
        .execute(AppCommand::ConfirmSearchCandidate(ConfirmSearchCandidate {
            candidate_id: id.clone(),
        }))
        .await
        .expect("confirm candidate");
    // 幂等：重复确认仍成功。
    facade
        .execute(AppCommand::ConfirmSearchCandidate(ConfirmSearchCandidate {
            candidate_id: id.clone(),
        }))
        .await
        .expect("re-confirm candidate");
    let listed = list_candidates(&facade).await;
    assert_eq!(listed[0].status, SearchCandidateStatus::Confirmed);

    {
        let reader = Database::open(&database_path).expect("reader database");
        let count: i64 = reader
            .connection_for_test()
            .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "确认候选绝不产生来源记录");
    }

    // 用户反悔：确认后的候选可以拒绝。
    facade
        .execute(AppCommand::DismissSearchCandidate(DismissSearchCandidate {
            candidate_id: id.clone(),
        }))
        .await
        .expect("dismiss confirmed candidate");
    // 拒绝后的候选不能再确认。
    let error = facade
        .execute(AppCommand::ConfirmSearchCandidate(ConfirmSearchCandidate {
            candidate_id: id.clone(),
        }))
        .await
        .expect_err("dismissed candidate must not be confirmable");
    assert_eq!(error.code, ErrorCode::OperationConflict);

    let error = facade
        .execute(AppCommand::DismissSearchCandidate(DismissSearchCandidate {
            candidate_id: "candidate:missing".into(),
        }))
        .await
        .expect_err("unknown candidate");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

/// local_only Skill 与候选共存时，更新检测诚实返回 NoUpstream。
#[tokio::test]
async fn check_source_updates_ignores_candidates_and_local_only_sources() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    let source = tempfile::tempdir().expect("source");
    write_skill_source(source.path());
    let skill_id = commit_candidate(&facade, local_candidate(source.path())).await;

    facade
        .execute(AppCommand::SaveSearchCandidates(SaveSearchCandidates {
            page: search_page(&["acme/pdf"]),
        }))
        .await
        .expect("save search candidates");

    let result = facade
        .query(AppQuery::CheckSourceUpdates(CheckSourceUpdates {
            skill_ids: vec![skill_id],
        }))
        .await
        .expect("check source updates");
    let AppQueryResult::SourceUpdateChecks(outcomes) = result else {
        panic!("expected source update checks");
    };
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        outcomes[0].state,
        skillhub_core::SourceState::NoUpstream,
        "候选与 local_only 来源都不得伪装成有上游"
    );
}

/// 新增 mutation 命令必须留下持久操作日志（kind 为人类可读 snake_case）。
#[tokio::test]
async fn candidate_mutations_write_operation_journal_records() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );

    facade
        .execute(AppCommand::SaveSearchCandidates(SaveSearchCandidates {
            page: search_page(&["acme/pdf"]),
        }))
        .await
        .expect("save search candidates");
    let listed = list_candidates(&facade).await;
    facade
        .execute(AppCommand::ConfirmSearchCandidate(ConfirmSearchCandidate {
            candidate_id: listed[0].id.clone(),
        }))
        .await
        .expect("confirm candidate");

    // 失败路径也有终态日志：不存在的候选确认。
    let _ = facade
        .execute(AppCommand::ConfirmSearchCandidate(ConfirmSearchCandidate {
            candidate_id: "candidate:missing".into(),
        }))
        .await;

    facade
        .execute(AppCommand::DismissSearchCandidate(DismissSearchCandidate {
            candidate_id: listed[0].id.clone(),
        }))
        .await
        .expect("dismiss candidate");

    let operations = recent_operations(&facade).await;
    let find = |kind: &str| {
        operations
            .iter()
            .find(|record| record.kind == kind)
            .unwrap_or_else(|| panic!("journal must contain a {kind} record"))
    };
    let saved = find("save_search_candidates");
    assert_eq!(saved.phase, OperationPhase::Committed);
    // 确认候选产生两条记录：成功一条、失败（未知候选）终态一条。
    let confirms = operations
        .iter()
        .filter(|record| record.kind == "confirm_search_candidate")
        .collect::<Vec<_>>();
    assert_eq!(confirms.len(), 2, "一次成功确认 + 一次失败确认都必须留痕");
    assert!(confirms
        .iter()
        .any(|record| record.phase == OperationPhase::Committed));
    assert!(confirms
        .iter()
        .any(|record| record.phase == OperationPhase::RolledBack));
    let dismissed = find("dismiss_search_candidate");
    assert_eq!(dismissed.phase, OperationPhase::Committed);
}

/// 单路由 zip 归档 fixture 服务器共用的打包函数（与 facade_upstream_check 相同模式）。
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
