//! W1-3（FB-006 裁决 A）：导入检查结果登记为该版本首次基础检查记录。
//!
//! 裁决口径：导入边界扫描结果保存并绑定该内容版本，标注来源
//! "导入时检查"（trigger=import）；导入后查询显示真实状态，重启保留；
//! 同版本已有检查记录时不覆盖；登记持久化失败则导入整体失败、不留
//! "看似成功"的库状态；扫描树与落库版本不一致时不登记（如实缺记录）。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, CommitImport, GetBasicCheckResult,
    PrepareImport, RunBasicCheck,
};
use skillhub_core::check::{CheckKind, CheckRunPhase, CheckTrigger};
use skillhub_core::{
    ApplicationFacade, ImportCandidate, ImportDecision, SourceDescriptor, SourceKind, SourceLocator,
};
use skillhub_storage::{CentralLibrary, Database};

struct Workspace {
    _root: tempfile::TempDir,
    library_root: std::path::PathBuf,
    database_path: std::path::PathBuf,
}

fn workspace() -> Workspace {
    let root = tempfile::tempdir().expect("workspace root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    Workspace {
        _root: root,
        library_root,
        database_path,
    }
}

fn facade_for(ws: &Workspace) -> LocalApplicationFacade {
    let database = Database::open(&ws.database_path).expect("open database");
    LocalApplicationFacade::new_with_library(database, &ws.library_root)
}

fn write_clean_skill(root: &std::path::Path, body: &str) {
    std::fs::write(root.join("SKILL.md"), body).expect("write SKILL.md");
}

async fn prepare(
    facade: &LocalApplicationFacade,
    root: &std::path::Path,
    name: &str,
) -> Box<skillhub_core::PreparedImport> {
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root)),
        root.to_string_lossy(),
        ".",
        "SKILL.md",
        name,
    );
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
    prepared
}

async fn commit(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::PreparedImport,
    decision: ImportDecision,
) -> Result<Box<skillhub_core::ImportSummary>, skillhub_core::AppError> {
    let committed = facade
        .execute(AppCommand::CommitImport(CommitImport {
            prepared_import_id: prepared.id,
            decision,
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
        .await;
    match committed {
        Ok(AppCommandResult::ImportSummary(summary)) => Ok(summary),
        Ok(other) => panic!("expected import summary, got {other:?}"),
        Err(error) => Err(error),
    }
}

fn current_run(
    database: &Database,
    skill_id: skillhub_core::SkillId,
    version_id: &skillhub_core::VersionId,
) -> Option<skillhub_core::check::CheckRun> {
    database
        .check_repository()
        .current_for_version_sync(skill_id, version_id, CheckKind::Basic)
        .expect("read current check run")
}

fn basic_check_row_count(database: &Database, version_id: &skillhub_core::VersionId) -> i64 {
    database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM check_runs WHERE version_id = ?1",
            [version_id.to_string()],
            |row| row.get(0),
        )
        .expect("count check runs")
}

/// RED ①：导入成功后该版本存在 trigger=import 的基础检查记录；门禁扫描
/// 与登记使用同一次扫描，登记走 execute_basic_check 相同的持久化路径。
#[tokio::test]
async fn import_registers_import_triggered_basic_check_run() {
    let ws = workspace();
    let facade = facade_for(&ws);
    let source = tempfile::tempdir().expect("source");
    write_clean_skill(source.path(), "# Notes\n");

    let prepared = prepare(&facade, source.path(), "Notes").await;
    let summary = commit(&facade, &prepared, ImportDecision::CopyIntoLibrary)
        .await
        .expect("commit import");
    let skill_id = summary.items[0]
        .skill_id
        .expect("imported skill landed in library");

    let database = Database::open(&ws.database_path).expect("reopen database");
    let version_id = database
        .current_version(skill_id)
        .expect("read current version")
        .expect("imported version has a pointer");

    let run = current_run(&database, skill_id, &version_id)
        .expect("the imported version must have a basic check run");
    assert_eq!(run.trigger, CheckTrigger::Import);
    assert_eq!(run.phase, CheckRunPhase::Completed);
    assert_eq!(run.ruleset_id.as_deref(), Some("basic-v1"));
    // findings 行与报告一致（门禁放行的内容为零条），随 run 同事务落库。
    assert!(run.findings.is_empty());
    assert_eq!(basic_check_row_count(&database, &version_id), 1);

    // 查询侧透出 trigger：列表/详情/安全页能看到真实状态。
    let queried = facade
        .query(AppQuery::GetBasicCheckResult(GetBasicCheckResult {
            skill_id,
            version_id: version_id.clone(),
        }))
        .await
        .expect("query basic check result");
    let AppQueryResult::BasicCheckResult(result) = queried else {
        panic!("expected basic check result");
    };
    assert_eq!(result.trigger, CheckTrigger::Import);
    assert_eq!(result.state, skillhub_core::check::CheckState::Passed);
    assert_eq!(result.run_id.as_deref(), Some(run.id.as_str()));
}

/// RED ④：facade 重开（重新打开数据库）后导入检查记录仍在——重启保留。
#[tokio::test]
async fn import_check_record_survives_facade_reopen() {
    let ws = workspace();
    let skill_id = {
        let facade = facade_for(&ws);
        let source = tempfile::tempdir().expect("source");
        write_clean_skill(source.path(), "# Persistent\n");
        let prepared = prepare(&facade, source.path(), "Persistent").await;
        let summary = commit(&facade, &prepared, ImportDecision::CopyIntoLibrary)
            .await
            .expect("commit import");
        summary.items[0].skill_id.expect("imported skill")
    };

    // 全新 facade（新数据库连接、新库上下文）读取同一条记录。
    let facade = facade_for(&ws);
    let database = Database::open(&ws.database_path).expect("reopen database");
    let version_id = database
        .current_version(skill_id)
        .expect("read current version")
        .expect("version pointer survives");
    let run = current_run(&database, skill_id, &version_id)
        .expect("the import check record survives a reopen");
    assert_eq!(run.trigger, CheckTrigger::Import);

    // 重开后的查询侧同样透出导入来源。
    let queried = facade
        .query(AppQuery::GetBasicCheckResult(GetBasicCheckResult {
            skill_id,
            version_id: version_id.clone(),
        }))
        .await
        .expect("query basic check result after reopen");
    let AppQueryResult::BasicCheckResult(result) = queried else {
        panic!("expected basic check result after reopen");
    };
    assert_eq!(result.trigger, CheckTrigger::Import);
}

/// RED ②：登记持久化失败 → 导入整体失败并回滚，不留半程状态。
#[tokio::test]
async fn check_registration_failure_fails_import_without_partial_state() {
    let ws = workspace();
    let facade = facade_for(&ws);
    let source = tempfile::tempdir().expect("source");
    write_clean_skill(source.path(), "# Doomed\n");
    let prepared = prepare(&facade, source.path(), "Doomed").await;

    // 注入确定性失败：check_runs 拒绝一切插入。
    facade
        .database_for_tests()
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER block_check_runs BEFORE INSERT ON check_runs
             BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END;",
        )
        .expect("inject failing trigger");

    let error = commit(&facade, &prepared, ImportDecision::CopyIntoLibrary)
        .await
        .expect_err("a failing check registration must fail the import");
    assert_eq!(
        error.code,
        skillhub_core::ErrorCode::InternalError,
        "the injected persistence failure surfaces as an internal error"
    );

    // 无半程状态：catalog、版本、可见树全部回滚。
    let database = Database::open(&ws.database_path).expect("reopen database");
    let skills: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM skills", [], |row| row.get(0))
        .expect("count skills");
    let versions: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM versions", [], |row| row.get(0))
        .expect("count versions");
    let runs: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM check_runs", [], |row| row.get(0))
        .expect("count check runs");
    assert_eq!(skills, 0, "no catalog row may survive a failed import");
    assert_eq!(versions, 0, "no version row may survive a failed import");
    assert_eq!(runs, 0, "no check run may survive a failed import");
    let skills_dir = ws.library_root.join("skills");
    let visible: Vec<String> = std::fs::read_dir(&skills_dir)
        .expect("visible skills dir")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        visible.is_empty(),
        "no materialized visible tree may survive a failed import, found {visible:?}"
    );
}

