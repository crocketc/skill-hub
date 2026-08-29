use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    api::AppQueryResult,
    catalog::{CatalogRepository, Skill},
    AppCommand, AppQuery as RootAppQuery, ApplicationFacade, ErrorCode, Severity,
};
use skillhub_storage::Database;

#[tokio::test]
async fn bootstrap_query_reads_counts_from_the_shared_database() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Markdown");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    let result = facade
        .query(RootAppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap result");

    let AppQueryResult::BootstrapSnapshot(snapshot) = result else {
        panic!("expected bootstrap snapshot");
    };
    assert_eq!(snapshot.skill_count, 1);
    assert_eq!(snapshot.project_count, 0);
    assert_eq!(snapshot.agent_count, 0);
    assert_eq!(snapshot.deployed_count, 0);
}

#[tokio::test]
async fn pending_query_uses_the_same_date_boundary_as_bootstrap() {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Trial").with_trial_due(2026, 8, 29);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");

    let facade = LocalApplicationFacade::new_with_today(database, (2026, 8, 29));
    let result = facade
        .query(RootAppQuery::ListPendingItems(
            skillhub_core::ListPendingItems,
        ))
        .await
        .expect("pending result");

    let AppQueryResult::PendingItems(items) = result else {
        panic!("expected pending items");
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].code, "trial.due");
}

#[tokio::test]
async fn unsupported_operations_return_a_structured_internal_error() {
    let facade = LocalApplicationFacade::new_with_today(
        Database::open_in_memory().expect("database"),
        (2026, 8, 29),
    );

    let error = facade
        .execute(AppCommand::CancelOperation {
            operation_id: skillhub_core::OperationId::new(),
        })
        .await
        .expect_err("unsupported command should fail explicitly");

    assert_eq!(error.code, ErrorCode::InternalError);
    assert_eq!(error.severity, Severity::Error);
    assert_eq!(error.params["operation"], "execute.cancel_operation");
}
