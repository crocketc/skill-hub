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

    // 导入触发已做 Full 校验：关系已是 Normal；显式复查 → Unchanged。
    let first = run_check(
        &facade,
        RelationshipCheckLevel::Full,
        RelationshipCheckScope::AllActive,
    )
    .await;
    assert_eq!(first.items.len(), 1, "one active local relation");
    assert_eq!(
        first.items[0].status,
        RelationshipCheckItemStatus::Unchanged
    );
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

#[tokio::test]
async fn successful_import_immediately_verifies_the_new_relation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = workspace.path().join("fresh-src");
    write_skill(&source, "# Fresh\n");
    import_copy(&facade, &source, "Fresh").await;

    // 5B：导入成功触发 Full 校验 → 关系 health 升为 Normal、有验证时间。
    let database = facade.database_for_tests().clone();
    let database = database.lock().unwrap();
    let relations = database
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("relations");
    assert_eq!(relations.len(), 1);
    assert_eq!(
        relations[0].health,
        skillhub_core::relationship::SourceCopyHealth::Normal,
        "the import trigger verified the fresh relation"
    );
    assert!(relations[0].last_verified_at.is_some());
}

#[tokio::test]
async fn path_scoped_check_only_verifies_relations_on_that_path() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source = workspace.path().join("scoped-src");
    write_skill(&source, "# Scoped\n");
    import_copy(&facade, &source, "Scoped").await;

    let report = facade
        .run_relationship_check_for_path_for_tests(
            source.to_string_lossy().as_ref(),
            RelationshipCheckLevel::Full,
        )
        .expect("path check");
    assert_eq!(report.items.len(), 1, "the path selects its relation");
    assert_eq!(
        report.items[0].health,
        Some(skillhub_core::relationship::SourceCopyHealth::Normal)
    );
    assert_eq!(
        report.items[0].status,
        RelationshipCheckItemStatus::Unchanged
    );

    // 无关路径选不中任何关系。
    let unrelated = facade
        .run_relationship_check_for_path_for_tests(
            workspace.path().join("elsewhere").to_str().unwrap(),
            RelationshipCheckLevel::Full,
        )
        .expect("path check");
    assert!(unrelated.items.is_empty());
}

#[tokio::test]
async fn legacy_reconciliation_reclassifies_only_provable_sources() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let library_root = workspace.path().join("library");

    // 两个迁移形态的 legacy 事件：一个落在集中库内（可证明），
    // 一个是普通用户目录（不可证明）。
    let database = facade.database_for_tests().clone();
    let seed = |provenance_id: &str, skill: skillhub_core::SkillId, path: &str| {
        let database = database.lock().unwrap();
        let repository = database.provenance_repository();
        repository
            .begin_import_batch(&format!("legacy:{provenance_id}"), 42)
            .expect("seed batch");
        database
            .connection_for_test()
            .execute(
                "INSERT INTO import_provenance_events_v19 \
                 (provenance_id, skill_id, source_path, source_path_key, relationship, \
                  file_representation, ownership, content_fingerprint, source_kind, source_locator, \
                  imported_at, batch_id, source_class, local_source_path) \
                 VALUES (?1, ?2, ?3, ?4, 'source_copy', 'directory', 'independent', 'hash-legacy', \
                  'local', ?3, 42, ?5, 'legacy_unclassified', ?3)",
                rusqlite::params![
                    provenance_id,
                    skill.to_string(),
                    path,
                    path,
                    format!("legacy:{provenance_id}")
                ],
            )
            .expect("seed legacy event");
    };
    let central_skill = skillhub_core::SkillId::new();
    let central_dir = library_root.join("centralized");
    std::fs::create_dir_all(&central_dir).expect("central dir");
    seed(
        "prov-legacy-1",
        central_skill,
        central_dir.to_str().unwrap(),
    );
    let orphan_skill = skillhub_core::SkillId::new();
    seed(
        "prov-legacy-2",
        orphan_skill,
        workspace
            .path()
            .join("users/Someone/notes")
            .to_str()
            .unwrap(),
    );

    let first = facade.reconcile_legacy_import_events();
    match first {
        Ok(report) => {
            assert_eq!(report.reclassified, 1, "central-library source is provable");
            assert_eq!(report.retained, 1, "user dir stays unclassified");
        }
        Err(error) => panic!("reconciliation failed: {error:?}"),
    }

    // 幂等：重复对账不再追加继承事件。
    let second = facade.reconcile_legacy_import_events().expect("replay");
    assert_eq!(second.reclassified, 0);

    let database = database.lock().unwrap();
    let events = database
        .provenance_repository()
        .list_provenance_events_for_skill(central_skill)
        .expect("events");
    assert!(events
        .iter()
        .any(|event| { event.source_class == skillhub_core::ImportSourceClass::CentralLibrary }));
    assert_eq!(
        events
            .iter()
            .filter(
                |event| event.source_class == skillhub_core::ImportSourceClass::LegacyUnclassified
            )
            .count(),
        1,
        "the original legacy event is retained as history"
    );
}

