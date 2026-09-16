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
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, DuplicateKind,
    ImportCandidate, ImportDecision, PrepareImport, SourceDescriptor, SourceKind, SourceLocator,
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

    // 同名不同内容：用户选择保留独立副本。
    write_skill(source.path(), "# Notes rewritten\n");
    let second = prepare(&facade, source.path(), "Notes").await;
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
        Some(source.path().to_string_lossy().as_ref())
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
    let reuse = prepare(&facade, source.path(), "Notes").await;
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

    // 显式新裁决：以其更新并刷新 decided_at。
    write_skill(source.path(), "# Notes rewritten\n");
    let second = prepare(&facade, source.path(), "Notes").await;
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
