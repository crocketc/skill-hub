//! K6 来源身份/候选/采纳闭环（A 侧 RED）。
//!
//! 覆盖 K0 契约 §K6 与统一预览绑定模式（§2）：
//! - RelinkSource 只接受经验证的来源身份（G-15）：HttpsUrl/GitUrl 严格解析
//!   +规范化，非法输入拒绝且原 upstream 原样保留；
//! - 来源更新采纳只有一条 Prepare→Commit 预览绑定路径（ApplySourceUpdate
//!   已移除）：Prepare 产出候选预览（preview_id、expires_at RFC3339 UTC、
//!   候选身份、文件级变更摘要），Commit 提交前重核当前版本与上游候选，
//!   漂移/过期一律拒绝并要求重新预览；采纳产生新版本且四类消费方一致；
//! - 忽略候选（D3）：按 skill+来源+候选身份持久化，采纳或来源变更后自动
//!   清除，新候选重新提醒；重启不丢失；
//! - B 侧查询面：来源候选/检查状态查询返回持久化事实与忽略状态。

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use skillhub_adapters::source::RepoDiscoveryProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, CommitSourceUpdate,
    GetSourceUpdateStatus, IgnoreSourceUpdate, PrepareSourceUpdate, SaveSkillContent,
};
use skillhub_core::catalog::Skill;
use skillhub_core::source::{
    SourceDescriptor, SourceKind, SourceLocator, SourceState, UpdateDecision,
};
use skillhub_core::{
    AppResult, ApplicationFacade, ErrorCode, ImportCandidate, ImportDecision, PrepareImport,
    RelinkSource, UpstreamCheckResult, UpstreamOrigin,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

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

/// 内容可变的单路由归档 fixture：分支归档路径命中时返回当前内容字节。
/// 返回句柄供测试在 Prepare 与 Commit 之间替换上游内容制造漂移。
fn mutable_archive_server(initial: Vec<u8>) -> (String, Arc<Mutex<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address");
    let content = Arc::new(Mutex::new(initial));
    let shared = Arc::clone(&content);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                let (status, payload) =
                    if path.starts_with("/anthropics/skills/archive/refs/heads/main.zip") {
                        (200, shared.lock().unwrap().clone())
                    } else {
                        (404, b"not found".to_vec())
                    };
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&payload);
            });
        }
    });
    (format!("http://{address}"), content)
}

/// 双路由归档 fixture（内容固定）：分支归档 + tag 归档各自独立内容，
/// /releases/latest 302 到 tag 展示页（AR-021 取数口径）。
fn tagged_archive_server(
    branch_body: Vec<u8>,
    tag_body: Vec<u8>,
    release_tag: &'static str,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address");
    let branch_body = Arc::new(branch_body);
    let tag_body = Arc::new(tag_body);
    let release_tag = release_tag.to_owned();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let branch_body = Arc::clone(&branch_body);
            let tag_body = Arc::clone(&tag_body);
            let release_tag = release_tag.clone();
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                if path.ends_with("/releases/latest") {
                    let response = format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://{address}/anthropics/skills/releases/tag/{release_tag}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes());
                    return;
                }
                let (status, payload) =
                    if path.starts_with("/anthropics/skills/archive/refs/heads/main.zip") {
                        (200, branch_body.as_slice())
                    } else if path.contains("/releases/tag/") {
                        (200, b"release page".as_slice())
                    } else if path.starts_with("/anthropics/skills/archive/refs/tags/v2.0.0.zip") {
                        (200, tag_body.as_slice())
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
            runtime_name_override: None,
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
            governance_decision: skillhub_core::ImportGovernanceDecision {
                group_actions: prepared
                    .analysis
                    .governance_groups
                    .iter()
                    .map(|group| (group.group_id.clone(), group.default_action))
                    .collect(),
                item_overrides: Default::default(),
            },
            batch_id: None,
            candidate_key: None,
            runtime_name_override: None,
            batch_signature: None,
            security_decision: None,
        }))
        .await
        .expect("committed import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary.items[0].skill_id.expect("imported skill id")
}

