//! Development-stage event log wiring (用户 2026-10-07 下单，开发状态待开发项)：
//! 桌面壳把脱敏、有界的 JSON 行日志接到 facade 后，关键路径必须落日志——
//! 操作 journal 的 begin/settle/error（带错误码）、存储层失败的 source 参数
//! （#12 定因缺口）、启动 journal 清扫、原始迁移恢复、盘账异常。脱敏与
//! 轮转本身由 skillhub-adapters 的测试覆盖；这里只验证接线与事件语义。

use skillhub_adapters::logging::LocalLogConfig;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::{AppCommand, ApplicationFacade, OperationId, OperationPhase, OperationRecord};
use skillhub_storage::{CentralLibrary, Database};
use std::sync::Arc;

fn attach_event_log(
    facade: LocalApplicationFacade,
) -> (LocalApplicationFacade, std::path::PathBuf) {
    // 与桌面壳同参数量级：有界 max_bytes，生产默认最小级别。
    let log_directory = std::env::temp_dir()
        .join(format!("skillhub-event-log-{}", OperationId::new()))
        .join("logs");
    let facade = facade.with_event_log(Arc::new(LocalLogConfig::new(
        log_directory.clone(),
        256 * 1024,
    )));
    (facade, log_directory)
}

fn facade_with_log(workspace: &std::path::Path) -> (LocalApplicationFacade, std::path::PathBuf) {
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    attach_event_log(facade)
}

fn log_lines(log_directory: &std::path::Path) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(log_directory.join("skillhub.log"))
        .expect("skillhub.log must exist after key-path activity");
    text.lines()
        .map(|line| serde_json::from_str(line).expect("every log line is one JSON object"))
        .collect()
}

fn events<'a>(lines: &'a [serde_json::Value], code: &str) -> Vec<&'a serde_json::Value> {
    lines
        .iter()
        .filter(|event| event["event_code"] == code)
        .collect()
}

fn param(event: &serde_json::Value, key: &str) -> String {
    event["params"][key].as_str().unwrap_or_default().to_owned()
}

fn count(event: &serde_json::Value, key: &str) -> u64 {
    event["counts"][key].as_u64().unwrap_or(0)
}

fn dismiss_unknown_candidate() -> AppCommand {
    AppCommand::DismissSearchCandidate(skillhub_core::api::DismissSearchCandidate {
        candidate_id: "never-saved".into(),
    })
}

#[tokio::test]
async fn journal_flows_record_begin_settle_and_error_lines() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, logs) = facade_with_log(workspace.path());

    let error = facade
        .execute(dismiss_unknown_candidate())
        .await
        .expect_err("an unknown candidate must fail");
    assert_eq!(error.code.as_str(), "object.not_found");

    let lines = log_lines(&logs);
    let records = events(&lines, "journal.record");
    assert_eq!(records.len(), 2, "begin plus settle records: {lines:?}");
    assert_eq!(records[0]["phase"], "planned");
    assert_eq!(param(records[0], "kind"), "dismiss_search_candidate");
    assert_eq!(records[0]["level"], "info");
    assert_eq!(records[1]["phase"], "rolled_back");
    assert_eq!(param(records[1], "error_code"), "object.not_found");
    assert_eq!(records[1]["level"], "error");
    assert_eq!(
        records[0]["operation_id"], records[1]["operation_id"],
        "begin and settle lines share the operation id"
    );
    assert!(
        records[0]["operation_id"].is_string(),
        "operation ids stay opaque strings in the log"
    );

    let errors = events(&lines, "journal.error");
    assert_eq!(errors.len(), 1, "the failing settle logs one error line");
    assert_eq!(param(errors[0], "kind"), "dismiss_search_candidate");
    assert_eq!(param(errors[0], "error_code"), "object.not_found");
}

#[tokio::test]
async fn storage_failures_log_the_error_code_and_source_params() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, logs) = facade_with_log(workspace.path());

    // #12 式存储失败：表在运行中的 facade 之下消失。journal 表只保留
    // 白名单错误码，source 参数（sqlite 原因）只能由日志留住。
    let second =
        rusqlite::Connection::open(workspace.path().join("db.sqlite")).expect("second connection");
    second
        .execute_batch("DROP TABLE search_candidates")
        .expect("drop the candidates table");
    drop(second);

    let error = facade
        .execute(dismiss_unknown_candidate())
        .await
        .expect_err("a dropped table must fail the command");
    assert_eq!(error.code.as_str(), "internal.error");

    let lines = log_lines(&logs);
    let storage = events(&lines, "storage.error");
    assert!(!storage.is_empty(), "storage errors funnel into the log");
    let last = storage.last().expect("at least one storage error");
    assert_eq!(param(last, "operation"), "execute.dismiss_search_candidate");
    assert_eq!(param(last, "error_code"), "internal.error");
    let source = param(last, "source");
    assert!(
        source.contains("no such table"),
        "the underlying sqlite cause must be preserved: {source}"
    );
    assert_eq!(last["level"], "error");

    let journal_errors = events(&lines, "journal.error");
    assert_eq!(journal_errors.len(), 1);
    assert!(
        param(journal_errors[0], "source").contains("no such table"),
        "the journal error line carries the source detail the journal table drops"
    );
}

