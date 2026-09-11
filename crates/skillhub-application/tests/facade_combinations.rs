//! Combination mutation flows driven through the public facade: rename with
//! duplicate/missing defense, legacy ambiguous names, and durable journal
//! records for the four mutation commands. No journal row is ever fabricated
//! by hand — every assertion reads `GetBootstrapSnapshot.recent_operations`.

use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CombinationResult, CreateCombination, DeleteCombination,
    ListCombinations, RenameCombination, UpdateCombination,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{
    AppCommand, AppQuery, ApplicationFacade, ErrorCode, OperationPhase, RecentOperationSummary,
};
use skillhub_storage::Database;

async fn list_combinations(facade: &LocalApplicationFacade) -> Vec<CombinationResult> {
    let result = facade
        .query(AppQuery::ListCombinations(ListCombinations))
        .await
        .expect("list combinations");
    let AppQueryResult::Combinations(items) = result else {
        panic!("expected combinations")
    };
    items
}

async fn recent_operations(facade: &LocalApplicationFacade) -> Vec<RecentOperationSummary> {
    let result = facade
        .query(AppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap snapshot");
    match result {
        AppQueryResult::BootstrapSnapshot(snapshot) => snapshot.recent_operations,
        other => panic!("unexpected result: {other:?}"),
    }
}

async fn facade_with_two_skills() -> (
    LocalApplicationFacade,
    skillhub_core::SkillId,
    skillhub_core::SkillId,
) {
    let database = Database::open_in_memory().expect("database");
    let first = Skill::new(skillhub_core::SkillId::new(), "First");
    let second = Skill::new(skillhub_core::SkillId::new(), "Second");
    {
        let repository = database.catalog_repository().expect("catalog repository");
        repository.insert(&first).await.expect("insert first");
        repository.insert(&second).await.expect("insert second");
    }
    let facade = LocalApplicationFacade::new(database);
    (facade, first.id(), second.id())
}

#[tokio::test]
async fn rename_combination_updates_the_name_and_keeps_members() {
    let (facade, first, second) = facade_with_two_skills().await;
    facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![second, first],
        }))
        .await
        .expect("create combination");

    let renamed = facade
        .execute(AppCommand::RenameCombination(RenameCombination {
            from: "Writing stack".into(),
            to: "Prose stack".into(),
        }))
        .await
        .expect("rename combination");
    let AppCommandResult::Combination(view) = renamed else {
        panic!("expected the renamed combination view");
    };
    assert_eq!(view.name, "Prose stack");
    assert_eq!(view.members, vec![second, first]);

    let items = list_combinations(&facade).await;
    assert_eq!(items.len(), 1, "the rename must not duplicate the row");
    assert_eq!(items[0].name, "Prose stack");
    assert_eq!(items[0].members, vec![second, first]);
}

#[tokio::test]
async fn renaming_to_an_existing_name_is_rejected_with_target_exists() {
    let (facade, first, _second) = facade_with_two_skills().await;
    for name in ["Writing stack", "Prose stack"] {
        facade
            .execute(AppCommand::CreateCombination(CreateCombination {
                name: name.into(),
                members: vec![first],
            }))
            .await
            .expect("create combination");
    }

    let error = facade
        .execute(AppCommand::RenameCombination(RenameCombination {
            from: "Writing stack".into(),
            to: "Prose stack".into(),
        }))
        .await
        .expect_err("renaming onto an existing name must fail");
    assert_eq!(error.code, ErrorCode::TargetExists);
    assert_eq!(
        error
            .params
            .get("combination")
            .and_then(|value| value.as_str()),
        Some("Prose stack"),
        "the error must name the colliding combination"
    );

    let items = list_combinations(&facade).await;
    assert_eq!(
        items.len(),
        2,
        "both combinations must survive the rejection"
    );
    assert_eq!(items[0].name, "Prose stack");
    assert_eq!(items[1].name, "Writing stack");
}

#[tokio::test]
async fn renaming_a_missing_combination_is_object_not_found() {
    let (facade, first, _second) = facade_with_two_skills().await;

    let error = facade
        .execute(AppCommand::RenameCombination(RenameCombination {
            from: "No such combination".into(),
            to: "Prose stack".into(),
        }))
        .await
        .expect_err("renaming a missing combination must fail");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);

    let _ = first;
    assert!(list_combinations(&facade).await.is_empty());
}

