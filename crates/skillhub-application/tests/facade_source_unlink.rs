use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, CheckSourceUpdate, GetSkillProvenance,
    GetSourceUpdateStatus, PrepareImport, ReadMarkdownFile, RelinkSource,
};
use skillhub_core::{
    ApplicationFacade, CommitImport, ErrorCode, ImportCandidate, ImportDecision,
    ImportGovernanceDecision, OperationId, SourceDescriptor, SourceKind, SourceLocator,
    SourceState, UnlinkUpdateSource, UpstreamCheckResult, UpstreamOrigin,
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

fn upstream() -> UpstreamOrigin {
    UpstreamOrigin {
        url: "https://github.com/example/skill".into(),
        branch: "main".into(),
        directory: "skills/notes".into(),
    }
}

async fn import_skill(
    facade: &LocalApplicationFacade,
    source_path: &std::path::Path,
) -> skillhub_core::SkillId {
    std::fs::create_dir_all(source_path).expect("create source directory");
    std::fs::write(source_path.join("SKILL.md"), "# Imported notes\n").expect("write skill");
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(source_path)),
        source_path.to_string_lossy(),
        ".",
        "SKILL.md",
        "Imported notes",
    )
    .with_upstream(upstream());
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepare import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    let governance_decision = ImportGovernanceDecision {
        group_actions: prepared
            .analysis
            .governance_groups
            .iter()
            .map(|group| (group.group_id.clone(), group.default_action))
            .collect(),
        item_overrides: Default::default(),
    };
    let committed = facade
        .execute(AppCommand::CommitImport(CommitImport {
            prepared_import_id: prepared.id,
            decision: ImportDecision::CopyIntoLibrary,
            governance_decision,
            batch_id: None,
            candidate_key: None,
            batch_signature: None,
            security_decision: None,
        }))
        .await
        .expect("commit import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary.items[0].skill_id.expect("imported skill id")
}

