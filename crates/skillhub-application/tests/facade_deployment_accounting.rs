use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CommitDeployment, CommitUndeploy, GetDeploymentPlan,
    ListDeployments, PrepareDeployment, PrepareUndeploy,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::{DeploymentMode, TargetChange};
use skillhub_core::{
    AppCommand, AppQuery as RootAppQuery, ApplicationFacade, BootstrapSnapshot, ErrorCode,
    OperationId, OperationPhase, RecoveryAction, RemovalDecision, StartupRecoveryState,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

fn skill_markdown(name: &str) -> String {
    format!("---\nname: {name}\ndescription: demo skill for deployment\n---\n\n# Demo\n")
}

struct Harness {
    facade: LocalApplicationFacade,
    database_dir: tempfile::TempDir,
    library_root: tempfile::TempDir,
    target_root: tempfile::TempDir,
    skill: Skill,
    version_id: skillhub_core::VersionId,
}

/// Builds a production facade: no injected target index, no pre-seeded
/// `targets` row, a real captured version manifest.
async fn harness(client_id: &str, markdown_name: &str) -> Harness {
    let database_dir = tempfile::tempdir().expect("database dir");
    let database = Database::open(database_dir.path().join("skillhub.sqlite")).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Demo");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(
        source.path().join("SKILL.md"),
        skill_markdown(markdown_name),
    )
    .expect("write skill markdown");
    let library_root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version.id.to_string(), skill.id().to_string()],
        )
        .expect("insert version row");
    let target_root = tempfile::tempdir().expect("target root");
    let physical_id =
        skillhub_core::physical_id_for_path(target_root.path()).expect("target identity");
    let snapshot = DiscoverySnapshot {
        generation: "1".into(),
        observed_at: "2026-09-18T00:00:00Z".into(),
        instances: vec![ClientInstance {
            profile_id: "anthropic".into(),
            client_id: client_id.into(),
            kind: ClientKind::Cli,
            display_name: "Fixture".into(),
            supported_os: vec![OperatingSystem::Windows],
            client_presence: ClientPresence::Unknown,
        }],
        logical_targets: vec![LogicalTarget {
            id: "claude-global".into(),
            profile_id: "anthropic".into(),
            client_id: client_id.into(),
            scope: TargetScope::Global,
            path: target_root.path().to_string_lossy().into_owned(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: false,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id,
        }],
        physical_targets: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    Harness {
        facade,
        database_dir,
        library_root,
        target_root,
        skill,
        version_id: version.id,
    }
}

async fn managed_copy_plan(harness: &Harness) -> skillhub_core::DeploymentPlan {
    let planned = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::deployment::DeploymentPlanRequest {
                skill_id: harness.skill.id(),
                version_id: harness.version_id.clone(),
                runtime_name: "find-skills".into(),
                logical_target_ids: vec!["claude-global".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect("deployment plan");
    let AppQueryResult::DeploymentPlan(plan) = planned else {
        panic!("expected deployment plan");
    };
    plan
}

/// Result of one production commit, without asserting success: the failure
/// classification tests need to inspect a rejected commit.
struct CommitOutcome {
    operation_id: OperationId,
    committed: bool,
    error_codes: Vec<Option<String>>,
}

async fn commit_outcome(harness: &Harness, plan: skillhub_core::DeploymentPlan) -> CommitOutcome {
    let prepared = harness
        .facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare deployment");
    let AppCommandResult::PreparedDeployment(prepared) = prepared else {
        panic!("expected prepared deployment");
    };
    let summary = harness
        .facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("commit deployment");
    let AppCommandResult::DeploymentSummary(summary) = summary else {
        panic!("expected deployment summary");
    };
    CommitOutcome {
        operation_id: summary.operation_id,
        committed: summary.committed,
        error_codes: summary
            .targets
            .iter()
            .map(|target| target.error_code.clone())
            .collect(),
    }
}

async fn commit(harness: &Harness, plan: skillhub_core::DeploymentPlan) -> CommitOutcome {
    let outcome = commit_outcome(harness, plan).await;
    assert!(
        outcome.committed,
        "commit must succeed; failures: {:?}",
        outcome.error_codes
    );
    outcome
}

/// Removes a deployment through the production undeploy flow.
async fn undeploy(harness: &Harness, deployment_id: skillhub_core::DeploymentId) {
    let prepared = harness
        .facade
        .execute(AppCommand::PrepareUndeploy(PrepareUndeploy {
            deployment_id,
        }))
        .await
        .expect("prepare undeploy");
    let AppCommandResult::RemovalImpact(impact) = prepared else {
        panic!("expected removal impact");
    };
    harness
        .facade
        .execute(AppCommand::CommitUndeploy(CommitUndeploy {
            prepared_undeploy_id: impact.operation_id,
            decision: RemovalDecision::RemoveOwnedTarget,
        }))
        .await
        .expect("commit undeploy");
}

async fn bootstrap(harness: &Harness) -> BootstrapSnapshot {
    let snapshot = harness
        .facade
        .query(RootAppQuery::GetBootstrapSnapshot)
        .await
        .expect("bootstrap snapshot");
    let AppQueryResult::BootstrapSnapshot(snapshot) = snapshot else {
        panic!("expected bootstrap snapshot");
    };
    snapshot
}

fn deployment_rows(harness: &Harness) -> Vec<(String, String, String)> {
    let connection = rusqlite::Connection::open_with_flags(
        harness.database_dir.path().join("skillhub.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read connection");
    let mut statement = connection
        .prepare("SELECT id,state,runtime_name FROM deployments ORDER BY id")
        .expect("deployments statement");
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("deployments rows");
    rows.map(|row| row.expect("deployment row")).collect()
}

/// Opens a second connection to inject a failure or inspect a row the facade
/// itself wrote.
fn side_connection(harness: &Harness) -> rusqlite::Connection {
    rusqlite::Connection::open(harness.database_dir.path().join("skillhub.sqlite"))
        .expect("side connection")
}

/// D-7 + D-8 regression: the whole production commit path must succeed
/// without a hand-seeded `targets` row, and the private staging tree must
/// avoid Windows-illegal characters.
#[tokio::test]
async fn deployment_commit_records_full_accounting_without_seeded_targets() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let plan = managed_copy_plan(&harness).await;
    commit(&harness, plan).await;

    let deployed = harness.target_root.path().join("find-skills");
    assert!(
        deployed.join("SKILL.md").is_file(),
        "managed copy must land"
    );

    let staging_root = harness
        .library_root
        .path()
        .join(".skillhub")
        .join("deployment-trees");
    let skill_dir = staging_root.join(harness.skill.id().to_string());
    assert!(skill_dir.is_dir(), "staging skill directory must exist");
    for entry in std::fs::read_dir(&skill_dir).expect("staging entries") {
        let entry = entry.expect("staging entry");
        let name = entry.file_name().to_string_lossy().into_owned();
        assert!(
            !name.contains(':'),
            "staging name {name} must be colon-free"
        );
    }

    let records = harness
        .facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(harness.skill.id()),
        }))
        .await
        .expect("deployment records");
    let AppQueryResult::Deployments(records) = records else {
        panic!("expected deployment records");
    };
    assert_eq!(records.len(), 1, "deployment must be accounted");
}

