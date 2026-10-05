//! W2-1（跟进 6）：来源更新守卫式快速重试——失败分类固化与决定留痕。
//!
//! `commit_source_update` 全部失败点的分类清单（逐点核实于实现，行为权威：
//! 未决事项产品裁决 §6）。分类只有两种结局：**预览保持 Prepared 可重试**
//! （同 preview_id + 原决定直接重试，事实重核在下次 commit 兜底）或
//! **预览被结算为 RolledBack，必须重新预览**。
//!
//! | #  | 失败点                                   | reason / 错误                          | 预览结局         | 重试语义 |
//! |----|------------------------------------------|----------------------------------------|------------------|----------|
//! | 1  | preview_id 不存在                         | source_update_preview_missing          | （无行可结算）    | 只能重新预览 |
//! | 2  | 预览相位非 Prepared（已结算/已消费/重启清扫） | source_update_preview_not_prepared     | 已是终态         | 必须重新预览 |
//! | 3  | recovery_data 损坏无法解析                 | source_update_preview_invalid          | 保持 Prepared    | 按"保留"类归类（事实守卫兜底的默认语义）；注意该路径结构性不可自愈，实际需重新预览——已知边界，见测试注释 |
//! | 4  | 不支持的决定（CreateIndependentBranch）    | source_update_decision_unsupported     | 保持 Prepared    | 可换决定重试 |
//! | 5  | KeepLocal / Cancel（决定执行，非失败）      | —（成功结算 decided）                   | 结算 RolledBack  | 决定已执行，无重试（既有测试覆盖） |
//! | 6  | 预览过期                                   | source_update_preview_expired          | 结算 RolledBack  | 必须重新预览（既有测试覆盖） |
//! | 7  | 本地事实变化（store/DB 指针漂移）           | source_update_preview_facts_changed    | 结算 RolledBack  | 必须重新预览 |
//! | 8  | 取数失败（网络中断/临时目录失败）            | InternalError（透传）                   | 保持 Prepared    | 可直接重试（实现注释明示） |
//! | 9  | 上游候选漂移（重取身份不一致）               | source_update_preview_drifted          | 结算 RolledBack  | 必须重新预览 |
//! | 10 | 主体已从 catalog 消失                       | source_update_preview_facts_changed    | 结算 RolledBack  | 必须重新预览；实现中该失败在 **journal_begin 之前** 的指针守卫（catalog 行删除使 current 查询漂移）即触发，因此**不产生 adoption journal 行**——2026-10-04 续做核实，与实现一致 |
//! | 11 | 采用快照失败（可见树指纹等，物理变更前）      | 透传                                   | 保持 Prepared    | 可直接重试（仅 adoption journal 结算） |
//! | 12 | Applying 检查点失败（首个物理变更前）        | 透传                                   | 保持 Prepared    | 可直接重试（与 11 同一结算路径） |
//! | 13 | 物理捕获失败                                | 透传                                   | 保持 Prepared    | 可直接重试（与 11 同一结算路径） |
//! | 14 | 捕获后身份复核漂移                           | source_update_preview_drifted          | 保持 Prepared    | 可直接重试；下次 commit 的上游重核（9 类）兜底 |
//! | 15 | 物理采用失败（四消费面补偿回滚）              | 透传                                   | 保持 Prepared    | 可直接重试：同 preview_id + 原决定 |
//! | 16 | 采用后持久化失败（revision/观察/忽略清理）    | 透传                                   | 保持 Prepared    | 可直接重试：同 preview_id + 原决定 |
//!
//! 判据映射：测试①固定 15/16 类"物理失败→同 preview_id+原决定重试成功"；
//! 测试②固定"失败后上游变化"走 9 类结算（实现中上游变化的 reason 是
//! drifted——实施计划 §2 W2-1 文字里的 facts_changed 与 drifted 互为笔误，
//! 以实现语义为准：上游变化=drifted，本地指针变化=facts_changed）；测试③
//! 固定"失败后本地指针漂移"走 7 类结算。2/5/6/8 类已有测试覆盖
//! （facade_source_update_preview_red.rs），此处引用不重复。
//!
//! 2026-10-04 续做核对修正（以实现语义为准，不放松判据）：
//! - 分类 16 的 fixture 原用 `ALTER TABLE sources RENAME` 制造持久化失败，
//!   但取数阶段 `fetch_remote_source_dir` 也要 SELECT sources，改名会提前在
//!   journal_begin 之前失败（实测为 8 类路径、无 adoption journal 行）。
//!   改用 `BEFORE UPDATE ON sources` 触发器精确拦截持久化首语句
//!   `set_revision`（取数为 SELECT 不受影响），fixture 才真正落在 16 类。
//! - 分类 10 的 journal 预期修正为"无 adoption journal 行"（见上表）；
//!   预览结算断言不变。
//!
//! 失败记录留痕：adoption journal 的失败行必须保留用户当时的决定
//! （KeepLocal/TakeUpstream 等，`recovery_data.source_update_decision`），
//! 重试审计可查"当时选了什么"。