async fn source_status(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> skillhub_core::SourceUpdateStatus {
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

async fn import_provenance(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> skillhub_core::api::SkillProvenanceResult {
    let result = facade
        .query(AppQuery::GetSkillProvenance(GetSkillProvenance {
            skill_id,
        }))
        .await
        .expect("import provenance");
    let AppQueryResult::SkillProvenance(result) = result else {
        panic!("expected skill provenance");
    };
    result
}

async fn skill_content(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> String {
    let result = facade
        .query(AppQuery::ReadMarkdownFile(ReadMarkdownFile {
            skill_id,
            path: "SKILL.md".into(),
            version_id: None,
        }))
        .await
        .expect("read skill content");
    let AppQueryResult::MarkdownFile(file) = result else {
        panic!("expected markdown file");
    };
    file.markdown
}

fn reject_unlink_operation_commit(facade: &LocalApplicationFacade) {
    let database = facade.database_for_tests();
    database
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER reject_unlink_operation_commit
             BEFORE UPDATE ON operations
             WHEN NEW.kind = 'unlink_update_source' AND NEW.phase = 'committed'
             BEGIN SELECT RAISE(ABORT, 'injected unlink operation commit failure'); END;",
        )
        .expect("install operation commit failure trigger");
}

#[tokio::test]
async fn unlink_preserves_import_events_and_content() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    let source_root = workspace.path().join("source");
    let facade = facade_with_library(&database_path, &library_root);
    let skill_id = import_skill(&facade, &source_root).await;
    let cache_database = Database::open(&database_path).expect("open source cache database");
    cache_database
        .source_repository()
        .record_update_check(
            &UpstreamCheckResult::new(skill_id, SourceState::UpdateAvailable)
                .with_upstream_label(Some("v2.0.0".into()))
                .with_candidate_identity(Some("candidate-1".into())),
        )
        .expect("record update candidate");
    cache_database
        .source_repository()
        .ignore_update(skill_id, "candidate-1", &upstream().url)
        .expect("ignore update candidate");
    drop(cache_database);
    let before_provenance = import_provenance(&facade, skill_id).await;
    let before_content = skill_content(&facade, skill_id).await;
    let before_status = source_status(&facade, skill_id).await;
    let expected_source_revision = before_status
        .association_revision
        .clone()
        .expect("active update source revision");
    assert_eq!(before_status.state, Some(SourceState::UpdateAvailable));
    assert_eq!(
        before_status.candidate_identity.as_deref(),
        Some("candidate-1")
    );
    assert!(before_status.candidate_ignored);

    let result = facade
        .execute(AppCommand::UnlinkUpdateSource(UnlinkUpdateSource {
            skill_id,
            operation_id: OperationId::new(),
            expected_source_revision,
        }))
        .await
        .expect("unlink update source");
    assert!(matches!(result, AppCommandResult::OperationSummary(_)));

    let after_status = source_status(&facade, skill_id).await;
    assert!(
        after_status.association.is_none(),
        "active update source is removed"
    );
    assert_eq!(
        after_status.check_capability,
        skillhub_core::SourceUpdateCheckCapability::NotAssociated
    );
    assert_eq!(
        after_status.state, None,
        "a prior source check is no longer current"
    );
    assert_eq!(after_status.candidate_identity, None);
    assert_eq!(after_status.ignored_candidates, Vec::<String>::new());
    assert_eq!(
        import_provenance(&facade, skill_id).await,
        before_provenance
    );
    assert_eq!(skill_content(&facade, skill_id).await, before_content);

    drop(facade);
    let database = Database::open(&database_path).expect("reopen database");
    let import_events = database
        .provenance_repository()
        .list_provenance_events_for_skill(skill_id)
        .expect("list import events");
    assert_eq!(
        import_events.len(),
        1,
        "unlink must not remove import history"
    );
}

#[tokio::test]
async fn unlink_source_rolls_back_when_operation_journal_commit_fails() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    let source_root = workspace.path().join("source");
    let facade = facade_with_library(&database_path, &library_root);
    let skill_id = import_skill(&facade, &source_root).await;
    let cache_database = Database::open(&database_path).expect("open source cache database");
    cache_database
        .source_repository()
        .record_update_check(
            &UpstreamCheckResult::new(skill_id, SourceState::UpdateAvailable)
                .with_candidate_identity(Some("candidate-rollback".into())),
        )
        .expect("record update candidate");
    cache_database
        .source_repository()
        .ignore_update(skill_id, "candidate-rollback", &upstream().url)
        .expect("ignore update candidate");
    drop(cache_database);
    let before_status = source_status(&facade, skill_id).await;
    let expected_source_revision = before_status
        .association_revision
        .clone()
        .expect("active update source revision");
    assert_eq!(before_status.state, Some(SourceState::UpdateAvailable));
    assert!(before_status.candidate_ignored);
    reject_unlink_operation_commit(&facade);

    let result = facade
        .execute(AppCommand::UnlinkUpdateSource(UnlinkUpdateSource {
            skill_id,
            operation_id: OperationId::new(),
            expected_source_revision,
        }))
        .await;

    assert!(
        result.is_err(),
        "journal failure must fail the unlink command"
    );
    let after_status = source_status(&facade, skill_id).await;
    assert!(after_status.association.is_some());
    assert_eq!(after_status.state, Some(SourceState::UpdateAvailable));
    assert_eq!(
        after_status.candidate_identity.as_deref(),
        Some("candidate-rollback")
    );
    assert!(after_status.candidate_ignored);
}

#[tokio::test]
async fn local_source_remains_associated_without_git_check_capability() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    let import_root = workspace.path().join("imported");
    let local_root = workspace.path().join("local-source");
    let facade = facade_with_library(&database_path, &library_root);
    let skill_id = import_skill(&facade, &import_root).await;
    let before_provenance = import_provenance(&facade, skill_id).await;
    std::fs::create_dir_all(&local_root).expect("create local source");
    std::fs::write(local_root.join("SKILL.md"), "# Local source\n").expect("write local skill");

    facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::local_path(&local_root),
            ),
        }))
        .await
        .expect("relink local update source");

    let linked = source_status(&facade, skill_id).await;
    assert!(linked.association.is_some());
    assert_eq!(
        linked.check_capability,
        skillhub_core::SourceUpdateCheckCapability::LocalDirectory
    );
    assert_eq!(
        linked.state, None,
        "relink invalidates the prior check result"
    );
    assert_eq!(
        import_provenance(&facade, skill_id).await,
        before_provenance
    );

    facade
        .execute(AppCommand::CheckSourceUpdate(CheckSourceUpdate {
            skill_id,
        }))
        .await
        .expect("check local source");
    let checked = source_status(&facade, skill_id).await;
    assert!(checked.association.is_some());
    assert_eq!(
        checked.check_capability,
        skillhub_core::SourceUpdateCheckCapability::LocalDirectory
    );
    assert_eq!(checked.state, Some(SourceState::NoUpstream));
}