async fn prepare_preview(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> skillhub_core::SourceUpdatePreview {
    let result = facade
        .execute(AppCommand::PrepareSourceUpdate(PrepareSourceUpdate {
            skill_id,
        }))
        .await
        .expect("prepare source update preview");
    let AppCommandResult::SourceUpdatePreview(preview) = result else {
        panic!("expected source update preview");
    };
    preview
}

async fn commit(
    facade: &LocalApplicationFacade,
    preview_id: skillhub_core::OperationId,
    decision: UpdateDecision,
) -> AppResult<AppCommandResult> {
    facade
        .execute(AppCommand::CommitSourceUpdate(CommitSourceUpdate {
            preview_id,
            decision,
        }))
        .await
}

async fn status(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> skillhub_core::api::SourceUpdateStatus {
    let result = facade
        .query(AppQuery::GetSourceUpdateStatus(GetSourceUpdateStatus {
            skill_id,
        }))
        .await
        .expect("source update status");
    let AppQueryResult::SourceUpdateStatus(status) = result else {
        panic!("expected source update status");
    };
    status
}

/// RFC3339 UTC 形状校验（`YYYY-MM-DDTHH:MM:SSZ`），不引入时间库依赖。
fn assert_rfc3339_utc(value: &str) {
    assert_eq!(value.len(), 20, "unexpected RFC3339 shape: {value}");
    assert_eq!(&value[4..5], "-");
    assert_eq!(&value[7..8], "-");
    assert_eq!(&value[10..11], "T");
    assert_eq!(&value[13..14], ":");
    assert_eq!(&value[16..17], ":");
    assert!(value.ends_with('Z'), "expires_at 必须是 UTC（Z 后缀）");
}

fn visible_skill_tree(library_root: &Path, skill_id: skillhub_core::SkillId) -> PathBuf {
    let entry = std::fs::read_dir(library_root.join("skills"))
        .expect("skills directory")
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(skill_id.to_string().as_str())
        })
        .expect("visible skill directory");
    entry.path()
}

fn portable_current_version(
    library_root: &Path,
    skill_id: skillhub_core::SkillId,
) -> Option<skillhub_core::VersionId> {
    let manifest = skillhub_storage::PortableManifestStore::new(
        library_root.join(".skillhub").join("library.json"),
        Arc::new(|_| false),
    )
    .load()
    .expect("read portable manifest");
    manifest
        .skills
        .into_iter()
        .find(|record| record.id == skill_id)
        .and_then(|record| record.current_version)
}

fn journal_phase(database_path: &Path, kind: &str) -> String {
    let database = Database::open(database_path).expect("reopen database");
    database
        .connection_for_test()
        .query_row(
            "SELECT phase FROM operations WHERE kind=?1",
            [kind],
            |row| row.get(0),
        )
        .expect("journal row for kind")
}

fn error_reason(error: &skillhub_core::AppError) -> Option<&str> {
    error.params.get("reason").and_then(|value| value.as_str())
}

// ---------------------------------------------------------------------------
// G-15：RelinkSource 只接受经验证的来源身份。
// ---------------------------------------------------------------------------

#[tokio::test]
async fn relink_rejects_free_text_git_url_and_keeps_the_existing_origin() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let database = Database::open(&database_path).expect("database");
    let skill_id = skillhub_core::SkillId::new();
    let original = origin();
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&Skill::new(skill_id, "Notes"))
        .expect("insert skill");
    database
        .source_repository()
        .record_upstream(skill_id, &original)
        .expect("record upstream");
    let facade = LocalApplicationFacade::new_with_library(database, workspace.path().join("lib"));

    let error = facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Git,
                SourceLocator::git_url("git hub错误的输入"),
            ),
        }))
        .await
        .expect_err("free text must not become a verified source identity");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    drop(facade);

    let database = Database::open(&database_path).expect("reopen database");
    assert_eq!(
        database
            .source_repository()
            .upstream_for_skill(skill_id)
            .expect("read upstream after rejected relink"),
        Some(original),
        "非法来源必须原样保留既有已验证 upstream"
    );
}

#[tokio::test]
async fn relink_normalizes_remote_urls_before_persisting() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let facade = facade_with_library(&database_path, &workspace.path().join("lib"));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;

    facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Git,
                SourceLocator::git_url("HTTPS://GitHub.COM/Owner/Repo/"),
            ),
        }))
        .await
        .expect("relink with a valid remote url");
    drop(facade);

    let database = Database::open(&database_path).expect("reopen database");
    let source = database
        .source_repository()
        .for_skill(skill_id)
        .expect("read source")
        .expect("source after relink");
    assert_eq!(
        source.locator.as_url(),
        Some("https://github.com/owner/repo"),
        "来源身份必须规范化（scheme/host 小写、去默认端口与尾斜杠）后落库"
    );
}

// ---------------------------------------------------------------------------
// Prepare→Commit 预览绑定。
// ---------------------------------------------------------------------------

