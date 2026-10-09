use serde_json::json;
use skillhub_core::import::{ImportProvenanceEvent, ImportSourceClass};
use skillhub_core::relationship::{
    DeploymentRelationFact, FileRepresentation, RelationHealthReason, RelationshipType,
    SourceCopyDecision, SourceCopyRelationFact, UsageDecision, UsageEntryKey,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{ObservedMatchState, ObservedOrigin, OwnershipState, SkillId};
use skillhub_storage::{Database, GovernanceHistoryEvent, UsageDecisionRecord};
use std::collections::BTreeMap;
use tempfile::tempdir;

fn insert_skill(db: &Database, skill_id: SkillId) {
    db.connection_for_test()
        .execute(
            "INSERT INTO skills(id, display_name, runtime_name, created_at, updated_at) VALUES (?1, 'Notes', 'notes', 1, 1)",
            [skill_id.to_string()],
        )
        .expect("insert skill");
}

fn entry_import_event(skill_id: SkillId, provenance_id: &str) -> ImportProvenanceEvent {
    let path = "/shared/skills/notes";
    ImportProvenanceEvent {
        provenance_id: provenance_id.into(),
        batch_id: format!("batch:{provenance_id}"),
        skill_id,
        source_class: ImportSourceClass::AgentLocal,
        source: SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(path)),
        local_source_path: Some(path.into()),
        source_container_id: Some("directory:shared".into()),
        physical_source_id: Some(format!("device:{provenance_id}")),
        agent_client_id: Some("agent-a".into()),
        content_fingerprint: "sha256:notes".into(),
        imported_at: 10,
    }
}

fn insert_shared_directory(db: &Database) {
    db.connection_for_test()
        .execute(
            "INSERT INTO directory_nodes(node_id, path, path_key, role, profile_id, agent_client_id, exists_flag, observed_at, scan_source)
             VALUES ('directory:shared', '/shared/skills', '/shared/skills', 'shared_directory', NULL, NULL, 1, 10, 'test')",
            [],
        )
        .expect("insert shared directory");
}

fn seed_active_source_copy(
    db: &Database,
    skill_id: SkillId,
    relation_id: &str,
    provenance_id: &str,
) {
    let event = entry_import_event(skill_id, provenance_id);
    db.provenance_repository()
        .begin_import_batch(&event.batch_id, event.imported_at)
        .expect("begin usage import batch");
    db.provenance_repository()
        .append_provenance_event(&event)
        .expect("append usage import event");
    let mut relation = SourceCopyRelationFact::from_import_event(
        relation_id,
        &event,
        "/shared/skills/notes",
        event
            .physical_source_id
            .as_deref()
            .expect("physical source id"),
    )
    .expect("local usage source copy");
    relation.decision = SourceCopyDecision::Pending;
    relation.current_fingerprint = Some("sha256:notes".into());
    db.relationship_repository()
        .upsert_source_copy_relation(&relation, "fs", 1)
        .expect("persist usage source copy");
}

fn deployment_relation(
    relation_id: &str,
    skill_id: SkillId,
    agent_client_id: &str,
) -> DeploymentRelationFact {
    DeploymentRelationFact {
        relation_id: relation_id.into(),
        skill_id: Some(skill_id),
        agent_client_id: agent_client_id.into(),
        path: "/shared/skills/notes".into(),
        path_key: "/shared/skills/notes".into(),
        directory_node_id: Some("directory:shared".into()),
        relationship: RelationshipType::ManagedCopy,
        file_representation: FileRepresentation::Copy,
        ownership: OwnershipState::SkillhubManaged,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: "sha256:notes".into(),
        origin: ObservedOrigin::Import,
        match_state: ObservedMatchState::ContentVerified,
        health_reasons: Some(Vec::<RelationHealthReason>::new()),
        active: true,
        observed_at: 20,
        released_at: None,
    }
}

