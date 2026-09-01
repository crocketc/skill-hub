use std::path::Path;

use skillhub_core::deployment::{
    DeploymentMode, DeploymentPlanInput, DeploymentPlanRequest, DeploymentPlanner,
    ExistingDeployment, ExistingOwnership, RegisteredTargetIndex, TargetFact, TargetFactSource,
    VerifiedTarget,
};
use skillhub_core::{
    physical_id_for_path, AllowedRoot, DeploymentCapability, PathPolicy, SkillId, VersionId,
};
use tempfile::{tempdir, TempDir};

fn capabilities(symlink: bool, junction: bool, copy: bool) -> DeploymentCapability {
    DeploymentCapability::new(symlink, junction, copy)
}

fn verified_target(
    workspace: &TempDir,
    logical_id: &str,
    capability: DeploymentCapability,
) -> VerifiedTarget {
    let target_path = workspace.path().join("skills");
    std::fs::create_dir_all(&target_path).unwrap();
    let physical_id = physical_id_for_path(&target_path).unwrap();
    let policy = PathPolicy::from_roots([AllowedRoot::new(workspace.path()).unwrap()]).unwrap();
    let fact = TargetFact::registered(
        logical_id,
        target_path,
        physical_id,
        TargetFactSource::Discovery,
        capability,
    );
    VerifiedTarget::from_fact(fact, &policy).unwrap()
}

fn input(capability: DeploymentCapability) -> (TempDir, DeploymentPlanInput) {
    let workspace = tempdir().unwrap();
    let target = verified_target(&workspace, "logical-codex", capability);
    let request = DeploymentPlanInput::new(
        SkillId::new(),
        VersionId::parse(&format!("sha256:{}", "a".repeat(64))).unwrap(),
        "pdf",
        "/SkillHub/library/pdf--abc",
        vec![target],
    );
    (workspace, request)
}

#[test]
fn planner_prefers_link_then_junction_then_managed_copy() {
    assert_eq!(
        DeploymentPlanner
            .plan(input(capabilities(true, true, true)).1)
            .unwrap()
            .mode,
        DeploymentMode::SymbolicLink
    );
    assert_eq!(
        DeploymentPlanner
            .plan(input(capabilities(false, true, true)).1)
            .unwrap()
            .mode,
        DeploymentMode::DirectoryJunction
    );
    assert_eq!(
        DeploymentPlanner
            .plan(input(capabilities(false, false, true)).1)
            .unwrap()
            .mode,
        DeploymentMode::ManagedCopy
    );
}

