use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::{
    AppCommandResult, AppQueryResult, CommitDeployment, GetDeploymentPlan, ListDeployments,
    PrepareDeployment,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::DeploymentMode;
use skillhub_core::{AppCommand, AppQuery as RootAppQuery, ApplicationFacade, ErrorCode};
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
    let database =
        Database::open(database_dir.path().join("skillhub.sqlite")).expect("database");
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

async fn commit(harness: &Harness, plan: skillhub_core::DeploymentPlan) {
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
    assert!(
        summary.committed,
        "commit must succeed; failures: {:?}",
        summary
            .targets
            .iter()
            .filter_map(|target| target.error_code.as_deref())
            .collect::<Vec<_>>()
    );
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
    assert!(deployed.join("SKILL.md").is_file(), "managed copy must land");

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

/// D-9 regression: the bundled Claude Code profile declares junction support
/// as unconfirmed, so a junction must never be auto-selected even when the
/// host account could create one.
#[tokio::test]
async fn claude_code_target_never_selects_a_junction() {
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
    assert_ne!(
        plan.targets[0].mode,
        DeploymentMode::DirectoryJunction,
        "profile declares junction unconfirmed"
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
/// agents will not recognize the skill.  The plan surfaces a warning.
#[tokio::test]
async fn deployment_plan_warns_when_folder_name_differs_from_frontmatter_name() {
    let harness = harness("anthropic.claude-code", "some-other-name").await;
    let plan = managed_copy_plan(&harness).await;
    assert!(
        plan.warnings
            .iter()
            .chain(plan.targets[0].warnings.iter())
            .any(|warning| warning == "deployment.name_mismatch"),
        "expected a name mismatch warning, got {:?}",
        plan.warnings
    );
}

#[tokio::test]
async fn matching_names_produce_no_name_warning() {
    let harness = harness("anthropic.claude-code", "find-skills").await;
    let plan = managed_copy_plan(&harness).await;
    assert!(
        !plan.warnings
            .iter()
            .chain(plan.targets[0].warnings.iter())
            .any(|warning| warning == "deployment.name_mismatch")
    );
}