fn seed_automatic_retained_copy(db: &Database, skill_id: SkillId) {
    insert_skill(db, skill_id);
    insert_shared_directory(db);
    let event = entry_import_event(skill_id, "event:auto-retained");
    db.provenance_repository()
        .begin_import_batch(&event.batch_id, event.imported_at)
        .expect("begin import batch");
    db.provenance_repository()
        .append_provenance_event(&event)
        .expect("append immutable import event");
    let relation = SourceCopyRelationFact::from_import_event(
        "source-copy:auto-retained",
        &event,
        "/shared/skills/notes",
        event
            .physical_source_id
            .as_deref()
            .expect("physical source id"),
    )
    .expect("local source copy");
    assert_eq!(relation.decision, SourceCopyDecision::Retained);
    db.relationship_repository()
        .upsert_source_copy_relation(&relation, "fs", 1)
        .expect("persist source copy relation");
}

fn append_explicit_keep_history(
    db: &Database,
    event_id: &str,
    skill_id: SkillId,
    relation_id: &str,
) {
    db.governance_history_repository()
        .append(&GovernanceHistoryEvent {
            event_id: event_id.into(),
            relation_id: relation_id.into(),
            skill_id: Some(skill_id.to_string()),
            skill_display_name: "Notes".into(),
            agent_presentation: json!({"client_id": "agent-a"}),
            path: "/shared/skills/notes".into(),
            scope: "source_copy".into(),
            project_id: None,
            action: "retain".into(),
            result: "retained".into(),
            reason: None,
            operation_id: None,
            occurred_at: 30,
        })
        .expect("append explicit legacy keep history");
}

fn append_explicit_end_history(
    db: &Database,
    event_id: &str,
    skill_id: SkillId,
    relation_id: &str,
) {
    db.governance_history_repository()
        .append(&GovernanceHistoryEvent {
            event_id: event_id.into(),
            relation_id: relation_id.into(),
            skill_id: Some(skill_id.to_string()),
            skill_display_name: "Notes".into(),
            agent_presentation: json!({"client_id": "agent-b"}),
            path: "/shared/skills/notes".into(),
            scope: "source_copy".into(),
            project_id: None,
            action: "end_relationship".into(),
            result: "ended".into(),
            reason: None,
            operation_id: Some("operation:legacy-end".into()),
            occurred_at: 31,
        })
        .expect("append explicit legacy end history");
}

fn append_explicit_deployment_end_history(
    db: &Database,
    event_id: &str,
    skill_id: SkillId,
    relation_id: &str,
) {
    db.governance_history_repository()
        .append(&GovernanceHistoryEvent {
            event_id: event_id.into(),
            relation_id: relation_id.into(),
            skill_id: Some(skill_id.to_string()),
            skill_display_name: "Notes".into(),
            agent_presentation: json!({"client_id": "agent-a"}),
            path: "/shared/skills/notes".into(),
            scope: "deployment".into(),
            project_id: Some("directory:shared".into()),
            action: "end_relationship".into(),
            result: "ended".into(),
            reason: None,
            operation_id: Some("operation:legacy-deployment-end".into()),
            occurred_at: 31,
        })
        .expect("append explicit legacy deployment end history");
}

fn append_legacy_revoke_retention_history(
    db: &Database,
    event_id: &str,
    skill_id: SkillId,
    relation_id: &str,
) {
    db.governance_history_repository()
        .append(&GovernanceHistoryEvent {
            event_id: event_id.into(),
            relation_id: relation_id.into(),
            skill_id: Some(skill_id.to_string()),
            skill_display_name: "Notes".into(),
            agent_presentation: json!({"client_id": "agent-a"}),
            path: "/shared/skills/notes".into(),
            scope: "source_copy".into(),
            project_id: Some("directory:shared".into()),
            action: "revoke_retention".into(),
            result: "retention_revoked".into(),
            reason: None,
            operation_id: Some("operation:legacy-revoke-retention".into()),
            occurred_at: 40,
        })
        .expect("append legacy retention revocation history");
}