/// D-8 regression: `deployments.target_id` references `targets(id)`, so the
/// commit must register the physical target itself.  `target_root()` (used by
/// removal and ownership proofs) reads exactly this row.
#[tokio::test]
async fn deployment_commit_writes_the_targets_row() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let plan = managed_copy_plan(&harness).await;
    commit(&harness, plan).await;
    let physical_id =
        skillhub_core::physical_id_for_path(harness.target_root.path()).expect("target identity");
    let connection = rusqlite::Connection::open_with_flags(
        harness.database_dir.path().join("skillhub.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read connection");
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM targets WHERE id=?1",
            rusqlite::params![physical_id],
            |row| row.get(0),
        )
        .expect("targets row");
    assert_eq!(count, 1, "the physical target must be registered");
}

/// D-9 regression, updated by DEV-21 (2026-09-20 user decision): the Claude
/// Code profile now declares junction support through the probe-verified
/// channel (RC-13/RC-14 real-machine evidence), so the plan follows the host
/// probe — symbolic link first, then junction, then managed copy. The D-9
/// gate itself (profile declaration ∩ host probe) is unchanged and stays
/// guarded by the dual-channel assertion in `builtin_profiles`.
#[tokio::test]
async fn claude_code_target_follows_host_capabilities_for_link_selection() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let planned = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::deployment::DeploymentPlanRequest {
                skill_id: harness.skill.id(),
                version_id: harness.version_id.clone(),
                runtime_name: "find-skills".into(),
                logical_target_ids: vec!["claude-global".into()],
                mode_override: None,
            },
        }))
        .await
        .expect("deployment plan");
    let AppQueryResult::DeploymentPlan(plan) = planned else {
        panic!("expected deployment plan");
    };
    assert_eq!(plan.targets.len(), 1);
    let host = skillhub_adapters::deployment::DeploymentFilesystem::new().available_capabilities();
    let declared = skillhub_core::DeploymentCapability::new(true, true, true);
    let expected = DeploymentMode::select(&skillhub_core::DeploymentCapability::new(
        declared.symlink && host.symlink,
        declared.junction && host.junction,
        declared.copy && host.copy,
    ))
    .expect("managed copy keeps the plan total");
    assert_eq!(
        plan.targets[0].mode, expected,
        "mode selection must follow the host probe under the declared profile"
    );
}

/// A client whose profile declares no deployment support at all must not
/// receive a plan instead of silently falling back to whatever the host can do.
#[tokio::test]
async fn profile_without_any_deployment_support_blocks_the_plan() {
    let harness = harness("anthropic.claude-desktop", "find-skills").await;
    let error = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::deployment::DeploymentPlanRequest {
                skill_id: harness.skill.id(),
                version_id: harness.version_id.clone(),
                runtime_name: "find-skills".into(),
                logical_target_ids: vec!["claude-global".into()],
                mode_override: None,
            },
        }))
        .await
        .expect_err("unsupported client must not produce a plan");
    assert_eq!(error.code, ErrorCode::AgentProfileInvalidCapability);
}

