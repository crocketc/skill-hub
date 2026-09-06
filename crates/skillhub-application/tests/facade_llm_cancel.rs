//! Cancellation of the in-flight LLM safety check. The check runs on a worker
//! thread, so the facade keeps it discoverable (`list_running_llm_checks`) and
//! `cancel_operation` marks it cancelled: the awaiting command then refuses to
//! persist or report a result for an abandoned run.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    api::{AppCommandResult, RunLlmSafetyCheck},
    catalog::{CatalogRepository, Skill},
    AppCommand, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode, OperationId,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

struct SlowRunner;

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for SlowRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        // Far longer than the test; a cancelled check must not wait for it.
        tokio::time::sleep(Duration::from_secs(30)).await;
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "slow-request".to_owned(),
            kind: request.kind,
            output: json!({}),
        })
    }
}

async fn facade_with_check() -> (
    Arc<LocalApplicationFacade>,
    skillhub_core::SkillId,
    skillhub_core::VersionId,
) {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Cancellable checks");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let profile = skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile");
    database
        .llm_profile_repository()
        .save(&profile)
        .expect("save profile");
    let library_root = tempfile::tempdir().expect("library");
    CentralLibrary::initialize(library_root.path()).expect("initialize library");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "quoted content\n").expect("write skill");
    let version = VersionStore::new(skillhub_core::LibraryPaths::from_root(
        library_root.path().to_path_buf(),
    ))
    .capture(skill.id(), source.path())
    .expect("capture version");
    let facade = Arc::new(LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        library_root.path(),
        Arc::new(SlowRunner),
    ));
    (facade, skill.id(), version.id)
}

fn running_checks(result: AppQueryResult) -> Vec<skillhub_core::LlmCheckRun> {
    match result {
        AppQueryResult::RunningLlmChecks(runs) => runs,
        other => panic!("unexpected result: {other:?}"),
    }
}

#[tokio::test]
async fn a_running_check_is_visible_and_cancel_operation_abandons_it() {
    let (facade, skill_id, version_id) = facade_with_check().await;
    let local = tokio::task::LocalSet::new();
    local.run_until(async move {
        let check_task = {
            let facade = facade.clone();
            tokio::task::spawn_local(async move {
                facade
                    .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
                        skill_id,
                        version_id: version_id.clone(),
                    }))
                    .await
            })
        };

        // The run announces itself for progress display before finishing.
        let operation_id = loop {
            let runs = running_checks(
                facade
                    .query(AppQuery::ListRunningLlmChecks)
                    .await
                    .expect("running checks"),
            );
            if let Some(run) = runs.first() {
                assert_eq!(run.skill_id, skill_id.to_string());
                break run.operation_id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };

        let cancel = facade
            .execute(AppCommand::CancelOperation { operation_id })
            .await
            .expect("cancel running check");
        let AppCommandResult::OperationSummary(summary) = cancel else {
            panic!("expected operation summary");
        };
        assert_eq!(summary.message_code, "operation.cancel_requested");

        let outcome = check_task
            .await
            .expect("check task joins")
            .expect_err("a cancelled check must not report a result");
        assert_eq!(outcome.code, ErrorCode::OperationConflict);

        // The registry no longer reports the abandoned run.
        let runs = running_checks(
            facade
                .query(AppQuery::ListRunningLlmChecks)
                .await
                .expect("running checks after cancel"),
        );
        assert!(runs.is_empty());
    });
}

#[tokio::test]
async fn cancelling_an_unknown_operation_is_an_honest_object_not_found() {
    let facade = LocalApplicationFacade::new(Database::open_in_memory().expect("database"));
    let error = facade
        .execute(AppCommand::CancelOperation {
            operation_id: OperationId::new(),
        })
        .await
        .expect_err("unknown operation id");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

#[tokio::test]
async fn a_second_check_for_the_same_version_is_refused_while_one_runs() {
    let (facade, skill_id, version_id) = facade_with_check().await;
    let local = tokio::task::LocalSet::new();
    local.run_until(async move {
        let first = {
            let facade = facade.clone();
            let skill_id = skill_id;
            let version_id = version_id.clone();
            tokio::task::spawn_local(async move {
                facade
                    .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
                        skill_id,
                        version_id,
                    }))
                    .await
            })
        };
        loop {
            if !running_checks(
                facade
                    .query(AppQuery::ListRunningLlmChecks)
                    .await
                    .expect("running checks"),
            )
            .is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let error = facade
            .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
                skill_id,
                version_id,
            }))
            .await
            .expect_err("duplicate concurrent check");
        assert_eq!(error.code, ErrorCode::OperationConflict);

        // Clean up: cancel the first run so its worker thread does not linger.
        let runs = running_checks(
            facade
                .query(AppQuery::ListRunningLlmChecks)
                .await
                .expect("running checks"),
        );
        facade
            .execute(AppCommand::CancelOperation {
                operation_id: runs[0].operation_id,
            })
            .await
            .expect("cancel");
        let _ = first.await;
    });
}