use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::Arc;

use skillhub_adapters::source::RepoDiscoveryProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, CommitSourceUpdate, PrepareSourceUpdate, SaveSkillContent,
};
use skillhub_core::{
    AppResult, ApplicationFacade, ErrorCode, ImportCandidate, ImportDecision, PrepareImport,
    SourceDescriptor, SourceKind, SourceLocator, UpdateDecision, UpstreamOrigin,
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

fn error_reason(error: &skillhub_core::AppError) -> Option<&str> {
    error.params.get("reason").and_then(|value| value.as_str())
}

fn visible_skill_tree(
    library_root: &std::path::Path,
    skill_id: skillhub_core::SkillId,
) -> std::path::PathBuf {
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

/// 让"采用后持久化"确定性失败：在 sources 表上挂 BEFORE UPDATE 触发器，
/// `set_revision`（持久化相首条 UPDATE）随即被 RAISE(ABORT) 拒绝，而取数
/// 阶段的 SELECT 不受影响——失败精确落在分类 16，不提前打断前置阶段。
/// 恢复即删除触发器。
fn break_persist_phase(facade: &LocalApplicationFacade, suffix: &str) {
    let database = facade.database_for_tests();
    let database = database.lock().unwrap();
    database
        .connection_for_test()
        .execute(
            &format!(
                "CREATE TRIGGER break_source_update_persist_{suffix} \
                 BEFORE UPDATE ON sources \
                 BEGIN SELECT RAISE(ABORT, 'persist phase broken for test'); END"
            ),
            [],
        )
        .expect("install persist-phase breaker");
}

fn restore_persist_phase(facade: &LocalApplicationFacade, suffix: &str) {
    let database = facade.database_for_tests();
    let database = database.lock().unwrap();
    database
        .connection_for_test()
        .execute(
            &format!("DROP TRIGGER break_source_update_persist_{suffix}"),
            [],
        )
        .expect("remove persist-phase breaker");
}

/// 读取预览行的相位（结算结局断言用）。
fn preview_phase(
    database_path: &std::path::Path,
    preview_id: skillhub_core::OperationId,
) -> String {
    let database = Database::open(database_path).expect("reopen database");
    database
        .connection_for_test()
        .query_row(
            "SELECT phase FROM operations WHERE operation_id=?1",
            [preview_id.to_string()],
            |row| row.get(0),
        )
        .expect("preview journal row")
}

/// 读取 adoption journal（kind=commit_source_update）全部行的相位。
fn adoption_journal_phases(database_path: &std::path::Path, kind: &str) -> Vec<String> {
    let database = Database::open(database_path).expect("reopen database");
    let mut statement = database
        .connection_for_test()
        .prepare("SELECT phase FROM operations WHERE kind=?1 ORDER BY rowid ASC")
        .expect("prepare journal query");
    let rows = statement
        .query_map([kind], |row| row.get::<_, String>(0))
        .expect("query journal rows");
    rows.map(|row| row.expect("journal row")).collect()
}

/// 读取 adoption journal（kind=commit_source_update）失败行保留的
/// recovery_data（决定留痕断言用）。recovery_data 存于 progress_json 信封
/// 内（无独立列），按存储编码解出。
fn adoption_journal_recovery_data(
    database_path: &std::path::Path,
    kind: &str,
) -> Vec<serde_json::Value> {
    let database = Database::open(database_path).expect("reopen database");
    let mut statement = database
        .connection_for_test()
        .prepare("SELECT progress_json FROM operations WHERE kind=?1 ORDER BY rowid ASC")
        .expect("prepare journal query");
    let rows = statement
        .query_map([kind], |row| row.get::<_, String>(0))
        .expect("query journal rows");
    rows.map(|row| {
        let progress_json = row.expect("journal row");
        serde_json::from_str::<serde_json::Value>(&progress_json)
            .ok()
            .and_then(|envelope| envelope.get("recovery_data").cloned())
            .unwrap_or(serde_json::Value::Null)
    })
    .collect()
}

const UPSTREAM_ROUTE: &str = "/anthropics/skills/archive/refs/heads/main.zip";

/// ①（分类 15/16）：物理失败后，预览保持 Prepared，同一 preview_id 携带
/// 原决定直接重试成功，不要求重新预览；失败 journal 行保留用户决定。
#[tokio::test]
async fn physical_failure_keeps_the_preview_retryable_with_the_original_decision() {
    let base = archive_server(
        UPSTREAM_ROUTE,
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream\n".to_vec(),
        )]),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    // 物理采用已过四消费面，"采用后持久化"失败（分类 16）。
    break_persist_phase(&facade, "broken");
    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("persist-phase failure must fail the commit");
    assert_eq!(error.code, ErrorCode::InternalError);
    restore_persist_phase(&facade, "broken");

    // 预览保持 Prepared 可重试；adoption journal 结算为 rolled_back。
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "prepared",
        "物理失败不得结算预览：同 preview_id 必须可直接重试"
    );
    assert_eq!(
        adoption_journal_phases(&database_path, "commit_source_update"),
        vec!["rolled_back".to_owned()],
        "失败的采用流必须留下 rolled_back 的 journal 行"
    );
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Portable\n",
        "失败补偿必须回滚可见树到原版本"
    );

    // 失败记录保留用户决定：审计可查"当时用户选了什么"。
    let recovery_data = adoption_journal_recovery_data(&database_path, "commit_source_update");
    assert_eq!(recovery_data.len(), 1);
    assert_eq!(
        recovery_data[0]
            .get("source_update_decision")
            .and_then(|value| value.as_str()),
        Some("take_upstream"),
        "失败 journal 行必须保留用户决定（W2-1 留痕要求）"
    );

    // 同 preview_id + 原决定直接重试：不需要重新预览。
    let retried = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect("retry with the same preview must succeed after the transient failure");
    let AppCommandResult::AppliedSourceUpdate(applied) = retried else {
        panic!("expected applied source update");
    };
    assert!(applied.new_version.is_some(), "重试成功必须产生新版本");
    assert_eq!(
        std::fs::read_to_string(visible_skill_tree(&library_root, skill_id).join("SKILL.md"))
            .expect("visible SKILL.md"),
        "# Changed upstream\n",
        "重试成功后可见树来自上游候选"
    );
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "rolled_back",
        "重试成功后预览被正常消费结算"
    );
}

