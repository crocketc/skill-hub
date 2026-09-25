//! M-14 验收回归：重新导入已入库的 Skill 时，冲突分析必须把完全重复与
//! 同名不同内容都标为需要处理的冲突，绝不返回"无冲突"。
//! 通过公开 Facade（PrepareImport/CommitImport/AnalyzeImport）驱动，无手工 SQL。
//!
//! Task 10 回归：导入提交时的确定性冲突必须落成 `ConflictCaseFact` 持久化，
//! 使冲突组表拥有真实生产写入方；Skill 详情关系概览因此获得真实数据。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{GetRelationshipOverview, RelationshipOverviewScope};
use skillhub_core::relationship::{ConflictClassification, ConflictEvidence, ConflictKind};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, AppResult, ApplicationFacade,
    DuplicateKind, ImportCandidate, ImportDecision, PrepareImport, SourceDescriptor, SourceKind,
    SourceLocator,
};
use skillhub_storage::{CentralLibrary, Database};

fn facade_with(workspace: &std::path::Path) -> LocalApplicationFacade {
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, &library_root)
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
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    prepared
}

async fn commit_copy(facade: &LocalApplicationFacade, prepared: &skillhub_core::PreparedImport) {
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
        }))
        .await
        .expect("commit import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    assert!(
        summary.items[0].skill_id.is_some(),
        "skill landed in library"
    );
}

fn write_skill(root: &std::path::Path, body: &str) {
    std::fs::write(root.join("SKILL.md"), body).expect("write SKILL.md");
}

async fn begin_batch(facade: &LocalApplicationFacade) -> String {
    let started = facade
        .execute(AppCommand::BeginImportBatch(
            skillhub_core::api::BeginImportBatch {},
        ))
        .await
        .expect("begin import batch");
    let AppCommandResult::ImportBatchStarted(started) = started else {
        panic!("expected import batch id");
    };
    started.batch_id
}

#[allow(clippy::too_many_arguments)]
async fn commit_in_batch(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::PreparedImport,
    decision: ImportDecision,
    batch_id: &str,
    candidate_key: &str,
) -> AppResult<Box<skillhub_core::ImportSummary>> {
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
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
            batch_id: Some(batch_id.to_owned()),
            candidate_key: Some(candidate_key.to_owned()),
        }))
        .await;
    match committed {
        Ok(AppCommandResult::ImportSummary(summary)) => Ok(summary),
        Ok(other) => panic!("expected import summary, got {other:?}"),
        Err(error) => Err(error),
    }
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
    commit_copy(&facade, &first).await;

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
    commit_copy(&facade, &first).await;

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
        .find(|conflict| conflict.kind == DuplicateKind::SameRuntimeNameDifferentContent)
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

// ===== Task 10：冲突组生产写入链路（导入提交 → ConflictCaseFact 持久化） =====

use skillhub_core::relationship::{ConflictCaseFact, ConflictMemberFact};
use skillhub_core::SkillId;

/// 通用提交：确认每个治理组后按给定决策提交。
async fn commit_with(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::PreparedImport,
    decision: ImportDecision,
) -> Box<skillhub_core::ImportSummary> {
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
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
        }))
        .await
        .expect("commit import");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    summary
}

async fn conflict_cases_for_skill(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
) -> Vec<ConflictCaseFact> {
    let result = facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::Skill { skill_id },
        }))
        .await
        .expect("relationship overview");
    let AppQueryResult::RelationshipOverview(overview) = result else {
        panic!("expected relationship overview");
    };
    overview.conflict_cases
}

async fn all_conflict_cases(facade: &LocalApplicationFacade) -> Vec<ConflictCaseFact> {
    let result = facade
        .query(AppQuery::GetRelationshipOverview(GetRelationshipOverview {
            scope: RelationshipOverviewScope::All,
        }))
        .await
        .expect("relationship overview");
    let AppQueryResult::RelationshipOverview(overview) = result else {
        panic!("expected relationship overview");
    };
    overview.conflict_cases
}

/// 预置一个既有冲突组（模拟冲突裁决流程先留下的裁决记录）。
fn seed_case(database: &Database, conflict_id: &str, decision: Option<ConflictClassification>) {
    database
        .conflict_repository()
        .create_case(&ConflictCaseFact {
            conflict_id: conflict_id.to_owned(),
            kind: ConflictKind::SameNameDifferentContent,
            classification: ConflictClassification::Uncertain,
            member_skill_ids: Vec::new(),
            members: Vec::new(),
            evidence: ConflictEvidence {
                fingerprints_match: Some(false),
                names_match: Some(true),
                identity_direction: None,
                sufficient_identity_evidence: false,
            },
            user_decision: decision,
            decided_at: decision.map(|_| 42),
        })
        .expect("seed conflict case");
}

