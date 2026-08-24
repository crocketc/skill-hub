use async_trait::async_trait;
use skillhub_core::application::{
    BasicCheckOutput, BasicCheckScanner, CheckService, VersionMaterializer,
};
use skillhub_core::check::{CheckKind, CheckRepository, CheckState, Finding, FindingDisposition};
use skillhub_core::deployment::{
    DeploymentPlanInput, DeploymentPlanner, RegisteredTargetIndex, TargetFact, TargetFactSource,
    VerifiedTarget,
};
use skillhub_core::{
    physical_id_for_path, AllowedRoot, AppResult, DeploymentCapability, ErrorCode, PathPolicy,
    RegisteredTargetResolver, Severity, SkillId, VersionId,
};
use std::path::Path;
use std::sync::Mutex;
use tempfile::{tempdir, TempDir};

#[derive(Default)]
struct MemoryCheckRepository {
    runs: Mutex<Vec<skillhub_core::check::CheckRun>>,
}

#[async_trait(?Send)]
impl CheckRepository for MemoryCheckRepository {
    async fn insert(&self, run: &skillhub_core::check::CheckRun) -> AppResult<()> {
        self.runs.lock().unwrap().push(run.clone());
        Ok(())
    }

    async fn get(&self, id: &str) -> AppResult<Option<skillhub_core::check::CheckRun>> {
        Ok(self
            .runs
            .lock()
            .unwrap()
            .iter()
            .find(|run| run.id == id)
            .cloned())
    }

    async fn update(&self, run: &skillhub_core::check::CheckRun) -> AppResult<()> {
        let mut runs = self.runs.lock().unwrap();
        let existing = runs
            .iter_mut()
            .find(|existing| existing.id == run.id)
            .expect("run exists");
        *existing = run.clone();
        Ok(())
    }

    async fn list_for_version(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        kind: CheckKind,
    ) -> AppResult<Vec<skillhub_core::check::CheckRun>> {
        Ok(self
            .runs
            .lock()
            .unwrap()
            .iter()
            .filter(|run| {
                run.skill_id == skill_id && &run.version_id == version_id && run.kind == kind
            })
            .cloned()
            .collect())
    }

    async fn current_for_version(
        &self,
        skill_id: SkillId,
        version_id: &VersionId,
        kind: CheckKind,
    ) -> AppResult<Option<skillhub_core::check::CheckRun>> {
        Ok(self
            .runs
            .lock()
            .unwrap()
            .iter()
            .filter(|run| {
                run.skill_id == skill_id && &run.version_id == version_id && run.kind == kind
            })
            .max_by_key(|run| (run.generation, run.started_at, run.id.clone()))
            .cloned())
    }
}

#[derive(Clone)]
struct StaticScanner {
    findings: Vec<Finding>,
}

impl BasicCheckScanner for StaticScanner {
    fn scan_version(&self, _root: &Path) -> AppResult<BasicCheckOutput> {
        Ok(BasicCheckOutput {
            ruleset_id: "basic-test".to_owned(),
            findings: self.findings.clone(),
            coverage_inputs: serde_json::json!({ "files": ["SKILL.md"] }),
        })
    }
}

struct FailingScanner;

impl BasicCheckScanner for FailingScanner {
    fn scan_version(&self, _root: &Path) -> AppResult<BasicCheckOutput> {
        Err(skillhub_core::AppError::new(
            ErrorCode::InternalError,
            Severity::Error,
        ))
    }
}

struct NoopMaterializer;

impl VersionMaterializer for NoopMaterializer {
    fn materialize_version(&self, _version_id: &VersionId, output: &Path) -> AppResult<()> {
        std::fs::create_dir_all(output).unwrap();
        std::fs::write(output.join("SKILL.md"), "# test").unwrap();
        Ok(())
    }
}

fn version(hex: char) -> VersionId {
    VersionId::parse(&format!("sha256:{}", hex.to_string().repeat(64))).unwrap()
}

fn high_risk_finding() -> Finding {
    Finding::at(
        "critical-delete",
        "security.destructive_command",
        Severity::Critical,
        "SKILL.md",
        4,
        None,
    )
}

fn warning_finding() -> Finding {
    Finding::at(
        "credential",
        "security.possible_plaintext_credential",
        Severity::Warning,
        "SKILL.md",
        3,
        None,
    )
}

fn check_service(
    findings: Vec<Finding>,
) -> CheckService<MemoryCheckRepository, StaticScanner, NoopMaterializer> {
    CheckService::new(
        MemoryCheckRepository::default(),
        StaticScanner { findings },
        NoopMaterializer,
    )
}

