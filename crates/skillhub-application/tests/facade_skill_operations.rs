//! Per-skill operation history. The persisted journal does not yet record a
//! skill dimension, so the query answers with the global journal and an
//! explicit limitation marker instead of pretending to filter by skill.

use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    AppQuery, AppQueryResult, ApplicationFacade, ErrorCode, OperationId, OperationPhase,
    OperationRecord, OperationRepository, SkillId,
};
use skillhub_storage::Database;

fn facade() -> LocalApplicationFacade {
    LocalApplicationFacade::new(Database::open_in_memory().expect("database"))
}

async fn insert_record(database: &Database, record: &OperationRecord) {
    database
        .operation_repository()
        .insert(record)
        .await
        .expect("insert operation record");
}

#[tokio::test]
async fn an_empty_journal_answers_with_an_honest_empty_history() {
    let facade = facade();
    let skill_id = SkillId::new();

    let result = facade
        .query(AppQuery::ListSkillOperations(
            skillhub_core::ListSkillOperations { skill_id },
        ))
        .await
        .expect("list skill operations");

    match result {
        AppQueryResult::SkillOperations(history) => {
            assert_eq!(history.skill_id, skill_id);
            assert!(history.entries.is_empty());
            assert!(!history.filtered);
            assert_eq!(
                history.limitation.as_deref(),
                Some("skill_dimension_not_recorded")
            );
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[tokio::test]
async fn journal_entries_are_reported_with_kind_phase_and_error() {
    let database = Database::open_in_memory().expect("database");

    let mut committed =
        OperationRecord::planned(OperationId::new(), "deploy_skill", "fingerprint-deploy");
    committed.phase = OperationPhase::Committed;
    committed.progress.phase = OperationPhase::Committed;
    insert_record(&database, &committed).await;

    let mut rolled_back =
        OperationRecord::planned(OperationId::new(), "remove_skill", "fingerprint-remove");
    rolled_back.phase = OperationPhase::RolledBack;
    rolled_back.progress.phase = OperationPhase::RolledBack;
    rolled_back.error_code = Some(ErrorCode::OperationConflict);
    insert_record(&database, &rolled_back).await;

    let facade = LocalApplicationFacade::new(database);
    let result = facade
        .query(AppQuery::ListSkillOperations(
            skillhub_core::ListSkillOperations {
                skill_id: SkillId::new(),
            },
        ))
        .await
        .expect("list skill operations");

    match result {
        AppQueryResult::SkillOperations(history) => {
            assert_eq!(history.entries.len(), 2);
            assert!(!history.filtered);
            let committed_entry = history
                .entries
                .iter()
                .find(|entry| entry.operation_id == committed.operation_id.to_string())
                .expect("committed entry is listed");
            assert_eq!(committed_entry.kind, "deploy_skill");
            assert_eq!(committed_entry.phase, OperationPhase::Committed);
            assert_eq!(committed_entry.error_code, None);
            let failed_entry = history
                .entries
                .iter()
                .find(|entry| entry.operation_id == rolled_back.operation_id.to_string())
                .expect("rolled back entry is listed");
            assert_eq!(failed_entry.kind, "remove_skill");
            assert_eq!(failed_entry.phase, OperationPhase::RolledBack);
            assert_eq!(failed_entry.error_code, Some(ErrorCode::OperationConflict));
        }
        other => panic!("unexpected result: {other:?}"),
    }
}

#[tokio::test]
async fn the_history_never_claims_skill_scoping_it_cannot_perform() {
    let database = Database::open_in_memory().expect("database");
    insert_record(
        &database,
        &OperationRecord::planned(OperationId::new(), "import_skill", "fingerprint-import"),
    )
    .await;
    let facade = LocalApplicationFacade::new(database);

    let result = facade
        .query(AppQuery::ListSkillOperations(
            skillhub_core::ListSkillOperations {
                skill_id: SkillId::new(),
            },
        ))
        .await
        .expect("list skill operations");

    match result {
        AppQueryResult::SkillOperations(history) => {
            // Even for an unrelated skill id the journal is returned globally:
            // the limitation marker is what keeps this honest in the UI.
            assert_eq!(history.entries.len(), 1);
            assert!(!history.filtered);
            assert!(history.limitation.is_some());
        }
        other => panic!("unexpected result: {other:?}"),
    }
}