#[tokio::test]
async fn prepare_returns_candidate_preview_with_label_and_file_summary() {
    let base = tagged_archive_server(
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Branch head\n".to_vec(),
        )]),
        repo_zip(vec![(
            "skills-v2.0.0/pdf/SKILL.md".into(),
            b"# Tagged candidate\n".to_vec(),
        )]),
        "v2.0.0",
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

    let preview = prepare_preview(&facade, skill_id).await;
    assert_eq!(preview.skill_id, skill_id);
    assert_eq!(
        preview.upstream_label.as_deref(),
        Some("v2.0.0"),
        "候选预览必须携带 release/tag 展示标签"
    );
    assert!(
        !preview.candidate_identity.is_empty(),
        "候选身份必须来自真实下载的候选内容"
    );
    assert!(
        preview.files.iter().any(|change| change.path == "SKILL.md"
            && change.change == skillhub_core::SourceUpdateFileChangeKind::Modified),
        "文件级变更摘要必须报告 SKILL.md 修改"
    );
    assert_rfc3339_utc(&preview.expires_at);
    assert!(!preview.confirmation_fingerprint.is_empty());
}

#[tokio::test]
async fn commit_adopts_candidate_across_all_four_consumers() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    let applied = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect("commit must adopt the prepared candidate");
    let AppCommandResult::AppliedSourceUpdate(applied) = applied else {
        panic!("expected applied source update");
    };
    let new_version = applied.new_version.clone().expect("采纳必须产生新版本");
    drop(facade);

    let database = Database::open(&database_path).expect("reopen database");
    let pointer: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [skill_id.to_string()],
            |row| row.get(0),
        )
        .expect("database current pointer");
    assert_eq!(pointer, new_version.to_string(), "①DB 指针");
    let library = CentralLibrary::open_existing(&library_root).expect("reopen library");
    assert_eq!(
        VersionStore::from_library(&library)
            .current(skill_id)
            .unwrap(),
        Some(new_version.clone()),
        "②版本库指针"
    );
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Changed upstream\n",
        "③可见树内容必须来自上游候选"
    );
    assert_eq!(
        portable_current_version(&library_root, skill_id),
        Some(new_version.clone()),
        "④portable current_version"
    );
    assert_eq!(
        journal_phase(&database_path, "commit_source_update"),
        "committed",
        "采纳全程 journal：成功路径必须留下 Committed 相位"
    );
    assert_eq!(
        database
            .source_repository()
            .revision_for_skill(skill_id)
            .expect("read revision"),
        Some(preview.candidate_identity.clone()),
        "采纳后必须记录来源 revision（候选身份=候选树哈希）"
    );
}

#[tokio::test]
async fn commit_rejects_when_the_upstream_drifts_after_prepare() {
    let (base, content) = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# First candidate\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    // Prepare→Commit 之间上游内容变化（tag 重指/分支推进的等价事实）。
    *content.lock().unwrap() = repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Moved upstream\n".to_vec(),
    )]);

    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("drifted upstream must reject the stale preview");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_drifted"),
        "上游漂移必须给出可定位的拒绝原因"
    );
    drop(facade);

    // 预览被拒绝后不得改变任何消费面。
    let database = Database::open(&database_path).expect("reopen database");
    let pointer: String = database
        .connection_for_test()
        .query_row(
            "SELECT version_id FROM current_pointers WHERE skill_id=?1",
            [skill_id.to_string()],
            |row| row.get(0),
        )
        .expect("database current pointer");
    assert_eq!(
        VersionStore::from_library(&CentralLibrary::open_existing(&library_root).unwrap())
            .current(skill_id)
            .unwrap()
            .map(|version| version.to_string()),
        Some(pointer),
        "拒绝后版本库指针与 DB 指针保持一致"
    );
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Portable\n",
        "拒绝后可见树保持导入基线"
    );
    let phase: String = database
        .connection_for_test()
        .query_row(
            "SELECT phase FROM operations WHERE operation_id=?1",
            [preview.preview_id.to_string()],
            |row| row.get(0),
        )
        .expect("preview journal row");
    assert_eq!(
        phase, "rolled_back",
        "被拒绝的预览必须结算为 rolled_back，不能被二次提交"
    );

    // 上游推进后重新预览必须得到新候选（重新提醒）。
    let facade = LocalApplicationFacade::new_with_library(
        Database::open(&database_path).expect("reopen database"),
        &library_root,
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    let fresh = prepare_preview(&facade, skill_id).await;
    assert_ne!(
        fresh.candidate_identity, preview.candidate_identity,
        "上游漂移后重新预览必须产生新的候选身份"
    );
}