#[test]
fn same_runtime_name_in_one_physical_target_requires_resolution() {
    let (_workspace, mut request) = input(capabilities(true, true, true));
    request.targets[0] = request.targets[0]
        .clone()
        .with_existing(ExistingDeployment::new("pdf", ExistingOwnership::Unknown));

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
    let (_workspace, mut request) = input(capabilities(true, true, true));
    let skill_id = request.skill_id;
    let previous_version = VersionId::parse(&format!("sha256:{}", "c".repeat(64))).unwrap();
    request.targets[0] = request.targets[0]
        .clone()
        .with_existing(ExistingDeployment::managed(
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
    let (workspace, request) = input(capabilities(false, false, true));
    let plan = DeploymentPlanner.plan(request).unwrap();
    let target = &plan.targets[0];
    let expected_target = workspace.path().join("skills");

    assert_eq!(target.target_path, expected_target.to_string_lossy());
    assert_eq!(
        target.destination_path,
        expected_target.join("pdf").to_string_lossy()
    );
    assert_eq!(target.source_path, "/SkillHub/library/pdf--abc");
    assert!(!Path::new(&target.destination_path).exists());
}

#[test]
fn logical_targets_sharing_a_physical_target_are_planned_once() {
    let workspace = tempdir().unwrap();
    let first = verified_target(&workspace, "logical-codex", capabilities(true, false, true));
    let second = verified_target(
        &workspace,
        "logical-claude",
        capabilities(true, false, true),
    );
    let request = DeploymentPlanInput::new(
        SkillId::new(),
        VersionId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
        "pdf",
        "/SkillHub/library/pdf--abc",
        vec![first, second],
    );

    let plan = DeploymentPlanner.plan(request).unwrap();
    assert_eq!(plan.targets.len(), 1);
    assert_eq!(plan.targets[0].logical_target_ids.len(), 2);
}

#[test]
fn raw_path_fact_outside_registered_roots_cannot_become_a_verified_target() {
    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let path = outside.path().join("skills");
    std::fs::create_dir_all(&path).unwrap();
    let fact = TargetFact::registered(
        "forged",
        &path,
        physical_id_for_path(&path).unwrap(),
        TargetFactSource::Discovery,
        capabilities(true, true, true),
    );
    let policy = PathPolicy::from_roots([AllowedRoot::new(workspace.path()).unwrap()]).unwrap();

    let error = VerifiedTarget::from_fact(fact, &policy).unwrap_err();
    assert_eq!(error.code.as_str(), "path.outside_allowed_root");
}

#[test]
fn recreated_registered_directory_is_rejected_when_physical_identity_changes() {
    let workspace = tempdir().unwrap();
    let path = workspace.path().join("skills");
    std::fs::create_dir_all(&path).unwrap();
    let original_id = physical_id_for_path(&path).unwrap();
    let fact = TargetFact::registered(
        "registered",
        &path,
        original_id,
        TargetFactSource::Project,
        capabilities(true, true, true),
    );
    let policy = PathPolicy::from_roots([AllowedRoot::new(workspace.path()).unwrap()]).unwrap();
    let replacement = workspace.path().join("replacement");
    std::fs::create_dir(&replacement).unwrap();
    std::fs::remove_dir(&path).unwrap();
    std::fs::rename(&replacement, &path).unwrap();

    let error = VerifiedTarget::from_fact(fact, &policy).unwrap_err();
    assert_eq!(error.code.as_str(), "operation.conflict");
}

#[cfg(unix)]
#[test]
fn aliased_path_is_rejected_when_registered_physical_identity_does_not_match() {
    let workspace = tempdir().unwrap();
    let real = workspace.path().join("real");
    let alias = workspace.path().join("alias");
    std::fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let policy = PathPolicy::from_roots([AllowedRoot::new(workspace.path()).unwrap()]).unwrap();
    let fact = TargetFact::registered(
        "aliased",
        &alias,
        "fs:forged-identity",
        TargetFactSource::Custom,
        capabilities(true, true, true),
    );

    let error = VerifiedTarget::from_fact(fact, &policy).unwrap_err();
    assert_eq!(error.code.as_str(), "operation.conflict");
}

#[test]
fn api_request_resolves_registered_ids_and_rejects_unregistered_ids() {
    let workspace = tempdir().unwrap();
    let target_path = workspace.path().join("skills");
    std::fs::create_dir(&target_path).unwrap();
    let policy = PathPolicy::from_roots([AllowedRoot::new(workspace.path()).unwrap()]).unwrap();
    let fact = TargetFact::registered(
        "registered",
        &target_path,
        physical_id_for_path(&target_path).unwrap(),
        TargetFactSource::Custom,
        capabilities(true, true, true),
    );
    let index = RegisteredTargetIndex::from_facts([fact], policy).unwrap();
    let request = DeploymentPlanRequest {
        skill_id: SkillId::new(),
        version_id: VersionId::parse(&format!("sha256:{}", "d".repeat(64))).unwrap(),
        runtime_name: "pdf".to_owned(),
        logical_target_ids: vec!["registered".to_owned()],
        mode_override: None,
    };
    assert!(request
        .resolve(&index, "/SkillHub/library/pdf--abc")
        .is_ok());

    let unregistered = DeploymentPlanRequest {
        logical_target_ids: vec!["not-registered".to_owned()],
        ..request
    };
    let error = unregistered
        .resolve(&index, "/SkillHub/library/pdf--abc")
        .unwrap_err();
    assert_eq!(error.code.as_str(), "object.not_found");
}
