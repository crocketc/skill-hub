//! OPT-20260914-08：导入存证、已观察部署关系与原始迁移审计的持久化行为。
//! 全部走真实 SQLite（内存库），覆盖幂等、状态迁移与回滚审计。

use skillhub_core::deployment::{
    reconcile_observed_row, ObservedOrigin, ObservedPathObservation, ObservedRowAction,
};
use skillhub_core::import::{
    CandidateOwnership, ImportProvenance, ImportProvenanceEvent, ImportSourceClass,
    OriginalMigrationResult, OriginalMigrationState,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{OperationId, SkillId};
use skillhub_storage::{
    Database, ImportBatchFinalStatus, ImportBatchItemRecord, ImportBatchItemStatus,
    ProvenanceRepository, CURRENT_SCHEMA_VERSION,
};

/// observed_deployments 等表对 skills(id) 有外键约束，先落父行。
fn insert_skill(database: &Database, skill_id: SkillId) {
    database
        .connection_for_test()
        .execute(
            "INSERT INTO skills (id, display_name, runtime_name, ownership, created_at, updated_at) VALUES (?1, 'Demo', 'demo', 'user_created', 0, 0)",
            [skill_id.to_string()],
        )
        .unwrap();
}

fn provenance(skill_id: SkillId, path: &str, client: Option<&str>) -> ImportProvenance {
    let provenance = ImportProvenance::new(
        skill_id,
        path,
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(path)),
        CandidateOwnership::KnownAgentTarget,
        "sha256:aa11",
        1_000,
    );
    match client {
        Some(client) => provenance.with_agent_client_id(client),
        None => provenance,
    }
}

#[test]
fn schema_pins_migration_0013() {
    let database = Database::open_in_memory().unwrap();
    assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
}

#[test]
fn provenance_round_trips_with_and_without_agent_attribution() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    database
        .provenance_repository()
        .upsert_provenance(&provenance(
            skill,
            "/tmp/trae/skills/demo",
            Some("trae.code"),
        ))
        .unwrap();
    let stored = database
        .provenance_repository()
        .provenance_for_skill(skill)
        .unwrap()
        .expect("provenance");
    assert_eq!(stored.agent_client_id.as_deref(), Some("trae.code"));
    assert_eq!(stored.original_path, "/tmp/trae/skills/demo");
    assert_eq!(stored.ownership, CandidateOwnership::KnownAgentTarget);

    // 来源不明：client 缺省持久化为 NULL，读回仍为 None（不猜）。
    let unattributed = SkillId::new();
    insert_skill(&database, unattributed);
    database
        .provenance_repository()
        .upsert_provenance(&provenance(unattributed, "/tmp/downloads/demo", None))
        .unwrap();
    let stored = database
        .provenance_repository()
        .provenance_for_skill(unattributed)
        .unwrap()
        .expect("provenance");
    assert_eq!(stored.agent_client_id, None);
    assert_eq!(
        stored.source,
        SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path("/tmp/downloads/demo")
        )
    );

    // 重复提交同一 Skill（幂等重试）覆盖而非新增。
    let mut updated = provenance(skill, "/tmp/trae/skills/demo", Some("trae.code"));
    updated.imported_at = 2_000;
    database
        .provenance_repository()
        .upsert_provenance(&updated)
        .unwrap();
    let stored = database
        .provenance_repository()
        .provenance_for_skill(skill)
        .unwrap()
        .expect("provenance");
    assert_eq!(stored.imported_at, 2_000);
}

/// v19 governance event fixture: user-local source with a filesystem-verified
/// physical identity.
fn import_event(skill_id: SkillId, provenance_id: &str) -> ImportProvenanceEvent {
    ImportProvenanceEvent {
        provenance_id: provenance_id.into(),
        batch_id: "batch".into(),
        skill_id,
        source_class: ImportSourceClass::UserLocal,
        source: SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path("/source/notes"),
        ),
        local_source_path: Some("/source/notes".into()),
        source_container_id: None,
        physical_source_id: Some("device:inode".into()),
        agent_client_id: None,
        content_fingerprint: "hash".into(),
        imported_at: 42,
    }
}