#[test]
fn automatic_retained_is_not_user_release() {
    let workspace = tempdir().expect("workspace");
    let path = workspace.path().join("usage-decisions.sqlite");
    let db = Database::open(&path).expect("database");
    let skill_id = SkillId::new();
    seed_automatic_retained_copy(&db, skill_id);

    // Reopen through the v29-to-current migration path while retaining all
    // legacy facts exactly as they were stored.
    db.connection_for_test()
        .execute_batch(
            "DROP TABLE IF EXISTS active_usage_evidence;
             DROP TABLE IF EXISTS active_usage_slots;
             DROP TABLE IF EXISTS usage_decisions;
             PRAGMA user_version = 29;",
        )
        .expect("restore pre-decision schema version");
    drop(db);

    let migrated = Database::open(&path).expect("migrate legacy database");
    let source_copies = migrated
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("read active legacy source copies");
    assert_eq!(source_copies.len(), 1);
    assert_eq!(source_copies[0].decision, SourceCopyDecision::Retained);
    assert!(source_copies[0].active);
    assert_eq!(
        migrated
            .provenance_repository()
            .list_provenance_events_for_skill(skill_id)
            .expect("read immutable import event")
            .len(),
        1
    );
    let active_slots: i64 = migrated
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM active_usage_slots", [], |row| {
            row.get(0)
        })
        .expect("count active slots after automatic retained migration");
    assert_eq!(active_slots, 1);

    let decision_count: i64 = migrated
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM usage_decisions WHERE skill_id=?1",
            [skill_id.to_string()],
            |row| row.get(0),
        )
        .expect("count migrated explicit decisions");
    assert_eq!(decision_count, 0);
}