#[tokio::test]
async fn keep_independent_import_persists_the_conflict_case_for_the_relationship_overview() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let first = prepare(&facade, source.path(), "Notes").await;
    let first_summary = commit_with(&facade, &first, ImportDecision::CopyIntoLibrary).await;
    let library_skill = first_summary.items[0].skill_id.expect("first import");

    // 同名不同内容：用户选择保留独立副本。第二次导入来自不同物理目录，
    // 不触发来源身份冲突（该场景由 identity_conflict 专门覆盖）。
    let second_source = tempfile::tempdir().expect("second source");
    write_skill(second_source.path(), "# Notes rewritten\n");
    let second = prepare(&facade, second_source.path(), "Notes").await;
    assert_eq!(
        second.analysis.duplicate_kind,
        Some(DuplicateKind::SameRuntimeNameDifferentContent)
    );
    let summary = commit_with(&facade, &second, ImportDecision::KeepIndependent).await;
    let imported_skill = summary.items[0].skill_id.expect("independent import");

    let cases = conflict_cases_for_skill(&facade, imported_skill).await;
    assert_eq!(
        cases.len(),
        1,
        "the production import path must feed the conflict group table"
    );
    let case = &cases[0];
    assert_eq!(
        case.conflict_id, "import-conflict:same_name_different_content:notes",
        "conflict id is deterministic across imports"
    );
    assert_eq!(case.kind, ConflictKind::SameNameDifferentContent);
    assert_eq!(case.classification, ConflictClassification::Uncertain);
    assert_eq!(
        case.user_decision,
        Some(ConflictClassification::DistinctSkill)
    );
    assert!(
        case.decided_at.is_some_and(|at| at > 0),
        "decided at recorded"
    );
    assert_eq!(case.member_skill_ids, vec![library_skill, imported_skill]);
    assert_eq!(case.members.len(), 2);
    let library_member: &ConflictMemberFact = &case.members[0];
    assert_eq!(library_member.skill_id, Some(library_skill));
    assert!(
        library_member
            .path
            .as_deref()
            .is_some_and(|path| !path.is_empty()),
        "library member carries the visible central path"
    );
    assert!(library_member.fingerprint.is_some());
    let importer_member = &case.members[1];
    assert_eq!(importer_member.skill_id, Some(imported_skill));
    assert_eq!(
        importer_member.path.as_deref(),
        Some(second_source.path().to_string_lossy().as_ref())
    );
    assert!(importer_member.fingerprint.is_some());
}

#[tokio::test]
async fn repeated_reuse_imports_keep_one_conflict_group_without_user_decision() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let first = prepare(&facade, source.path(), "Notes").await;
    let summary = commit_with(&facade, &first, ImportDecision::CopyIntoLibrary).await;
    let library_skill = summary.items[0].skill_id.expect("first import");

    // 完全重复：复用既有 Skill。指纹一致是确定性事实，无需用户裁决身份。
    let reuse = prepare(&facade, source.path(), "Notes").await;
    assert_eq!(
        reuse.analysis.duplicate_kind,
        Some(DuplicateKind::ExactContent)
    );
    let reused = commit_with(&facade, &reuse, ImportDecision::ReuseExisting).await;
    assert_eq!(reused.items[0].skill_id, Some(library_skill));

    let cases = conflict_cases_for_skill(&facade, library_skill).await;
    assert_eq!(
        cases.len(),
        1,
        "repeated imports must not duplicate the group"
    );
    let case = &cases[0];
    assert_eq!(
        case.conflict_id,
        "import-conflict:duplicate_same_content:notes"
    );
    assert_eq!(case.kind, ConflictKind::DuplicateSameContent);
    assert_eq!(
        case.classification,
        ConflictClassification::SameSkillVersion
    );
    assert_eq!(case.user_decision, None);
    assert_eq!(case.decided_at, None);
    assert_eq!(case.members.len(), 2);
    assert_eq!(
        case.members[0].fingerprint, case.members[1].fingerprint,
        "exact content means identical fingerprints on both members"
    );

    // 再次重复导入同一来源：仍是同一冲突组。
    let again = prepare(&facade, source.path(), "Notes").await;
    commit_with(&facade, &again, ImportDecision::ReuseExisting).await;
    assert_eq!(
        conflict_cases_for_skill(&facade, library_skill).await.len(),
        1
    );
}