#[test]
fn import_events_are_immutable_chronological_and_counted_per_batch() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    let repository = database.provenance_repository();
    repository.begin_import_batch("batch", 41).unwrap();

    let first = import_event(skill, "event-1");
    let second = import_event(skill, "event-2");
    repository.append_provenance_event(&first).unwrap();
    repository.append_provenance_event(&second).unwrap();

    // 一个 Skill 允许多条存证，按时间顺序可回放。
    assert_eq!(
        repository.list_provenance_events_for_skill(skill).unwrap(),
        vec![first.clone(), second.clone()]
    );

    // 存证不可改写：同一 provenance ID 换内容再落库必须被拒绝。
    let mut tampered = first.clone();
    tampered.content_fingerprint = "tampered".into();
    assert!(repository.append_provenance_event(&tampered).is_err());

    let batch = repository.import_batch("batch").unwrap().expect("batch");
    assert_eq!(batch.batch_id, "batch");
    assert_eq!(batch.imported_count, 2);
    assert!(repository.import_batch("missing").unwrap().is_none());
}

#[test]
fn legacy_backfill_seam_lists_only_unclassified_events_and_never_deletes() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    let repository = database.provenance_repository();

    // 兼容写入路径（deprecated）落库为 legacy_unclassified：存储层不猜来源类别。
    repository
        .upsert_provenance(&provenance(
            skill,
            "/tmp/legacy/skills/demo",
            Some("legacy.agent"),
        ))
        .unwrap();

    let classified = {
        let mut event = import_event(skill, "event-classified");
        event.source_class = ImportSourceClass::UserLocal;
        event
    };
    repository.begin_import_batch("batch", 1).unwrap();
    repository.append_provenance_event(&classified).unwrap();

    let unclassified = repository.list_unclassified_legacy_events().unwrap();
    assert_eq!(unclassified.len(), 1);
    assert_eq!(
        unclassified[0].source_class,
        ImportSourceClass::LegacyUnclassified
    );
    assert_ne!(unclassified[0].provenance_id, "event-classified");

    // 只读回填缝：重复读取不删除、不改写，等待后续分类流程处理。
    assert_eq!(
        repository.list_unclassified_legacy_events().unwrap(),
        unclassified
    );
}

#[test]
fn observed_relation_lifecycle_establish_release_and_reactivate() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    let repository = database.provenance_repository();
    let path = "/tmp/trae/skills/demo";
    let observation = ObservedPathObservation {
        path: path.into(),
        fingerprint: "sha256:aa11".into(),
    };

    // 建立。
    let action = reconcile_observed_row(None, Some(&observation), Some(skill));
    repository
        .apply_observed_row_action("trae.code", path, &action, ObservedOrigin::Scan, 100)
        .unwrap();
    let rows = repository.list_observed_for_skill(skill).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].client_id, "trae.code");
    assert_eq!(rows[0].status, skillhub_core::ObservedStatus::Active);
    assert_eq!(
        rows[0].match_state,
        skillhub_core::ObservedMatchState::ContentVerified
    );
    let normalized = database.relationship_repository().list_relations().unwrap();
    assert_eq!(normalized.len(), 1);
    assert_eq!(normalized[0].skill_id, Some(skill));
    assert!(normalized[0].active);
    assert_eq!(
        normalized[0].match_state,
        skillhub_core::ObservedMatchState::ContentVerified
    );
    assert_eq!(normalized[0].content_fingerprint, "sha256:aa11");

    // 幂等：同一观察再次应用不产生重复行。
    repository
        .apply_observed_row_action("trae.code", path, &action, ObservedOrigin::Scan, 101)
        .unwrap();
    assert_eq!(repository.list_observed().unwrap().len(), 1);

    // 收回：路径不再被观察到。
    repository
        .apply_observed_row_action(
            "trae.code",
            path,
            &ObservedRowAction::Release,
            ObservedOrigin::Scan,
            200,
        )
        .unwrap();
    let rows = repository.list_observed_for_skill(skill).unwrap();
    assert_eq!(rows[0].status, skillhub_core::ObservedStatus::Released);
    assert_eq!(rows[0].released_at, Some(200));
    let normalized = database.relationship_repository().list_relations().unwrap();
    assert!(!normalized[0].active);
    assert_eq!(normalized[0].released_at, Some(200));

    // 关系更新：重新观察到一致内容 → 重新激活。
    repository
        .apply_observed_row_action("trae.code", path, &action, ObservedOrigin::Scan, 300)
        .unwrap();
    let rows = repository.list_observed_for_skill(skill).unwrap();
    assert_eq!(rows[0].status, skillhub_core::ObservedStatus::Active);
    assert_eq!(rows[0].released_at, None);
    assert_eq!(rows[0].observed_at, 300);
    let normalized = database.relationship_repository().list_relations().unwrap();
    assert_eq!(normalized[0].relation_id, rows[0].id.to_string());
}