mod watch_confirmation {
    //! Task 6B 验收：watcher hint 只做映射关系确认（Full）；补偿类 hint
    //! 触发 Light 全量扫描；确认失败时 hint 留在 pending，不归档、不推进
    //! revision；root generation 原子切换且空集合保持停止（plan 6.2–6.4、
    //! 6.9）。

    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use skillhub_adapters::watcher::{
        ManualWatchClock, NativeWatchBackend, NativeWatchEvent, NativeWatchEventKind,
    };
    use skillhub_application::relationship_watch_confirmation::{
        FacadeRelationshipCheckExecutor, RelationshipCheckExecuting, RelationshipWatchRuntime,
    };
    use skillhub_core::relationship::{
        RelationshipCheckItem, RelationshipCheckItemStatus, SourceCopyHealth,
    };
    use skillhub_core::{AppError, ErrorCode, Severity, SkillId};

    use super::*;

    fn facade_arc(workspace: &std::path::Path) -> Arc<LocalApplicationFacade> {
        Arc::new(facade_with(workspace))
    }

    fn changed_event(path: &Path) -> NativeWatchEvent {
        NativeWatchEvent {
            kind: NativeWatchEventKind::Changed,
            path: path.to_path_buf(),
        }
    }

    fn runtime_with(backend: &FakeBackend, clock: &ManualWatchClock) -> RelationshipWatchRuntime {
        RelationshipWatchRuntime::for_tests(Box::new(backend.clone()), Box::new(clock.clone()))
    }

    fn unchanged_report() -> RelationshipCheckReport {
        RelationshipCheckReport {
            items: vec![RelationshipCheckItem {
                relation_id: "relation-fake".to_owned(),
                skill_id: SkillId::new(),
                status: RelationshipCheckItemStatus::Unchanged,
                health: Some(SourceCopyHealth::Normal),
                reason: None,
            }],
            relationship_revision: 0,
        }
    }

    #[derive(Default)]
    struct FakeExecutorState {
        roots: Vec<PathBuf>,
        check_calls: usize,
        compensate_calls: usize,
        fail: bool,
        empty_for: Vec<String>,
    }

    #[derive(Clone, Default)]
    struct FakeExecutor {
        state: Arc<Mutex<FakeExecutorState>>,
    }

    impl FakeExecutor {
        fn set_roots(&self, roots: &[PathBuf]) {
            self.state.lock().unwrap().roots = roots.to_vec();
        }

        fn calls(&self) -> (usize, usize) {
            let state = self.state.lock().unwrap();
            (state.check_calls, state.compensate_calls)
        }

        fn set_fail(&self, fail: bool) {
            self.state.lock().unwrap().fail = fail;
        }

        fn return_empty_for(&self, path: &str) {
            self.state.lock().unwrap().empty_for.push(path.to_owned());
        }
    }

    impl RelationshipCheckExecuting for FakeExecutor {
        fn active_roots(&self) -> skillhub_core::AppResult<Vec<PathBuf>> {
            Ok(self.state.lock().unwrap().roots.clone())
        }

        fn check_path(&self, path: &Path) -> skillhub_core::AppResult<RelationshipCheckReport> {
            let mut state = self.state.lock().unwrap();
            state.check_calls += 1;
            if state.fail {
                return Err(AppError::new(ErrorCode::InternalError, Severity::Error));
            }
            if state
                .empty_for
                .iter()
                .any(|target| *target == path.to_string_lossy())
            {
                return Ok(RelationshipCheckReport {
                    items: Vec::new(),
                    relationship_revision: 0,
                });
            }
            Ok(unchanged_report())
        }

        fn compensate(&self) -> skillhub_core::AppResult<RelationshipCheckReport> {
            let mut state = self.state.lock().unwrap();
            state.compensate_calls += 1;
            if state.fail {
                return Err(AppError::new(ErrorCode::InternalError, Severity::Error));
            }
            Ok(unchanged_report())
        }
    }

