//! Import-flow AI checks (step 5): a user-initiated batch pre-check over
//! prepared imports. The LLM layer is strictly advisory — deterministic gates
//! (format, ownership, conflicts, delete protection) are untouched — and
//! failures are reported per object without losing the rest of the batch.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    AppCommand, AppCommandResult, ApplicationFacade, ImportCandidate, ImportDecision,
    PrepareImport, RunImportAiChecks, SourceDescriptor, SourceKind, SourceLocator,
};
use skillhub_storage::{CentralLibrary, Database};

/// One LLM finding per successful call; fails on demand.
struct OutcomeRunner {
    fail: bool,
}

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for OutcomeRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        if self.fail {
            return Err(skillhub_core::AppError::llm_request_timeout(1_000));
        }
        let _ = &request;
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "import-ai-request".to_owned(),
            kind: request.kind,
            output: json!({
                "findings": [{
                    "code": "llm.credential_handling",
                    "severity": "warning",
                    "file": "SKILL.md",
                    "line_start": 1,
                    "line_end": 1,
                    "explanation": "looks like a credential"
                }]
            }),
        })
    }
}

fn facade_with(workspace: &std::path::Path, runner: OutcomeRunner) -> LocalApplicationFacade {
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
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
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        &library_root,
        Arc::new(runner),
    )
}

async fn enable_safety_check(facade: &LocalApplicationFacade) {
    facade
        .execute(AppCommand::SetDesktopPreferences(
            skillhub_core::DesktopPreferences {
                llm_capabilities: skillhub_core::settings::LlmCapabilitySettings {
                    safety_check: true,
                    ..skillhub_core::settings::LlmCapabilitySettings::default()
                },
                ..skillhub_core::DesktopPreferences::default()
            },
        ))
        .await
        .expect("enable safety check capability");
}

async fn prepared_import(
    facade: &LocalApplicationFacade,
    root: &std::path::Path,
) -> skillhub_core::OperationId {
    let candidate = ImportCandidate::detected(
        SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(root)),
        root.to_string_lossy(),
        ".",
        "SKILL.md",
        "Notes",
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
    prepared.id
}

#[tokio::test]
async fn import_ai_checks_report_per_object_and_leave_import_gates_intact() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path(), OutcomeRunner { fail: false });
    enable_safety_check(&facade).await;
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write SKILL.md");
    std::fs::write(source.path().join("USAGE.md"), "how to use\n").expect("write USAGE.md");
    let id = prepared_import(&facade, source.path()).await;

    let report = facade
        .execute(AppCommand::RunImportAiChecks(RunImportAiChecks {
            prepared_import_ids: vec![id],
        }))
        .await
        .expect("import ai checks");
    let AppCommandResult::ImportAiChecksReport(report) = report else {
        panic!("expected import ai checks report");
    };
    assert_eq!(report.requested, 1);
    assert_eq!(report.provider, "test");
    assert_eq!(report.model, "test-model");
    assert_eq!(report.outcomes.len(), 1);
    let outcome = &report.outcomes[0];
    assert_eq!(outcome.prepared_import_id, id);
    assert_eq!(outcome.state, skillhub_core::check::CheckState::Passed);
    assert_eq!(outcome.finding_count, 1);
    assert_eq!(outcome.file_count, 2, "both markdown files were evidence");
    assert_eq!(outcome.failure_code, None);

    // The AI layer is advisory: the deterministic import still succeeds.
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: id,
            decision: ImportDecision::CopyIntoLibrary,
        }))
        .await
        .expect("commit import after ai findings");
    let AppCommandResult::ImportSummary(summary) = committed else {
        panic!("expected import summary");
    };
    assert!(summary.items[0].skill_id.is_some());
}

#[tokio::test]
async fn import_ai_checks_report_failures_per_object_without_losing_the_rest() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path(), OutcomeRunner { fail: true });
    enable_safety_check(&facade).await;
    let first = tempfile::tempdir().expect("first source");
    std::fs::write(first.path().join("SKILL.md"), "# A\n").expect("write");
    let second = tempfile::tempdir().expect("second source");
    std::fs::write(second.path().join("SKILL.md"), "# B\n").expect("write");
    let id_a = prepared_import(&facade, first.path()).await;
    let id_b = prepared_import(&facade, second.path()).await;
    let missing = skillhub_core::OperationId::new();

    let report = facade
        .execute(AppCommand::RunImportAiChecks(RunImportAiChecks {
            prepared_import_ids: vec![id_a, missing, id_b],
        }))
        .await
        .expect("batch runs to completion");
    let AppCommandResult::ImportAiChecksReport(report) = report else {
        panic!("expected import ai checks report");
    };
    assert_eq!(report.requested, 3);
    assert_eq!(report.outcomes.len(), 3);
    for outcome in &report.outcomes {
        assert_eq!(
            outcome.state,
            skillhub_core::check::CheckState::Failed,
            "each object reports its own failure"
        );
    }
    assert_eq!(
        report.outcomes[0].failure_code.as_deref(),
        Some("llm.request_timeout")
    );
    assert_eq!(
        report.outcomes[1].failure_code.as_deref(),
        Some("object.not_found"),
        "an unknown prepared id is an honest per-object failure"
    );
    assert_eq!(
        report.outcomes[2].failure_code.as_deref(),
        Some("llm.request_timeout")
    );
    let reported_ids: Vec<_> = report
        .outcomes
        .iter()
        .map(|outcome| outcome.prepared_import_id)
        .collect();
    assert_eq!(reported_ids, vec![id_a, missing, id_b]);
}

#[tokio::test]
async fn import_ai_checks_respect_the_capability_switch() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path(), OutcomeRunner { fail: false });
    // Capability stays off (privacy-first default).
    let source = tempfile::tempdir().expect("source");
    std::fs::write(source.path().join("SKILL.md"), "# Notes\n").expect("write");
    let id = prepared_import(&facade, source.path()).await;

    let error = facade
        .execute(AppCommand::RunImportAiChecks(RunImportAiChecks {
            prepared_import_ids: vec![id],
        }))
        .await
        .expect_err("capability disabled");
    assert_eq!(error.code.as_str(), "llm.capability_disabled");
}