#[tokio::test]
async fn unadjudicated_imports_never_clobber_an_existing_user_decision() {
    let workspace = tempfile::tempdir().expect("workspace");
    let db_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    {
        let database = Database::open(&db_path).expect("database");
        seed_case(
            &database,
            "import-conflict:duplicate_same_content:notes",
            Some(ConflictClassification::DistinctSkill),
        );
    }
    let facade = LocalApplicationFacade::new_with_library(
        Database::open(&db_path).expect("database"),
        &library_root,
    );
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let first = prepare(&facade, source.path(), "Notes").await;
    commit_with(&facade, &first, ImportDecision::CopyIntoLibrary).await;

    // 完全重复推导不出用户裁决身份（None），绝不能拿 None 覆盖既有裁决。
    // 第二次导入来自不同物理目录的相同内容，不触发来源身份冲突。
    let second_source = tempfile::tempdir().expect("second source");
    write_skill(second_source.path(), "# Notes\n");
    let reuse = prepare(&facade, second_source.path(), "Notes").await;
    commit_with(&facade, &reuse, ImportDecision::CopyIntoLibrary).await;

    let cases = all_conflict_cases(&facade).await;
    assert_eq!(cases.len(), 1);
    assert_eq!(
        cases[0].conflict_id,
        "import-conflict:duplicate_same_content:notes"
    );
    assert_eq!(
        cases[0].user_decision,
        Some(ConflictClassification::DistinctSkill),
        "an existing decision must survive an unadjudicated import"
    );
    assert_eq!(
        cases[0].decided_at,
        Some(42),
        "preserved decision keeps decided_at"
    );
}

#[tokio::test]
async fn an_explicit_new_decision_updates_the_case_and_refreshes_decided_at() {
    let workspace = tempfile::tempdir().expect("workspace");
    let db_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    {
        let database = Database::open(&db_path).expect("database");
        seed_case(
            &database,
            "import-conflict:same_name_different_content:notes",
            Some(ConflictClassification::SameSkillVersion),
        );
    }
    let facade = LocalApplicationFacade::new_with_library(
        Database::open(&db_path).expect("database"),
        &library_root,
    );
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let first = prepare(&facade, source.path(), "Notes").await;
    commit_with(&facade, &first, ImportDecision::CopyIntoLibrary).await;

    // 显式新裁决：以其更新并刷新 decided_at。第二次导入来自不同物理
    // 目录，不触发来源身份冲突。
    let second_source = tempfile::tempdir().expect("second source");
    write_skill(second_source.path(), "# Notes rewritten\n");
    let second = prepare(&facade, second_source.path(), "Notes").await;
    commit_with(&facade, &second, ImportDecision::KeepIndependent).await;

    let cases = all_conflict_cases(&facade).await;
    assert_eq!(cases.len(), 1);
    assert_eq!(
        cases[0].user_decision,
        Some(ConflictClassification::DistinctSkill)
    );
    assert!(
        cases[0].decided_at.is_some_and(|at| at > 42),
        "an explicit decision refreshes decided_at"
    );
    assert_eq!(cases[0].members.len(), 2, "members are replaced wholesale");
}

#[tokio::test]
async fn skip_never_creates_or_touches_conflict_cases() {
    let workspace = tempfile::tempdir().expect("workspace");
    let db_path = workspace.path().join("db.sqlite");
    let library_root = workspace.path().join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    {
        let database = Database::open(&db_path).expect("database");
        seed_case(
            &database,
            "import-conflict:same_name_different_content:notes",
            Some(ConflictClassification::DistinctSkill),
        );
    }
    let facade = LocalApplicationFacade::new_with_library(
        Database::open(&db_path).expect("database"),
        &library_root,
    );
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let first = prepare(&facade, source.path(), "Notes").await;
    commit_with(&facade, &first, ImportDecision::CopyIntoLibrary).await;
    write_skill(source.path(), "# Notes rewritten\n");
    let second = prepare(&facade, source.path(), "Notes").await;
    assert_eq!(
        second.analysis.duplicate_kind,
        Some(DuplicateKind::SameRuntimeNameDifferentContent)
    );

    let summary = commit_with(&facade, &second, ImportDecision::Skip).await;
    assert_eq!(summary.items[0].skill_id, None, "skip imports nothing");

    let cases = all_conflict_cases(&facade).await;
    assert_eq!(cases.len(), 1, "skip must not create a new case");
    assert_eq!(
        cases[0].conflict_id,
        "import-conflict:same_name_different_content:notes"
    );
    assert_eq!(
        cases[0].user_decision,
        Some(ConflictClassification::DistinctSkill)
    );
    assert_eq!(cases[0].decided_at, Some(42), "existing case untouched");
    assert!(cases[0].members.is_empty(), "seeded members stay untouched");
}

