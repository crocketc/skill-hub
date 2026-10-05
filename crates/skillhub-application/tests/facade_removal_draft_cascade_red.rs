//! W1-2（跟进 4 裁决 A）：删除主体级联清理编辑草稿。
//!
//! 裁决口径：草稿属主体私有数据，删除主体时一并删除全部编辑草稿，
//! 一次确认完成，不残留孤儿草稿；"不丢用户原文件"边界以此为例外。
//!
//! 实现契约（实施计划 §6.2）：`delete_skill` 在 catalog 删除成功后把
//! `drafts/<skill_id>/` 移入同一 `.skillhub/tmp/` 备份区（与 visible-backup
//! 同模式命名），随既有"丢弃备份"步骤一并清理——回滚窗口与主体删除一致；
//! 删除失败或回滚时草稿随主体同命运。`prepare_delete` 的影响结果报告
//! `draft_count`。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{AppCommand, AppCommandResult, CommitDeleteSkill, PrepareDeleteSkill};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{ApplicationFacade, OperationId, RemovalImpact};
use skillhub_storage::{CentralLibrary, Database, MarkdownDraftStore, VersionStore};

struct Workspace {
    _root: tempfile::TempDir,
    library_root: std::path::PathBuf,
    database_path: std::path::PathBuf,
}

fn workspace() -> Workspace {
    let root = tempfile::tempdir().expect("workspace root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    Workspace {
        _root: root,
        library_root,
        database_path,
    }
}

/// 已入库的单版本 Skill：store 指针、portable、可见树就绪，可走完整删除链。
fn seed_imported_skill(library: &CentralLibrary, database: &Database, name: &str) -> Skill {
    let skill = Skill::new(skillhub_core::SkillId::new(), name);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");
    let source = tempfile::tempdir().expect("version source");
    std::fs::write(source.path().join("SKILL.md"), format!("# {name}\n")).expect("write source");
    let store = VersionStore::from_library(library);
    let version = store
        .capture(skill.id(), source.path())
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable metadata");
    library
        .materialize_current_skill(&skill, &version.id)
        .expect("materialize visible tree");
    skill
}

fn drafts_store(library_root: &std::path::Path) -> MarkdownDraftStore {
    MarkdownDraftStore::from_library(
        &CentralLibrary::initialize_with_fault_handler(library_root, Arc::new(|_| false))
            .expect("open central library"),
    )
}

fn drafts_dir(
    library_root: &std::path::Path,
    skill_id: skillhub_core::SkillId,
) -> std::path::PathBuf {
    library_root.join("drafts").join(skill_id.to_string())
}

async fn prepare_delete(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> RemovalImpact {
    let prepared = facade
        .execute(AppCommand::PrepareDeleteSkill(PrepareDeleteSkill {
            skill_id,
        }))
        .await
        .expect("prepare delete");
    let AppCommandResult::RemovalImpact(impact) = prepared else {
        panic!("expected removal impact");
    };
    impact
}

async fn commit_delete(
    facade: &LocalApplicationFacade,
    operation_id: OperationId,
) -> skillhub_core::RemovalResult {
    let committed = facade
        .execute(AppCommand::CommitDeleteSkill(CommitDeleteSkill {
            prepared_delete_id: operation_id,
            decisions: Vec::new(),
        }))
        .await
        .expect("commit delete");
    let AppCommandResult::RemovalResult(result) = committed else {
        panic!("expected removal result");
    };
    result
}

/// RED ③：prepare 影响结果报告该主体的真实草稿数；RED ①：删除后
/// `drafts/<skill_id>/` 不存在，无 drafts 备份残留；RED ②：其他主体的
/// 草稿不受影响。
#[tokio::test]
async fn delete_cascades_subject_drafts_and_reports_draft_count() {
    let ws = workspace();
    let library = CentralLibrary::initialize(&ws.library_root).expect("central library");
    let database = Database::open(&ws.database_path).expect("database");
    let skill = seed_imported_skill(&library, &database, "Drafted");
    let other = seed_imported_skill(&library, &database, "Untouched");

    let drafts = drafts_store(&ws.library_root);
    let version = VersionStore::from_library(&library)
        .current(skill.id())
        .ok()
        .flatten()
        .expect("current version");
    drafts
        .save(
            skill.id(),
            "SKILL.md",
            "# half written\n",
            Some(&version),
            "object-1",
            1,
        )
        .expect("save first draft");
    drafts
        .save(
            skill.id(),
            "docs/notes.md",
            "# notes\n",
            None,
            "object-2",
            2,
        )
        .expect("save second draft");
    drafts
        .save(
            other.id(),
            "SKILL.md",
            "# other draft\n",
            None,
            "object-3",
            3,
        )
        .expect("save other draft");
    assert!(drafts_dir(&ws.library_root, skill.id()).is_dir());

    let facade = LocalApplicationFacade::new_with_library(database, &ws.library_root);
    let impact = prepare_delete(&facade, skill.id()).await;
    assert_eq!(
        impact.draft_count, 2,
        "prepare must report the subject's draft files"
    );

    let result = commit_delete(&facade, impact.operation_id).await;
    assert!(result.central_skill_deleted, "subject deletion succeeds");

    // RED ①：主体草稿目录随删除消失，且不留 tmp 备份残留。
    assert!(
        !drafts_dir(&ws.library_root, skill.id()).exists(),
        "the deleted subject's drafts directory must be gone"
    );
    let tmp_dir = ws.library_root.join(".skillhub").join("tmp");
    let leftovers: Vec<String> = std::fs::read_dir(&tmp_dir)
        .expect("tmp dir")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        leftovers
            .iter()
            .all(|name| !name.starts_with("drafts-backup-")),
        "drafts backup must be discarded with the subject deletion, found {leftovers:?}"
    );

    // RED ②：其他主体的草稿不受影响。
    assert!(
        drafts.load(other.id(), "SKILL.md").expect("load").is_some(),
        "another subject's drafts must be untouched"
    );
    assert!(
        drafts_dir(&ws.library_root, other.id()).is_dir(),
        "another subject's drafts directory must survive"
    );
}

