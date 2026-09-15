use std::path::Path;

use skillhub_core::agent::{
    AgentClient, AgentProfile, CallPolicy, ClientKind, DeploymentCapability, DirectoryPrecedence,
    OperatingSystem, PathCandidate, TargetScope,
};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::deployment::{
    DeploymentMode, DeploymentPlanInput, DeploymentPlanRequest, DeploymentPlanner,
    ExistingDeployment, ExistingOwnership, RegisteredTargetIndex, TargetFact, TargetFactSource,
    VerifiedTarget,
};
use skillhub_core::relationship::classifier::{
    classify_directory_capability, classify_observed_relation,
    classify_observed_relation_with_reason, RelationTargetFact,
};
use skillhub_core::relationship::{
    AgentDirectoryCapabilityFact, DirectoryRecognition, DirectoryRole, FileRepresentation,
    GovernanceTaskKind, RelationshipType,
};
use skillhub_core::{physical_id_for_path, AllowedRoot, PathPolicy, SkillId, VersionId};
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
fn planner_defaults_project_targets_to_managed_copies_while_agent_targets_stay_linked() {
    let workspace = tempdir().unwrap();
    let agent_path = workspace.path().join("agent-skills");
    let project_path = workspace.path().join("project-skills");
    std::fs::create_dir_all(&agent_path).unwrap();
    std::fs::create_dir_all(&project_path).unwrap();
    let policy = PathPolicy::from_roots([AllowedRoot::new(workspace.path()).unwrap()]).unwrap();
    let agent = TargetFact::registered(
        "agent",
        &agent_path,
        physical_id_for_path(&agent_path).unwrap(),
        TargetFactSource::Discovery,
        capabilities(true, true, true),
    )
    .verify(&policy)
    .unwrap();
    let project = TargetFact::registered(
        "project",
        &project_path,
        physical_id_for_path(&project_path).unwrap(),
        TargetFactSource::Project,
        capabilities(true, true, true),
    )
    .verify(&policy)
    .unwrap();
    let version = VersionId::parse(&format!("sha256:{}", "a".repeat(64))).unwrap();

    let agent_plan = DeploymentPlanner
        .plan(DeploymentPlanInput::new(
            SkillId::new(),
            version.clone(),
            "pdf",
            "central/pdf",
            vec![agent],
        ))
        .unwrap();
    let project_plan = DeploymentPlanner
        .plan(DeploymentPlanInput::new(
            SkillId::new(),
            version,
            "pdf",
            "central/pdf",
            vec![project],
        ))
        .unwrap();

    assert_eq!(agent_plan.mode, DeploymentMode::SymbolicLink);
    assert_eq!(project_plan.mode, DeploymentMode::ManagedCopy);
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

#[test]
fn directory_capability_is_deterministic_and_does_not_use_directory_existence() {
    let profile = AgentProfile {
        profile_version: 1,
        research_date: "2026-09-15".into(),
        official_references: vec!["https://example.test/profile".into()],
        brand: "Example".into(),
        clients: vec![AgentClient {
            id: "example.cli".into(),
            kind: ClientKind::Cli,
            display_name: "Example CLI".into(),
            supported_os: vec![OperatingSystem::Windows, OperatingSystem::Macos],
            path_candidates: vec![PathCandidate {
                path: "{user_home}/.agents/skills".into(),
                scope: TargetScope::Global,
                precedence: DirectoryPrecedence::Preferred,
                marker: "SKILL.md".into(),
                shared_reference: true,
            }],
            skill_marker: "SKILL.md".into(),
            deployment: DeploymentCapability::new(true, false, true),
            call_policy: CallPolicy::Unknown,
        }],
    };

    assert_eq!(
        classify_directory_capability(&profile, r"C:\Users\Ada\.agents\skills"),
        DirectoryRecognition::Unknown
    );
    assert_eq!(
        classify_directory_capability(&profile, r"C:\Users\Ada\.agents\skills-demo"),
        DirectoryRecognition::Unknown
    );
}

#[test]
fn native_profile_candidate_is_supported_but_shared_candidate_is_only_unknown() {
    let profile = AgentProfile {
        profile_version: 1,
        research_date: "2026-09-15".into(),
        official_references: vec!["https://example.test/profile".into()],
        brand: "Example".into(),
        clients: vec![
            AgentClient {
                id: "example.cli".into(),
                kind: ClientKind::Cli,
                display_name: "Example CLI".into(),
                supported_os: vec![OperatingSystem::Windows, OperatingSystem::Macos],
                path_candidates: vec![PathCandidate {
                    path: "{user_home}/.example/skills".into(),
                    scope: TargetScope::Global,
                    precedence: DirectoryPrecedence::Preferred,
                    marker: "SKILL.md".into(),
                    shared_reference: false,
                }],
                skill_marker: "SKILL.md".into(),
                deployment: DeploymentCapability::new(true, false, true),
                call_policy: CallPolicy::Unknown,
            },
            AgentClient {
                id: "example.shared".into(),
                kind: ClientKind::SharedDirectory,
                display_name: "Agent Skills directory".into(),
                supported_os: vec![OperatingSystem::Windows, OperatingSystem::Macos],
                path_candidates: vec![PathCandidate {
                    path: "{user_home}/.agents/skills".into(),
                    scope: TargetScope::Global,
                    precedence: DirectoryPrecedence::Preferred,
                    marker: "SKILL.md".into(),
                    shared_reference: true,
                }],
                skill_marker: "SKILL.md".into(),
                deployment: DeploymentCapability::new(true, false, true),
                call_policy: CallPolicy::Unknown,
            },
        ],
    };

    assert_eq!(
        classify_directory_capability(&profile, r"C:\Users\Ada\.example\skills"),
        DirectoryRecognition::Supported
    );
    assert_eq!(
        classify_directory_capability(&profile, r"C:\Users\Ada\.agents\skills"),
        DirectoryRecognition::Unknown
    );
}

#[test]
fn shared_directory_unknown_or_unsupported_capability_never_becomes_a_shared_relation() {
    let shared = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    );

    for recognition in [
        DirectoryRecognition::Unknown,
        DirectoryRecognition::Unsupported,
    ] {
        let capability = AgentDirectoryCapabilityFact {
            agent_client_id: "codex".into(),
            directory_node_id: "shared".into(),
            recognition,
            precedence: DirectoryPrecedence::Preferred,
            evidence_reference: None,
            researched_at: None,
            applicable_platforms: vec![],
        };
        let classification = classify_observed_relation_with_reason(
            "/home/ada/.agents/skills/demo",
            std::slice::from_ref(&shared),
            std::slice::from_ref(&capability),
        );

        assert_eq!(classification.fact.relationship, RelationshipType::Unknown);
        assert_eq!(
            classification
                .governance_task
                .as_ref()
                .map(|task| task.kind),
            Some(GovernanceTaskKind::UnknownDirectoryRecognition)
        );
        assert!(classification.reason.is_some());
    }
}