#[test]
fn observed_relation_marks_divergence_without_duplicating_rows() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    let repository = database.provenance_repository();
    let path = "/tmp/trae/skills/demo";
    let verified = ObservedPathObservation {
        path: path.into(),
        fingerprint: "sha256:aa11".into(),
    };
    repository
        .apply_observed_row_action(
            "trae.code",
            path,
            &reconcile_observed_row(None, Some(&verified), Some(skill)),
            ObservedOrigin::Scan,
            100,
        )
        .unwrap();

    // 指纹分叉 → 明确标注 Diverged，行数不变。
    let diverged = ObservedPathObservation {
        path: path.into(),
        fingerprint: "sha256:ff22".into(),
    };
    repository
        .apply_observed_row_action(
            "trae.code",
            path,
            &reconcile_observed_row(
                Some(&repository.list_observed().unwrap()[0]),
                Some(&diverged),
                None,
            ),
            ObservedOrigin::Scan,
            110,
        )
        .unwrap();
    let rows = repository.list_observed().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].match_state,
        skillhub_core::ObservedMatchState::Diverged
    );
    assert_eq!(rows[0].content_fingerprint, "sha256:ff22");
    let normalized = database.relationship_repository().list_relations().unwrap();
    assert_eq!(normalized.len(), 1);
    assert_eq!(normalized[0].skill_id, None);
    assert_eq!(
        normalized[0].match_state,
        skillhub_core::ObservedMatchState::Diverged
    );
    assert_eq!(normalized[0].content_fingerprint, "sha256:ff22");
}

#[test]
fn observed_name_only_action_clears_normalized_skill_identity() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    let repository = database.provenance_repository();
    let path = "/tmp/trae/skills/name-only";
    repository
        .apply_observed_row_action(
            "trae.code",
            path,
            &reconcile_observed_row(
                None,
                Some(&ObservedPathObservation {
                    path: path.into(),
                    fingerprint: "sha256:aa11".into(),
                }),
                Some(skill),
            ),
            ObservedOrigin::Scan,
            100,
        )
        .unwrap();
    repository
        .apply_observed_row_action(
            "trae.code",
            path,
            &ObservedRowAction::MarkUnreliable {
                match_state: skillhub_core::ObservedMatchState::NameOnly,
                fingerprint: "sha256:name-only".into(),
            },
            ObservedOrigin::Scan,
            110,
        )
        .unwrap();

    let normalized = database.relationship_repository().list_relations().unwrap();
    assert_eq!(normalized.len(), 1);
    assert_eq!(normalized[0].skill_id, None);
    assert_eq!(
        normalized[0].match_state,
        skillhub_core::ObservedMatchState::NameOnly
    );
    assert_eq!(normalized[0].content_fingerprint, "sha256:name-only");
}

