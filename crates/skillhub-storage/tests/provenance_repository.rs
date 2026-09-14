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
    assert_eq!(database.schema_version().unwrap(), 13);
}

#[test]
fn provenance_round_trips_with_and_without_agent_attribution() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
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

    // 关系更新：重新观察到一致内容 → 重新激活。
    repository
        .apply_observed_row_action("trae.code", path, &action, ObservedOrigin::Scan, 300)
        .unwrap();
    let rows = repository.list_observed_for_skill(skill).unwrap();
    assert_eq!(rows[0].status, skillhub_core::ObservedStatus::Active);
    assert_eq!(rows[0].released_at, None);
    assert_eq!(rows[0].observed_at, 300);
}

#[test]
fn observed_relation_marks_divergence_without_duplicating_rows() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
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
}

#[test]
fn original_migration_records_support_rollback_audit() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
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