/// ②（分类 9）：物理失败后上游内容变化，同一 preview 再提交被 drifted
/// 结算拒绝，再次提交被拒（预览已是终态）——必须重新预览。
/// 注：实现语义中"上游变化"= drifted（实施计划文字与实现互为笔误，以
/// 实现为准）；本地指针变化才是 facts_changed（测试③）。
#[tokio::test]
async fn upstream_change_after_failure_settles_the_preview_and_forces_repreview() {
    let base = archive_server(
        UPSTREAM_ROUTE,
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream\n".to_vec(),
        )]),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    // 先制造一次物理失败（预览保留），再让上游推进。
    break_persist_phase(&facade, "broken");
    commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("first commit fails in the persist phase");
    restore_persist_phase(&facade, "broken");

    // 上游内容变化（分支推进/tag 重指的等价事实）。
    let changed = archive_server(
        UPSTREAM_ROUTE,
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Moved upstream\n".to_vec(),
        )]),
    );
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&changed),
    ));

    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("upstream drift after failure must settle the stale preview");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_drifted"),
        "失败后上游变化必须以 drifted 结算，落回重新预览"
    );
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "rolled_back",
        "drifted 预览必须被结算为终态"
    );

    // 被结算的预览不能二次提交：重新预览是唯一出路。
    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("a settled preview must not be committable");
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_not_prepared"),
        "已结算预览再提交必须被拒，要求重新预览"
    );
}

/// ③（分类 7）：物理失败后本地指针漂移（本地编辑产生新版本），同一
/// preview 再提交被 facts_changed 结算拒绝——落回重新预览。无前置失败
/// 的同守卫行为已由
/// facade_source_update_preview_red::commit_rejects_when_the_current_version_drifts_after_prepare
/// 覆盖，此处固定"失败之后仍然守卫"的链路。
#[tokio::test]
async fn local_pointer_drift_after_failure_settles_the_preview_and_forces_repreview() {
    let base = archive_server(
        UPSTREAM_ROUTE,
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream\n".to_vec(),
        )]),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;

    break_persist_phase(&facade, "broken");
    commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("first commit fails in the persist phase");
    restore_persist_phase(&facade, "broken");

    // 本地编辑推进当前版本（指针漂移）。
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
        .expect_err("local pointer drift after failure must settle the stale preview");
    assert_eq!(error.code, ErrorCode::OperationConflict);
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_facts_changed"),
        "失败后本地指针漂移必须以 facts_changed 结算，落回重新预览"
    );
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "rolled_back",
        "facts_changed 预览必须被结算为终态"
    );
    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("a settled preview must not be committable");
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_not_prepared")
    );
}

