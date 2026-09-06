//! N7：仓库发现导入的长期上游来源记录。
//!
//! 下载目录在扫描/导入时被盖上上游坐标（url/branch/directory），提交导入后坐标
//! 落库为长期 git 来源（sources.metadata_json + skill_sources），供后续远端更新
//! 检测使用。本地导入不受影响（无坐标 → 不落库）。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade,
    DiscoverImportCandidates, ImportCandidate, ImportDecision, PrepareImport, SourceDescriptor,
    SourceKind, SourceLocator, UpstreamOrigin,
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

#[tokio::test]
async fn downloaded_repo_paths_stamp_upstream_onto_scanned_candidates() {
    let workspace = tempfile::tempdir().expect("workspace");
    let library = workspace.path().join("library");
    let facade = facade_with_library(&workspace.path().join("db.sqlite"), &library);
    let downloaded = tempfile::tempdir().expect("downloaded dir");
    write_skill_source(downloaded.path());

    facade.register_upstream_origin(downloaded.path().to_string_lossy(), origin());

    let result = facade
        .query(AppQuery::DiscoverImportCandidates(
            DiscoverImportCandidates {
                source: SourceDescriptor::new(
                    SourceKind::Local,
                    SourceLocator::local_path(downloaded.path()),
                ),
            },
        ))
        .await
        .expect("candidates");
    let AppQueryResult::ImportCandidates(candidates) = result else {
        panic!("expected import candidates");
    };
    assert!(!candidates.is_empty());
    for candidate in &candidates {
        let upstream = candidate.upstream.as_ref().expect("stamped upstream");
        assert_eq!(upstream.url, "https://github.com/anthropics/skills");
        assert_eq!(upstream.branch, "main");
        assert_eq!(upstream.directory, "pdf");
    }
}

#[tokio::test]
async fn commit_import_records_upstream_origin_as_long_term_git_source() {
    let workspace = tempfile::tempdir().expect("workspace");
    let library = workspace.path().join("library");
    let facade = facade_with_library(&workspace.path().join("db.sqlite"), &library);
    let source = tempfile::tempdir().expect("source");
    write_skill_source(source.path());
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
    let skill_id = summary.items[0].skill_id.expect("imported skill id");

    let reader = Database::open(workspace.path().join("db.sqlite")).expect("reader database");
    let upstream = reader
        .source_repository()
        .upstream_for_skill(skill_id)
        .expect("upstream lookup")
        .expect("long-term origin recorded");
    assert_eq!(upstream.url, "https://github.com/anthropics/skills");
    assert_eq!(upstream.branch, "main");
    assert_eq!(upstream.directory, "pdf");

    let descriptor = reader
        .source_repository()
        .for_skill(skill_id)
        .expect("source lookup")
        .expect("origin source");
    assert_eq!(descriptor.kind, SourceKind::Git);
}

#[tokio::test]
async fn local_imports_without_upstream_do_not_record_git_sources() {
    let workspace = tempfile::tempdir().expect("workspace");
    let library = workspace.path().join("library");
    let facade = facade_with_library(&workspace.path().join("db.sqlite"), &library);
    let source = tempfile::tempdir().expect("source");
    write_skill_source(source.path());
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source.path())),
        source.path().to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
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
    let skill_id = summary.items[0].skill_id.expect("imported skill id");

    let reader = Database::open(workspace.path().join("db.sqlite")).expect("reader database");
    assert!(reader
        .source_repository()
        .upstream_for_skill(skill_id)
        .expect("upstream lookup")
        .is_none());
}
