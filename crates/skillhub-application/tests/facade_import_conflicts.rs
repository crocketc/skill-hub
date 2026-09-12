//! M-14 验收回归：重新导入已入库的 Skill 时，冲突分析必须把完全重复与
//! 同名不同内容都标为需要处理的冲突，绝不返回"无冲突"。
//! 通过公开 Facade（PrepareImport/CommitImport/AnalyzeImport）驱动，无手工 SQL。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    AppCommand, AppCommandResult, ApplicationFacade, DuplicateKind, ImportCandidate,
    ImportDecision, PrepareImport, SourceDescriptor, SourceKind, SourceLocator,
};
use skillhub_storage::{CentralLibrary, Database};

fn facade_with(workspace: &std::path::Path) -> LocalApplicationFacade {
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, &library_root)
}

async fn prepare(facade: &LocalApplicationFacade, root: &std::path::Path, name: &str) -> Box<skillhub_core::PreparedImport> {
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
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    prepared
}

async fn commit_copy(facade: &LocalApplicationFacade, prepared_id: skillhub_core::OperationId) {
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared_id,
            decision: ImportDecision::CopyIntoLibrary,
        }))
        .await
        .expect("commit import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    assert!(summary.items[0].skill_id.is_some(), "skill landed in library");
}

fn write_skill(root: &std::path::Path, body: &str) {
    std::fs::write(root.join("SKILL.md"), body).expect("write SKILL.md");
}

#[tokio::test]
async fn reimporting_the_same_directory_reports_an_exact_duplicate_conflict() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    std::fs::write(source.path().join("USAGE.md"), "how to use\n").expect("write USAGE.md");

    // First import lands the skill in the library.
    let first = prepare(&facade, source.path(), "Notes").await;
    commit_copy(&facade, first.id).await;

    // Re-import the SAME directory: this must surface a conflict, never
    // "nothing to handle".
    let second = prepare(&facade, source.path(), "Notes").await;
    assert_eq!(
        second.analysis.duplicate_kind,
        Some(DuplicateKind::ExactContent),
        "identical trees are recognized as exact content"
    );
    assert!(
        !second.analysis.conflicts.is_empty(),
        "an exact duplicate must be reported as a conflict, not silence"
    );
    let conflict = second
        .analysis
        .conflicts
        .iter()
        .find(|conflict| conflict.kind == DuplicateKind::ExactContent)
        .expect("exact duplicate conflict entry");
    assert!(conflict.requires_choice, "the user decides reuse/copy/skip");
    assert_eq!(conflict.reason_code, "import.exact_duplicate_conflict");
    // 名称可辨：冲突指向的已有 Skill 与候选都带可读名称，而不是只有 UUID。
    let matched = second
        .analysis
        .matches
        .iter()
        .find(|entry| entry.skill_id == conflict.skill_id)
        .expect("match backing the conflict");
    assert_eq!(matched.runtime_name, "Notes");
    assert!(!matched.display_name.is_empty());
    // 路径可辨：候选带着自己的来源路径。
    assert_eq!(
        second.candidate.absolute_root,
        source.path().to_string_lossy()
    );
}

#[tokio::test]
async fn same_runtime_name_with_different_content_reports_a_name_conflict() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let first = prepare(&facade, source.path(), "Notes").await;
    commit_copy(&facade, first.id).await;

    // Same directory, changed content: the runtime name still collides.
    write_skill(source.path(), "# Notes rewritten\n");
    let second = prepare(&facade, source.path(), "Notes").await;
    assert_eq!(
        second.analysis.duplicate_kind,
        Some(DuplicateKind::SameRuntimeNameDifferentContent)
    );
    let conflict = second
        .analysis
        .conflicts
        .iter()
        .find(|conflict| {
            conflict.kind == DuplicateKind::SameRuntimeNameDifferentContent
        })
        .expect("same-name conflict entry");
    assert!(conflict.requires_choice);
    let matched = second
        .analysis
        .matches
        .iter()
        .find(|entry| entry.skill_id == conflict.skill_id)
        .expect("match backing the name conflict");
    assert_eq!(matched.runtime_name, "Notes");
    assert_eq!(matched.display_name, "Notes");
    assert_eq!(
        second.candidate.absolute_root,
        source.path().to_string_lossy()
    );
}