/// Name consistency: SKILL.md `name` must match the deployed folder name or
/// agents will not recognize the skill.  Without a safe alias strategy the
/// deployment preview must block before any target is touched.
#[tokio::test]
async fn deployment_plan_blocks_when_folder_name_differs_from_frontmatter_name() {
    let harness = harness("anthropic.claude-code", "some-other-name").await;
    let error = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::deployment::DeploymentPlanRequest {
                skill_id: harness.skill.id(),
                version_id: harness.version_id.clone(),
                runtime_name: "find-skills".into(),
                logical_target_ids: vec!["claude-global".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect_err("a deployment alias must not be silently applied");
    assert_eq!(error.code, ErrorCode::DeploymentNameMismatch);
}

#[tokio::test]
async fn matching_names_produce_no_name_warning() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let plan = managed_copy_plan(&harness).await;
    assert!(!plan
        .warnings
        .iter()
        .chain(plan.targets[0].warnings.iter())
        .any(|warning| warning == "deployment.name_mismatch"));
}

/// D-14/R-11 regression: removing a deployment only marks its row `removed`,
/// so the `UNIQUE(target_id, runtime_name)` slot stays occupied.  Adding the
/// same Skill to the same Agent again must reactivate that row instead of
/// failing on the constraint — and there must never be two rows for one
/// target position.
#[tokio::test]
async fn re_adding_a_removed_skill_reuses_the_same_position() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let deployed = harness.target_root.path().join("find-skills");

    let first = commit(&harness, managed_copy_plan(&harness).await).await;
    let original = deployment_rows(&harness);
    assert_eq!(original.len(), 1, "one accounting row after the first add");

    let records = harness
        .facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(harness.skill.id()),
        }))
        .await
        .expect("deployment records");
    let AppQueryResult::Deployments(records) = records else {
        panic!("expected deployment records");
    };
    undeploy(&harness, records[0].id).await;
    assert!(
        !deployed.exists(),
        "undeploy must remove the tenant directory"
    );
    assert_eq!(deployment_rows(&harness)[0].1, "removed");

    let second = commit(&harness, managed_copy_plan(&harness).await).await;
    assert!(
        deployed.join("SKILL.md").is_file(),
        "the second add must land the skill again"
    );

    let rows = deployment_rows(&harness);
    assert_eq!(rows.len(), 1, "one target position keeps exactly one row");
    assert_eq!(rows[0].1, "deployed", "the row must be reactivated");
    assert_eq!(rows[0].0, original[0].0, "the reactivated row keeps its id");
    assert_ne!(
        first.operation_id, second.operation_id,
        "each add is its own operation"
    );

    let snapshot = bootstrap(&harness).await;
    assert_eq!(
        snapshot.recovery_state,
        StartupRecoveryState::Clean,
        "a successful re-add must not leave the app in the recovery gate"
    );
}

/// D-12/R-10 regression: a deployment that is rejected before anything is
/// written (the destination is already occupied) is a terminal outcome, not a
/// recoverable one.  A plain rejected add must therefore keep the next launch
/// out of the recovery gate.
///
/// D-11 moves an occupied destination's rejection to planning time, so this
/// test plants the foreign directory *after* planning: it covers the race
/// where the destination is taken between plan and commit.
#[tokio::test]
async fn a_rejected_deployment_is_terminal_and_keeps_startup_clean() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let plan = managed_copy_plan(&harness).await;
    let occupied = harness.target_root.path().join("find-skills");
    std::fs::create_dir_all(&occupied).expect("foreign directory");
    std::fs::write(occupied.join("SKILL.md"), "# foreign\n").expect("foreign file");

    let outcome = commit_outcome(&harness, plan).await;
    assert!(
        !outcome.committed,
        "an occupied destination rejects the add"
    );
    assert_eq!(
        outcome.error_codes,
        vec![Some("deployment.target_exists".into())]
    );

    assert_eq!(
        std::fs::read_to_string(occupied.join("SKILL.md")).expect("foreign file survives"),
        "# foreign\n",
        "a rejected add must never touch the foreign content"
    );
    assert!(deployment_rows(&harness).is_empty(), "no accounting row");

    let snapshot = bootstrap(&harness).await;
    assert_eq!(
        snapshot.recovery_state,
        StartupRecoveryState::Clean,
        "a terminal failure must not gate the next launch"
    );
    let operation = snapshot
        .recent_operations
        .iter()
        .find(|operation| operation.operation_id == outcome.operation_id)
        .expect("the rejected add must still be journalled");
    assert_eq!(operation.phase, OperationPhase::RolledBack);
    assert_eq!(
        operation.error_code.as_deref(),
        Some("deployment.target_exists")
    );
}

/// The rejected add must tell the user *which* target failed and where, not
/// only an error code: `/operations/:id` reads this projection.
///
/// Like the terminal-classification test above, the foreign directory is
/// planted after planning because D-11 rejects an occupied destination at
/// planning time; this test covers the commit-time race.
#[tokio::test]
async fn a_rejected_deployment_records_the_failing_target_details() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let plan = managed_copy_plan(&harness).await;
    let occupied = harness.target_root.path().join("find-skills");
    std::fs::create_dir_all(&occupied).expect("foreign directory");

    let outcome = commit_outcome(&harness, plan).await;
    let snapshot = bootstrap(&harness).await;
    let operation = snapshot
        .recent_operations
        .iter()
        .find(|operation| operation.operation_id == outcome.operation_id)
        .expect("the rejected add must still be journalled");

    assert_eq!(operation.targets.len(), 1, "one target result is recorded");
    let target = &operation.targets[0];
    assert_eq!(
        target.error_code.as_deref(),
        Some("deployment.target_exists")
    );
    assert_eq!(
        target.path.as_deref(),
        Some(occupied.to_string_lossy().as_ref()),
        "the failing destination path must reach the operation record"
    );
}