#[tokio::test]
async fn batch_lifecycle_maps_every_outcome_and_finalizes_once() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let batch_id = begin_batch(&facade).await;

    // 成功项：事件 + 批次项 + 活动来源关系，summary 携带批次上下文。
    let prepared = prepare(&facade, source.path(), "Notes").await;
    let summary = commit_in_batch(
        &facade,
        &prepared,
        ImportDecision::CopyIntoLibrary,
        &batch_id,
        "acq|notes",
    )
    .await
    .expect("first commit");
    let skill_id = summary.items[0].skill_id.expect("skill id");
    assert_eq!(
        summary.batch.as_ref().expect("batch context").batch_id,
        batch_id
    );

    // 跳过项：只有批次项，没有事件。
    let second = prepare(&facade, source.path(), "Notes").await;
    let skipped = commit_in_batch(
        &facade,
        &second,
        ImportDecision::Skip,
        &batch_id,
        "acq|notes|skip",
    )
    .await
    .expect("skip commit");

    let database = facade.database_for_tests().clone();
    {
        let database = database.lock().unwrap();
        let events = database
            .provenance_repository()
            .list_provenance_events_for_skill(skill_id)
            .expect("events");
        assert_eq!(events.len(), 1, "skip must not append an event");
        let skipped_items: i64 = database
            .connection_for_test()
            .query_row(
                "SELECT COUNT(*) FROM import_batch_items WHERE batch_id=?1 AND status='skipped'",
                [batch_id.as_str()],
                |row| row.get(0),
            )
            .expect("skipped items");
        assert_eq!(skipped_items, 1, "skip records a batch item only");
    }
    let _ = skipped;

    // 终结：从持久化映射计算 manageable_source_count，重复终结幂等。
    let finalized = facade
        .execute(AppCommand::FinalizeImportBatch(
            skillhub_core::api::FinalizeImportBatch {
                batch_id: batch_id.clone(),
            },
        ))
        .await
        .expect("finalize");
    let AppCommandResult::ImportBatchFinalized(finalized) = finalized else {
        panic!("expected batch finalization");
    };
    assert_eq!(finalized.batch_id, batch_id);
    assert_eq!(finalized.manageable_source_count, 1);
    let replay = facade
        .execute(AppCommand::FinalizeImportBatch(
            skillhub_core::api::FinalizeImportBatch { batch_id },
        ))
        .await
        .expect("finalize replay is idempotent");
    let AppCommandResult::ImportBatchFinalized(replay) = replay else {
        panic!("expected batch finalization");
    };
    assert_eq!(replay.manageable_source_count, 1);
}

#[tokio::test]
async fn reuse_existing_appends_evidence_and_keeps_one_active_relation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let batch_id = begin_batch(&facade).await;

    let first = prepare(&facade, source.path(), "Notes").await;
    let first_summary = commit_in_batch(
        &facade,
        &first,
        ImportDecision::CopyIntoLibrary,
        &batch_id,
        "acq|notes|1",
    )
    .await
    .expect("copy commit");
    let skill_id = first_summary.items[0].skill_id.expect("skill id");

    let second = prepare(&facade, source.path(), "Notes").await;
    let second_summary = commit_in_batch(
        &facade,
        &second,
        ImportDecision::ReuseExisting,
        &batch_id,
        "acq|notes|2",
    )
    .await
    .expect("reuse commit");
    assert_eq!(
        second_summary.items[0].skill_id,
        Some(skill_id),
        "reuse resolves to the matched skill"
    );

    let database = facade.database_for_tests().clone();
    let database = database.lock().unwrap();
    let repository = database.provenance_repository();
    let events = repository
        .list_provenance_events_for_skill(skill_id)
        .expect("events");
    assert_eq!(
        events.len(),
        2,
        "every successful import appends its own event"
    );
    let relations = database
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("relations");
    assert_eq!(
        relations.len(),
        1,
        "one active relation per physical source"
    );
    let relation_id = relations[0].relation_id.clone();
    let mapped: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM import_batch_items \
             WHERE batch_id=?1 AND status='succeeded' AND source_relation_id=?2",
            rusqlite::params![batch_id.as_str(), relation_id.as_str()],
            |row| row.get(0),
        )
        .expect("mapped items");
    assert_eq!(mapped, 2, "both batch items map the active relation");
}