#[test]
fn unknown_relation_keeps_reason_and_governance_in_with_reason_result() {
    let classification =
        classify_observed_relation_with_reason("/home/ada/.unregistered/skills/demo", &[], &[]);

    assert_eq!(classification.fact.relationship, RelationshipType::Unknown);
    assert_eq!(
        classification
            .governance_task
            .as_ref()
            .map(|task| task.kind),
        Some(GovernanceTaskKind::UnknownDirectoryRecognition)
    );
    assert_eq!(
        classification.reason.as_deref(),
        Some("no registered directory contains the observed path")
    );
}

#[test]
fn relation_classifier_uses_longest_directory_boundary_and_shared_capability() {
    let shared = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    );
    let nested = RelationTargetFact::directory(
        "native",
        "/home/ada/.agents/skills-demo",
        "codex",
        DirectoryRole::AgentNative,
    );
    let capability = AgentDirectoryCapabilityFact {
        agent_client_id: "codex".into(),
        directory_node_id: "shared".into(),
        recognition: DirectoryRecognition::Supported,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: Some("official".into()),
        researched_at: Some("2026-09-15".into()),
        applicable_platforms: vec!["windows".into()],
    };

    let relation = classify_observed_relation(
        "/home/ada/.agents/skills/demo",
        &[nested, shared],
        &[capability],
    );

    assert_eq!(relation.relationship, RelationshipType::SharedDirectoryRead);
    assert_eq!(relation.file_representation, FileRepresentation::Directory);
    assert_eq!(relation.directory_node_id.as_deref(), Some("shared"));
}

#[test]
fn relation_classifier_distinguishes_native_managed_links_and_shared_aliases() {
    let native = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("managed-link", RelationshipType::Unknown)
    .with_ownership(skillhub_core::OwnershipState::SkillhubManaged)
    .with_file_representation(FileRepresentation::SymbolicLink);
    let shared = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    );
    let managed = classify_observed_relation(
        "/home/ada/.codex/skills/demo",
        std::slice::from_ref(&native),
        &[],
    );
    assert_eq!(managed.relationship, RelationshipType::ManagedLink);
    assert_eq!(
        managed.file_representation,
        FileRepresentation::SymbolicLink
    );

    let alias = native
        .with_relation("shared-alias", RelationshipType::Unknown)
        .with_ownership(skillhub_core::OwnershipState::ObservedUnmanaged)
        .with_link_target("/home/ada/.agents/skills/demo", Some("shared".into()));
    let shared_capability = AgentDirectoryCapabilityFact {
        agent_client_id: "codex".into(),
        directory_node_id: "shared".into(),
        recognition: DirectoryRecognition::Supported,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: None,
        researched_at: None,
        applicable_platforms: vec![],
    };
    let alias = classify_observed_relation(
        "/home/ada/.codex/skills/demo",
        &[alias, shared],
        std::slice::from_ref(&shared_capability),
    );
    assert_eq!(
        alias.relationship,
        RelationshipType::SharedDirectoryReference
    );
    assert_eq!(
        alias.ownership,
        skillhub_core::OwnershipState::SharedReference
    );
}