#[test]
fn provenance_projection_rolls_back_when_legacy_projection_fails() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    database
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_legacy_provenance BEFORE INSERT ON import_provenance
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();

    assert!(database
        .provenance_repository()
        .upsert_provenance(&provenance(skill, "/tmp/source", Some("agent")))
        .is_err());
    let source_count: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM source_relations", [], |row| {
            row.get(0)
        })
        .unwrap();
    let legacy_count: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM import_provenance", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(source_count, 0);
    assert_eq!(legacy_count, 0);
}

#[test]
fn original_migration_records_support_rollback_audit() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    let migration_id = OperationId::new();
    let result = OriginalMigrationResult {
        migration_id,
        skill_id: skill,
        original_path: "/tmp/trae/skills/demo".into(),
        backup_path: "/library/.skillhub/original-migrations/backup".into(),
        content_fingerprint: "sha256:aa11".into(),
        state: OriginalMigrationState::Migrated,
        confirmed_at: 500,
        rolled_back_at: None,
    };
    database
        .provenance_repository()
        .insert_original_migration(&result)
        .unwrap();
    let stored = database
        .provenance_repository()
        .original_migration(migration_id)
        .unwrap()
        .expect("migration record");
    assert_eq!(stored.state, OriginalMigrationState::Migrated);
    assert_eq!(stored.backup_path, result.backup_path);

    // 回滚：状态翻转，备份路径保留（历史证据不删除）。
    database
        .provenance_repository()
        .mark_original_migration_rolled_back(migration_id, 600)
        .unwrap();
    let stored = database
        .provenance_repository()
        .original_migration(migration_id)
        .unwrap()
        .expect("migration record");
    assert_eq!(stored.state, OriginalMigrationState::RolledBack);
    assert_eq!(stored.rolled_back_at, Some(600));
    assert_eq!(stored.backup_path, result.backup_path);
}

#[test]
fn provenance_history_keeps_multiple_sources_and_duplicate_import_facts() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);

    database
        .provenance_repository()
        .upsert_provenance(&provenance(
            skill,
            "/tmp/shared/skills/demo",
            Some("shared.directory"),
        ))
        .unwrap();
    database
        .provenance_repository()
        .upsert_provenance(&provenance(
            skill,
            "/tmp/trae/skills/demo",
            Some("trae.code"),
        ))
        .unwrap();
    let mut reimported = provenance(skill, "/tmp/shared/skills/demo", Some("shared.directory"));
    reimported.imported_at = 2_000;
    database
        .provenance_repository()
        .upsert_provenance(&reimported)
        .unwrap();

    let history = database
        .provenance_repository()
        .list_provenance_for_skill(skill)
        .unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(
        history
            .iter()
            .filter(|item| item.imported_at == 1_000)
            .count(),
        2
    );
    assert_eq!(
        history
            .iter()
            .filter(|item| item.imported_at == 2_000)
            .count(),
        1
    );
    assert!(history
        .iter()
        .any(|item| item.original_path == "/tmp/trae/skills/demo"));
    assert!(history
        .iter()
        .any(|item| item.original_path == "/tmp/shared/skills/demo"));
    assert_eq!(
        database
            .provenance_repository()
            .provenance_for_skill(skill)
            .unwrap()
            .unwrap()
            .imported_at,
        2_000
    );
}