#[tokio::test]
async fn identity_conflict_demands_decision_and_never_overwrites() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let batch_id = begin_batch(&facade).await;

    let first = prepare(&facade, source.path(), "Notes").await;
    let first_summary = commit_in_batch(
        &facade,
        &first,
        ImportDecision::CopyIntoLibrary,
        &batch_id,
        "acq|notes|a",
    )
    .await
    .expect("copy commit");
    let skill_a = first_summary.items[0].skill_id.expect("skill a");

    // 同一物理目录内容变化后再次导入并保留独立副本：物理身份已活动
    // 映射 A，指向新 Skill 的决策必须返回 needs_identity_decision 且
    // 不覆盖旧关系。
    write_skill(source.path(), "# Notes rewritten\n");
    let second = prepare(&facade, source.path(), "Notes").await;
    let conflict = commit_in_batch(
        &facade,
        &second,
        ImportDecision::KeepIndependent,
        &batch_id,
        "acq|notes|b",
    )
    .await
    .expect_err("identity conflict must fail the commit");
    assert_eq!(conflict.code, skillhub_core::ErrorCode::OperationConflict);

    let database = facade.database_for_tests().clone();
    let database = database.lock().unwrap();
    let relations = database
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("relations");
    assert_eq!(relations.len(), 1);
    assert_eq!(relations[0].skill_id, skill_a, "old relation stands");
}

#[tokio::test]
async fn legacy_establish_managed_relation_is_rejected_without_writes() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let batch_id = begin_batch(&facade).await;

    let prepared = prepare(&facade, source.path(), "Notes").await;
    let error = commit_in_batch(
        &facade,
        &prepared,
        ImportDecision::EstablishManagedRelation,
        &batch_id,
        "acq|notes|legacy",
    )
    .await
    .expect_err("legacy decision is rejected");
    assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);

    let database = facade.database_for_tests().clone();
    let database = database.lock().unwrap();
    let skills: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM skills", [], |row| row.get(0))
        .expect("skill count");
    assert_eq!(skills, 0, "no skill was created");
    let events: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM import_provenance_events_v19",
            [],
            |row| row.get(0),
        )
        .expect("event count");
    assert_eq!(events, 0, "no event was written");
    let _ = batch_id;
}

/// 15.8 跨层回归：进程重启后打开的导入批次仍然可查询恢复。批次列表来自
/// 持久化存储，新 facade 实例（模拟重启）必须看到未终结批次；终结后消失。
#[tokio::test]
async fn open_import_batches_survive_a_facade_restart_and_clear_after_finalize() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = tempfile::tempdir().expect("source");
    write_skill(source.path(), "# Notes\n");
    let batch_id = begin_batch(&facade).await;

    async fn find_open(
        facade: &LocalApplicationFacade,
        batch_id: &str,
    ) -> skillhub_core::api::OpenImportBatch {
        let result = facade
            .query(AppQuery::QueryOpenImportBatch(
                skillhub_core::api::QueryOpenImportBatch {},
            ))
            .await
            .expect("open batches");
        let AppQueryResult::OpenImportBatches(batches) = result else {
            panic!("expected open import batches");
        };
        batches
            .into_iter()
            .find(|batch| batch.batch_id == batch_id)
            .expect("batch is still open")
    }

    // 同一实例与重启后的新实例都看到该批次。
    let seen = find_open(&facade, &batch_id).await;
    assert_eq!(seen.batch_id, batch_id);

    drop(facade);
    let restarted = facade_with(workspace.path());
    let seen_after_restart = find_open(&restarted, &batch_id).await;
    assert_eq!(seen_after_restart.batch_id, batch_id);
    assert!(
        seen_after_restart.started_at > 0,
        "started_at is a real epoch value"
    );

    // 终结后批次不再出现在打开列表。
    let prepared = prepare(&restarted, source.path(), "Notes").await;
    let _ = commit_in_batch(
        &restarted,
        &prepared,
        ImportDecision::CopyIntoLibrary,
        &batch_id,
        "acq|restart|notes",
    )
    .await
    .expect("commit in reopened batch");
    let AppCommandResult::ImportBatchFinalized(_) = restarted
        .execute(AppCommand::FinalizeImportBatch(
            skillhub_core::api::FinalizeImportBatch {
                batch_id: batch_id.clone(),
            },
        ))
        .await
        .expect("finalize")
    else {
        panic!("expected batch finalization");
    };
    let result = restarted
        .query(AppQuery::QueryOpenImportBatch(
            skillhub_core::api::QueryOpenImportBatch {},
        ))
        .await
        .expect("open batches");
    let AppQueryResult::OpenImportBatches(remaining) = result else {
        panic!("expected open import batches");
    };
    assert!(
        !remaining.iter().any(|batch| batch.batch_id == batch_id),
        "finalized batch leaves the open list"
    );
}