#[test]
fn relation_classifier_does_not_preserve_import_copy_when_observed_facts_disagree() {
    let imported = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("import", RelationshipType::ImportCopy)
    .with_ownership(skillhub_core::OwnershipState::ObservedUnmanaged)
    .with_file_representation(FileRepresentation::Directory);

    let relation = classify_observed_relation(
        "/home/ada/.codex/skills/demo",
        std::slice::from_ref(&imported),
        &[],
    );

    assert_eq!(relation.relationship, RelationshipType::ObservedCopy);
    assert_eq!(
        relation.ownership,
        skillhub_core::OwnershipState::ObservedUnmanaged
    );
    assert_eq!(relation.file_representation, FileRepresentation::Directory);
}

#[test]
fn unknown_ownership_representation_pair_keeps_governance_reason() {
    let unknown = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_file_representation(FileRepresentation::Unknown);

    let classification = classify_observed_relation_with_reason(
        "/home/ada/.codex/skills/demo",
        std::slice::from_ref(&unknown),
        &[],
    );

    assert_eq!(classification.fact.relationship, RelationshipType::Unknown);
    assert!(classification.reason.is_some());
    assert_eq!(
        classification
            .governance_task
            .as_ref()
            .map(|task| task.kind),
        Some(GovernanceTaskKind::UnknownDirectoryRecognition)
    );
}

#[test]
fn shared_alias_requires_current_agent_capability_for_link_target_node() {
    let alias = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_link_target("/home/ada/.agents/skills/demo", Some("shared".into()))
    .with_file_representation(FileRepresentation::SymbolicLink);
    let shared = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    );
    let classification = classify_observed_relation_with_reason(
        "/home/ada/.codex/skills/demo",
        &[alias, shared],
        &[],
    );

    assert_eq!(classification.fact.relationship, RelationshipType::Unknown);
    assert!(classification.reason.is_some());
    assert_eq!(
        classification
            .governance_task
            .as_ref()
            .map(|task| task.kind),
        Some(GovernanceTaskKind::UnknownDirectoryRecognition)
    );
}

#[test]
fn relation_target_ties_are_resolved_by_stable_directory_identity() {
    let copy = RelationTargetFact::directory(
        "z-node",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("copy", RelationshipType::ManagedCopy)
    .with_ownership(skillhub_core::OwnershipState::SkillhubManaged)
    .with_file_representation(FileRepresentation::Copy);
    let link = RelationTargetFact::directory(
        "a-node",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("link", RelationshipType::ManagedLink)
    .with_ownership(skillhub_core::OwnershipState::SkillhubManaged)
    .with_file_representation(FileRepresentation::SymbolicLink);

    let forward = classify_observed_relation(
        "/home/ada/.codex/skills/demo",
        &[copy.clone(), link.clone()],
        &[],
    );
    let reverse = classify_observed_relation("/home/ada/.codex/skills/demo", &[link, copy], &[]);

    assert_eq!(forward.directory_node_id, Some("a-node".into()));
    assert_eq!(forward, reverse);
}

#[test]
fn relation_classifier_folds_windows_case_but_preserves_posix_case_and_boundaries() {
    let windows_shared = RelationTargetFact::directory(
        "shared-win",
        r"C:\Users\Ada\.agents\skills",
        "codex",
        DirectoryRole::SharedDirectory,
    );
    let supported = AgentDirectoryCapabilityFact {
        agent_client_id: "codex".into(),
        directory_node_id: "shared-win".into(),
        recognition: DirectoryRecognition::Supported,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: None,
        researched_at: None,
        applicable_platforms: vec!["windows".into()],
    };
    let relation = classify_observed_relation(
        r"c:\users\ada\.AGENTS\SKILLS\demo",
        std::slice::from_ref(&windows_shared),
        std::slice::from_ref(&supported),
    );
    assert_eq!(relation.relationship, RelationshipType::SharedDirectoryRead);
    assert_eq!(
        relation.path_key,
        observed_path_key(r"c:\users\ada\.AGENTS\SKILLS\demo")
    );

    let boundary = classify_observed_relation(
        r"C:\Users\Ada\.agents\skills-demo\demo",
        std::slice::from_ref(&windows_shared),
        std::slice::from_ref(&supported),
    );
    assert_eq!(boundary.relationship, RelationshipType::Unknown);
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