    #[tokio::test]
    async fn watch_hints_run_full_checks_only_for_mapped_relations() {
        let workspace = tempfile::tempdir().expect("workspace");
        let facade = facade_arc(workspace.path());
        let source = workspace.path().join("watched-src");
        write_skill(&source, "# Watched\n");
        import_copy(&facade, &source, "Watched").await;

        let executor = FacadeRelationshipCheckExecutor::new(facade.clone());
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut runtime = runtime_with(&backend, &clock);
        runtime.start(&executor).expect("start");
        assert_eq!(
            runtime.roots_generation(),
            1,
            "first refresh applies the relation roots"
        );
        let revision_before = run_check(
            &facade,
            RelationshipCheckLevel::Full,
            RelationshipCheckScope::AllActive,
        )
        .await
        .relationship_revision;

        // 映射路径内的 hint：只检查映射到的关系，检查后事实不变。
        backend.push(changed_event(&source.join("references/a.md")));
        assert_eq!(
            runtime.collect().expect("collect"),
            0,
            "a hint stamps on its arrival tick"
        );
        clock.advance(400);
        assert_eq!(
            runtime.collect().expect("collect"),
            1,
            "and is confirmed after the stable window"
        );
        let report = runtime.confirm_pending(&executor);
        assert_eq!(report.confirmed_file_hints, 1);
        assert_eq!(report.dropped_unmapped, 0);
        assert_eq!(report.retained_hints, 0);
        assert!(
            !report.facts_changed,
            "unchanged facts do not announce a change"
        );

        // 未映射路径（不在任何活动关系根下）的 hint 在 watcher 过滤层就被
        // 丢弃，confirm 队列为空，不触发任何检查。
        backend.push(changed_event(&workspace.path().join("elsewhere/x.md")));
        assert_eq!(runtime.collect().expect("collect"), 0);
        clock.advance(400);
        assert_eq!(runtime.collect().expect("collect"), 0);
        let report = runtime.confirm_pending(&executor);
        assert_eq!(report.confirmed_file_hints, 0);
        assert_eq!(report.retained_hints, 0);
        assert_eq!(runtime.pending_len(), 0);

        let revision_after = run_check(
            &facade,
            RelationshipCheckLevel::Full,
            RelationshipCheckScope::AllActive,
        )
        .await
        .relationship_revision;
        assert_eq!(revision_after, revision_before);
        assert_eq!(runtime.pending_len(), 0);
    }

    #[tokio::test]
    async fn compensation_hints_run_light_scans_through_the_real_pipeline() {
        let workspace = tempfile::tempdir().expect("workspace");
        let facade = facade_arc(workspace.path());
        let source = workspace.path().join("vanish-src");
        write_skill(&source, "# Vanish\n");
        import_copy(&facade, &source, "Vanish").await;
        std::fs::remove_dir_all(&source).expect("remove source");

        let executor = FacadeRelationshipCheckExecutor::new(facade.clone());
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut runtime = runtime_with(&backend, &clock);
        runtime.start(&executor).expect("start");

        runtime.on_app_resumed();
        assert_eq!(
            runtime.collect().expect("collect"),
            1,
            "compensation intent surfaces as one pending hint"
        );
        let report = runtime.confirm_pending(&executor);
        assert_eq!(report.compensation_scans, 1);
        assert_eq!(report.confirmed_file_hints, 0);
        assert!(
            report.facts_changed,
            "the compensation scan archived a genuinely removed source"
        );

        // 第二次补偿（Overflow）继续走同一通道；归档后重扫无活动关系。
        runtime.on_overflow(source.to_string_lossy().into_owned());
        runtime.collect().expect("collect");
        let report = runtime.confirm_pending(&executor);
        assert_eq!(report.compensation_scans, 1);

        let database = facade.database_for_tests().clone();
        let database = database.lock().unwrap();
        let relations = database
            .relationship_repository()
            .list_source_copy_relations(true)
            .expect("relations");
        assert!(
            relations.is_empty(),
            "the removed source was archived by the compensation scan"
        );
    }

