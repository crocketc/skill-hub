//! OPT-20260914-08：导入存证、已观察部署关系与原始迁移审计的持久化行为。
//! 全部走真实 SQLite（内存库），覆盖幂等、状态迁移与回滚审计。

use skillhub_core::deployment::{
    reconcile_observed_row, ObservedOrigin, ObservedPathObservation, ObservedRowAction,
};
use skillhub_core::import::{
    CandidateOwnership, ImportProvenance, OriginalMigrationResult, OriginalMigrationState,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{OperationId, SkillId};
use skillhub_storage::Database;

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
    assert_eq!(database.schema_version().unwrap(), 14);
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