/// RED ③（零草稿）：无草稿主体报告 0，且不产生任何草稿备份痕迹。
#[tokio::test]
async fn delete_without_drafts_reports_zero_and_leaves_no_draft_backup() {
    let ws = workspace();
    let library = CentralLibrary::initialize(&ws.library_root).expect("central library");
    let database = Database::open(&ws.database_path).expect("database");
    let skill = seed_imported_skill(&library, &database, "NoDrafts");

    let facade = LocalApplicationFacade::new_with_library(database, &ws.library_root);
    let impact = prepare_delete(&facade, skill.id()).await;
    assert_eq!(impact.draft_count, 0, "no drafts means a count of zero");

    let result = commit_delete(&facade, impact.operation_id).await;
    assert!(result.central_skill_deleted);
    assert!(
        !ws.library_root
            .join("drafts")
            .join(skill.id().to_string())
            .exists(),
        "no drafts directory may appear for a subject that never had one"
    );
}

/// RED ④：删除流程失败路径不产生孤儿草稿——草稿随主体同命运。主体仍
/// 在（catalog 行保留、恢复材料留存）时草稿必须原位保留；不出现"主体
/// 已删而草稿仍在 drafts/ 下"的静默孤儿。
#[tokio::test]
async fn failed_deletion_keeps_drafts_with_their_subject() {
    let ws = workspace();
    let fault_armed = Arc::new(AtomicBool::new(false));
    let fault_handler: skillhub_storage::ManifestFaultHandler = {
        let fault_armed = Arc::clone(&fault_armed);
        Arc::new(move |point: &str| {
            point == "before_manifest_replace" && fault_armed.swap(false, Ordering::SeqCst)
        })
    };
    // 夹具与 facade 共用同一故障处理器：facade 自建的库实例在 portable
    // manifest 写入点真实失败（restore_portable_skill_record）。
    let library =
        CentralLibrary::initialize_with_fault_handler(&ws.library_root, Arc::clone(&fault_handler))
            .expect("central library");
    let database = Database::open(&ws.database_path).expect("database");
    let skill = seed_imported_skill(&library, &database, "FailedDelete");
    let drafts = drafts_store(&ws.library_root);
    drafts
        .save(
            skill.id(),
            "SKILL.md",
            "# doomed with subject\n",
            None,
            "object-1",
            1,
        )
        .expect("save draft");

    let facade = LocalApplicationFacade::new_with_library_and_faults(
        database,
        &ws.library_root,
        fault_handler,
    );
    let impact = prepare_delete(&facade, skill.id()).await;
    fault_armed.store(true, Ordering::SeqCst);
    let result = commit_delete(&facade, impact.operation_id).await;

    assert!(
        !result.central_skill_deleted,
        "the faulty deletion must not report success"
    );
    assert!(
        result.central_delete_error.is_some(),
        "the deletion failure must surface a stable error code"
    );
    // 草稿随主体：主体 catalog 行仍在（不可逆中断、恢复材料留存），
    // 草稿必须原位保留，而不是变成孤儿。
    let audit = Database::open(&ws.database_path).expect("reopen database");
    assert!(
        audit
            .catalog_repository()
            .expect("catalog repository")
            .get_sync(skill.id())
            .expect("read catalog")
            .is_some(),
        "the interrupted subject keeps its catalog row"
    );
    assert!(
        drafts.load(skill.id(), "SKILL.md").expect("load").is_some(),
        "the draft follows its still-existing subject, never orphaned"
    );
}