#[test]
fn explicit_keep_archives_active_relation() {
    let db = Database::open_in_memory().expect("database");
    insert_shared_directory(&db);
    let skill_id = SkillId::new();
    let other_skill_id = SkillId::new();
    insert_skill(&db, skill_id);
    insert_skill(&db, other_skill_id);
    seed_active_source_copy(&db, skill_id, "source-copy:skill-a", "event:skill-a");
    db.relationship_repository()
        .upsert_deployment_relation(&deployment_relation(
            "deployment:skill-a",
            skill_id,
            "agent-a",
        ))
        .expect("persist first Skill entry");
    db.relationship_repository()
        .upsert_deployment_relation(&deployment_relation(
            "deployment:skill-b",
            other_skill_id,
            "agent-b",
        ))
        .expect("persist conflicting Skill at the same shared entry");

    let record = UsageDecisionRecord {
        decision_id: "decision:keep:1".into(),
        skill_id,
        entry_key: UsageEntryKey {
            directory_id: "directory:shared".into(),
            relative_entry_path: "notes".into(),
        },
        relation_ids: vec!["deployment:skill-a".into(), "source-copy:skill-a".into()],
        physical_source_ids: vec!["device:event:skill-a".into()],
        decision: UsageDecision::RetainedIndependentCopy,
        content_fingerprint: Some("sha256:notes".into()),
        decided_at: 30,
        operation_id: Some("operation:keep:1".into()),
    };
    let mut missing_operation_id = record.clone();
    missing_operation_id.operation_id = None;
    assert!(db.record_usage_decision(&missing_operation_id).is_err());

    // If one half of the cross-table archive fails, the decision and earlier
    // relationship updates must roll back in the same SQLite transaction.
    db.connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_skill_a_deployment_archive
             BEFORE UPDATE OF active ON deployment_relations
             WHEN OLD.relation_id='deployment:skill-a' AND NEW.active=0
             BEGIN SELECT RAISE(ABORT, 'forced deployment archive failure'); END;",
        )
        .expect("install archive failure trigger");
    assert!(db.record_usage_decision(&record).is_err());
    db.connection_for_test()
        .execute_batch("DROP TRIGGER fail_skill_a_deployment_archive;")
        .expect("remove archive failure trigger");
    assert_eq!(
        db.relationship_repository()
            .list_source_copy_relations(true)
            .expect("read active copies after rollback")
            .len(),
        1
    );
    let active_deployments: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM deployment_relations WHERE active=1",
            [],
            |row| row.get(0),
        )
        .expect("count active deployments after rollback");
    assert_eq!(active_deployments, 2);
    assert!(db
        .list_usage_decisions(&skill_id, &record.entry_key)
        .expect("read decisions after rollback")
        .is_empty());

    // A decision-write failure must leave all active relations untouched.
    db.connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_usage_decision_insert
             BEFORE INSERT ON usage_decisions
             BEGIN SELECT RAISE(ABORT, 'forced decision write failure'); END;",
        )
        .expect("install decision failure trigger");
    assert!(db.record_usage_decision(&record).is_err());
    db.connection_for_test()
        .execute_batch("DROP TRIGGER fail_usage_decision_insert;")
        .expect("remove decision failure trigger");
    assert_eq!(
        db.relationship_repository()
            .list_source_copy_relations(true)
            .expect("read active copies after decision failure")
            .len(),
        1
    );
    let deployments_after_decision_failure: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM deployment_relations WHERE active=1",
            [],
            |row| row.get(0),
        )
        .expect("count deployments after decision failure");
    assert_eq!(deployments_after_decision_failure, 2);

    // A late failure after both decision insertion and relation archival must
    // roll the entire transaction back in the opposite direction.
    db.connection_for_test()
        .execute_batch(
            "CREATE TRIGGER fail_usage_slot_cleanup
             BEFORE DELETE ON active_usage_slots
             BEGIN SELECT RAISE(ABORT, 'forced usage slot cleanup failure'); END;",
        )
        .expect("install late failure trigger");
    assert!(db.record_usage_decision(&record).is_err());
    db.connection_for_test()
        .execute_batch("DROP TRIGGER fail_usage_slot_cleanup;")
        .expect("remove late failure trigger");
    assert_eq!(
        db.relationship_repository()
            .list_source_copy_relations(true)
            .expect("read copies after late failure rollback")
            .len(),
        1
    );
    let decisions_after_late_failure: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM usage_decisions WHERE decision_id=?1",
            [&record.decision_id],
            |row| row.get(0),
        )
        .expect("count decisions after late failure");
    assert_eq!(decisions_after_late_failure, 0);
    let deployments_after_late_failure: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM deployment_relations WHERE active=1",
            [],
            |row| row.get(0),
        )
        .expect("count deployments after late failure");
    assert_eq!(deployments_after_late_failure, 2);

    db.record_usage_decision(&record)
        .expect("record explicit keep decision");
    let remaining_source_copies = db
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("read active source copies after keep");
    assert!(remaining_source_copies.is_empty());
    let active_deployments: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM deployment_relations WHERE active=1",
            [],
            |row| row.get(0),
        )
        .expect("count remaining active deployments");
    assert_eq!(active_deployments, 1);
    let remaining_slots: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM active_usage_slots WHERE skill_id=?1",
            [other_skill_id.to_string()],
            |row| row.get(0),
        )
        .expect("count other Skill's independent entry slot");
    assert_eq!(remaining_slots, 1);
    assert_eq!(
        db.list_usage_decisions(&skill_id, &record.entry_key)
            .expect("read explicit keep history"),
        vec![record.clone()]
    );

    // Reusing an operation ID with the same payload is idempotent; reusing it
    // for a different decision is rejected.
    db.record_usage_decision(&record)
        .expect("replay explicit keep");
    let mut conflicting_retry = record.clone();
    conflicting_retry.decision = UsageDecision::Released;
    assert!(db.record_usage_decision(&conflicting_retry).is_err());

    seed_active_source_copy(
        &db,
        skill_id,
        "source-copy:skill-a:second",
        "event:skill-a:second",
    );
    db.relationship_repository()
        .upsert_deployment_relation(&deployment_relation(
            "deployment:skill-a",
            skill_id,
            "agent-a",
        ))
        .expect("reestablish same skill entry after a new verification");
    let second_decision = UsageDecisionRecord {
        decision_id: "decision:release:2".into(),
        relation_ids: vec![
            "deployment:skill-a".into(),
            "source-copy:skill-a:second".into(),
        ],
        physical_source_ids: vec!["device:event:skill-a:second".into()],
        decision: UsageDecision::Released,
        decided_at: 40,
        operation_id: Some("operation:release:2".into()),
        ..record.clone()
    };
    db.record_usage_decision(&second_decision)
        .expect("record later decision for the same entry");
    let history = db
        .list_usage_decisions(&skill_id, &record.entry_key)
        .expect("read multiple decisions for the same entry");
    assert_eq!(history, vec![record, second_decision]);
}