/// A storage failure after the target was written must roll the written tree
/// back instead of leaving an unaccounted directory in the Agent folder.
#[tokio::test]
async fn a_storage_failure_rolls_back_the_written_target() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let deployed = harness.target_root.path().join("find-skills");
    side_connection(&harness)
        .execute_batch(
            "CREATE TRIGGER refuse_deployment_insert BEFORE INSERT ON deployments \
             BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;",
        )
        .expect("inject storage failure");

    let outcome = commit_outcome(&harness, managed_copy_plan(&harness).await).await;
    assert!(
        !outcome.committed,
        "the injected failure must fail the commit"
    );
    assert!(
        !deployed.exists(),
        "a failed commit must not leave the written target behind"
    );

    let records = harness
        .facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(harness.skill.id()),
        }))
        .await
        .expect("deployment records");
    let AppQueryResult::Deployments(records) = records else {
        panic!("expected deployment records");
    };
    assert!(records.is_empty(), "nothing may be accounted either");

    let snapshot = bootstrap(&harness).await;
    assert_eq!(
        snapshot.recovery_state,
        StartupRecoveryState::Clean,
        "a fully rolled back failure needs no user decision"
    );
}

/// Rolling back a recovery candidate must undo what the interrupted operation
/// wrote, not only settle the accounting row.
#[tokio::test]
async fn rolling_back_recovery_removes_the_recorded_target() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let residue = harness.target_root.path().join("find-skills");
    std::fs::create_dir_all(&residue).expect("half-written target");
    std::fs::write(residue.join("SKILL.md"), "# half written\n").expect("half-written file");

    let operation_id = OperationId::new();
    let progress = serde_json::json!({
        "progress": {
            "operation_id": operation_id.to_string(),
            "phase": "needs_recovery",
            "completed": 0,
            "total": 1,
            "message_code": "operation.deploy_skill.needs_recovery",
        },
        "recovery_data": {
            "pending_targets": [{
                "path": residue.to_string_lossy(),
                "runtime_name": "find-skills",
                "mode": "managed_copy",
            }],
        },
    });
    side_connection(&harness)
        .execute(
            "INSERT INTO operations(operation_id,kind,state,phase,request_fingerprint,progress_json,inverse_json,error_code,created_at,updated_at) \
             VALUES(?1,'deploy_skill','needs_recovery','needs_recovery','fixture',?2,'{}','operation.conflict',0,0)",
            rusqlite::params![operation_id.to_string(), progress.to_string()],
        )
        .expect("seed a recovery candidate");

    assert_eq!(
        bootstrap(&harness).await.recovery_state,
        StartupRecoveryState::NeedsRecovery,
        "the seeded candidate must gate startup"
    );

    harness
        .facade
        .execute(AppCommand::ResolveRecovery(
            skillhub_core::ResolveRecovery {
                operation_id,
                action: RecoveryAction::RollbackOperation,
            },
        ))
        .await
        .expect("rollback the candidate");

    assert!(
        !residue.exists(),
        "recovery must remove the target the interrupted operation wrote"
    );
    let snapshot = bootstrap(&harness).await;
    assert_eq!(
        snapshot.recovery_state,
        StartupRecoveryState::Clean,
        "the gate must open after the only candidate is resolved"
    );
    let operation = snapshot
        .recent_operations
        .iter()
        .find(|operation| operation.operation_id == operation_id)
        .expect("resolved operation stays in the history");
    assert_eq!(operation.phase, OperationPhase::RolledBack);
}

/// D-11 regression: a destination already occupied by a foreign directory
/// must be rejected at planning time, so the user decides before anything is
/// written instead of discovering the collision as a failed commit.
#[tokio::test]
async fn a_plan_for_an_occupied_destination_is_rejected_before_commit() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let occupied = harness.target_root.path().join("find-skills");
    std::fs::create_dir_all(&occupied).expect("foreign directory");
    std::fs::write(occupied.join("SKILL.md"), "# foreign\n").expect("foreign file");

    let planned = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::deployment::DeploymentPlanRequest {
                skill_id: harness.skill.id(),
                version_id: harness.version_id.clone(),
                runtime_name: "find-skills".into(),
                logical_target_ids: vec!["claude-global".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await;

    let error = planned.expect_err("an occupied destination must fail planning");
    assert_eq!(error.code.as_str(), "deployment.target_exists");
    assert_eq!(
        std::fs::read_to_string(occupied.join("SKILL.md")).expect("foreign file survives"),
        "# foreign\n",
        "planning must never touch the foreign content"
    );
    assert!(deployment_rows(&harness).is_empty(), "no accounting row");
}

/// D-11 regression: the same Skill and version already managed at the target
/// must plan as a no-op, not as a fresh create over an invisible deployment.
#[tokio::test]
async fn replanning_a_deployed_skill_reports_noop() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    commit(&harness, managed_copy_plan(&harness).await).await;

    let plan = managed_copy_plan(&harness).await;
    assert!(
        plan.conflicts.is_empty(),
        "the skill's own deployment is not a conflict: {:?}",
        plan.conflicts
    );
    assert_eq!(plan.targets.len(), 1);
    assert_eq!(plan.targets[0].change, TargetChange::NoOp);
}

/// D-11 companion: a removed row keeps its `(target, runtime_name)` position
/// in the database but occupies nothing on disk, so re-adding must plan as a
/// clean create.
#[tokio::test]
async fn replanning_after_undeploy_offers_a_clean_readd() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    commit(&harness, managed_copy_plan(&harness).await).await;
    let records = harness
        .facade
        .query(RootAppQuery::ListDeployments(ListDeployments {
            skill_id: Some(harness.skill.id()),
        }))
        .await
        .expect("deployment records");
    let AppQueryResult::Deployments(records) = records else {
        panic!("expected deployment records");
    };
    undeploy(&harness, records[0].id).await;

    let plan = managed_copy_plan(&harness).await;
    assert!(
        plan.conflicts.is_empty(),
        "a removed deployment must not block re-adding: {:?}",
        plan.conflicts
    );
    assert_eq!(plan.targets[0].change, TargetChange::Create);
}