#[tokio::test]
async fn creating_a_combination_with_a_duplicate_name_is_target_exists() {
    let (facade, first, second) = facade_with_two_skills().await;
    facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![first],
        }))
        .await
        .expect("create combination");

    let error = facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![second],
        }))
        .await
        .expect_err("a duplicate combination name must be rejected");
    assert_eq!(error.code, ErrorCode::TargetExists);
    assert_eq!(
        error
            .params
            .get("combination")
            .and_then(|value| value.as_str()),
        Some("Writing stack"),
        "the error must name the colliding combination"
    );

    let items = list_combinations(&facade).await;
    assert_eq!(items.len(), 1, "the duplicate row must not be inserted");
    assert_eq!(items[0].members, vec![first]);
}

#[tokio::test]
async fn combination_mutations_are_journalled_as_committed_records() {
    let (facade, first, second) = facade_with_two_skills().await;

    let created = facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![first, second],
        }))
        .await
        .expect("create combination");
    let AppCommandResult::OperationSummary(create_summary) = created else {
        panic!("expected create operation summary");
    };
    facade
        .execute(AppCommand::UpdateCombination(UpdateCombination {
            name: "Writing stack".into(),
            members: vec![second],
        }))
        .await
        .expect("update combination");
    facade
        .execute(AppCommand::RenameCombination(RenameCombination {
            from: "Writing stack".into(),
            to: "Prose stack".into(),
        }))
        .await
        .expect("rename combination");
    let deleted = facade
        .execute(AppCommand::DeleteCombination(DeleteCombination {
            name: "Prose stack".into(),
        }))
        .await
        .expect("delete combination");
    let AppCommandResult::OperationSummary(delete_summary) = deleted else {
        panic!("expected delete operation summary");
    };

    let operations = recent_operations(&facade).await;
    let create_record = operations
        .iter()
        .find(|record| record.operation_id == create_summary.operation_id)
        .expect("create_combination must be journalled with the returned operation id");
    assert_eq!(create_record.kind, "create_combination");
    assert_eq!(create_record.state, "completed");
    assert_eq!(create_record.phase, OperationPhase::Committed);
    assert_eq!(create_record.error_code, None);

    let update_record = operations
        .iter()
        .find(|record| record.kind == "update_combination")
        .expect("update_combination must be journalled");
    assert_eq!(update_record.state, "completed");
    assert_eq!(update_record.phase, OperationPhase::Committed);

    let rename_record = operations
        .iter()
        .find(|record| record.kind == "rename_combination")
        .expect("rename_combination must be journalled");
    assert_eq!(rename_record.state, "completed");
    assert_eq!(rename_record.phase, OperationPhase::Committed);

    let delete_record = operations
        .iter()
        .find(|record| record.operation_id == delete_summary.operation_id)
        .expect("delete_combination must be journalled with the returned operation id");
    assert_eq!(delete_record.kind, "delete_combination");
    assert_eq!(delete_record.state, "completed");
    assert_eq!(delete_record.phase, OperationPhase::Committed);
}

#[tokio::test]
async fn a_failed_create_combination_is_a_terminal_rolled_back_record() {
    let (facade, first, _second) = facade_with_two_skills().await;
    facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![first],
        }))
        .await
        .expect("create combination");

    let error = facade
        .execute(AppCommand::CreateCombination(CreateCombination {
            name: "Writing stack".into(),
            members: vec![first],
        }))
        .await
        .expect_err("duplicate create must fail");
    assert_eq!(error.code, ErrorCode::TargetExists);

    let operations = recent_operations(&facade).await;
    assert_eq!(operations.len(), 2, "both attempts are journalled");
    let failed = operations
        .iter()
        .find(|record| record.state == "rolled_back")
        .expect("the failed attempt must be journalled");
    assert_eq!(failed.kind, "create_combination");
    assert_eq!(failed.phase, OperationPhase::RolledBack);
    assert_eq!(
        failed.error_code.as_deref(),
        Some(ErrorCode::TargetExists.as_str())
    );
}