/// 分类 4 + 3：不支持的决定与 recovery_data 损坏都**不结算**预览。
/// 分类 3 的边界如实注明：预览按"保留"类归入守卫兜底语义，但快照损坏
/// 无法自愈，实际出路仍是重新预览（重新预览会写入全新 recovery_data）。
#[tokio::test]
async fn unsupported_decision_and_corrupt_snapshot_keep_the_preview_prepared() {
    let base = archive_server(
        UPSTREAM_ROUTE,
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream\n".to_vec(),
        )]),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;

    // 分类 4：CreateIndependentBranch 不由本入口执行，预览保持可用。
    let preview = prepare_preview(&facade, skill_id).await;
    let error = commit(
        &facade,
        preview.preview_id,
        UpdateDecision::CreateIndependentBranch,
    )
    .await
    .expect_err("unsupported decision must be rejected");
    assert_eq!(
        error_reason(&error),
        Some("source_update_decision_unsupported")
    );
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "prepared",
        "不支持决定不得结算预览：用户可换决定重试"
    );

    // 分类 3：recovery_data 损坏 → 拒绝提交但不结算（守卫兜底语义）。
    {
        let database = facade.database_for_tests();
        let database = database.lock().unwrap();
        let mut record = database
            .operation_repository()
            .get_sync(preview.preview_id)
            .expect("preview record")
            .expect("preview row");
        record.recovery_data = serde_json::json!({});
        database
            .operation_repository()
            .update_sync(&record)
            .expect("corrupt snapshot");
    }
    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("an unparsable snapshot must reject the commit");
    assert_eq!(error_reason(&error), Some("source_update_preview_invalid"));
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "prepared",
        "快照损坏不结算预览（与实现现状一致，按保留类归类并注明边界）"
    );
}

/// 分类 10 + 11：主体从 catalog 消失 → 预览被结算（facts_changed，必须
/// 重新预览）；物理变更前的采用快照失败 → 预览保持 Prepared 可重试。
#[tokio::test]
async fn missing_skill_settles_while_pre_checkpoint_rejection_keeps_the_preview() {
    let base = archive_server(
        UPSTREAM_ROUTE,
        repo_zip(vec![(
            "skills-main/pdf/SKILL.md".into(),
            b"# Changed upstream\n".to_vec(),
        )]),
    );
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    let facade = facade_with_library(&database_path, &library_root);
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));

    // 分类 10：主体消失，提交前重核失败 → 预览结算为 facts_changed。
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;
    {
        let database = facade.database_for_tests();
        let database = database.lock().unwrap();
        database
            .connection_for_test()
            .execute("DELETE FROM skills WHERE id=?1", [skill_id.to_string()])
            .expect("remove skill row");
    }
    let error = commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("a vanished skill must fail the commit");
    assert_eq!(
        error_reason(&error),
        Some("source_update_preview_facts_changed")
    );
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "rolled_back",
        "主体消失属于事实变化：预览必须结算，重新预览是唯一出路"
    );

    // 分类 11：可见树被外部替换成文件 → 采用快照失败（物理变更前），
    // 仅 adoption journal 结算，预览保持 Prepared。
    let skill_id = import_skill_with_upstream(&facade, "# Portable\n").await;
    let preview = prepare_preview(&facade, skill_id).await;
    let visible = visible_skill_tree(&library_root, skill_id);
    std::fs::remove_dir_all(&visible).expect("remove visible tree");
    std::fs::write(&visible, b"not a directory").expect("replace tree with a file");
    commit(&facade, preview.preview_id, UpdateDecision::TakeUpstream)
        .await
        .expect_err("a corrupted visible tree must fail the adoption snapshot");
    assert_eq!(
        preview_phase(&database_path, preview.preview_id),
        "prepared",
        "物理变更前的快照失败只结算 adoption journal，预览保持可重试"
    );
    // 分类 10 在 journal_begin 之前的指针守卫失败，不落 adoption journal；
    // 只有分类 11 的快照失败留下唯一一行 rolled_back（2026-10-04 续做按
    // 实现语义修正，见文件头分类表）。
    assert_eq!(
        adoption_journal_phases(&database_path, "commit_source_update"),
        vec!["rolled_back".to_owned()],
        "分类 11 的快照失败留下 rolled_back 的 adoption journal 行；分类 10 早于 journal_begin 不产行"
    );
}