#[test]
fn migration_is_idempotent_and_survives_restart() {
    let workspace = tempdir().expect("workspace");
    let path = workspace.path().join("legacy-usage-decision.sqlite");
    let skill_id = SkillId::new();
    let released_skill_id = SkillId::new();
    let entry_key = UsageEntryKey {
        directory_id: "directory:shared".into(),
        relative_entry_path: "notes".into(),
    };
    {
        let db = Database::open(&path).expect("database");
        insert_shared_directory(&db);
        insert_skill(&db, skill_id);
        insert_skill(&db, released_skill_id);
        seed_active_source_copy(
            &db,
            skill_id,
            "source-copy:legacy-keep",
            "event:legacy-keep",
        );
        seed_active_source_copy(
            &db,
            released_skill_id,
            "source-copy:legacy-end",
            "event:legacy-end",
        );
        append_explicit_keep_history(
            &db,
            "history:legacy-keep",
            skill_id,
            "source-copy:legacy-keep",
        );
        append_explicit_end_history(
            &db,
            "history:legacy-end",
            released_skill_id,
            "source-copy:legacy-end",
        );
        db.connection_for_test()
            .execute_batch(
                "DROP TABLE active_usage_evidence;
                 DROP TABLE active_usage_slots;
                 DROP TABLE usage_decisions;
                 PRAGMA user_version = 29;",
            )
            .expect("prepare v29 database");
    }

    {
        let migrated = Database::open(&path).expect("migrate explicit legacy decision");
        let decisions = migrated
            .list_usage_decisions(&skill_id, &entry_key)
            .expect("read migrated decision");
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].decision_id, "history:legacy-keep");
        assert_eq!(
            decisions[0].decision,
            UsageDecision::RetainedIndependentCopy
        );
        let released_decisions = migrated
            .list_usage_decisions(&released_skill_id, &entry_key)
            .expect("read migrated explicit end decision");
        assert_eq!(released_decisions.len(), 1);
        assert_eq!(released_decisions[0].decision, UsageDecision::Released);
        assert!(migrated
            .relationship_repository()
            .list_source_copy_relations(true)
            .expect("read active copies after migration")
            .is_empty());
        assert_eq!(
            migrated
                .provenance_repository()
                .list_provenance_events_for_skill(skill_id)
                .expect("preserve import events")
                .len(),
            1
        );
    }

    let reopened = Database::open(&path).expect("reopen migrated database");
    let decisions = reopened
        .list_usage_decisions(&skill_id, &entry_key)
        .expect("read decisions after restart");
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0].decision_id, "history:legacy-keep");
    assert!(reopened
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("read active copies after restart")
        .is_empty());
    assert_eq!(
        reopened
            .list_usage_decisions(&released_skill_id, &entry_key)
            .expect("read released decision after restart")
            .len(),
        1
    );
}

#[test]
fn unknown_legacy_decision_keeps_evidence() {
    let workspace = tempdir().expect("workspace");
    let path = workspace.path().join("unknown-usage-decision.sqlite");
    let skill_id = SkillId::new();
    let relation_id = "source-copy:unknown-directory";
    let entry_key = UsageEntryKey {
        directory_id: "directory:missing".into(),
        relative_entry_path: "notes".into(),
    };
    let before_fact_json;
    {
        let db = Database::open(&path).expect("database");
        insert_skill(&db, skill_id);
        seed_active_source_copy(&db, skill_id, relation_id, "event:unknown-directory");
        append_explicit_keep_history(&db, "history:unknown-directory", skill_id, relation_id);
        before_fact_json = db
            .connection_for_test()
            .query_row(
                "SELECT fact_json FROM source_copy_relations WHERE relation_id=?1",
                [relation_id],
                |row| row.get::<_, String>(0),
            )
            .expect("save unmodified source fact");
        db.connection_for_test()
            .execute_batch(
                "DROP TABLE active_usage_evidence;
                 DROP TABLE active_usage_slots;
                 DROP TABLE usage_decisions;
                 PRAGMA user_version = 29;",
            )
            .expect("prepare unresolved v29 database");
    }

    let migrated = Database::open(&path).expect("migrate unresolved legacy history");
    assert!(migrated
        .list_usage_decisions(&skill_id, &entry_key)
        .expect("read decisions for unresolved identity")
        .is_empty());
    let source_copies = migrated
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("read preserved unknown source fact");
    assert_eq!(source_copies.len(), 1);
    assert!(source_copies[0].active);
    let after_fact_json: String = migrated
        .connection_for_test()
        .query_row(
            "SELECT fact_json FROM source_copy_relations WHERE relation_id=?1",
            [relation_id],
            |row| row.get(0),
        )
        .expect("read preserved source fact");
    assert_eq!(after_fact_json, before_fact_json);
    let active_slots: i64 = migrated
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM active_usage_slots", [], |row| {
            row.get(0)
        })
        .expect("count unresolved active slots");
    assert_eq!(active_slots, 0);
    assert_eq!(
        migrated
            .governance_history_repository()
            .list_for_relation(relation_id)
            .expect("read retained immutable legacy evidence")
            .len(),
        1
    );
}