// ---------------------------------------------------------------------------
// Task 13B: server-owned batch preview.  The client only ever names Skills,
// targets and a preference; every fact, the disposition and the final
// DeploymentPlan stay server-owned.  Commit carries a preview id plus per-pair
// fallback confirmations and exclusions, and the backend re-plans everything.
// ---------------------------------------------------------------------------

use skillhub_core::agent::DeploymentCapability;
use skillhub_core::api::{
    CommitDeploymentPreview, CommitDeploymentPreviewPair, DeploymentBatchPreview,
    DeploymentBatchPreviewRequestItem, DeploymentPairCommitOutcome, DeploymentPairPreview,
    DeploymentPreviewCommitResult, GetDeploymentBatchPreview,
};
use skillhub_core::deployment::{
    DeploymentBlockReason, DeploymentPreference, DeploymentPreviewDisposition,
};

struct TargetedHarness {
    facade: LocalApplicationFacade,
    database_dir: tempfile::TempDir,
    #[allow(dead_code)]
    library_root: tempfile::TempDir,
    target_root: tempfile::TempDir,
    skill: Skill,
    second_skill: Skill,
    version_id: skillhub_core::VersionId,
    second_version_id: skillhub_core::VersionId,
}

/// A production facade with an injected registered-target index, so preview
/// outcomes never depend on the host's own link privileges.  Two logical ids
/// point at the same physical directory and a second Skill is captured.
async fn targeted_harness(
    capabilities: DeploymentCapability,
    shared_reference: bool,
) -> TargetedHarness {
    use skillhub_core::deployment::{RegisteredTargetIndex, TargetFact, TargetFactSource};
    use skillhub_core::{AllowedRoot, PathPolicy};

    let database_dir = tempfile::tempdir().expect("database dir");
    let database = Database::open(database_dir.path().join("skillhub.sqlite")).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "Demo");
    let second_skill = Skill::new(skillhub_core::SkillId::new(), "Second");
    let catalog = database.catalog_repository().expect("catalog repository");
    catalog.insert(&skill).await.expect("insert skill");
    catalog.insert(&second_skill).await.expect("insert second");

    let library_root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let mut version_ids = Vec::new();
    for current in [&skill, &second_skill] {
        let source = tempfile::tempdir().expect("source");
        std::fs::write(
            source.path().join("SKILL.md"),
            skill_markdown("find-skills"),
        )
        .expect("write skill markdown");
        let version = VersionStore::from_library(&library)
            .capture(current.id(), source.path())
            .expect("capture");
        library
            .save_portable_skill(current, Some(&version.id))
            .expect("register current version");
        database
            .connection_for_test()
            .execute(
                "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
                rusqlite::params![version.id.to_string(), current.id().to_string()],
            )
            .expect("insert version row");
        version_ids.push(version.id);
    }

    let target_root = tempfile::tempdir().expect("target root");
    let physical_id =
        skillhub_core::physical_id_for_path(target_root.path()).expect("target identity");
    let policy = PathPolicy::from_roots([AllowedRoot::new(target_root.path()).unwrap()]).unwrap();
    let mut facts = Vec::new();
    for logical_id in ["claude-global", "codex-global"] {
        facts.push(
            TargetFact::registered(
                logical_id,
                target_root.path(),
                physical_id.clone(),
                TargetFactSource::Discovery,
                capabilities.clone(),
            )
            .with_case_sensitive(!cfg!(windows)),
        );
    }
    if shared_reference {
        // The registered shared-directory entry other agents read; the
        // preview must treat deployment here as a shared-impact question.
        let snapshot = skillhub_core::DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-09-24T00:00:00Z".into(),
            instances: Vec::new(),
            logical_targets: vec![skillhub_core::LogicalTarget {
                id: "claude-global".into(),
                profile_id: "agent-skills".into(),
                client_id: "agent-skills.directory".into(),
                scope: skillhub_core::TargetScope::Global,
                path: target_root.path().to_string_lossy().into_owned(),
                marker: "SKILL.md".into(),
                precedence: skillhub_core::DirectoryPrecedence::Preferred,
                shared_reference: true,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: physical_id.clone(),
            }],
            physical_targets: Vec::new(),
        };
        database
            .agent_repository()
            .replace(&snapshot)
            .expect("save shared discovery");
    }
    let index = RegisteredTargetIndex::from_facts(facts, policy).expect("target index");
    let facade =
        LocalApplicationFacade::new_with_library_and_targets(database, library_root.path(), index);
    TargetedHarness {
        facade,
        database_dir,
        library_root,
        target_root,
        skill,
        second_skill,
        version_id: version_ids[0].clone(),
        second_version_id: version_ids[1].clone(),
    }
}

async fn batch_preview(
    harness: &TargetedHarness,
    items: Vec<DeploymentBatchPreviewRequestItem>,
) -> DeploymentBatchPreview {
    batch_preview_with_confirmations(harness, items, []).await
}

async fn batch_preview_with_confirmations(
    harness: &TargetedHarness,
    items: Vec<DeploymentBatchPreviewRequestItem>,
    confirmations: impl IntoIterator<Item = (String, String)>,
) -> DeploymentBatchPreview {
    let response = harness
        .facade
        .query(RootAppQuery::GetDeploymentBatchPreview(
            GetDeploymentBatchPreview {
                items,
                confirmations: confirmations.into_iter().collect(),
                exclusions: Vec::new(),
            },
        ))
        .await
        .expect("batch preview");
    let AppQueryResult::DeploymentBatchPreview(preview) = response else {
        panic!("expected a deployment batch preview");
    };
    preview
}

