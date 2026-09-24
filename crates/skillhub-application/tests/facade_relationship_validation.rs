//! Task 5A 验收回归：RunRelationshipCheck 按 scope 只检查活动本地关系，
//! MissingWithAccessibleParent 是唯一归档形态（ExternalRemoved 历史），
//! 权限/离线等失败保留活动关系，重复检查不重复写历史、相同状态不推进
//! revision（plan 5.3–5.5、5.11）。

use skillhub_adapters::relationship::FilesystemRelationshipProbe;
use skillhub_application::relationship_validation_service::RelationshipPathProbing;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::RunRelationshipCheck;
use skillhub_core::relationship::RelationshipPathProbe;
use skillhub_core::relationship::{
    RelationshipCheckItemStatus, RelationshipCheckLevel, RelationshipCheckReport,
    RelationshipCheckScope,
};
use skillhub_core::{
    AppCommand, AppCommandResult, ApplicationFacade, ImportCandidate, ImportDecision,
    PrepareImport, SourceDescriptor, SourceKind, SourceLocator,
};
use skillhub_storage::{CentralLibrary, Database};
use std::path::Path;
use std::sync::{Arc, Mutex};

fn facade_with(workspace: &std::path::Path) -> LocalApplicationFacade {
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, &library_root)
}

fn write_skill(root: &Path, body: &str) {
    std::fs::create_dir_all(root).expect("create dir");
    std::fs::write(root.join("SKILL.md"), body).expect("write SKILL.md");
}

async fn import_copy(
    facade: &LocalApplicationFacade,
    root: &Path,
    name: &str,
) -> skillhub_core::SkillId {
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
    summary.items[0].skill_id.expect("skill in library")
}

async fn run_check(
    facade: &LocalApplicationFacade,
    level: RelationshipCheckLevel,
    scope: RelationshipCheckScope,
) -> RelationshipCheckReport {
    let result = facade
        .execute(AppCommand::RunRelationshipCheck(RunRelationshipCheck {
            level,
            scope,
        }))
        .await
        .expect("relationship check");
    let AppCommandResult::RelationshipCheckReport(report) = result else {
        panic!("expected check report");
    };
    report
}

/// Controlled probe: overrides verdicts for paths matching the predicate.
struct OverrideProbe {
    base: FilesystemRelationshipProbe,
    overrides: Mutex<Vec<(String, RelationshipPathProbe)>>,
}

impl OverrideProbe {
    fn override_path(&self, path: &Path, probe: RelationshipPathProbe) {
        self.overrides
            .lock()
            .expect("overrides")
            .push((path.to_string_lossy().into_owned(), probe));
    }
}

impl RelationshipPathProbing for OverrideProbe {
    fn probe(&self, path: &Path) -> RelationshipPathProbe {
        let key = path.to_string_lossy().into_owned();
        let mut overrides = self.overrides.lock().expect("overrides");
        if let Some(position) = overrides.iter().position(|(target, _)| *target == key) {
            let (_, verdict) = overrides.remove(position);
            return verdict;
        }
        drop(overrides);
        self.base.probe(path)
    }
}

fn override_probe_arc() -> Arc<OverrideProbe> {
    Arc::new(OverrideProbe {
        base: FilesystemRelationshipProbe,
        overrides: Mutex::new(Vec::new()),
    })
}

