//! The AI safety-check closed loop: a fresh deterministic basic check always
//! runs first and its run id is linked into the AI result, and the evidence
//! sent to the LLM has plaintext credential values masked before transmission.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::{
    api::RunLlmSafetyCheck, AppCommand, AppCommandResult, AppQuery, AppQueryResult,
    ApplicationFacade, SkillId, VersionId,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

/// Returns one valid LLM finding and records every prompt it was shown so
/// tests can assert on the exact evidence transmission.
struct RecordingRunner {
    inputs: Mutex<Vec<String>>,
}

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for RecordingRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        self.inputs
            .lock()
            .expect("record inputs")
            .push(request.input.clone());
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "safety-request".to_owned(),
            kind: request.kind,
            output: json!({
                "findings": [{
                    "code": "llm.credential_handling",
                    "severity": "warning",
                    "file": "SKILL.md",
                    "line_start": 1,
                    "line_end": 1,
                    "explanation": "credential-like value present"
                }]
            }),
        })
    }
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

/// Library-backed facade plus one captured version whose `SKILL.md` carries
/// the given content. Returns the ids the check commands need and the shared
/// recording runner.
async fn fixture(
    skill_content: &str,
) -> (
    tempfile::TempDir,
    Arc<LocalApplicationFacade>,
    Arc<RecordingRunner>,
    SkillId,
    VersionId,
) {
    let database = Database::open_in_memory().expect("database");
    let skill = Skill::new(SkillId::new(), "Safety flow");
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
    std::fs::write(source.path().join("SKILL.md"), skill_content).expect("write skill");
    let version = VersionStore::new(skillhub_core::LibraryPaths::from_root(
        library_root.path().to_path_buf(),
    ))
    .capture(skill.id(), source.path())
    .expect("capture version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version.id.to_string(), skill.id().to_string()],
        )
        .expect("insert version");
    let runner = Arc::new(RecordingRunner {
        inputs: Mutex::new(Vec::new()),
    });
    let facade = Arc::new(LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        library_root.path(),
        runner.clone(),
    ));
    enable_safety_check(&facade).await;
    (library_root, facade, runner, skill.id(), version.id)
}

#[tokio::test]
async fn llm_check_runs_a_fresh_basic_check_first_and_links_it() {
    let (_library, facade, _runner, skill_id, version_id) =
        fixture("Extract rows from spreadsheets\n").await;

    let result = facade
        .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
            skill_id,
            version_id: version_id.clone(),
        }))
        .await
        .expect("llm safety check");
    let AppCommandResult::LlmSafetyCheckResult(result) = result else {
        panic!("expected llm safety result");
    };
    assert!(result
        .run_id
        .as_deref()
        .is_some_and(|id| id.starts_with("llm-safety-") && id.ends_with("-0")));
    assert_eq!(result.model_id.as_deref(), Some("test-model"));

    // The deterministic basic check ran first and is linked from the AI run.
    let basic = basic_run(&facade, skill_id, &version_id).await;
    let Some(basic) = basic else {
        panic!("expected a basic check run");
    };
    assert_eq!(basic.ruleset_id.as_deref(), Some("basic-v1"));
    assert_eq!(
        result.basic_run_id.as_deref(),
        basic.run_id.as_deref(),
        "the AI result links the basic run it was built on"
    );
}

#[tokio::test]
async fn llm_check_reuses_a_current_basic_run_instead_of_rerunning() {
    let (_library, facade, _runner, skill_id, version_id) =
        fixture("Extract rows from spreadsheets\n").await;
    facade
        .execute(AppCommand::RunBasicCheck(
            skillhub_core::api::RunBasicCheck {
                skill_id,
                version_id: version_id.clone(),
            },
        ))
        .await
        .expect("basic check");
    let before = basic_run(&facade, skill_id, &version_id)
        .await
        .expect("basic run");

    facade
        .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
            skill_id,
            version_id: version_id.clone(),
        }))
        .await
        .expect("llm safety check");

    let after = basic_run(&facade, skill_id, &version_id)
        .await
        .expect("basic run");
    assert_eq!(before.run_id, after.run_id, "current basic run is reused");
}

#[tokio::test]
async fn evidence_sent_to_the_llm_masks_plaintext_credentials() {
    let secret = "sk-live-abcdef123456";
    let content = format!("API_TOKEN={secret}\nExtract rows from spreadsheets\n");
    let (_library, facade, runner, skill_id, version_id) = fixture(&content).await;

    let result = facade
        .execute(AppCommand::RunLlmSafetyCheck(RunLlmSafetyCheck {
            skill_id,
            version_id: version_id.clone(),
        }))
        .await
        .expect("llm safety check");
    let AppCommandResult::LlmSafetyCheckResult(_) = result else {
        panic!("expected llm safety result");
    };

    let inputs = runner.inputs.lock().expect("inputs").clone();
    assert_eq!(inputs.len(), 1, "exactly one evidence transmission");
    assert!(
        !inputs[0].contains(secret),
        "the credential value must never be transmitted"
    );
    assert!(
        inputs[0].contains("[REDACTED]"),
        "masked evidence keeps the line but not the value"
    );
}

async fn basic_run(
    facade: &LocalApplicationFacade,
    skill_id: SkillId,
    version_id: &VersionId,
) -> Option<skillhub_core::api::BasicCheckResult> {
    let result = facade
        .query(AppQuery::GetBasicCheckResult(
            skillhub_core::api::GetBasicCheckResult {
                skill_id,
                version_id: version_id.clone(),
            },
        ))
        .await
        .expect("basic check result");
    let AppQueryResult::BasicCheckResult(result) = result else {
        panic!("expected basic check result");
    };
    Some(result)
}
