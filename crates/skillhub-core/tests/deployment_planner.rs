use std::path::Path;

use skillhub_core::deployment::{
    DeploymentMode, DeploymentPlanInput, DeploymentPlanner, ExistingDeployment, ExistingOwnership,
    LogicalTargetSelection, PhysicalTargetInput,
};
use skillhub_core::{DeploymentCapability, SkillId, VersionId};

fn capabilities(symlink: bool, junction: bool, copy: bool) -> DeploymentCapability {
    DeploymentCapability {
        copy,
        symlink,
        junction,
        limitations: Vec::new(),
    }
}

fn target_root() -> &'static str {
    if cfg!(windows) {
        r"C:\Users\test\.agents\skills"
    } else {
        "/Users/test/.agents/skills"
    }
}

fn source_root() -> &'static str {
    if cfg!(windows) {
        r"C:\SkillHub\library\pdf--abc"
    } else {
        "/SkillHub/library/pdf--abc"
    }
}

fn input(capability: DeploymentCapability) -> DeploymentPlanInput {
    let physical_id = "physical-codex".to_owned();
    DeploymentPlanInput::new(
        SkillId::new(),
        VersionId::parse(&format!("sha256:{}", "a".repeat(64))).unwrap(),
        "pdf",
        vec![LogicalTargetSelection::new("logical-codex", &physical_id)],
        vec![PhysicalTargetInput::new(
            physical_id,
            target_root(),
            capability,
        )],
    )
}

#[test]
fn planner_prefers_link_then_junction_then_managed_copy() {
    let planner = DeploymentPlanner;

    assert_eq!(
        planner
            .plan(input(capabilities(true, true, true)))
            .unwrap()
            .mode,
        DeploymentMode::SymbolicLink
    );
    assert_eq!(
        planner
            .plan(input(capabilities(false, true, true)))
            .unwrap()
            .mode,
        DeploymentMode::DirectoryJunction
    );
    assert_eq!(
        planner
            .plan(input(capabilities(false, false, true)))
            .unwrap()
            .mode,
        DeploymentMode::ManagedCopy
    );
}

#[test]
fn same_runtime_name_in_one_physical_target_requires_resolution() {
    let mut request = input(capabilities(true, true, true));
    request.physical_targets[0]
        .existing
        .push(ExistingDeployment::new("pdf", ExistingOwnership::Unknown));

    let error = DeploymentPlanner.plan(request).unwrap_err();
    assert_eq!(error.code.as_str(), "deployment.target_exists");
    assert!(!error
        .actions
        .contains(&skillhub_core::RecoveryAction::OverwriteUnknown));
    assert!(error
        .actions
        .contains(&skillhub_core::RecoveryAction::ChooseAnotherName));
}

#[test]
fn managed_deployment_of_same_skill_can_move_to_a_new_version() {
    let mut request = input(capabilities(true, true, true));
    let skill_id = request.skill_id;
    let previous_version = VersionId::parse(&format!("sha256:{}", "c".repeat(64))).unwrap();
    request.physical_targets[0]
        .existing
        .push(ExistingDeployment::managed(
            "pdf",
            skillhub_core::DeploymentId::new(),
            skill_id,
            previous_version,
        ));

    let plan = DeploymentPlanner.plan(request).unwrap();
    assert_eq!(
        plan.targets[0].change,
        skillhub_core::deployment::TargetChange::Create
    );
}

#[test]
fn planner_returns_exact_source_and_destination_paths_without_touching_disk() {
    let mut request = input(capabilities(false, false, true));
    request.source_path = source_root().to_owned();
    let plan = DeploymentPlanner.plan(request).unwrap();
    let target = &plan.targets[0];

    assert_eq!(target.target_path, target_root());
    assert_eq!(
        target.destination_path,
        Path::new(target_root())
            .join("pdf")
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(target.source_path, source_root());
    assert!(!Path::new(&target.destination_path).exists());
}

#[test]
fn logical_targets_sharing_a_physical_target_are_planned_once() {
    let physical_id = "physical-shared".to_owned();
    let mut request = DeploymentPlanInput::new(
        SkillId::new(),
        VersionId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
        "pdf",
        vec![
            LogicalTargetSelection::new("logical-codex", &physical_id),
            LogicalTargetSelection::new("logical-claude", &physical_id),
        ],
        vec![PhysicalTargetInput::new(
            physical_id,
            target_root(),
            capabilities(true, false, true),
        )],
    );
    request.physical_targets[0].case_sensitive = false;

    let plan = DeploymentPlanner.plan(request).unwrap();
    assert_eq!(plan.targets.len(), 1);
    assert_eq!(plan.targets[0].logical_target_ids.len(), 2);
}