#[test]
fn migration_maps_explicit_deployment_release() {
    let workspace = tempdir().expect("workspace");
    let path = workspace.path().join("legacy-deployment-release.sqlite");
    let skill_id = SkillId::new();
    let entry_key = UsageEntryKey {
        directory_id: "directory:shared".into(),
        relative_entry_path: "notes".into(),
    };
    {
        let db = Database::open(&path).expect("database");
        insert_shared_directory(&db);
        insert_skill(&db, skill_id);
        db.relationship_repository()
            .upsert_deployment_relation(&deployment_relation(
                "deployment:legacy-release",
                skill_id,
                "agent-a",
            ))
            .expect("persist legacy deployment");
        append_explicit_deployment_end_history(
            &db,
            "history:legacy-deployment-release",
            skill_id,
            "deployment:legacy-release",
        );
        db.connection_for_test()
            .execute_batch(
                "DROP TABLE active_usage_evidence;
                 DROP TABLE active_usage_slots;
                 DROP TABLE usage_decisions;
                 PRAGMA user_version = 29;",
            )
            .expect("prepare v29 database");
    }

    let migrated = Database::open(&path).expect("migrate legacy deployment release");
    let decisions = migrated
        .list_usage_decisions(&skill_id, &entry_key)
        .expect("read migrated deployment decision");
    assert_eq!(decisions.len(), 1);
    assert_eq!(
        decisions[0].decision_id,
        "history:legacy-deployment-release"
    );
    assert_eq!(decisions[0].decision, UsageDecision::Released);
    let active: i64 = migrated
        .connection_for_test()
        .query_row(
            "SELECT active FROM deployment_relations WHERE relation_id='deployment:legacy-release'",
            [],
            |row| row.get(0),
        )
        .expect("read migrated deployment activity");
    assert_eq!(active, 0);
}

#[test]
fn revoked_legacy_retention_does_not_migrate_as_current_decision() {
    let workspace = tempdir().expect("workspace");
    let path = workspace.path().join("revoked-legacy-retention.sqlite");
    let skill_id = SkillId::new();
    let relation_id = "source-copy:revoked-retention";
    let entry_key = UsageEntryKey {
        directory_id: "directory:shared".into(),
        relative_entry_path: "notes".into(),
    };
    {
        let db = Database::open(&path).expect("database");
        insert_shared_directory(&db);
        insert_skill(&db, skill_id);
        seed_active_source_copy(&db, skill_id, relation_id, "event:revoked-retention");
        append_explicit_keep_history(&db, "history:retained-before-revoke", skill_id, relation_id);
        append_legacy_revoke_retention_history(
            &db,
            "history:revoke-retention",
            skill_id,
            relation_id,
        );
        db.connection_for_test()
            .execute_batch(
                "DROP TABLE active_usage_evidence;
                 DROP TABLE active_usage_slots;
                 DROP TABLE usage_decisions;
                 PRAGMA user_version = 29;",
            )
            .expect("prepare v29 database");
    }

    let migrated = Database::open(&path).expect("migrate revoked legacy retention");
    assert!(migrated
        .list_usage_decisions(&skill_id, &entry_key)
        .expect("read current structured decisions")
        .is_empty());
    let active = migrated
        .relationship_repository()
        .list_source_copy_relations(true)
        .expect("read active source copy after revoked retention");
    assert_eq!(active.len(), 1);
    assert!(active[0].active);
    assert_eq!(active[0].decision, SourceCopyDecision::Pending);
    assert_eq!(
        migrated
            .governance_history_repository()
            .list_for_relation(relation_id)
            .expect("preserve both immutable history events")
            .len(),
        2
    );
}