fn find_pair<'a>(
    preview: &'a DeploymentBatchPreview,
    skill_id: &skillhub_core::SkillId,
    logical_id: &str,
) -> &'a DeploymentPairPreview {
    preview
        .pairs
        .iter()
        .find(|pair| {
            pair.skill_id == *skill_id && pair.logical_target_ids.iter().any(|id| id == logical_id)
        })
        .unwrap_or_else(|| {
            panic!(
                "pair for {logical_id} missing: {:?}",
                preview
                    .pairs
                    .iter()
                    .map(|pair| pair.pair_id.clone())
                    .collect::<Vec<_>>()
            )
        })
}

fn item(
    skill_id: skillhub_core::SkillId,
    version_id: Option<skillhub_core::VersionId>,
    logical_target_ids: &[&str],
    preference: DeploymentPreference,
) -> DeploymentBatchPreviewRequestItem {
    DeploymentBatchPreviewRequestItem {
        skill_id,
        version_id,
        runtime_name: Some("find-skills".into()),
        logical_target_ids: logical_target_ids.iter().map(|id| id.to_string()).collect(),
        preference,
    }
}

async fn commit_preview(
    harness: &TargetedHarness,
    preview_id: &str,
    pairs: Vec<CommitDeploymentPreviewPair>,
) -> DeploymentPreviewCommitResult {
    let response = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview_id.into(),
                pairs,
            },
        ))
        .await
        .expect("commit deployment preview");
    let AppCommandResult::DeploymentPreviewCommitResult(result) = response else {
        panic!("expected a deployment preview commit result");
    };
    result
}

fn fallback_pair(pair_id: &str, confirm: bool, exclude: bool) -> CommitDeploymentPreviewPair {
    CommitDeploymentPreviewPair {
        pair_id: pair_id.into(),
        confirm_fallback: confirm,
        exclude,
    }
}

