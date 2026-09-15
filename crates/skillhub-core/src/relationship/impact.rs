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

    let mut other_consumers = Vec::new();
    if let Some(relation) = &relation {
        for capability in &facts.directory_capabilities {
            if capability.agent_client_id == relation.agent_client_id
                || Some(&capability.directory_node_id) != relation.directory_node_id.as_ref()
                || capability.recognition != DirectoryRecognition::Supported
            {
                continue;
            }
            if !other_consumers
                .iter()
                .any(|consumer: &SharedDirectoryConsumer| {
                    consumer.agent_client_id == capability.agent_client_id
                })
            {
                other_consumers.push(SharedDirectoryConsumer {
                    agent_client_id: capability.agent_client_id.clone(),
                    relation_id: facts
                        .relations
                        .iter()
                        .find(|candidate| {
                            candidate.agent_client_id == capability.agent_client_id
                                && candidate.directory_node_id == relation.directory_node_id
                        })
                        .map(|candidate| candidate.relation_id.clone()),
                    directory_node_id: relation.directory_node_id.clone(),
                    recognition: capability.recognition,
                });
            }
        }
    }
    if let Some(relation) = &relation {
        for candidate in &facts.relations {
            if candidate.relation_id == relation.relation_id
                || !candidate.active
                || candidate.directory_node_id != relation.directory_node_id
                || candidate.relationship != RelationshipType::SharedDirectoryRead
                || candidate.agent_client_id == relation.agent_client_id
            {
                continue;
            }
            if !other_consumers
                .iter()
                .any(|consumer| consumer.agent_client_id == candidate.agent_client_id)
            {
                other_consumers.push(SharedDirectoryConsumer {
                    agent_client_id: candidate.agent_client_id.clone(),
                    relation_id: Some(candidate.relation_id.clone()),
                    directory_node_id: candidate.directory_node_id.clone(),
                    recognition: DirectoryRecognition::Supported,
                });
            }
        }
    }
    other_consumers.sort_by(|left, right| left.agent_client_id.cmp(&right.agent_client_id));

    let other_skill_paths = relation
        .as_ref()
        .map(|selected| {
            facts
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
                .collect()
        })
        .unwrap_or_default();

    let mut governance_tasks = Vec::new();
    if relation.is_none() || facts.permission_limited {
        governance_tasks.push(governance_task(
            relation_id,
            if facts.permission_limited {
                "permission is restricted; rescan and confirm before removal"
            } else {
                "relationship was not found in the current fact snapshot"
            },
        ));
    }
    if let Some(relation) = &relation {
        if relation.relationship == RelationshipType::Unknown
            || relation.file_representation == crate::relationship::FileRepresentation::Unknown
            || relation.match_state != ObservedMatchState::ContentVerified
        {
            governance_tasks.push(governance_task(
                relation_id,
                "relationship or Skill identity is not deterministically confirmed",
            ));
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

fn governance_task(subject_id: &str, detail: &str) -> GovernanceTaskFact {
    GovernanceTaskFact {
        task_id: format!("removal:{subject_id}:governance"),
        kind: GovernanceTaskKind::ConfirmSharedDirectoryImpact,
        subject_id: subject_id.into(),
        detail: detail.into(),
        resolved: false,
        created_at: 0,
        resolved_at: None,
    }
}
