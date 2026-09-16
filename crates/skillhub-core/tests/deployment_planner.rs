use std::path::Path;

use skillhub_core::agent::profile::path_matches_candidate;
use skillhub_core::agent::{
    AgentClient, AgentProfile, CallPolicy, ClientKind, DeploymentCapability, DirectoryPrecedence,
    OperatingSystem, PathCandidate, ProfileCatalog, TargetScope,
};
use skillhub_core::deployment::observed_path_key;
use skillhub_core::deployment::reconcile::path_lives_under_platform;
use skillhub_core::deployment::{
    DeploymentMode, DeploymentPlanInput, DeploymentPlanRequest, DeploymentPlanner,
    ExistingDeployment, ExistingOwnership, ObservedMatchState, ObservedOrigin,
    RegisteredTargetIndex, TargetFact, TargetFactSource, VerifiedTarget,
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
fn directory_link_modes_share_one_predicate_apart_from_managed_copies() {
    // Ownership proofs and removal treat the two link kinds the same way: the
    // deployment owns the reparse point, not the directory it resolves to, so
    // the library may repoint it during a source update.  A managed copy owns
    // its own content and must keep the stricter treatment.
    assert!(DeploymentMode::SymbolicLink.is_directory_link());
    assert!(DeploymentMode::DirectoryJunction.is_directory_link());
    assert!(!DeploymentMode::ManagedCopy.is_directory_link());
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
fn builtin_agent_skills_profile_never_claims_shared_directory_support() {
    let profile = ProfileCatalog::builtin()
        .profiles
        .into_iter()
        .find(|profile| profile.brand == "Agent Skills")
        .expect("builtin Agent Skills profile");

    assert_eq!(
        classify_directory_capability(&profile, r"C:\Users\Ada\.agents\skills"),
        DirectoryRecognition::Unknown
    );
    assert_eq!(
        classify_directory_capability(&profile, "/home/ada/.agents/skills"),
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
fn shared_capability_downgrade_preserves_target_facts_and_creates_governance() {
    let skill_id = SkillId::new();
    let mut alias = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("shared-alias", RelationshipType::ManagedCopy)
    .with_ownership(skillhub_core::OwnershipState::SkillhubManaged)
    .with_file_representation(FileRepresentation::SymbolicLink)
    .with_link_target("/home/ada/.agents/skills/demo", Some("shared".into()))
    .with_skill(skill_id, "sha256:preserve")
    .with_match_state(ObservedMatchState::ContentVerified);
    alias.origin = ObservedOrigin::Import;
    alias.active = false;
    alias.released_at = Some(77);

    let shared = RelationTargetFact::directory(
        "shared",
        "/home/ada/.agents/skills",
        "codex",
        DirectoryRole::SharedDirectory,
    );
    let capability = AgentDirectoryCapabilityFact {
        agent_client_id: "codex".into(),
        directory_node_id: "shared".into(),
        recognition: DirectoryRecognition::Unsupported,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: None,
        researched_at: None,
        applicable_platforms: vec![],
    };

    let classification = classify_observed_relation_with_reason(
        "/home/ada/.codex/skills/demo",
        &[alias, shared],
        &[capability],
    );
    let fact = classification.fact;

    assert_eq!(fact.relation_id, "shared-alias");
    assert_eq!(fact.relationship, RelationshipType::Unknown);
    assert_eq!(fact.skill_id, Some(skill_id));
    assert_eq!(fact.agent_client_id, "codex");
    assert_eq!(fact.directory_node_id.as_deref(), Some("native"));
    assert_eq!(
        fact.ownership,
        skillhub_core::OwnershipState::SkillhubManaged
    );
    assert_eq!(fact.file_representation, FileRepresentation::SymbolicLink);
    assert_eq!(
        fact.link_target_path.as_deref(),
        Some("/home/ada/.agents/skills/demo")
    );
    assert_eq!(
        fact.link_target_path_key.as_deref(),
        Some(observed_path_key("/home/ada/.agents/skills/demo")).as_deref()
    );
    assert_eq!(fact.link_target_directory_id.as_deref(), Some("shared"));
    assert_eq!(fact.content_fingerprint, "sha256:preserve");
    assert_eq!(fact.origin, ObservedOrigin::Import);
    assert_eq!(fact.match_state, ObservedMatchState::ContentVerified);
    assert!(!fact.active);
    assert_eq!(fact.released_at, Some(77));
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
        &[alias.clone(), shared.clone()],
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

    let copy_alias = classify_observed_relation(
        "/home/ada/.codex/skills/demo",
        &[
            alias_target_for_shared_reference().with_file_representation(FileRepresentation::Copy),
            shared,
        ],
        std::slice::from_ref(&shared_capability),
    );
    assert_eq!(copy_alias.relationship, RelationshipType::ObservedCopy);
}

#[test]
fn relation_classifier_keeps_managed_link_when_target_is_in_central_library() {
    let managed_link = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_ownership(skillhub_core::OwnershipState::SkillhubManaged)
    .with_file_representation(FileRepresentation::SymbolicLink)
    .with_link_target("/home/ada/skillhub/library/demo", Some("library".into()));
    let library = RelationTargetFact::directory(
        "library",
        "/home/ada/skillhub/library",
        "skillhub",
        DirectoryRole::CentralLibrary,
    );

    let classification = classify_observed_relation_with_reason(
        "/home/ada/.codex/skills/demo",
        &[managed_link, library],
        &[],
    );

    assert_eq!(
        classification.fact.relationship,
        RelationshipType::ManagedLink
    );
    assert_eq!(classification.reason, None);
    assert_eq!(classification.governance_task, None);
}

#[test]
fn relation_classifier_keeps_observed_link_when_target_is_in_known_non_shared_directory() {
    let observed_link = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_ownership(skillhub_core::OwnershipState::ObservedUnmanaged)
    .with_file_representation(FileRepresentation::DirectoryJunction)
    .with_link_target("/home/ada/projects/skills/demo", Some("project".into()));
    let project = RelationTargetFact::directory(
        "project",
        "/home/ada/projects/skills",
        "codex",
        DirectoryRole::Project,
    );

    let classification = classify_observed_relation_with_reason(
        "/home/ada/.codex/skills/demo",
        &[observed_link, project],
        &[],
    );

    assert_eq!(
        classification.fact.relationship,
        RelationshipType::ObservedLink
    );
    assert_eq!(classification.reason, None);
    assert_eq!(classification.governance_task, None);
}

#[test]
fn relation_classifier_keeps_link_relation_but_governs_unknown_target() {
    let cases = [
        (
            skillhub_core::OwnershipState::SkillhubManaged,
            RelationshipType::ManagedLink,
        ),
        (
            skillhub_core::OwnershipState::ObservedUnmanaged,
            RelationshipType::ObservedLink,
        ),
    ];

    for (ownership, expected_relationship) in cases {
        let link = RelationTargetFact::directory(
            "native",
            "/home/ada/.codex/skills",
            "codex",
            DirectoryRole::AgentNative,
        )
        .with_ownership(ownership)
        .with_file_representation(FileRepresentation::SymbolicLink)
        .with_link_target("/home/ada/unregistered/skills/demo", None);

        let classification = classify_observed_relation_with_reason(
            "/home/ada/.codex/skills/demo",
            std::slice::from_ref(&link),
            &[],
        );

        assert_eq!(classification.fact.relationship, expected_relationship);
        assert_eq!(
            classification.reason.as_deref(),
            Some("link target directory was not found among registered directories")
        );
        assert_eq!(
            classification
                .governance_task
                .as_ref()
                .map(|task| task.kind),
            Some(GovernanceTaskKind::UnknownDirectoryRecognition)
        );
    }
}

#[test]
fn shared_reference_is_not_retained_without_a_supported_shared_target() {
    let target = RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation(
        "stale-shared-reference",
        RelationshipType::SharedDirectoryReference,
    )
    .with_ownership(skillhub_core::OwnershipState::SharedReference)
    .with_file_representation(FileRepresentation::SymbolicLink);

    let relation = classify_observed_relation(
        "/home/ada/.codex/skills/demo",
        std::slice::from_ref(&target),
        &[],
    );

    assert_eq!(relation.relationship, RelationshipType::Unknown);
}

fn alias_target_for_shared_reference() -> RelationTargetFact {
    RelationTargetFact::directory(
        "native",
        "/home/ada/.codex/skills",
        "codex",
        DirectoryRole::AgentNative,
    )
    .with_relation("shared-alias", RelationshipType::Unknown)
    .with_ownership(skillhub_core::OwnershipState::ObservedUnmanaged)
    .with_link_target("/home/ada/.agents/skills/demo", Some("shared".into()))
    .with_file_representation(FileRepresentation::SymbolicLink)
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
fn relation_classifier_rederives_copy_and_link_from_ownership_and_representation() {
    let cases = [
        (
            "managed-copy-with-symlink",
            RelationshipType::ManagedCopy,
            skillhub_core::OwnershipState::SkillhubManaged,
            FileRepresentation::SymbolicLink,
            RelationshipType::ManagedLink,
        ),
        (
            "managed-link-with-copy",
            RelationshipType::ManagedLink,
            skillhub_core::OwnershipState::SkillhubManaged,
            FileRepresentation::Copy,
            RelationshipType::ManagedCopy,
        ),
        (
            "observed-link-with-copy",
            RelationshipType::ObservedLink,
            skillhub_core::OwnershipState::ObservedUnmanaged,
            FileRepresentation::Copy,
            RelationshipType::ObservedCopy,
        ),
        (
            "observed-copy-with-symlink",
            RelationshipType::ObservedCopy,
            skillhub_core::OwnershipState::ObservedUnmanaged,
            FileRepresentation::SymbolicLink,
            RelationshipType::ObservedLink,
        ),
    ];

    for (relation_id, relation, ownership, representation, expected) in cases {
        let target = RelationTargetFact::directory(
            relation_id,
            "/home/ada/.codex/skills",
            "codex",
            DirectoryRole::AgentNative,
        )
        .with_relation(relation_id, relation)
        .with_ownership(ownership)
        .with_file_representation(representation);

        let classified = classify_observed_relation(
            "/home/ada/.codex/skills/demo",
            std::slice::from_ref(&target),
            &[],
        );

        assert_eq!(classified.relationship, expected, "{relation_id}");
    }
}

#[test]
fn shared_directory_read_requires_directory_representation_and_supported_capability() {
    let capability = AgentDirectoryCapabilityFact {
        agent_client_id: "codex".into(),
        directory_node_id: "shared".into(),
        recognition: DirectoryRecognition::Supported,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: Some("direct-read".into()),
        researched_at: None,
        applicable_platforms: vec![],
    };

    let cases = [
        (
            "direct-read",
            skillhub_core::OwnershipState::ObservedUnmanaged,
            FileRepresentation::Directory,
            RelationshipType::ObservedCopy,
            RelationshipType::SharedDirectoryRead,
        ),
        (
            "shared-copy",
            skillhub_core::OwnershipState::ObservedUnmanaged,
            FileRepresentation::Copy,
            RelationshipType::SharedDirectoryRead,
            RelationshipType::ObservedCopy,
        ),
        (
            "shared-link",
            skillhub_core::OwnershipState::ObservedUnmanaged,
            FileRepresentation::SymbolicLink,
            RelationshipType::SharedDirectoryRead,
            RelationshipType::ObservedLink,
        ),
        (
            "managed-shared-copy",
            skillhub_core::OwnershipState::SkillhubManaged,
            FileRepresentation::Copy,
            RelationshipType::SharedDirectoryRead,
            RelationshipType::ManagedCopy,
        ),
        (
            "managed-shared-link",
            skillhub_core::OwnershipState::SkillhubManaged,
            FileRepresentation::SymbolicLink,
            RelationshipType::SharedDirectoryRead,
            RelationshipType::ManagedLink,
        ),
        (
            "managed-old-direct-read",
            skillhub_core::OwnershipState::ObservedUnmanaged,
            FileRepresentation::Directory,
            RelationshipType::ManagedCopy,
            RelationshipType::SharedDirectoryRead,
        ),
    ];

    for (relation_id, ownership, representation, old_relationship, expected) in cases {
        let target = RelationTargetFact::directory(
            "shared",
            "/home/ada/.agents/skills",
            "codex",
            DirectoryRole::SharedDirectory,
        )
        .with_relation(relation_id, old_relationship)
        .with_ownership(ownership)
        .with_file_representation(representation);

        let classified = classify_observed_relation(
            "/home/ada/.agents/skills/demo",
            std::slice::from_ref(&target),
            std::slice::from_ref(&capability),
        );

        assert_eq!(classified.relationship, expected, "{relation_id}");
    }
}

#[test]
fn profile_path_matching_is_posix_case_sensitive_and_trims_trailing_separators() {
    let posix = PathCandidate {
        path: "/home/ada/.codex/skills".into(),
        scope: TargetScope::Global,
        precedence: DirectoryPrecedence::Preferred,
        marker: "SKILL.md".into(),
        shared_reference: false,
    };
    assert!(path_matches_candidate(&posix, "/home/ada/.codex/skills/"));
    assert!(!path_matches_candidate(&posix, "/home/Ada/.codex/skills/"));
    assert!(!path_matches_candidate(
        &posix,
        "/home/ada/.codex/skills-demo/demo"
    ));

    let windows = PathCandidate {
        path: r"C:\Users\Ada\.codex\skills".into(),
        scope: TargetScope::Global,
        precedence: DirectoryPrecedence::Preferred,
        marker: "SKILL.md".into(),
        shared_reference: false,
    };
    assert!(path_matches_candidate(
        &windows,
        r"c:\users\ada\.CODEX\SKILLS\\"
    ));
    assert!(!path_matches_candidate(
        &windows,
        r"C:\Users\Ada\.codex\skills-demo\demo"
    ));
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
fn shared_alias_with_unknown_or_unsupported_capability_stays_in_governance() {
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
            "/home/ada/.codex/skills/demo",
            &[alias_target_for_shared_reference(), shared.clone()],
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

#[test]
fn path_lives_under_platform_trims_trailing_separators_on_both_paths() {
    assert!(!path_lives_under_platform(
        "/tmp/trae/skills",
        "/tmp/trae/skills/",
        false
    ));
    assert!(!path_lives_under_platform(
        "/tmp/trae/skills/",
        "/tmp/trae/skills",
        false
    ));
    assert!(path_lives_under_platform(
        "/tmp/trae/skills/demo/",
        "/tmp/trae/skills///",
        false
    ));
    assert!(!path_lives_under_platform(
        r"C:\Users\Ada\Skills\",
        r"C:\Users\Ada\Skills",
        true
    ));
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