fn deployment_rows_accounting(harness: &TargetedHarness) -> Vec<(String, String, String)> {
    let connection = rusqlite::Connection::open_with_flags(
        harness.database_dir.path().join("skillhub.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("read connection");
    let mut statement = connection
        .prepare("SELECT id,state,runtime_name FROM deployments ORDER BY id")
        .expect("deployments statement");
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("deployments rows");
    rows.map(|row| row.expect("deployment row")).collect()
}

/// 13.6: every Skill x target pair is reported on its own; one pair's failure
/// never hides another pair of the same Skill, and several logical targets on
/// one physical directory collapse into one pair.
#[tokio::test]
async fn batch_preview_reports_each_pair_independently_and_dedupes_physical_targets() {
    let harness = targeted_harness(DeploymentCapability::new(true, false, true), false).await;
    let preview = batch_preview(
        &harness,
        vec![
            item(
                harness.skill.id(),
                Some(harness.version_id.clone()),
                &["claude-global", "codex-global"],
                DeploymentPreference::Automatic,
            ),
            item(
                harness.skill.id(),
                Some(harness.version_id.clone()),
                &["not-registered"],
                DeploymentPreference::Automatic,
            ),
            item(
                harness.second_skill.id(),
                Some(harness.second_version_id.clone()),
                &["not-registered"],
                DeploymentPreference::Automatic,
            ),
        ],
    )
    .await;

    assert!(!preview.preview_id.is_empty());
    assert!(
        preview.pairs.len() == 3,
        "physical duplicates collapse, failures stay visible: {:?}",
        preview
            .pairs
            .iter()
            .map(|pair| pair.pair_id.clone())
            .collect::<Vec<_>>()
    );

    let healthy = preview
        .pairs
        .iter()
        .find(|pair| pair.skill_id == harness.skill.id() && pair.logical_target_ids.len() == 2)
        .expect("merged physical pair");
    assert_eq!(
        healthy.disposition,
        DeploymentPreviewDisposition::SelectedMode
    );
    assert_eq!(healthy.mode, Some(DeploymentMode::SymbolicLink));
    assert_eq!(healthy.block_reason, None);
    assert_eq!(
        healthy.target_path,
        harness.target_root.path().to_string_lossy()
    );

    let failed = find_pair(&preview, &harness.skill.id(), "not-registered");
    assert_eq!(failed.disposition, DeploymentPreviewDisposition::Blocked);
    assert_eq!(
        failed.block_reason,
        Some(DeploymentBlockReason::PathUnavailable)
    );
    assert!(
        failed.technical_error.is_some(),
        "the original failure stays available for the technical details area"
    );

    let second = find_pair(&preview, &harness.second_skill.id(), "not-registered");
    assert_eq!(second.disposition, DeploymentPreviewDisposition::Blocked);
}

/// 13.12: the application resolves the Skill's current version and declared
/// runtime name when the request does not pin them.
#[tokio::test]
async fn batch_preview_resolves_current_version_and_runtime_name_server_side() {
    let harness = targeted_harness(DeploymentCapability::new(true, true, true), false).await;
    let mut request_item = item(
        harness.skill.id(),
        None,
        &["claude-global"],
        DeploymentPreference::Automatic,
    );
    request_item.runtime_name = None;
    let preview = batch_preview(&harness, vec![request_item]).await;

    let pair = &preview.pairs[0];
    assert_eq!(pair.version_id, harness.version_id);
    assert_eq!(pair.runtime_name, "find-skills");
    assert_eq!(pair.skill_display_name, "Demo");
}

/// 13.7: an explicit Link preference on a copy-only target recommends a copy;
/// only the confirmed fallback replans to a real ManagedCopy deployment.
#[tokio::test]
async fn confirmed_copy_fallback_commits_through_a_replanned_managed_copy() {
    let harness = targeted_harness(DeploymentCapability::new(false, false, true), false).await;
    let preview = batch_preview(
        &harness,
        vec![item(
            harness.skill.id(),
            Some(harness.version_id.clone()),
            &["claude-global"],
            DeploymentPreference::Link,
        )],
    )
    .await;
    let pair = find_pair(&preview, &harness.skill.id(), "claude-global").clone();
    assert_eq!(
        pair.disposition,
        DeploymentPreviewDisposition::RecommendCopy
    );
    assert_eq!(pair.fallback_mode, Some(DeploymentMode::ManagedCopy));
    assert!(!pair.confirmation_preserved);

    // Re-previewing with the held confirmation marks it preserved: the facts
    // did not move since the fingerprint was minted.  This must happen before
    // the commit, whose own deployment changes the facts.
    let again = batch_preview_with_confirmations(
        &harness,
        vec![item(
            harness.skill.id(),
            Some(harness.version_id.clone()),
            &["claude-global"],
            DeploymentPreference::Link,
        )],
        [(pair.pair_id.clone(), pair.confirmation_fingerprint.clone())],
    )
    .await;
    let rechecked = find_pair(&again, &harness.skill.id(), "claude-global");
    assert!(
        rechecked.confirmation_preserved,
        "unchanged facts keep the confirmation valid"
    );

    let result = commit_preview(
        &harness,
        &preview.preview_id,
        vec![fallback_pair(&pair.pair_id, true, false)],
    )
    .await;
    assert_eq!(result.pairs.len(), 1);
    assert_eq!(
        result.pairs[0].outcome,
        DeploymentPairCommitOutcome::Deployed
    );
    assert!(result.pairs[0].operation_id.is_some());
    assert!(!result.replayed);
    assert_eq!(deployment_rows_accounting(&harness).len(), 1);

    // After the deployment the facts moved, so the same held confirmation no
    // longer matches: the backend says so instead of trusting the client.
    let after = batch_preview_with_confirmations(
        &harness,
        vec![item(
            harness.skill.id(),
            Some(harness.version_id.clone()),
            &["claude-global"],
            DeploymentPreference::Link,
        )],
        [(pair.pair_id.clone(), pair.confirmation_fingerprint.clone())],
    )
    .await;
    let invalidated = find_pair(&after, &harness.skill.id(), "claude-global");
    assert!(
        !invalidated.confirmation_preserved,
        "a deployed pair invalidates the held confirmation"
    );
}

/// 13.8: a RecommendCopy pair without an explicit confirmation never reaches
/// prepare, and facts that moved since the preview refuse the old snapshot.
#[tokio::test]
async fn unconfirmed_or_stale_copy_fallback_never_touches_the_filesystem() {
    let harness = targeted_harness(DeploymentCapability::new(false, false, true), false).await;
    let preview = batch_preview(
        &harness,
        vec![item(
            harness.skill.id(),
            Some(harness.version_id.clone()),
            &["claude-global"],
            DeploymentPreference::Link,
        )],
    )
    .await;
    let pair = find_pair(&preview, &harness.skill.id(), "claude-global").clone();

    let unconfirmed = commit_preview(
        &harness,
        &preview.preview_id,
        vec![fallback_pair(&pair.pair_id, false, false)],
    )
    .await;
    assert_eq!(
        unconfirmed.pairs[0].outcome,
        DeploymentPairCommitOutcome::Blocked
    );
    assert!(deployment_rows_accounting(&harness).is_empty());

    // The destination gets occupied after the preview: the stale snapshot
    // must refuse the commit instead of replaying stale facts.
    let occupied = harness.target_root.path().join("find-skills");
    std::fs::create_dir_all(&occupied).expect("foreign directory");
    let stale = commit_preview(
        &harness,
        &preview.preview_id,
        vec![fallback_pair(&pair.pair_id, true, false)],
    )
    .await;
    assert_eq!(stale.pairs[0].outcome, DeploymentPairCommitOutcome::Blocked);
    assert_eq!(
        stale.pairs[0]
            .error
            .as_ref()
            .expect("stale fingerprint reports the cause")
            .code,
        skillhub_core::ErrorCode::TargetChanged
    );
    assert!(
        std::fs::symlink_metadata(&occupied).is_ok(),
        "the foreign directory survives"
    );
    assert!(deployment_rows_accounting(&harness).is_empty());
}

/// 13.8 + 13.10: forged previews are refused, an identical commit replays its
/// recorded result, and a consumed snapshot cannot run a second batch.
#[tokio::test]
async fn forged_unknown_or_replayed_preview_commits_are_refused() {
    // ManagedCopy is the one form every host can actually write, so the
    // committed pair's outcome never depends on local link privileges.
    let harness = targeted_harness(DeploymentCapability::new(false, false, true), false).await;
    let preview = batch_preview(
        &harness,
        vec![item(
            harness.skill.id(),
            Some(harness.version_id.clone()),
            &["claude-global"],
            DeploymentPreference::Copy,
        )],
    )
    .await;
    let pair = find_pair(&preview, &harness.skill.id(), "claude-global").clone();
    assert_eq!(pair.disposition, DeploymentPreviewDisposition::SelectedMode);
    assert_eq!(pair.mode, Some(DeploymentMode::ManagedCopy));

    let forged = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: "forged-preview-id".into(),
                pairs: vec![fallback_pair("forged-pair", false, false)],
            },
        ))
        .await;
    assert!(forged.is_err(), "an unknown preview id is rejected");

    let first = commit_preview(
        &harness,
        &preview.preview_id,
        vec![fallback_pair(&pair.pair_id, false, false)],
    )
    .await;
    assert_eq!(
        first.pairs[0].outcome,
        DeploymentPairCommitOutcome::Deployed
    );

    // The identical commit replays the recorded result instead of re-running.
    let replay = commit_preview(
        &harness,
        &preview.preview_id,
        vec![fallback_pair(&pair.pair_id, false, false)],
    )
    .await;
    assert!(replay.replayed);
    assert_eq!(replay.pairs, first.pairs);
    assert_eq!(deployment_rows_accounting(&harness).len(), 1);

    // The snapshot is consumed: any further batch on it is refused.
    let consumed = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: preview.preview_id.clone(),
                pairs: vec![fallback_pair(&pair.pair_id, false, true)],
            },
        ))
        .await;
    assert!(
        consumed.is_err(),
        "a consumed snapshot refuses further commits"
    );

    // Unknown pair ids inside a known preview are forgeries too.
    let second = batch_preview(
        &harness,
        vec![item(
            harness.second_skill.id(),
            Some(harness.second_version_id.clone()),
            &["codex-global"],
            DeploymentPreference::Automatic,
        )],
    )
    .await;
    let forged_pair = harness
        .facade
        .execute(AppCommand::CommitDeploymentPreview(
            CommitDeploymentPreview {
                preview_id: second.preview_id.clone(),
                pairs: vec![fallback_pair("not-a-real-pair", false, false)],
            },
        ))
        .await;
    assert!(forged_pair.is_err(), "unknown pair ids are rejected");
}