#[tokio::test]
async fn repeated_unlink_is_safe_and_stale_revision_cannot_remove_new_source() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    let import_root = workspace.path().join("imported");
    let replacement_root = workspace.path().join("replacement");
    let facade = facade_with_library(&database_path, &library_root);
    let skill_id = import_skill(&facade, &import_root).await;
    let old_revision = source_status(&facade, skill_id)
        .await
        .association_revision
        .expect("old revision");

    std::fs::create_dir_all(&replacement_root).expect("create replacement source");
    std::fs::write(replacement_root.join("SKILL.md"), "# Replacement\n")
        .expect("write replacement skill");
    facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::local_path(&replacement_root),
            ),
        }))
        .await
        .expect("relink replacement source");
    let current = source_status(&facade, skill_id).await;
    assert_ne!(
        current.association_revision.as_deref(),
        Some(old_revision.as_str())
    );

    let stale = facade
        .execute(AppCommand::UnlinkUpdateSource(UnlinkUpdateSource {
            skill_id,
            operation_id: OperationId::new(),
            expected_source_revision: old_revision.clone(),
        }))
        .await
        .expect_err("stale revision must be rejected");
    assert_eq!(stale.code, ErrorCode::OperationConflict);
    assert!(source_status(&facade, skill_id).await.association.is_some());

    let result = facade
        .execute(AppCommand::UnlinkUpdateSource(UnlinkUpdateSource {
            skill_id,
            operation_id: OperationId::new(),
            expected_source_revision: current.association_revision.expect("current revision"),
        }))
        .await
        .expect("unlink current source");
    assert!(matches!(result, AppCommandResult::OperationSummary(_)));
    let repeated = facade
        .execute(AppCommand::UnlinkUpdateSource(UnlinkUpdateSource {
            skill_id,
            operation_id: OperationId::new(),
            expected_source_revision: old_revision,
        }))
        .await
        .expect("repeated unlink is idempotent");
    assert!(matches!(repeated, AppCommandResult::OperationSummary(_)));
    assert!(source_status(&facade, skill_id).await.association.is_none());
}

#[tokio::test]
async fn relinking_the_same_source_invalidates_a_stale_unlink_revision() {
    let workspace = tempfile::tempdir().expect("workspace");
    let database_path = workspace.path().join("skillhub.sqlite");
    let library_root = workspace.path().join("library");
    let source_root = workspace.path().join("imported");
    let facade = facade_with_library(&database_path, &library_root);
    let skill_id = import_skill(&facade, &source_root).await;
    let old_revision = source_status(&facade, skill_id)
        .await
        .association_revision
        .expect("old revision");

    facade
        .execute(AppCommand::RelinkSource(RelinkSource {
            skill_id,
            source: SourceDescriptor::new(SourceKind::Git, SourceLocator::git_url(upstream().url)),
        }))
        .await
        .expect("relink same source");
    let current = source_status(&facade, skill_id).await;
    assert_ne!(
        current.association_revision.as_deref(),
        Some(old_revision.as_str()),
        "a new association must have a new revision even when its locator is unchanged"
    );

    let stale = facade
        .execute(AppCommand::UnlinkUpdateSource(UnlinkUpdateSource {
            skill_id,
            operation_id: OperationId::new(),
            expected_source_revision: old_revision,
        }))
        .await
        .expect_err("old association revision must not unlink the relinked source");
    assert_eq!(stale.code, ErrorCode::OperationConflict);
    assert!(source_status(&facade, skill_id).await.association.is_some());
}