#[tokio::test]
async fn commit_rejects_when_the_current_version_drifts_after_prepare() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&workspace.path().join("db.sqlite"), &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    // Prepare→Commit 之间本地产生了新版本（当前指针漂移）。
    let edited = tempfile::tempdir().expect("edited dir");
    std::fs::write(edited.path().join("SKILL.md"), "# Local edit\n").expect("local edit");
    facade
        .execute(AppCommand::SaveSkillContent(SaveSkillContent {
            skill_id,
            source_path: edited.path().to_string_lossy().into_owned(),
        }))
        .await
        .expect("save local version");

    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("moved current version must reject the stale preview");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_facts_changed"),
        "当前版本漂移必须给出可定位的拒绝原因"
    );
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Local edit\n",
        "拒绝后可见树保持本地最新版本"
    );
}

#[tokio::test]
async fn commit_rejects_an_expired_preview() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    {
        let database = facade.database_for_tests();
        let database = database.lock().unwrap();
        let mut record = database
            .operation_repository()
            .get_sync(preview.preview_id)
            .expect("preview record")
            .expect("preview row");
        record.recovery_data["expires_at"] = serde_json::json!(0);
        database
            .operation_repository()
            .update_sync(&record)
            .expect("expire preview");
    }

    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("expired preview must be rejected");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(error_reason(&error), Some("source_update_preview_expired"));
}

#[tokio::test]
async fn commit_after_restart_is_rejected_instead_of_silently_allowed() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;
    drop(facade);

    // 重启：启动清扫把上一会话遗留的 prepared 预览结算为 rolled_back，
    // 破坏性提交（D2）重启后被拒绝而非误放行。
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("a preview from a previous session must not survive a restart");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_not_prepared")
    );
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Portable\n",
        "重启后拒绝提交不得改动可见树"
    );
}

#[tokio::test]
async fn keep_local_and_cancel_settle_the_preview_without_adopting() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;

    let keep_preview = prepare_preview(&facade, skill_id).await;
    let kept = commit(&facade, keep_preview.preview_id, UpdateDecision::KeepLocal)
        .await
        .expect("keep local must settle the preview");
    let AppCommandResult::AppliedSourceUpdate(applied) = kept else {
        panic!("expected applied source update");
    };
    assert_eq!(applied.decision, UpdateDecision::KeepLocal);
    assert!(applied.new_version.is_none(), "保留本地不产生新版本");
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Portable\n",
        "保留本地不得改动可见树"
    );
    let phase: String = {
        let database = Database::open(&database_path).expect("reopen database");
        database
            .connection_for_test()
            .query_row(
                "SELECT phase FROM operations WHERE operation_id=?1",
                [keep_preview.preview_id.to_string()],
                |row| row.get(0),
            )
            .expect("preview row")
    };
    assert_eq!(phase, "rolled_back", "已决定的预览必须结算，不能复用");

    let cancel_preview = prepare_preview(&facade, skill_id).await;
    let cancelled = commit(&facade, cancel_preview.preview_id, UpdateDecision::Cancel)
        .await
        .expect("cancel must settle the preview");
    let AppCommandResult::AppliedSourceUpdate(applied) = cancelled else {
        panic!("expected applied source update");
    };
    assert_eq!(applied.decision, UpdateDecision::Cancel);
}

#[tokio::test]
async fn commit_rejects_unknown_or_mismatched_previews() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));

    // 从未 Prepare 过的 preview_id 直接 Commit：必须在预览查询阶段被拒绝。
    let error = commit(
        &facade,
        skillhub_core::OperationId::new(),
        UpdateDecision::TakeUpstream,
    )
    .await
    .expect_err("commit without a prepared preview must be rejected");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(error_reason(&error), Some("source_update_preview_missing"));
}