#[test]
fn basic_check_result_is_bound_to_one_immutable_version() {
    block_on(async {
        let service = check_service(Vec::new());
        let skill_id = SkillId::new();
        let checked = version('a');
        let edited = version('b');

        let result = service
            .run_basic_check(skill_id, checked.clone())
            .await
            .unwrap();
        assert_eq!(result.state, CheckState::Passed);
        assert_eq!(
            service
                .get_basic_check_result(skill_id, &checked)
                .await
                .unwrap()
                .state,
            CheckState::Passed
        );
        assert_eq!(
            service
                .get_basic_check_result(skill_id, &edited)
                .await
                .unwrap()
                .state,
            CheckState::NotChecked
        );
    });
}

#[test]
fn failed_basic_check_is_persisted_as_check_result_not_retried_forever() {
    block_on(async {
        let service = CheckService::new(
            MemoryCheckRepository::default(),
            FailingScanner,
            NoopMaterializer,
        );
        let skill_id = SkillId::new();
        let version_id = version('f');

        let result = service
            .run_basic_check(skill_id, version_id.clone())
            .await
            .unwrap();
        assert_eq!(result.state, CheckState::Failed);
        assert_eq!(
            result.run.as_ref().unwrap().failure_code.as_deref(),
            Some("internal.error")
        );
        assert_eq!(
            service
                .get_basic_check_result(skill_id, &version_id)
                .await
                .unwrap()
                .state,
            CheckState::Failed
        );
    });
}

#[test]
fn unresolved_high_risk_basic_finding_blocks_deployment_until_explicit_decision() {
    block_on(async {
        let service = check_service(vec![high_risk_finding()]);
        let skill_id = SkillId::new();
        let version_id = version('c');
        let run = service
            .run_basic_check(skill_id, version_id.clone())
            .await
            .unwrap();
        assert_eq!(run.state, CheckState::Failed);

        let blocked = DeploymentPlanner
            .plan(
                deployment_input(skill_id, version_id.clone())
                    .with_basic_check_run(run.run.unwrap()),
            )
            .unwrap_err();
        assert_eq!(blocked.code, ErrorCode::SecurityCheckBlocked);

        let unconfirmed = service
            .set_finding_disposition(
                skill_id,
                &version_id,
                "critical-delete",
                FindingDisposition::Acknowledged,
                false,
            )
            .await
            .unwrap_err();
        assert_eq!(unconfirmed.code, ErrorCode::InvalidInput);

        let acknowledged = service
            .set_finding_disposition(
                skill_id,
                &version_id,
                "critical-delete",
                FindingDisposition::Acknowledged,
                true,
            )
            .await
            .unwrap();
        assert_eq!(acknowledged.state, CheckState::Passed);

        DeploymentPlanner
            .plan(
                deployment_input(skill_id, version_id.clone())
                    .with_basic_check_run(acknowledged.run.unwrap()),
            )
            .unwrap();
    });
}

#[test]
fn warning_basic_finding_can_be_reviewed_without_blocking_deployment() {
    block_on(async {
        let service = check_service(vec![warning_finding()]);
        let skill_id = SkillId::new();
        let version_id = version('d');
        let run = service
            .run_basic_check(skill_id, version_id.clone())
            .await
            .unwrap();
        assert_eq!(run.state, CheckState::Failed);

        DeploymentPlanner
            .plan(deployment_input(skill_id, version_id).with_basic_check_run(run.run.unwrap()))
            .unwrap();
    });
}

#[test]
fn absent_llm_configuration_is_not_a_deployment_gate_fact() {
    let skill_id = SkillId::new();

    DeploymentPlanner
        .plan(deployment_input(skill_id, version('e')))
        .unwrap();
}

fn deployment_input(skill_id: SkillId, version_id: VersionId) -> DeploymentPlanInput {
    let workspace = tempdir().unwrap();
    let target = verified_target(&workspace);
    let input = DeploymentPlanInput::new(
        skill_id,
        version_id,
        "dangerous-skill",
        "/SkillHub/library/dangerous-skill",
        vec![target],
    );
    std::mem::forget(workspace);
    input
}

fn verified_target(workspace: &TempDir) -> VerifiedTarget {
    let target_path = workspace.path().join("skills");
    std::fs::create_dir_all(&target_path).unwrap();
    let physical_id = physical_id_for_path(&target_path).unwrap();
    let policy = PathPolicy::from_roots([AllowedRoot::new(workspace.path()).unwrap()]).unwrap();
    let fact = TargetFact::registered(
        "codex",
        target_path,
        physical_id,
        TargetFactSource::Discovery,
        DeploymentCapability::new(true, false, true),
    );
    let index = RegisteredTargetIndex::from_facts([fact], policy).unwrap();
    index.resolve(&["codex".to_owned()]).unwrap().remove(0)
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(future)
}
