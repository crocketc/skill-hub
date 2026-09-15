use crate::agent::AgentProfile;
use crate::deployment::observed_path_key;
pub use crate::deployment::reconcile::RelationTargetFact;
use crate::deployment::reconcile::{normalized_path_key, path_lives_under_platform};
use crate::relationship::{
    AgentDirectoryCapabilityFact, DeploymentRelationFact, DirectoryRecognition, DirectoryRole,
    FileRepresentation, GovernanceTaskFact, GovernanceTaskKind, OwnershipState, RelationshipType,
};

pub fn classify_directory_capability(profile: &AgentProfile, path: &str) -> DirectoryRecognition {
    profile.directory_recognition(path)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelationClassification {
    pub fact: DeploymentRelationFact,
    pub reason: Option<String>,
    pub governance_task: Option<GovernanceTaskFact>,
}

pub fn classify_observed_relation(
    path: &str,
    target_facts: &[RelationTargetFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
) -> DeploymentRelationFact {
    classify_observed_relation_with_reason(path, target_facts, directory_capabilities).fact
}

pub fn classify_observed_relation_with_reason(
    path: &str,
    target_facts: &[RelationTargetFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
) -> RelationClassification {
    let windows = looks_like_windows_path(path)
        || target_facts
            .iter()
            .any(|fact| looks_like_windows_path(&fact.directory_path));
    let selected = target_facts
        .iter()
        .filter(|fact| path_lives_under_platform(path, &fact.directory_path, windows))
        .min_by_key(|fact| target_sort_key(fact, windows));

    let Some(target) = selected else {
        return unknown_classification(path, "no registered directory contains the observed path");
    };

    let shared_target = target.link_target_path.as_deref().and_then(|link_target| {
        let mut candidates = target_facts
            .iter()
            .filter(|candidate| candidate.directory_role == DirectoryRole::SharedDirectory)
            .filter(|candidate| {
                path_lives_under_platform(link_target, &candidate.directory_path, windows)
            })
            .collect::<Vec<_>>();
        if let Some(directory_node_id) = target.link_target_directory_id.as_deref() {
            candidates.retain(|candidate| candidate.directory_node_id == directory_node_id);
        }
        candidates
            .into_iter()
            .min_by_key(|candidate| target_sort_key(candidate, windows))
    });

    let shared_capability_target = if target.directory_role == DirectoryRole::SharedDirectory {
        Some(target)
    } else {
        shared_target
    };
    let recognition = shared_capability_target
        .map(|shared_target| {
            directory_capabilities
                .iter()
                .find(|capability| {
                    capability.agent_client_id == target.agent_client_id
                        && capability.directory_node_id == shared_target.directory_node_id
                })
                .map(|capability| capability.recognition)
                .unwrap_or(DirectoryRecognition::Unknown)
        })
        .unwrap_or(DirectoryRecognition::Supported);

    if target.link_target_path.is_some() && shared_capability_target.is_none() {
        return unknown_classification(path, "shared link target directory was not found")
            .with_target_context(target);
    }

    if shared_capability_target.is_some() && recognition != DirectoryRecognition::Supported {
        let reason = match recognition {
            DirectoryRecognition::Unknown => {
                "shared directory capability is not confirmed for this Agent".to_owned()
            }
            DirectoryRecognition::Unsupported => {
                "Agent facts explicitly do not support this shared directory".to_owned()
            }
            DirectoryRecognition::Supported => unreachable!(),
        };
        return unknown_classification(path, &reason).with_target_context(target);
    }

    let mut fact = target.to_deployment_relation_fact();
    fact.path = path.to_owned();
    fact.path_key = observed_path_key(path);
    if target.relation_id.is_none() {
        fact.relation_id = format!("observed:{}", fact.path_key);
    }
    fact.directory_node_id = Some(target.directory_node_id.clone());
    fact.link_target_path_key = fact.link_target_path.as_deref().map(observed_path_key);

    let derived_relationship = relationship_for_target(target);
    let direct_shared_read = target.directory_role == DirectoryRole::SharedDirectory
        && target.file_representation == FileRepresentation::Directory
        && target.ownership == OwnershipState::ObservedUnmanaged
        && matches!(
            target.relationship,
            RelationshipType::Unknown | RelationshipType::SharedDirectoryRead
        );
    let shared_reference = shared_target.is_some()
        && matches!(
            target.file_representation,
            FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction
        )
        && matches!(
            target.ownership,
            OwnershipState::ObservedUnmanaged | OwnershipState::SharedReference
        )
        && matches!(
            derived_relationship,
            RelationshipType::ObservedLink | RelationshipType::Unknown
        );
    let relationship = if direct_shared_read {
        RelationshipType::SharedDirectoryRead
    } else if shared_reference {
        RelationshipType::SharedDirectoryReference
    } else {
        derived_relationship
    };
    fact.relationship = relationship;
    fact.ownership = if relationship == RelationshipType::SharedDirectoryReference {
        OwnershipState::SharedReference
    } else {
        target.ownership
    };
    if target.match_state != crate::deployment::ObservedMatchState::ContentVerified {
        fact.skill_id = None;
    }
    if relationship == RelationshipType::Unknown {
        let mut classification = unknown_classification(
            path,
            "ownership and file representation do not define a known relationship",
        )
        .with_target_context(target);
        classification.fact = fact;
        return classification;
    }
    RelationClassification {
        fact,
        reason: None,
        governance_task: None,
    }
}

fn relationship_for_ownership(
    ownership: OwnershipState,
    representation: FileRepresentation,
) -> RelationshipType {
    let link = matches!(
        representation,
        FileRepresentation::SymbolicLink | FileRepresentation::DirectoryJunction
    );
    let copy = matches!(
        representation,
        FileRepresentation::Directory | FileRepresentation::Copy
    );
    match (ownership, link, copy) {
        (OwnershipState::SkillhubManaged, true, false) => RelationshipType::ManagedLink,
        (OwnershipState::SkillhubManaged, false, true) => RelationshipType::ManagedCopy,
        (OwnershipState::ObservedUnmanaged, true, false) => RelationshipType::ObservedLink,
        (OwnershipState::ObservedUnmanaged, false, true) => RelationshipType::ObservedCopy,
        _ => RelationshipType::Unknown,
    }
}

fn relationship_for_target(target: &RelationTargetFact) -> RelationshipType {
    // The persisted relationship is a hint from an earlier observation. The
    // current ownership and filesystem representation are authoritative.
    relationship_for_ownership(target.ownership, target.file_representation)
}

fn unknown_classification(path: &str, reason: &str) -> RelationClassification {
    let path_key = observed_path_key(path);
    let task = GovernanceTaskFact {
        task_id: format!("relationship:{path_key}:classification"),
        kind: GovernanceTaskKind::UnknownDirectoryRecognition,
        subject_id: path_key.clone(),
        detail: reason.to_owned(),
        resolved: false,
        created_at: 0,
        resolved_at: None,
    };
    RelationClassification {
        fact: DeploymentRelationFact {
            relation_id: format!("observed:{path_key}"),
            skill_id: None,
            agent_client_id: "unknown".into(),
            path: path.into(),
            path_key,
            directory_node_id: None,
            relationship: RelationshipType::Unknown,
            file_representation: FileRepresentation::Unknown,
            ownership: OwnershipState::ObservedUnmanaged,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: None,
            content_fingerprint: String::new(),
            origin: crate::deployment::ObservedOrigin::Scan,
            match_state: crate::deployment::ObservedMatchState::NameOnly,
            active: true,
            observed_at: 0,
            released_at: None,
        },
        reason: Some(reason.to_owned()),
        governance_task: Some(task),
    }
}

impl RelationClassification {
    fn with_target_context(mut self, target: &RelationTargetFact) -> Self {
        self.fact.agent_client_id = target.agent_client_id.clone();
        self.fact.directory_node_id = Some(target.directory_node_id.clone());
        self
    }
}

fn looks_like_windows_path(path: &str) -> bool {
    path.as_bytes().get(1) == Some(&b':') || path.contains('\\')
}

fn target_sort_key(
    target: &RelationTargetFact,
    windows: bool,
) -> (std::cmp::Reverse<usize>, String, String, String, String) {
    (
        std::cmp::Reverse(normalized_path_key(&target.directory_path, windows).len()),
        normalized_path_key(&target.directory_path, windows),
        target.directory_node_id.clone(),
        target.agent_client_id.clone(),
        target.relation_id.clone().unwrap_or_default(),
    )
}