// ---------------------------------------------------------------------------
// D3：忽略候选。
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ignore_persists_survives_restart_and_clears_after_adoption() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    // 「关闭窗口」不调用任何命令，不产生忽略记录。
    facade
        .execute(AppCommand::IgnoreSourceUpdate(IgnoreSourceUpdate {
            skill_id,
            candidate_identity: preview.candidate_identity.clone(),
        }))
        .await
        .expect("ignore candidate");
    let observed = status(&facade, skill_id).await;
    assert_eq!(
        observed.ignored_candidates,
        vec![preview.candidate_identity.clone()],
        "忽略记录必须按候选身份持久化"
    );
    assert!(observed.candidate_ignored);
    drop(facade);

    // 重启后忽略记录仍在。
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let observed = status(&facade, skill_id).await;
    assert!(observed.candidate_ignored, "忽略记录必须跨会话持久化");

    // 候选被采纳后忽略记录自动失效清除。上一会话的 prepared 预览已被
    // 启动清扫结算（D2），采纳必须走重新预览：同一上游内容重准备得到
    // 同一候选身份，恰好证明忽略记录按候选身份仍然命中。
    let fresh = prepare_preview(&facade, skill_id).await;
    assert_eq!(fresh.candidate_identity, preview.candidate_identity);
    let applied = commit(&facade, fresh.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect("adopt the ignored candidate");
    let AppCommandResult::AppliedSourceUpdate(applied) = applied else {
        panic!("expected applied source update");
    };
    assert!(applied.new_version.is_some());
    let observed = status(&facade, skill_id).await;
    assert!(
        observed.ignored_candidates.is_empty(),
        "采纳后忽略记录必须自动清除"
    );
    assert!(!observed.candidate_ignored);
    assert_eq!(
        observed.state,
        Some(SourceState::UpToDate),
        "采纳后来源状态必须反映 UpToDate"
    );

    // 新候选重新提醒：不被旧忽略记录吞掉。
    *base.1.lock().unwrap() = repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Second upstream\n".to_vec(),
    )]);
    let check = facade
        .execute(AppCommand::CheckSourceUpdate(
            skillhub_core::CheckSourceUpdate { skill_id },
        ))
        .await
        .expect("check source update");
    let AppCommandResult::UpstreamCheckResult(UpstreamCheckResult { state, .. }) = check else {
        panic!("expected upstream check result");
    };
    assert_eq!(state, SourceState::UpdateAvailable);
    let observed = status(&facade, skill_id).await;
    assert!(
        !observed.candidate_ignored,
        "新候选必须重新提醒，不被旧忽略记录吞掉"
    );
    assert_ne!(
        observed.candidate_identity.as_deref(),
        Some(preview.candidate_identity.as_str()),
        "新候选必须有新的身份"
    );
}

#[tokio::test]
async fn ignore_is_cleared_when_the_source_identity_changes() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;
    facade
        .execute(AppCommand::IgnoreSourceUpdate(IgnoreSourceUpdate {
            skill_id,
            candidate_identity: preview.candidate_identity.clone(),
        }))
        .await
        .expect("ignore candidate");
    assert!(status(&facade, skill_id).await.candidate_ignored);

    // 来源身份变更（relink 到另一个已验证来源）后忽略记录自动失效。
    facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Git,
                SourceLocator::git_url("https://github.com/other-owner/other-repo"),
            ),
        }))
        .await
        .expect("relink to another verified source");
    let observed = status(&facade, skill_id).await;
    assert!(
        observed.ignored_candidates.is_empty(),
        "来源身份变更后忽略记录必须自动失效清除"
    );
}

// ---------------------------------------------------------------------------
// B 侧查询面。
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_query_reports_persisted_check_facts_without_network() {
    let base = mutable_archive_server(repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"# Changed upstream\n".to_vec(),
    )]));
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with_library(
        &workspace.path().join("db.sqlite"),
        &workspace.path().join("library"),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base.0),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;

    let initial = status(&facade, skill_id).await;
    assert_eq!(
        initial.state, None,
        "从未检查过的 Skill 必须诚实缺省 state=None"
    );
    assert!(!initial.candidate_ignored);

    let check = facade
        .execute(AppCommand::CheckSourceUpdate(
            skillhub_core::CheckSourceUpdate { skill_id },
        ))
        .await
        .expect("check source update");
    let AppCommandResult::UpstreamCheckResult(check) = check else {
        panic!("expected upstream check result");
    };
    assert_eq!(check.state, SourceState::UpdateAvailable);

    let observed = status(&facade, skill_id).await;
    assert_eq!(observed.state, Some(SourceState::UpdateAvailable));
    assert!(
        observed.checked_at.is_some(),
        "状态查询必须暴露最近检查时刻"
    );
    if let Some(checked_at) = &observed.checked_at {
        assert_rfc3339_utc(checked_at);
    }
    assert_eq!(
        observed.candidate_identity.as_deref(),
        check.candidate_identity.as_deref(),
        "状态查询的候选身份必须与最近一次检查一致"
    );
    assert!(
        observed
            .candidate_identity
            .as_deref()
            .is_some_and(|identity| !identity.is_empty()),
        "UpdateAvailable 检查必须给出候选身份"
    );
}