#[test]
fn import_batch_lifecycle_records_non_succeeded_items_and_finalizes_once() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    insert_skill(&database, skill);
    let repository = database.provenance_repository();
    repository.begin_import_batch("batch", 41).unwrap();

    // 失败/跳过候选有了显式落库通道（带原因），不再是只有成功项可写。
    for (candidate_key, status, reason) in [
        (
            "candidate-failed",
            ImportBatchItemStatus::Failed,
            "source disappeared before commit",
        ),
        (
            "candidate-skipped",
            ImportBatchItemStatus::Skipped,
            "duplicate of an existing skill",
        ),
    ] {
        repository
            .record_batch_item(&ImportBatchItemRecord {
                batch_id: "batch".into(),
                candidate_key: candidate_key.into(),
                skill_id: None,
                provenance_id: None,
                source_relation_id: None,
                status,
                reason: Some(reason.into()),
            })
            .unwrap();
    }

    let event = import_event(skill, "event-1");
    repository.append_provenance_event(&event).unwrap();

    // 终态落库：status 与 finished_at 一起写入。
    repository
        .finalize_import_batch("batch", ImportBatchFinalStatus::Completed, 99)
        .unwrap();
    let (status, finished_at): (String, Option<i64>) = database
        .connection_for_test()
        .query_row(
            "SELECT status, finished_at FROM import_batches WHERE batch_id='batch'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(finished_at, Some(99));

    // 批次仍可通过 import_batch 观察；计数只统计成功候选。
    let batch = repository.import_batch("batch").unwrap().expect("batch");
    assert_eq!(batch.batch_id, "batch");
    assert_eq!(batch.imported_count, 1);

    // 失败/跳过原因可读回。
    let (failed_reason, skipped_reason): (String, String) = database
        .connection_for_test()
        .query_row(
            "SELECT
                 (SELECT reason FROM import_batch_items WHERE batch_id='batch' AND candidate_key='candidate-failed'),
                 (SELECT reason FROM import_batch_items WHERE batch_id='batch' AND candidate_key='candidate-skipped')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(failed_reason, "source disappeared before commit");
    assert_eq!(skipped_reason, "duplicate of an existing skill");

    // 终态语义：完全相同的重放是幂等无操作；其他任何终态迁移都被拒绝。
    repository
        .finalize_import_batch("batch", ImportBatchFinalStatus::Completed, 99)
        .expect("identical finalize replay is an idempotent no-op");
    assert!(
        repository
            .finalize_import_batch("batch", ImportBatchFinalStatus::Failed, 100)
            .is_err(),
        "a finalized batch must not switch terminal status"
    );
    assert!(
        repository
            .finalize_import_batch("batch", ImportBatchFinalStatus::Completed, 100)
            .is_err(),
        "a finalized batch must not change finished_at"
    );
    let (status, finished_at): (String, Option<i64>) = database
        .connection_for_test()
        .query_row(
            "SELECT status, finished_at FROM import_batches WHERE batch_id='batch'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(finished_at, Some(99));

    // 不存在的批次：拒绝。
    assert!(repository
        .finalize_import_batch("missing", ImportBatchFinalStatus::Completed, 99)
        .is_err());
}

#[test]
fn caller_transaction_rolls_back_batch_lifecycle_changes() {
    let database = Database::open_in_memory().unwrap();
    database
        .provenance_repository()
        .begin_import_batch("batch", 1)
        .unwrap();

    let item = ImportBatchItemRecord {
        batch_id: "batch".into(),
        candidate_key: "candidate-tx".into(),
        skill_id: None,
        provenance_id: None,
        source_relation_id: None,
        status: ImportBatchItemStatus::Cancelled,
        reason: Some("user cancelled the import".into()),
    };
    {
        let tx = database.begin_transaction().unwrap();
        ProvenanceRepository::record_batch_item_tx(&tx, &item).unwrap();
        ProvenanceRepository::finalize_import_batch_tx(
            &tx,
            "batch",
            ImportBatchFinalStatus::Failed,
            50,
        )
        .unwrap();
        // 未提交即丢弃：批次条目与终态迁移必须整体回滚。
    }

    let (status, finished_at): (String, Option<i64>) = database
        .connection_for_test()
        .query_row(
            "SELECT status, finished_at FROM import_batches WHERE batch_id='batch'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "running");
    assert_eq!(finished_at, None);
    let item_count: i64 = database
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM import_batch_items WHERE batch_id='batch'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(item_count, 0);
}
