use crate::deployment::{DeploymentRelationFact, ObservedMatchState};
use crate::relationship::{
    AgentDirectoryCapabilityFact, DirectoryRecognition, GovernanceTaskFact, GovernanceTaskKind,
    OwnershipState, RelationshipType,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MinimalImpactAction {
    RemoveCurrentAgentTarget,
    RemoveCurrentRelationKeepSharedFiles,
    RemoveCurrentSharedAlias,
    ConvertCopyToManagedLink,
    CreateGovernanceTask,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SharedDirectoryConsumer {
    pub agent_client_id: String,
    pub relation_id: Option<String>,
    pub directory_node_id: Option<String>,
    pub recognition: DirectoryRecognition,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelatedSkillPath {
    pub relation_id: String,
    pub path: String,
    pub relationship: RelationshipType,
    pub file_representation: crate::relationship::FileRepresentation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupRecoveryInfo {
    pub required: bool,
    pub rollback_available: bool,
    pub backup_location: Option<String>,
    pub detail: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RemovalImpactFact {
    pub relation_id: String,
    pub relation: Option<DeploymentRelationFact>,
    pub ownership: Option<OwnershipState>,
    pub current_agent_reads_shared_directory: bool,
    pub other_consumers: Vec<SharedDirectoryConsumer>,
    pub other_skill_paths: Vec<RelatedSkillPath>,
    pub minimal_action: MinimalImpactAction,
    pub backup: BackupRecoveryInfo,
    pub governance_tasks: Vec<GovernanceTaskFact>,
    pub permission_limited: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RemovalFacts {
    pub relations: Vec<DeploymentRelationFact>,
    pub directory_capabilities: Vec<AgentDirectoryCapabilityFact>,
    pub permission_limited: bool,
}

impl RemovalFacts {
    pub fn new(
        relations: Vec<DeploymentRelationFact>,
        directory_capabilities: Vec<AgentDirectoryCapabilityFact>,
    ) -> Self {
        Self {
            relations,
            directory_capabilities,
            permission_limited: false,
        }
    }

    pub fn with_permission_limited(mut self, value: bool) -> Self {
        self.permission_limited = value;
        self
    }
}

pub fn calculate_removal_impact(relation_id: &str, facts: &RemovalFacts) -> RemovalImpactFact {
    let relation = facts
        .relations
        .iter()
        .find(|relation| relation.relation_id == relation_id)
        .cloned();
    let ownership = relation.as_ref().map(|relation| relation.ownership);
    let current_agent_reads_shared_directory = relation
        .as_ref()
        .is_some_and(|relation| relation.relationship == RelationshipType::SharedDirectoryRead);

    let mut governance_tasks = Vec::new();
    let shared_node_id = relation.as_ref().and_then(shared_directory_node_id);
    let mut other_consumers = Vec::new();

    if let Some(relation) = &relation {
        if let Some(directory_node_id) = shared_node_id.as_deref() {
            let current_recognition =
                capability_recognition(facts, &relation.agent_client_id, directory_node_id);
            if current_recognition != DirectoryRecognition::Supported {
                add_governance_task(
                    &mut governance_tasks,
                    relation_id,
                    GovernanceTaskKind::UnknownDirectoryRecognition,
                    format!(
                        "shared directory capability is {:?} for {}",
                        current_recognition, relation.agent_client_id
                    ),
                );
            }

            for candidate in facts.relations.iter().filter(|candidate| {
                candidate.relation_id != relation.relation_id
                    && candidate.active
                    && candidate.agent_client_id != relation.agent_client_id
                    && shared_directory_node_id(candidate).as_deref() == Some(directory_node_id)
            }) {
                let recognition =
                    capability_recognition(facts, &candidate.agent_client_id, directory_node_id);
                other_consumers.push(SharedDirectoryConsumer {
                    agent_client_id: candidate.agent_client_id.clone(),
                    relation_id: Some(candidate.relation_id.clone()),
                    directory_node_id: Some(directory_node_id.to_owned()),
                    recognition,
                });
                if recognition != DirectoryRecognition::Supported {
                    add_governance_task(
                        &mut governance_tasks,
                        relation_id,
                        GovernanceTaskKind::UnknownDirectoryRecognition,
                        format!(
                            "shared directory capability is {:?} for {}",
                            recognition, candidate.agent_client_id
                        ),
                    );
                }
            }

            for capability in facts.directory_capabilities.iter().filter(|capability| {
                capability.directory_node_id == directory_node_id
                    && capability.agent_client_id != relation.agent_client_id
                    && !other_consumers
                        .iter()
                        .any(|consumer| consumer.agent_client_id == capability.agent_client_id)
                    && capability.recognition != DirectoryRecognition::Supported
            }) {
                add_governance_task(
                    &mut governance_tasks,
                    relation_id,
                    GovernanceTaskKind::UnknownDirectoryRecognition,
                    format!(
                        "shared directory capability is {:?} for {}",
                        capability.recognition, capability.agent_client_id
                    ),
                );
            }
        }
    }
    other_consumers.sort_by(|left, right| {
        left.agent_client_id
            .cmp(&right.agent_client_id)
            .then_with(|| left.relation_id.cmp(&right.relation_id))
            .then_with(|| left.directory_node_id.cmp(&right.directory_node_id))
    });

    let other_skill_paths = relation
        .as_ref()
        .map(|selected| {
            let mut paths = facts
                .relations
                .iter()
                .filter(|candidate| {
                    candidate.relation_id != selected.relation_id
                        && candidate.active
                        && candidate.skill_id.is_some()
                        && candidate.skill_id == selected.skill_id
                })
                .map(|candidate| RelatedSkillPath {
                    relation_id: candidate.relation_id.clone(),
                    path: candidate.path.clone(),
                    relationship: candidate.relationship,
                    file_representation: candidate.file_representation,
                })
                .collect::<Vec<_>>();
            paths.sort_by(|left, right| {
                left.relation_id
                    .cmp(&right.relation_id)
                    .then_with(|| left.path.cmp(&right.path))
            });
            paths
        })
        .unwrap_or_default();

    if relation.is_none() || facts.permission_limited {
        add_governance_task(
            &mut governance_tasks,
            relation_id,
            GovernanceTaskKind::OperationFailureRecovery,
            if facts.permission_limited {
                "permission is restricted; rescan and confirm before removal".into()
            } else {
                "relationship was not found in the current fact snapshot".into()
            },
        );
    }
    if let Some(relation) = &relation {
        if relation.relationship == RelationshipType::Unknown
            || relation.file_representation == crate::relationship::FileRepresentation::Unknown
            || relation.match_state != ObservedMatchState::ContentVerified
        {
            add_governance_task(
                &mut governance_tasks,
                relation_id,
                GovernanceTaskKind::UnknownDirectoryRecognition,
                "relationship or Skill identity is not deterministically confirmed".into(),
            );
        }
    }

    let backup = backup_info(relation.as_ref());
    let mut impact = RemovalImpactFact {
        relation_id: relation_id.to_owned(),
        relation,
        ownership,
        current_agent_reads_shared_directory,
        other_consumers,
        other_skill_paths,
        minimal_action: MinimalImpactAction::CreateGovernanceTask,
        backup,
        governance_tasks,
        permission_limited: facts.permission_limited,
    };
    impact.minimal_action = recommend_removal_action(&impact);
    impact
}

pub fn recommend_removal_action(impact: &RemovalImpactFact) -> MinimalImpactAction {
    if !impact.governance_tasks.is_empty() || impact.permission_limited || impact.relation.is_none()
    {
        return MinimalImpactAction::CreateGovernanceTask;
    }
    let relation = impact.relation.as_ref().expect("checked above");
    match relation.relationship {
        RelationshipType::SharedDirectoryRead => {
            MinimalImpactAction::RemoveCurrentRelationKeepSharedFiles
        }
        RelationshipType::SharedDirectoryReference => MinimalImpactAction::RemoveCurrentSharedAlias,
        RelationshipType::ObservedCopy | RelationshipType::ManagedCopy => {
            MinimalImpactAction::ConvertCopyToManagedLink
        }
        RelationshipType::ManagedLink
        | RelationshipType::ObservedLink
        | RelationshipType::ImportCopy => MinimalImpactAction::RemoveCurrentAgentTarget,
        RelationshipType::Unknown => MinimalImpactAction::CreateGovernanceTask,
    }
}

fn backup_info(relation: Option<&DeploymentRelationFact>) -> BackupRecoveryInfo {
    let conversion = relation.is_some_and(|relation| {
        matches!(
            relation.relationship,
            RelationshipType::ObservedCopy | RelationshipType::ManagedCopy
        )
    });
    BackupRecoveryInfo {
        required: conversion,
        rollback_available: conversion,
        backup_location: None,
        detail: if conversion {
            "backup and content verification are required before link conversion".into()
        } else {
            "no filesystem mutation is planned by this pure impact calculation".into()
        },
    }
}

fn shared_directory_node_id(relation: &DeploymentRelationFact) -> Option<String> {
    match relation.relationship {
        RelationshipType::SharedDirectoryRead => relation.directory_node_id.clone(),
        RelationshipType::SharedDirectoryReference => relation
            .link_target_directory_id
            .clone()
            .or_else(|| relation.directory_node_id.clone()),
        _ => None,
    }
}

fn capability_recognition(
    facts: &RemovalFacts,
    agent_client_id: &str,
    directory_node_id: &str,
) -> DirectoryRecognition {
    facts
        .directory_capabilities
        .iter()
        .find(|capability| {
            capability.agent_client_id == agent_client_id
                && capability.directory_node_id == directory_node_id
        })
        .map(|capability| capability.recognition)
        .unwrap_or(DirectoryRecognition::Unknown)
}

fn add_governance_task(
    tasks: &mut Vec<GovernanceTaskFact>,
    subject_id: &str,
    kind: GovernanceTaskKind,
    detail: String,
) {
    if tasks
        .iter()
        .any(|task| task.kind == kind && task.subject_id == subject_id)
    {
        return;
    }
    tasks.push(governance_task(subject_id, kind, detail));
}

fn governance_task(
    subject_id: &str,
    kind: GovernanceTaskKind,
    detail: String,
) -> GovernanceTaskFact {
    GovernanceTaskFact {
        task_id: format!("removal:{subject_id}:governance"),
        kind,
        subject_id: subject_id.into(),
        detail,
        resolved: false,
        created_at: 0,
        resolved_at: None,
    }
}