#[test]
fn active_slot_matches_usage_entry_key_path_normalization() {
    let db = Database::open_in_memory().expect("database");
    insert_shared_directory(&db);
    let skill_id = SkillId::new();
    insert_skill(&db, skill_id);
    let mut deployment = deployment_relation("deployment:normalized-path", skill_id, "agent-a");
    deployment.path = "/shared/skills//notes".into();
    db.relationship_repository()
        .upsert_deployment_relation(&deployment)
        .expect("persist deployment with repeated separator");

    let relative_entry_path: String = db
        .connection_for_test()
        .query_row(
            "SELECT relative_entry_path FROM active_usage_slots WHERE skill_id=?1",
            [skill_id.to_string()],
            |row| row.get(0),
        )
        .expect("read canonical active slot key");
    assert_eq!(relative_entry_path, "notes");
}

#[test]
fn unknown_fingerprint_does_not_match_recorded_content() {
    let db = Database::open_in_memory().expect("database");
    insert_shared_directory(&db);
    let skill_id = SkillId::new();
    insert_skill(&db, skill_id);
    db.relationship_repository()
        .upsert_deployment_relation(&deployment_relation(
            "deployment:unknown-fingerprint",
            skill_id,
            "agent-a",
        ))
        .expect("persist active deployment");
    let record = UsageDecisionRecord {
        decision_id: "decision:unknown-fingerprint".into(),
        skill_id,
        entry_key: UsageEntryKey {
            directory_id: "directory:shared".into(),
            relative_entry_path: "notes".into(),
        },
        relation_ids: vec!["deployment:unknown-fingerprint".into()],
        physical_source_ids: Vec::new(),
        decision: UsageDecision::Released,
        content_fingerprint: Some("sha256:notes".into()),
        decided_at: 40,
        operation_id: Some("operation:unknown-fingerprint".into()),
    };
    db.connection_for_test()
        .execute(
            "UPDATE active_usage_evidence SET content_fingerprint=NULL
             WHERE relation_kind='deployment' AND relation_id='deployment:unknown-fingerprint'",
            [],
        )
        .expect("remove fingerprint evidence");

    assert!(db.record_usage_decision(&record).is_err());
    let active_deployments: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM deployment_relations
             WHERE relation_id='deployment:unknown-fingerprint' AND active=1",
            [],
            |row| row.get(0),
        )
        .expect("count active deployment after rejected decision");
    assert_eq!(active_deployments, 1);
    assert!(db
        .list_usage_decisions(&skill_id, &record.entry_key)
        .expect("read decisions after unknown fingerprint")
        .is_empty());
}

#[test]
fn decision_time_fingerprint_uses_separate_per_relation_cas_evidence() {
    let db = Database::open_in_memory().expect("database");
    insert_shared_directory(&db);
    let skill_id = SkillId::new();
    insert_skill(&db, skill_id);
    db.relationship_repository()
        .upsert_deployment_relation(&deployment_relation(
            "deployment:decision-fingerprint",
            skill_id,
            "agent-a",
        ))
        .expect("persist active deployment");

    let record = UsageDecisionRecord {
        decision_id: "decision:changed-at-release".into(),
        skill_id,
        entry_key: UsageEntryKey {
            directory_id: "directory:shared".into(),
            relative_entry_path: "notes".into(),
        },
        relation_ids: vec!["deployment:decision-fingerprint".into()],
        physical_source_ids: Vec::new(),
        decision: UsageDecision::RetainedIndependentCopy,
        content_fingerprint: Some("sha256:decision-time".into()),
        decided_at: 41,
        operation_id: Some("operation:changed-at-release".into()),
    };
    let expected = BTreeMap::from([(
        "deployment:decision-fingerprint".to_owned(),
        Some("sha256:notes".to_owned()),
    )]);
    db.record_usage_decision_with_expected_evidence_fingerprints(&record, &expected)
        .expect("CAS against stored evidence while persisting current decision fingerprint");
    assert_eq!(
        db.list_usage_decisions(&skill_id, &record.entry_key)
            .expect("decision history")[0]
            .content_fingerprint
            .as_deref(),
        Some("sha256:decision-time"),
    );
}