/// 13.14: LocalDeploymentBackend::revalidate really re-checks registered
/// targets, occupancy and capabilities before the prepared plan is applied.
#[tokio::test]
async fn commit_revalidates_registered_facts_and_refuses_stale_plans() {
    let harness = targeted_harness(DeploymentCapability::new(true, true, true), false).await;
    let planned = harness
        .facade
        .query(RootAppQuery::GetDeploymentPlan(GetDeploymentPlan {
            request: skillhub_core::deployment::DeploymentPlanRequest {
                skill_id: harness.skill.id(),
                version_id: harness.version_id.clone(),
                runtime_name: "find-skills".into(),
                logical_target_ids: vec!["claude-global".into()],
                mode_override: Some(DeploymentMode::ManagedCopy),
            },
        }))
        .await
        .expect("deployment plan");
    let AppQueryResult::DeploymentPlan(plan) = planned else {
        panic!("expected deployment plan");
    };
    let prepared = harness
        .facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare");
    let AppCommandResult::PreparedDeployment(prepared) = prepared else {
        panic!("expected prepared deployment");
    };

    // A foreign directory appears between prepare and commit: the stale plan
    // must be refused instead of overwriting it.
    let occupied = harness.target_root.path().join("find-skills");
    std::fs::create_dir_all(&occupied).expect("foreign directory");
    let refused = harness
        .facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("a refused commit is a rolled-back operation, not a crash");
    let AppCommandResult::DeploymentSummary(refused) = refused else {
        panic!("expected a refused deployment summary");
    };
    assert!(!refused.committed);
    assert_eq!(
        refused.targets[0].error_code.as_deref(),
        Some("deployment.target_exists"),
        "the re-planned conflict surfaces as the refusing reason"
    );
    assert!(
        std::fs::read_dir(&occupied)
            .expect("foreign directory survives")
            .next()
            .is_none(),
        "the refused commit writes nothing into the foreign directory"
    );
    assert!(deployment_rows_accounting(&harness).is_empty());

    // Once the obstruction is gone the very same prepared plan commits.
    std::fs::remove_dir_all(&occupied).expect("clear obstruction");
    let committed = harness
        .facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("commit after the obstruction is cleared");
    let AppCommandResult::DeploymentSummary(summary) = committed else {
        panic!("expected deployment summary");
    };
    assert!(summary.committed, "failures: {:?}", summary.targets);
    assert_eq!(deployment_rows_accounting(&harness).len(), 1);
}

/// 13.4: a shared directory that other agents read blocks the pair until the
/// shared-impact question is resolved, for every preference.
#[tokio::test]
async fn shared_directory_pairs_block_until_shared_impact_is_resolved() {
    let harness = targeted_harness(DeploymentCapability::new(true, true, true), true).await;
    let preview = batch_preview(
        &harness,
        vec![item(
            harness.skill.id(),
            Some(harness.version_id.clone()),
            &["claude-global"],
            DeploymentPreference::Automatic,
        )],
    )
    .await;
    let pair = find_pair(&preview, &harness.skill.id(), "claude-global");
    assert_eq!(pair.disposition, DeploymentPreviewDisposition::Blocked);
    assert_eq!(
        pair.block_reason,
        Some(DeploymentBlockReason::SharedImpactRequiresResolution)
    );

    let result = commit_preview(
        &harness,
        &preview.preview_id,
        vec![fallback_pair(&pair.pair_id, false, false)],
    )
    .await;
    assert_eq!(
        result.pairs[0].outcome,
        DeploymentPairCommitOutcome::Blocked
    );
    assert!(deployment_rows_accounting(&harness).is_empty());
}