#[tokio::test]
async fn all_active_scope_checks_healthy_relations_and_stays_idempotent() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = workspace.path().join("notes-src");
    write_skill(&source, "# Notes\n");
    import_copy(&facade, &source, "Notes").await;

    // Full 检查：目录健康 → Checked，health 升为 Normal。
    let first = run_check(
        &facade,
        RelationshipCheckLevel::Full,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert_eq!(first.items.len(), 1, "one active local relation");
    assert_eq!(first.items[0].status, RelationshipCheckItemStatus::Checked);
    assert_eq!(
        first.items[0].health,
        Some(skillhub_core::relationship::SourceCopyHealth::Normal)
    );

    // 相同状态立即复查：Unchanged 且 revision 不推进（plan 5.5）。
    let second = run_check(
        &facade,
        RelationshipCheckLevel::Full,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert_eq!(
        second.items[0].status,
        RelationshipCheckItemStatus::Unchanged
    );
    assert_eq!(second.relationship_revision, first.relationship_revision);
}

#[tokio::test]
async fn scopes_limit_the_checked_relation_set() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let alpha_dir = workspace.path().join("alpha-src");
    let beta_dir = workspace.path().join("beta-src");
    write_skill(&alpha_dir, "# Alpha\n");
    write_skill(&beta_dir, "# Beta\n");
    let alpha_skill = import_copy(&facade, &alpha_dir, "Alpha").await;
    import_copy(&facade, &beta_dir, "Beta").await;

    let all = run_check(
        &facade,
        RelationshipCheckLevel::Light,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert_eq!(all.items.len(), 2);

    // Skill scope 只检查该 Skill 的关系。
    let by_skill = run_check(
        &facade,
        RelationshipCheckLevel::Light,
        RelationshipCheckScope::Skill {
            skill_id: alpha_skill,
        },
    )
    .await;
    assert_eq!(by_skill.items.len(), 1);

    // RelationIds scope 只检查列出的关系。
    let relation_id = all.items[0].relation_id.clone();
    let by_ids = run_check(
        &facade,
        RelationshipCheckLevel::Light,
        RelationshipCheckScope::RelationIds {
            relation_ids: vec![relation_id],
        },
    )
    .await;
    assert_eq!(by_ids.items.len(), 1);

    // Agent scope 按 client 归属过滤。
    let by_agent = run_check(
        &facade,
        RelationshipCheckLevel::Light,
        RelationshipCheckScope::Agent {
            client_id: "codebuddy.code".to_owned(),
        },
    )
    .await;
    assert_eq!(
        by_agent.items.len(),
        0,
        "local temp sources carry no client"
    );

    // Project scope：来源副本关系不挂项目容器 → 空集。
    let by_project = run_check(
        &facade,
        RelationshipCheckLevel::Light,
        RelationshipCheckScope::Project {
            project_id: "proj-1".to_owned(),
        },
    )
    .await;
    assert_eq!(by_project.items.len(), 0);
}

#[tokio::test]
async fn batch_scope_selects_relations_created_inside_the_batch() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = workspace.path().join("batched-src");
    write_skill(&source, "# Batched\n");

    let batch = facade
        .execute(AppCommand::BeginImportBatch(
            skillhub_core::api::BeginImportBatch {},
        ))
        .await
        .expect("begin batch");
    let AppCommandResult::ImportBatchStarted(started) = batch else {
        panic!("expected batch id");
    };

    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(&source)),
        source.to_string_lossy(),
        ".",
        "SKILL.md",
        "Batched",
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
    facade
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
            batch_id: Some(started.batch_id.clone()),
            candidate_key: Some("acq|batched".to_owned()),
        }))
        .await
        .expect("commit in batch");

    let in_batch = run_check(
        &facade,
        RelationshipCheckLevel::Light,
        RelationshipCheckScope::Batch {
            batch_id: started.batch_id,
        },
    )
    .await;
    assert_eq!(in_batch.items.len(), 1, "batch items map the relation");
}

#[tokio::test]
async fn missing_source_archives_once_with_external_removed_history() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = workspace.path().join("vanish-src");
    write_skill(&source, "# Vanish\n");
    import_copy(&facade, &source, "Vanish").await;
    std::fs::remove_dir_all(&source).expect("remove source");

    let first = run_check(
        &facade,
        RelationshipCheckLevel::Full,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert_eq!(first.items[0].status, RelationshipCheckItemStatus::Archived);
    assert_eq!(
        first.items[0].reason.as_deref(),
        Some("external_removed"),
        "MissingWithAccessibleParent is the only archiving verdict"
    );

    // 归档后关系离开活动集合，历史只写一条（plan 5.5）。
    let second = run_check(
        &facade,
        RelationshipCheckLevel::Full,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert!(
        second.items.is_empty(),
        "archived relation leaves the scope"
    );

    let database = facade.database_for_tests().clone();
    let database = database.lock().unwrap();
    let history = database
        .governance_history_repository()
        .list_for_relation(&first.items[0].relation_id)
        .expect("history");
    assert_eq!(history.len(), 1, "no duplicate history for one removal");
    assert_eq!(history[0].result, "archived");
    assert_eq!(history[0].reason.as_deref(), Some("external_removed"));
}

#[tokio::test]
async fn permission_denied_and_offline_volume_keep_relations_active() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = workspace.path().join("denied-src");
    write_skill(&source, "# Denied\n");
    import_copy(&facade, &source, "Denied").await;

    let probe = override_probe_arc();
    probe.override_path(&source, RelationshipPathProbe::PermissionDenied);
    facade.set_relationship_probe_for_tests(probe.clone());
    let denied = run_check(
        &facade,
        RelationshipCheckLevel::Full,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert_eq!(denied.items[0].status, RelationshipCheckItemStatus::Checked);
    assert_eq!(
        denied.items[0].health,
        Some(skillhub_core::relationship::SourceCopyHealth::PermissionLimited)
    );

    probe.override_path(&source, RelationshipPathProbe::DriveOrVolumeUnavailable);
    let offline = run_check(
        &facade,
        RelationshipCheckLevel::Full,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert_eq!(
        offline.items[0].health,
        Some(skillhub_core::relationship::SourceCopyHealth::NeedsValidation),
        "volume outage never archives"
    );

    // 两种失败之后关系仍然活动：AllActive 仍能选中它。
    assert_eq!(offline.items.len(), 1);
}