/// RED ③：同内容以复用决定再次导入时不新增任何检查记录——版本已有的
/// 记录（导入登记 + 手动检查）保持原样，手动结果仍是 current，不被
/// import 记录覆盖。
#[tokio::test]
async fn reimport_with_existing_manual_run_does_not_add_import_run() {
    let ws = workspace();
    let facade = facade_for(&ws);
    let source = tempfile::tempdir().expect("source");
    write_clean_skill(source.path(), "# Notes\n");

    let first = prepare(&facade, source.path(), "Notes").await;
    let summary = commit(&facade, &first, ImportDecision::CopyIntoLibrary)
        .await
        .expect("first import");
    let skill_id = summary.items[0].skill_id.expect("imported skill");
    let database = Database::open(&ws.database_path).expect("reopen database");
    let version_id = database
        .current_version(skill_id)
        .expect("read current version")
        .expect("version pointer");

    let manual = facade
        .execute(AppCommand::RunBasicCheck(RunBasicCheck {
            skill_id,
            version_id: version_id.clone(),
        }))
        .await
        .expect("manual basic check");
    let AppCommandResult::BasicCheckResult(manual) = manual else {
        panic!("expected basic check result");
    };
    assert_eq!(manual.trigger, CheckTrigger::Manual);

    // 首次导入已登记 import 记录，手动检查追加第二条；复用导入前后
    // 总数都不得再增长。
    assert_eq!(
        basic_check_row_count(&database, &version_id),
        2,
        "import run + manual run coexist before the reimport"
    );

    // 同内容再次导入：完全重复 → 复用决定；不新增任何检查记录。
    let reimport = prepare(&facade, source.path(), "Notes").await;
    let summary = commit(&facade, &reimport, ImportDecision::ReuseExisting)
        .await
        .expect("reimport reuses the existing skill");
    assert_eq!(summary.items[0].skill_id, Some(skill_id));

    let database = Database::open(&ws.database_path).expect("reopen database");
    assert_eq!(
        basic_check_row_count(&database, &version_id),
        2,
        "the reused import must not add a third check run"
    );
    let run = current_run(&database, skill_id, &version_id).expect("current run");
    assert_eq!(run.trigger, CheckTrigger::Manual);
    assert_eq!(run.id, manual.run_id.expect("manual run id"));
}