#[tokio::test]
async fn attaching_the_logger_reports_the_startup_journal_sweep() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database = Database::open(workspace.path().join("db.sqlite")).expect("database");
    let stale_planned = OperationRecord::planned(OperationId::new(), "delete_skill", "");
    database
        .operation_repository()
        .insert_sync(&stale_planned)
        .expect("seed stale planned row");
    let mut stale_applying = OperationRecord::planned(OperationId::new(), "deploy_skill", "");
    stale_applying.phase = OperationPhase::Applying;
    database
        .operation_repository()
        .insert_sync(&stale_applying)
        .expect("seed stale applying row");
    drop(database);

    // 构造即触发启动清扫（#11 裁决：applying 行转 needs_recovery 记账）。
    let db = Database::open(workspace.path().join("db.sqlite")).expect("reopen database");
    let facade = LocalApplicationFacade::new(db);
    let (_facade, logs) = attach_event_log(facade);

    let lines = log_lines(&logs);
    let sweeps = events(&lines, "startup.journal_sweep");
    assert_eq!(sweeps.len(), 1, "the sweep is reported once: {lines:?}");
    assert_eq!(count(sweeps[0], "rolled_back"), 1);
    assert_eq!(count(sweeps[0], "needs_recovery"), 1);
}

#[tokio::test]
async fn original_migration_recovery_logs_begin_and_done_counts() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, logs) = facade_with_log(workspace.path());

    // 一条备份与原目录都不在的未终态迁移：只能如实转 needs_recovery。
    {
        let database = facade.database_for_tests();
        let database = database.lock().expect("database lock");
        let connection = database.connection_for_test();
        connection
            .execute(
                "INSERT INTO skills (id, display_name, runtime_name, created_at, updated_at) \
                 VALUES ('00000000-0000-0000-0000-000000000001', 'Migrating Skill', 'migrating-skill', 1, 1)",
                [],
            )
            .expect("seed skill row");
        connection
            .execute(
                "INSERT INTO original_migrations \
                 (id, skill_id, original_path, backup_path, content_fingerprint, state, confirmed_at, rolled_back_at, source_relation_id) \
                 VALUES ('a0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', \
                 'Z:/skillhub-missing-original', 'Z:/skillhub-missing-backup', 'fp', 'backed_up', 1, NULL, NULL)",
                [],
            )
            .expect("seed pending migration");
    }

    let advanced = facade
        .recover_original_migrations()
        .expect("migration recovery runs");
    assert_eq!(advanced, 1, "the needs_recovery advance completed");

    let lines = log_lines(&logs);
    let begins = events(&lines, "migration.recovery.begin");
    assert_eq!(begins.len(), 1);
    assert_eq!(count(begins[0], "pending"), 1);
    let dones = events(&lines, "migration.recovery.done");
    assert_eq!(dones.len(), 1);
    assert_eq!(count(dones[0], "needs_recovery"), 1);
    assert_eq!(count(dones[0], "advanced"), 1);
    assert!(
        events(&lines, "migration.recovery.advance").is_empty(),
        "per-record detail is Debug level and stays out under the production default"
    );
}

#[tokio::test]
async fn scan_anomalies_log_inventory_events() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, logs) = facade_with_log(workspace.path());

    // 未注册的 scope：扫描注册必然失败（无效输入也是盘账异常）。
    let error = facade
        .execute(AppCommand::ScanTargets(skillhub_core::api::ScanTargets {
            scope_ids: vec!["never-registered-scope".into()],
        }))
        .await
        .expect_err("an unknown scope must fail the scan");
    assert_eq!(error.code.as_str(), "input.invalid");
    let lines = log_lines(&logs);
    let scan_failed = events(&lines, "inventory.scan.failed");
    assert_eq!(scan_failed.len(), 1);
    assert_eq!(param(scan_failed[0], "error_code"), "input.invalid");
    assert_eq!(scan_failed[0]["level"], "error");

    // 盘账比对阶段失败：扫描走完后 reconcile 在缺表处中断。
    let second =
        rusqlite::Connection::open(workspace.path().join("db.sqlite")).expect("second connection");
    second
        .execute_batch("DROP TABLE observed_deployments")
        .expect("drop the observed deployments table");
    drop(second);

    facade
        .execute(AppCommand::ScanTargets(skillhub_core::api::ScanTargets {
            scope_ids: Vec::new(),
        }))
        .await
        .expect_err("a dropped observed table must fail the reconcile pass");
    let lines = log_lines(&logs);
    assert!(
        !events(&lines, "inventory.reconcile.failed").is_empty(),
        "reconcile failures get their own inventory event: {lines:?}"
    );
    assert!(
        !events(&lines, "inventory.scan.failed").is_empty(),
        "the wrapping scan reports the same failure at its own level"
    );
}

#[tokio::test]
async fn rescan_anomalies_log_inventory_events() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, logs) = facade_with_log(workspace.path());

    let error = facade
        .execute(AppCommand::RescanSkill(skillhub_core::api::RescanSkill {
            scope_id: "never-registered-scope".into(),
            path: "Z:/nowhere".into(),
        }))
        .await
        .expect_err("an unknown scope must fail the rescan");
    assert_eq!(error.code.as_str(), "input.invalid");

    let lines = log_lines(&logs);
    let rescan_failed = events(&lines, "inventory.rescan.failed");
    assert_eq!(rescan_failed.len(), 1);
    assert_eq!(param(rescan_failed[0], "error_code"), "input.invalid");
}

#[tokio::test]
async fn log_writes_never_block_or_fail_operations_without_a_logger() {
    // 未接日志器的 facade（CLI/测试默认）必须照常工作：日志永远是尽力而为。
    let workspace = tempfile::tempdir().expect("workspace");
    let database = Database::open(workspace.path().join("db.sqlite")).expect("database");
    let facade = LocalApplicationFacade::new(database);
    let error = facade
        .execute(dismiss_unknown_candidate())
        .await
        .expect_err("unknown candidate still fails");
    assert_eq!(error.code.as_str(), "object.not_found");
}