#[test]
fn per_relation_fingerprint_cas_rejects_any_drift_including_expected_none() {
    let db = Database::open_in_memory().expect("database");
    insert_shared_directory(&db);
    let skill_id = SkillId::new();
    insert_skill(&db, skill_id);
    for (relation_id, agent_id) in [
        ("deployment:cas-a", "agent-a"),
        ("deployment:cas-b", "agent-b"),
    ] {
        db.relationship_repository()
            .upsert_deployment_relation(&deployment_relation(relation_id, skill_id, agent_id))
            .expect("persist active deployment");
    }
    db.connection_for_test()
        .execute(
            "UPDATE active_usage_evidence SET content_fingerprint='sha256:drift'
             WHERE relation_kind='deployment' AND relation_id='deployment:cas-b'",
            [],
        )
        .expect("simulate changed per-relation evidence");

    let record = UsageDecisionRecord {
        decision_id: "decision:cas-drift".into(),
        skill_id,
        entry_key: UsageEntryKey {
            directory_id: "directory:shared".into(),
            relative_entry_path: "notes".into(),
        },
        relation_ids: vec!["deployment:cas-a".into(), "deployment:cas-b".into()],
        physical_source_ids: Vec::new(),
        decision: UsageDecision::Released,
        content_fingerprint: Some("sha256:decision-time".into()),
        decided_at: 42,
        operation_id: Some("operation:cas-drift".into()),
    };
    let expected = BTreeMap::from([
        (
            "deployment:cas-a".to_owned(),
            Some("sha256:notes".to_owned()),
        ),
        ("deployment:cas-b".to_owned(), None),
    ]);
    assert!(db
        .record_usage_decision_with_expected_evidence_fingerprints(&record, &expected)
        .is_err());
    assert!(db
        .list_usage_decisions(&skill_id, &record.entry_key)
        .expect("no decision on CAS failure")
        .is_empty());
    assert_eq!(
        db.relationship_repository()
            .list_relations()
            .expect("active deployments")
            .iter()
            .filter(|relation| relation.active)
            .count(),
        2,
    );
}

#[test]
fn noncanonical_entry_path_is_rejected() {
    let db = Database::open_in_memory().expect("database");
    insert_shared_directory(&db);
    let skill_id = SkillId::new();
    insert_skill(&db, skill_id);
    db.relationship_repository()
        .upsert_deployment_relation(&deployment_relation(
            "deployment:bad-entry-key",
            skill_id,
            "agent-a",
        ))
        .expect("persist active deployment");
    db.connection_for_test()
        .execute(
            "DELETE FROM active_usage_evidence
             WHERE relation_kind='deployment' AND relation_id='deployment:bad-entry-key'",
            [],
        )
        .expect("remove canonical usage evidence");
    db.connection_for_test()
        .execute(
            "DELETE FROM active_usage_slots
             WHERE skill_id=?1 AND directory_id='directory:shared' AND relative_entry_path='notes'",
            [skill_id.to_string()],
        )
        .expect("remove canonical usage slot");
    db.connection_for_test()
        .execute(
            "INSERT INTO active_usage_slots(skill_id, directory_id, relative_entry_path)
             VALUES (?1, 'directory:shared', '../notes')",
            [skill_id.to_string()],
        )
        .expect("seed malformed usage slot");
    db.connection_for_test()
        .execute(
            "INSERT INTO active_usage_evidence
             (skill_id, directory_id, relative_entry_path, relation_kind, relation_id,
              physical_source_id, content_fingerprint)
             VALUES (?1, 'directory:shared', '../notes', 'deployment',
                     'deployment:bad-entry-key', NULL, 'sha256:notes')",
            [skill_id.to_string()],
        )
        .expect("seed malformed usage evidence");
    let record = UsageDecisionRecord {
        decision_id: "decision:bad-entry-key".into(),
        skill_id,
        entry_key: UsageEntryKey {
            directory_id: "directory:shared".into(),
            relative_entry_path: "../notes".into(),
        },
        relation_ids: vec!["deployment:bad-entry-key".into()],
        physical_source_ids: Vec::new(),
        decision: UsageDecision::Released,
        content_fingerprint: Some("sha256:notes".into()),
        decided_at: 40,
        operation_id: Some("operation:bad-entry-key".into()),
    };

    assert!(db.record_usage_decision(&record).is_err());
    let active_deployments: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM deployment_relations
             WHERE relation_id='deployment:bad-entry-key' AND active=1",
            [],
            |row| row.get(0),
        )
        .expect("count active deployment after invalid key");
    assert_eq!(active_deployments, 1);
}