    #[tokio::test]
    async fn failed_confirmation_keeps_hint_pending_without_fact_changes() {
        let executor = FakeExecutor::default();
        executor.set_roots(&[PathBuf::from("/lib")]);
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut runtime = runtime_with(&backend, &clock);
        runtime.start(&executor).expect("start");

        backend.push(changed_event(Path::new("/lib/pdf/SKILL.md")));
        assert_eq!(runtime.collect().expect("collect"), 0);
        clock.advance(400);
        assert_eq!(runtime.collect().expect("collect"), 1);

        executor.set_fail(true);
        let report = runtime.confirm_pending(&executor);
        assert_eq!(report.retained_hints, 1);
        assert_eq!(runtime.pending_len(), 1, "failed confirmation stays queued");
        assert!(!report.facts_changed);
        assert_eq!(executor.calls(), (1, 0));

        executor.set_fail(false);
        let report = runtime.confirm_pending(&executor);
        assert_eq!(report.confirmed_file_hints, 1);
        assert_eq!(report.retained_hints, 0);
        assert_eq!(runtime.pending_len(), 0);
        assert_eq!(executor.calls(), (2, 0));
    }

    #[tokio::test]
    async fn hints_without_mapped_relations_are_dropped_without_effects() {
        let executor = FakeExecutor::default();
        executor.set_roots(&[PathBuf::from("/lib")]);
        executor.return_empty_for("/lib/other/x.md");
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut runtime = runtime_with(&backend, &clock);
        runtime.start(&executor).expect("start");

        backend.push(changed_event(Path::new("/lib/other/x.md")));
        runtime.collect().expect("collect");
        clock.advance(400);
        runtime.collect().expect("collect");

        let report = runtime.confirm_pending(&executor);
        assert_eq!(report.dropped_unmapped, 1);
        assert_eq!(report.confirmed_file_hints, 0);
        assert!(!report.facts_changed);
        assert_eq!(runtime.pending_len(), 0);
    }

    #[tokio::test]
    async fn root_generation_switches_replace_roots_without_event_loss() {
        let executor = FakeExecutor::default();
        let root_a = PathBuf::from("/gen-a");
        let root_b = PathBuf::from("/gen-b");
        executor.set_roots(std::slice::from_ref(&root_a));
        let backend = FakeBackend::default();
        let clock = ManualWatchClock::default();
        let mut runtime = runtime_with(&backend, &clock);
        runtime.start(&executor).expect("start");
        assert_eq!(runtime.roots_generation(), 1);

        executor.set_roots(std::slice::from_ref(&root_b));
        assert!(runtime.refresh_roots(&executor).expect("refresh"));
        assert_eq!(runtime.roots_generation(), 2);
        assert!(runtime.is_running(), "non-empty switch keeps watching");

        // 旧 generation 的事件被新 root 过滤丢弃（即使已过窗口也不会
        // 入队），新 generation 事件在后续 tick 确认。
        backend.push(changed_event(&root_a.join("x.md")));
        clock.advance(400);
        assert_eq!(runtime.collect().expect("collect"), 0);
        backend.push(changed_event(&root_b.join("y.md")));
        assert_eq!(
            runtime.collect().expect("collect"),
            0,
            "stamped on the arrival tick"
        );
        clock.advance(400);
        assert_eq!(
            runtime.collect().expect("collect"),
            1,
            "confirmed after the stable window"
        );

        // 未变化的 roots 不换代。
        assert!(!runtime.refresh_roots(&executor).expect("refresh"));
        assert_eq!(runtime.roots_generation(), 2);

        // 空集合保持停止。
        executor.set_roots(&[]);
        assert!(runtime.refresh_roots(&executor).expect("refresh"));
        assert!(!runtime.is_running());
        backend.push(changed_event(&root_b.join("y.md")));
        assert_eq!(runtime.collect().expect("collect"), 0);
        assert_eq!(runtime.roots_generation(), 3);
    }

    #[derive(Default)]
    struct FakeBackendState {
        queue: VecDeque<NativeWatchEvent>,
    }

    #[derive(Clone, Default)]
    struct FakeBackend {
        state: Arc<Mutex<FakeBackendState>>,
    }

    impl FakeBackend {
        fn push(&self, event: NativeWatchEvent) {
            self.state.lock().unwrap().queue.push_back(event);
        }
    }

    impl NativeWatchBackend for FakeBackend {
        fn start(&mut self, _roots: &[PathBuf]) -> skillhub_core::AppResult<()> {
            Ok(())
        }

        fn stop(&mut self) -> skillhub_core::AppResult<()> {
            Ok(())
        }

        fn poll(&mut self) -> Vec<NativeWatchEvent> {
            self.state.lock().unwrap().queue.drain(..).collect()
        }
    }
}
