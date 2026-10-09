use std::collections::HashMap;
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::deployment::ObservedMatchState;
use crate::import::ImportProvenanceEvent;
use crate::source::{SourceDescriptor, SourceLocator, SourceRecord};
use crate::SkillId;

use super::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, DeploymentRelationFact,
    DirectoryNodeFact, DirectoryRecognition, DirectoryRole, RelationGovernanceRow,
    RelationGovernanceState, RelationGovernanceTargetKind, RelationTargetIdentity,
    RelationshipType, SkillLineageFact, SourceRelationFact, UsageRelationView,
};

const MAX_CONTEXT_NODES_PER_KIND: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipGraphNodeKind {
    Skill,
    Source,
    Agent,
    Project,
    Directory,
    Conflict,
    Collapsed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipGraphEdgeKind {
    RelatedSkill,
    Source,
    Deployment,
    LocatedIn,
    Shared,
    Conflict,
}

/// User-facing relation kinds used by graph edges and filters. Structural
/// connections such as conflicts remain represented by `kind` only.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    Usage,
    ImportOrigin,
    UpdateSource,
    DerivedFrom,
    DirectoryOwnership,
    DirectoryRecognition,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipGraphStatus {
    Active,
    Released,
    ContentVerified,
    NameOnly,
    Diverged,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationshipGraphFilters {
    #[serde(default)]
    pub relationship_kinds: Vec<RelationshipKind>,
    #[serde(default)]
    pub statuses: Vec<RelationshipGraphStatus>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationshipGraphFactCounts {
    /// Distinct current use relations from the authoritative governance rows.
    pub usage_relations: u32,
    pub deployment_relations: u32,
    /// Import/upstream provenance facts; these are not use relations.
    pub source_relations: u32,
    pub conflict_cases: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillRelationshipNode {
    pub node_id: String,
    pub kind: RelationshipGraphNodeKind,
    pub skill_id: Option<SkillId>,
    #[serde(default)]
    #[specta(optional)]
    pub display_name: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub reference_only: bool,
    pub relation_id: Option<String>,
    pub provenance_id: Option<String>,
    pub conflict_id: Option<String>,
    pub agent_client_id: Option<String>,
    pub directory_node_id: Option<String>,
    pub path: Option<String>,
    pub role: Option<DirectoryRole>,
    pub profile_id: Option<String>,
    pub collapsed_kind: Option<RelationshipGraphNodeKind>,
    /// Relationship, state, and verification fields are intentionally empty on
    /// shared context nodes; those facts belong to the edge that observed them.
    pub relationship: Option<RelationshipType>,
    pub match_state: Option<ObservedMatchState>,
    pub active: Option<bool>,
    pub source: Option<SourceDescriptor>,
    pub collapsed_count: u32,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillRelationshipEdge {
    pub edge_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: RelationshipGraphEdgeKind,
    #[serde(default)]
    #[specta(optional)]
    pub relationship_kind: Option<RelationshipKind>,
    /// RelatedSkill and Conflict edges are structural connections, so they
    /// have no relationship/status fact and are never removed by fact filters.
    pub relationship: Option<RelationshipType>,
    pub relation_id: Option<String>,
    pub provenance_id: Option<String>,
    pub conflict_id: Option<String>,
    pub match_state: Option<ObservedMatchState>,
    pub active: Option<bool>,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
    /// Present only on the one target-use edge backed by a governance row.
    /// Structural, provenance and conflict edges intentionally have no state.
    pub governance: Option<RelationGovernanceState>,
    pub target_identity: Option<RelationTargetIdentity>,
    pub evidence_relation_ids: Vec<String>,
}

/// Additional persisted business facts not carried by the legacy deployment
/// projection. `Some([])` for active usage is authoritative; `None` is kept
/// for compatibility callers that only have the older technical facts.
pub struct RelationshipGraphAdditionalFacts<'a> {
    pub active_usage_relations: Option<&'a [UsageRelationView]>,
    pub import_events: &'a [ImportProvenanceEvent],
    pub update_sources: &'a [SourceRecord],
    pub lineage: &'a [SkillLineageFact],
    pub existing_skill_ids: &'a [SkillId],
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillRelationshipGraph {
    pub center_skill_id: SkillId,
    pub nodes: Vec<SkillRelationshipNode>,
    pub edges: Vec<SkillRelationshipEdge>,
    pub fact_counts: RelationshipGraphFactCounts,
    pub collapsed_count: u32,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
}

impl SkillRelationshipGraph {
    pub fn has_node(&self, node_id: &str) -> bool {
        self.nodes.iter().any(|node| node.node_id == node_id)
    }

    pub fn has_skill_node(&self, skill_id: &SkillId) -> bool {
        self.nodes.iter().any(|node| {
            node.kind == RelationshipGraphNodeKind::Skill && node.skill_id == Some(*skill_id)
        })
    }
}

pub fn project_skill_relationship_graph(
    center_skill_id: SkillId,
    deployments: &[DeploymentRelationFact],
    source_relations: &[SourceRelationFact],
    directory_nodes: &[DirectoryNodeFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    conflict_cases: &[ConflictCaseFact],
    filters: &RelationshipGraphFilters,
) -> SkillRelationshipGraph {
    project_skill_relationship_graph_with_governance(
        center_skill_id,
        deployments,
        source_relations,
        &[],
        directory_nodes,
        directory_capabilities,
        conflict_cases,
        filters,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn project_skill_relationship_graph_with_governance(
    center_skill_id: SkillId,
    deployments: &[DeploymentRelationFact],
    source_relations: &[SourceRelationFact],
    governance_rows: &[RelationGovernanceRow],
    directory_nodes: &[DirectoryNodeFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    conflict_cases: &[ConflictCaseFact],
    filters: &RelationshipGraphFilters,
) -> SkillRelationshipGraph {
    project_skill_relationship_graph_with_facts(
        center_skill_id,
        deployments,
        source_relations,
        governance_rows,
        directory_nodes,
        directory_capabilities,
        conflict_cases,
        filters,
        RelationshipGraphAdditionalFacts {
            active_usage_relations: None,
            import_events: &[],
            update_sources: &[],
            lineage: &[],
            existing_skill_ids: &[],
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn project_skill_relationship_graph_with_facts(
    center_skill_id: SkillId,
    deployments: &[DeploymentRelationFact],
    source_relations: &[SourceRelationFact],
    governance_rows: &[RelationGovernanceRow],
    directory_nodes: &[DirectoryNodeFact],
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    conflict_cases: &[ConflictCaseFact],
    filters: &RelationshipGraphFilters,
    additional_facts: RelationshipGraphAdditionalFacts<'_>,
) -> SkillRelationshipGraph {
    let directory_facts = directory_fact_index(directory_nodes);
    let mut relevant_conflicts = conflict_cases
        .iter()
        .filter(|case| {
            case.classification == ConflictClassification::Uncertain
                && case.user_decision.is_none()
                && conflict_skill_ids(case).contains(&center_skill_id)
        })
        .collect::<Vec<_>>();
    relevant_conflicts.sort_by(|left, right| left.conflict_id.cmp(&right.conflict_id));
    let conflict_related_skill_ids = relevant_conflicts
        .iter()
        .flat_map(|case| conflict_skill_ids(case))
        .filter(|skill_id| *skill_id != center_skill_id)
        .collect::<HashSet<_>>();

    let mut skill_ids = vec![center_skill_id];
    let mut skill_id_set = HashSet::from([center_skill_id]);
    for case in &relevant_conflicts {
        for skill_id in conflict_skill_ids(case) {
            if skill_id_set.insert(skill_id) {
                skill_ids.push(skill_id);
            }
        }
    }
    let live_skill_ids = additional_facts
        .existing_skill_ids
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    for fact in additional_facts
        .lineage
        .iter()
        .filter(|fact| fact.skill_id == center_skill_id || fact.origin_skill_id == center_skill_id)
    {
        let related_skill_id = if fact.skill_id == center_skill_id {
            Some(fact.origin_skill_id)
        } else if live_skill_ids.contains(&fact.skill_id) {
            Some(fact.skill_id)
        } else {
            None
        };
        if let Some(skill_id) = related_skill_id {
            if skill_id_set.insert(skill_id) {
                skill_ids.push(skill_id);
            }
        }
    }
    skill_ids[1..].sort_by_key(|skill_id| skill_id.to_string());

    let fact_counts = RelationshipGraphFactCounts {
        usage_relations: governance_rows
            .iter()
            .filter(|row| row.skill_id().is_some_and(|id| skill_id_set.contains(&id)))
            .count()
            .try_into()
            .unwrap_or(u32::MAX),
        deployment_relations: deployments
            .iter()
            .filter(|relation| {
                relation
                    .skill_id
                    .is_some_and(|id| skill_id_set.contains(&id))
            })
            .count()
            .try_into()
            .unwrap_or(u32::MAX),
        source_relations: source_relations
            .iter()
            .filter(|relation| skill_id_set.contains(&relation.skill_id))
            .count()
            .saturating_add(
                additional_facts
                    .import_events
                    .iter()
                    .filter(|event| skill_id_set.contains(&event.skill_id))
                    .count(),
            )
            .try_into()
            .unwrap_or(u32::MAX),
        conflict_cases: relevant_conflicts.len().try_into().unwrap_or(u32::MAX),
    };
    let last_verified_at = deployments
        .iter()
        .filter(|relation| {
            relation
                .skill_id
                .is_some_and(|id| skill_id_set.contains(&id))
        })
        .map(|relation| relation.observed_at)
        .max();

    let mut graph = SkillRelationshipGraph {
        center_skill_id,
        nodes: skill_ids
            .iter()
            .copied()
            .map(|skill_id| {
                let mut node = skill_node(skill_id);
                if let Some(fact) = additional_facts.lineage.iter().find(|fact| {
                    fact.origin_skill_id == skill_id
                        && !live_skill_ids.contains(&fact.origin_skill_id)
                        && fact.skill_id == center_skill_id
                }) {
                    node.display_name = fact.origin_display_name.clone();
                    node.reference_only = true;
                }
                node
            })
            .collect(),
        edges: Vec::new(),
        fact_counts,
        collapsed_count: 0,
        last_verified_at,
    };
    let governance_by_relation_id = governance_rows
        .iter()
        .filter(|row| row.skill_id().is_some_and(|id| skill_id_set.contains(&id)))
        .flat_map(|row| {
            row.evidence_relation_ids
                .iter()
                .map(move |relation_id| (relation_id.as_str(), row))
        })
        .collect::<HashMap<_, _>>();
    let mut collapsed_context_node_ids = HashSet::new();
    let mut expanded_shared_directories = HashSet::new();

    if let Some(active_usage_relations) = additional_facts.active_usage_relations {
        for usage in active_usage_relations.iter().filter(|usage| {
            usage
                .skill_id
                .is_some_and(|skill_id| skill_id_set.contains(&skill_id))
        }) {
            let Some(skill_id) = usage.skill_id else {
                continue;
            };
            let match_state = usage_match_state(usage, deployments);
            let usage_visible = fact_visible(
                RelationshipKind::Usage,
                Some(match_state),
                Some(usage.active),
                filters,
            );
            if usage.target.kind == RelationGovernanceTargetKind::Agent
                && relationship_kind_visible(RelationshipKind::DirectoryOwnership, filters)
            {
                if let Some(directory_id) = usage.target.directory_id.as_deref() {
                    let directory_node_id = ensure_directory_node(
                        &mut graph,
                        &mut collapsed_context_node_ids,
                        directory_id,
                        &directory_facts,
                    );
                    graph.edges.push(structural_edge_with_relationship(
                        format!("usage-directory:{}", usage.relation_id),
                        skill_id.to_string(),
                        directory_node_id,
                        RelationshipGraphEdgeKind::LocatedIn,
                        RelationshipKind::DirectoryOwnership,
                    ));
                }
            }

            if usage.target.kind == RelationGovernanceTargetKind::SharedDirectory {
                if let Some(directory_id) = usage.target.directory_id.as_deref() {
                    let directory_node_id = ensure_directory_node(
                        &mut graph,
                        &mut collapsed_context_node_ids,
                        directory_id,
                        &directory_facts,
                    );
                    append_directory_recognition_edges(
                        &mut graph,
                        &mut collapsed_context_node_ids,
                        &mut expanded_shared_directories,
                        directory_id,
                        &directory_node_id,
                        directory_capabilities,
                        filters,
                    );
                }
            }
            if !usage_visible {
                continue;
            }
            let Some((kind, to_node_id)) = usage_target_node(
                usage,
                &mut graph,
                &mut collapsed_context_node_ids,
                &directory_facts,
            ) else {
                continue;
            };
            let governance_row = usage
                .evidence_relation_ids
                .iter()
                .find_map(|id| governance_by_relation_id.get(id.as_str()).copied());
            let relationship = usage
                .evidence_relation_ids
                .iter()
                .find_map(|id| {
                    deployments
                        .iter()
                        .find(|relation| relation.relation_id == *id)
                        .map(|relation| relation.relationship)
                })
                .unwrap_or(RelationshipType::Unknown);
            let input = FactEdgeInput {
                edge_id: format!("usage:{}", usage.relation_id),
                from_node_id: skill_id.to_string(),
                to_node_id: to_node_id.clone(),
                kind,
                relationship_kind: Some(RelationshipKind::Usage),
                relationship: Some(relationship),
                relation_id: Some(usage.relation_id.clone()),
                provenance_id: None,
                conflict_id: None,
                match_state: Some(match_state),
                active: Some(usage.active),
                last_verified_at: usage
                    .evidence_relation_ids
                    .iter()
                    .filter_map(|id| {
                        deployments
                            .iter()
                            .find(|relation| relation.relation_id == *id)
                            .map(|relation| relation.observed_at)
                    })
                    .max(),
            };
            graph.edges.push(match governance_row {
                Some(row) => authoritative_fact_edge(input, row),
                None => fact_edge(input),
            });
        }
    }

    for skill_id in skill_ids
        .iter()
        .copied()
        .filter(|id| conflict_related_skill_ids.contains(id))
    {
        graph.edges.push(structural_edge(
            format!("related:{center_skill_id}:{skill_id}"),
            center_skill_id.to_string(),
            skill_id.to_string(),
            RelationshipGraphEdgeKind::RelatedSkill,
        ));
    }

    let mut sorted_deployments = deployments
        .iter()
        .filter(|relation| {
            relation
                .skill_id
                .is_some_and(|id| skill_id_set.contains(&id))
        })
        .collect::<Vec<_>>();
    sorted_deployments.sort_by(|left, right| left.relation_id.cmp(&right.relation_id));
    for relation in sorted_deployments {
        // When supplied, the business usage view is authoritative for active
        // usage edges. Keep inactive deployment facts as historical/released
        // evidence, while avoiding a second edge for an active relation.
        if additional_facts.active_usage_relations.is_some() && relation.active {
            continue;
        }
        if !fact_visible(
            RelationshipKind::Usage,
            Some(relation.match_state),
            Some(relation.active),
            filters,
        ) {
            continue;
        }
        let Some(skill_id) = relation.skill_id else {
            continue;
        };
        let governance_row = governance_by_relation_id
            .get(relation.relation_id.as_str())
            .copied();
        let is_governance_representative =
            governance_row.is_some_and(|row| row.relation_id() == relation.relation_id);
        let is_duplicate_use_edge = governance_row
            .is_some_and(|row| row.target_identity.is_some() && !is_governance_representative);
        let skill_node_id = skill_id.to_string();
        let shared_directory_id = relation
            .directory_node_id
            .as_deref()
            .filter(|directory_id| {
                directory_facts
                    .get(directory_id)
                    .is_some_and(|fact| fact.role == DirectoryRole::SharedDirectory)
            })
            .or_else(|| {
                relation
                    .link_target_directory_id
                    .as_deref()
                    .filter(|directory_id| {
                        directory_facts
                            .get(directory_id)
                            .is_some_and(|fact| fact.role == DirectoryRole::SharedDirectory)
                    })
            });
        if shared_directory_id.is_none() && !is_duplicate_use_edge {
            let agent_node_id = ensure_context_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                RelationshipGraphNodeKind::Agent,
                format!("agent:{}", relation.agent_client_id),
                ContextData::Agent {
                    agent_client_id: relation.agent_client_id.clone(),
                },
            );
            let input = FactEdgeInput {
                edge_id: format!("deployment:{}", relation.relation_id),
                from_node_id: skill_node_id.clone(),
                to_node_id: agent_node_id,
                kind: RelationshipGraphEdgeKind::Deployment,
                relationship_kind: Some(RelationshipKind::Usage),
                relationship: Some(relation.relationship),
                relation_id: Some(relation.relation_id.clone()),
                provenance_id: None,
                conflict_id: None,
                match_state: Some(relation.match_state),
                active: Some(relation.active),
                last_verified_at: Some(relation.observed_at),
            };
            graph
                .edges
                .push(match (governance_row, is_governance_representative) {
                    (Some(row), true) => authoritative_fact_edge(input, row),
                    _ => fact_edge(input),
                });
        }
        if let Some(directory_id) = &relation.directory_node_id {
            let directory_node_id = ensure_directory_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                directory_id,
                &directory_facts,
            );
            let edge_kind = if shared_directory_id == Some(directory_id.as_str()) {
                RelationshipGraphEdgeKind::Shared
            } else {
                RelationshipGraphEdgeKind::LocatedIn
            };
            let relationship_kind = if edge_kind == RelationshipGraphEdgeKind::Shared {
                RelationshipKind::Usage
            } else {
                RelationshipKind::DirectoryOwnership
            };
            let input = FactEdgeInput {
                edge_id: format!(
                    "{}:{}",
                    if shared_directory_id == Some(directory_id.as_str()) {
                        "shared"
                    } else {
                        "located"
                    },
                    relation.relation_id
                ),
                from_node_id: skill_node_id.clone(),
                to_node_id: directory_node_id.clone(),
                kind: edge_kind,
                relationship_kind: Some(relationship_kind),
                relationship: Some(relation.relationship),
                relation_id: Some(relation.relation_id.clone()),
                provenance_id: None,
                conflict_id: None,
                match_state: Some(relation.match_state),
                active: Some(relation.active),
                last_verified_at: Some(relation.observed_at),
            };
            let targets_this_directory = governance_row
                .and_then(|row| row.target_identity.as_ref())
                .is_some_and(|identity| identity.directory_node_id == *directory_id);
            if !(is_duplicate_use_edge
                && targets_this_directory
                && edge_kind == RelationshipGraphEdgeKind::Shared)
            {
                graph.edges.push(
                    match (
                        governance_row,
                        is_governance_representative,
                        targets_this_directory,
                    ) {
                        (Some(row), true, true)
                            if matches!(
                                row.target_identity
                                    .as_ref()
                                    .map(|identity| identity.target_kind),
                                Some(
                                    RelationGovernanceTargetKind::SharedDirectory
                                        | RelationGovernanceTargetKind::Project
                                )
                            ) =>
                        {
                            authoritative_fact_edge(input, row)
                        }
                        _ => fact_edge(input),
                    },
                );
            }
            if additional_facts.active_usage_relations.is_none()
                && shared_directory_id == Some(directory_id.as_str())
            {
                append_directory_recognition_edges(
                    &mut graph,
                    &mut collapsed_context_node_ids,
                    &mut expanded_shared_directories,
                    directory_id,
                    &directory_node_id,
                    directory_capabilities,
                    filters,
                );
            }
        }
        if let Some(directory_id) = &relation.link_target_directory_id {
            let directory_node_id = ensure_directory_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                directory_id,
                &directory_facts,
            );
            let input = FactEdgeInput {
                edge_id: format!("shared:{}", relation.relation_id),
                from_node_id: skill_node_id,
                to_node_id: directory_node_id,
                kind: RelationshipGraphEdgeKind::Shared,
                relationship_kind: Some(RelationshipKind::Usage),
                relationship: Some(relation.relationship),
                relation_id: Some(relation.relation_id.clone()),
                provenance_id: None,
                conflict_id: None,
                match_state: Some(relation.match_state),
                active: Some(relation.active),
                last_verified_at: Some(relation.observed_at),
            };
            let targets_this_directory = governance_row
                .and_then(|row| row.target_identity.as_ref())
                .is_some_and(|identity| identity.directory_node_id == *directory_id);
            if !(is_duplicate_use_edge && targets_this_directory) {
                graph.edges.push(
                    match (
                        governance_row,
                        is_governance_representative,
                        targets_this_directory,
                    ) {
                        (Some(row), true, true)
                            if row.target_identity.as_ref().is_some_and(|identity| {
                                identity.target_kind
                                    == RelationGovernanceTargetKind::SharedDirectory
                            }) =>
                        {
                            authoritative_fact_edge(input, row)
                        }
                        _ => fact_edge(input),
                    },
                );
            }
        }
    }

    // AgentLocal/Project source copies can be current usage targets before
    // takeover. They are represented by the same governance rows, while the
    // immutable import provenance below remains a separate source edge.
    for row in governance_rows.iter().filter(|row| {
        row.skill_id().is_some_and(|id| skill_id_set.contains(&id))
            && row.source_copy().is_some()
            && row.deployment().is_none()
            && additional_facts.active_usage_relations.is_none()
    }) {
        let Some(copy) = row.source_copy() else {
            continue;
        };
        if !fact_visible(
            RelationshipKind::Usage,
            Some(source_copy_match_state(copy.health)),
            Some(true),
            filters,
        ) {
            continue;
        }
        let skill_node_id = copy.skill_id.to_string();
        let target = row.target_identity.as_ref();
        let edge_kind =
            target.map_or(
                RelationshipGraphEdgeKind::Deployment,
                |identity| match identity.target_kind {
                    RelationGovernanceTargetKind::SharedDirectory => {
                        RelationshipGraphEdgeKind::Shared
                    }
                    RelationGovernanceTargetKind::Agent | RelationGovernanceTargetKind::Project => {
                        RelationshipGraphEdgeKind::Deployment
                    }
                },
            );
        let to_node_id = match target.map(|identity| identity.target_kind) {
            Some(RelationGovernanceTargetKind::SharedDirectory)
            | Some(RelationGovernanceTargetKind::Project) => ensure_directory_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                &target.expect("target identity").directory_node_id,
                &directory_facts,
            ),
            _ => match copy.agent_client_id.as_deref() {
                Some(agent_client_id) => ensure_context_node(
                    &mut graph,
                    &mut collapsed_context_node_ids,
                    RelationshipGraphNodeKind::Agent,
                    format!("agent:{agent_client_id}"),
                    ContextData::Agent {
                        agent_client_id: agent_client_id.to_owned(),
                    },
                ),
                None => continue,
            },
        };
        graph.edges.push(authoritative_fact_edge(
            FactEdgeInput {
                edge_id: format!("usage:{}", row.relation_id()),
                from_node_id: skill_node_id.clone(),
                to_node_id: to_node_id.clone(),
                kind: edge_kind,
                relationship_kind: Some(RelationshipKind::Usage),
                relationship: Some(RelationshipType::ImportCopy),
                relation_id: Some(row.relation_id().to_owned()),
                provenance_id: None,
                conflict_id: None,
                match_state: Some(source_copy_match_state(copy.health)),
                active: Some(true),
                last_verified_at: copy.last_verified_at,
            },
            row,
        ));

        if target
            .is_some_and(|identity| identity.target_kind == RelationGovernanceTargetKind::Agent)
        {
            if let Some(directory_id) = &copy.directory_node_id {
                let directory_node_id = ensure_directory_node(
                    &mut graph,
                    &mut collapsed_context_node_ids,
                    directory_id,
                    &directory_facts,
                );
                graph.edges.push(structural_edge(
                    format!("usage-directory:{}", row.relation_id()),
                    skill_node_id,
                    directory_node_id,
                    RelationshipGraphEdgeKind::LocatedIn,
                ));
            }
        }

        if additional_facts.active_usage_relations.is_none()
            && target.is_some_and(|identity| {
                identity.target_kind == RelationGovernanceTargetKind::SharedDirectory
            })
        {
            let directory_id = &target.expect("shared target").directory_node_id;
            append_directory_recognition_edges(
                &mut graph,
                &mut collapsed_context_node_ids,
                &mut expanded_shared_directories,
                directory_id,
                &to_node_id,
                directory_capabilities,
                filters,
            );
        }
    }

    let mut sorted_sources = source_relations
        .iter()
        .filter(|relation| skill_id_set.contains(&relation.skill_id))
        .collect::<Vec<_>>();
    sorted_sources.sort_by(|left, right| left.provenance_id.cmp(&right.provenance_id));
    for relation in sorted_sources {
        if !source_visible(RelationshipKind::ImportOrigin, filters) {
            continue;
        }
        let skill_node_id = relation.skill_id.to_string();
        let source_node_id = ensure_context_node(
            &mut graph,
            &mut collapsed_context_node_ids,
            RelationshipGraphNodeKind::Source,
            format!("source:{}", relation.provenance_id),
            ContextData::Source {
                provenance_id: Some(relation.provenance_id.clone()),
                source: relation.source.clone(),
                path: Some(relation.source_path.clone()),
            },
        );
        graph.edges.push(fact_edge(FactEdgeInput {
            edge_id: format!("source:{}:{}", relation.skill_id, relation.provenance_id),
            from_node_id: skill_node_id.clone(),
            to_node_id: source_node_id.clone(),
            kind: RelationshipGraphEdgeKind::Source,
            relationship_kind: Some(RelationshipKind::ImportOrigin),
            relationship: Some(relation.relationship),
            relation_id: None,
            provenance_id: Some(relation.provenance_id.clone()),
            conflict_id: None,
            match_state: None,
            active: None,
            last_verified_at: None,
        }));
        if let Some(agent_client_id) = &relation.agent_client_id {
            let agent_node_id = ensure_context_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                RelationshipGraphNodeKind::Agent,
                format!("agent:{agent_client_id}"),
                ContextData::Agent {
                    agent_client_id: agent_client_id.clone(),
                },
            );
            graph.edges.push(structural_fact_edge(
                format!(
                    "source-agent:{}:{}",
                    relation.skill_id, relation.provenance_id
                ),
                source_node_id.clone(),
                agent_node_id,
                RelationshipGraphEdgeKind::Shared,
                Some(relation.relationship),
                Some(relation.provenance_id.clone()),
            ));
        }
        if let Some(directory_id) = &relation.directory_node_id {
            let directory_node_id = ensure_directory_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                directory_id,
                &directory_facts,
            );
            graph.edges.push(structural_fact_edge(
                format!(
                    "source-directory:{}:{}",
                    relation.skill_id, relation.provenance_id
                ),
                source_node_id.clone(),
                directory_node_id,
                RelationshipGraphEdgeKind::LocatedIn,
                Some(relation.relationship),
                Some(relation.provenance_id.clone()),
            ));
        }
        if let Some(directory_id) = &relation.link_target_directory_id {
            let directory_node_id = ensure_directory_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                directory_id,
                &directory_facts,
            );
            graph.edges.push(structural_fact_edge(
                format!(
                    "source-shared:{}:{}",
                    relation.skill_id, relation.provenance_id
                ),
                source_node_id,
                directory_node_id,
                RelationshipGraphEdgeKind::Shared,
                Some(relation.relationship),
                Some(relation.provenance_id.clone()),
            ));
        }
    }

    let mut import_events = additional_facts
        .import_events
        .iter()
        .filter(|event| skill_id_set.contains(&event.skill_id))
        .collect::<Vec<_>>();
    import_events.sort_by(|left, right| {
        left.skill_id
            .to_string()
            .cmp(&right.skill_id.to_string())
            .then_with(|| left.provenance_id.cmp(&right.provenance_id))
    });
    for event in import_events {
        if !source_visible(RelationshipKind::ImportOrigin, filters) {
            continue;
        }
        let source_node_id = ensure_source_node(
            &mut graph,
            &mut collapsed_context_node_ids,
            &event.source,
            event.local_source_path.as_deref(),
        );
        graph.edges.push(fact_edge(FactEdgeInput {
            edge_id: format!("import-origin:{}:{}", event.skill_id, event.provenance_id),
            from_node_id: event.skill_id.to_string(),
            to_node_id: source_node_id.clone(),
            kind: RelationshipGraphEdgeKind::Source,
            relationship_kind: Some(RelationshipKind::ImportOrigin),
            relationship: None,
            relation_id: None,
            provenance_id: Some(event.provenance_id.clone()),
            conflict_id: None,
            match_state: None,
            active: None,
            last_verified_at: None,
        }));
        if let Some(agent_client_id) = &event.agent_client_id {
            let agent_node_id = ensure_context_node(
                &mut graph,
                &mut collapsed_context_node_ids,
                RelationshipGraphNodeKind::Agent,
                format!("agent:{agent_client_id}"),
                ContextData::Agent {
                    agent_client_id: agent_client_id.clone(),
                },
            );
            graph.edges.push(structural_fact_edge(
                format!("import-agent:{}:{}", event.skill_id, event.provenance_id),
                source_node_id,
                agent_node_id,
                RelationshipGraphEdgeKind::Shared,
                None,
                Some(event.provenance_id.clone()),
            ));
        }
    }

    let mut update_sources = additional_facts
        .update_sources
        .iter()
        .filter(|source| skill_id_set.contains(&source.skill_id))
        .collect::<Vec<_>>();
    update_sources.sort_by_key(|source| source.skill_id.to_string());
    for source in update_sources {
        if !source_visible(RelationshipKind::UpdateSource, filters) {
            continue;
        }
        let source_node_id = ensure_source_node(
            &mut graph,
            &mut collapsed_context_node_ids,
            &source.source,
            None,
        );
        graph.edges.push(fact_edge(FactEdgeInput {
            edge_id: format!(
                "update-source:{}:{}",
                source.skill_id,
                source_locator_key(&source.source)
            ),
            from_node_id: source.skill_id.to_string(),
            to_node_id: source_node_id,
            kind: RelationshipGraphEdgeKind::Source,
            relationship_kind: Some(RelationshipKind::UpdateSource),
            relationship: None,
            relation_id: None,
            provenance_id: None,
            conflict_id: None,
            match_state: None,
            active: None,
            last_verified_at: None,
        }));
    }

    for fact in additional_facts.lineage.iter().filter(|fact| {
        (fact.skill_id == center_skill_id || fact.origin_skill_id == center_skill_id)
            && skill_id_set.contains(&fact.skill_id)
            && skill_id_set.contains(&fact.origin_skill_id)
            && relationship_kind_visible(RelationshipKind::DerivedFrom, filters)
    }) {
        graph.edges.push(fact_edge(FactEdgeInput {
            edge_id: format!("derived-from:{}:{}", fact.origin_skill_id, fact.skill_id),
            from_node_id: fact.origin_skill_id.to_string(),
            to_node_id: fact.skill_id.to_string(),
            kind: RelationshipGraphEdgeKind::RelatedSkill,
            relationship_kind: Some(RelationshipKind::DerivedFrom),
            relationship: None,
            relation_id: None,
            provenance_id: None,
            conflict_id: None,
            match_state: None,
            active: None,
            last_verified_at: None,
        }));
    }

    for case in relevant_conflicts {
        let conflict_node_id = ensure_context_node(
            &mut graph,
            &mut collapsed_context_node_ids,
            RelationshipGraphNodeKind::Conflict,
            format!("conflict:{}", case.conflict_id),
            ContextData::Conflict {
                conflict_id: case.conflict_id.clone(),
            },
        );
        for skill_id in conflict_skill_ids(case) {
            if skill_id_set.contains(&skill_id) {
                graph.edges.push(structural_conflict_edge(
                    format!("conflict:{}:{skill_id}", case.conflict_id),
                    skill_id.to_string(),
                    conflict_node_id.clone(),
                    RelationshipGraphEdgeKind::Conflict,
                    case.conflict_id.clone(),
                ));
            }
        }
    }

    graph.nodes.sort_by(|left, right| {
        node_sort_key(left, center_skill_id).cmp(&node_sort_key(right, center_skill_id))
    });
    graph
        .edges
        .sort_by(|left, right| left.edge_id.cmp(&right.edge_id));
    graph
}

fn directory_fact_index<'a>(
    directory_nodes: &'a [DirectoryNodeFact],
) -> BTreeMap<&'a str, &'a DirectoryNodeFact> {
    let mut facts: BTreeMap<&'a str, &'a DirectoryNodeFact> = BTreeMap::new();
    for fact in directory_nodes {
        match facts.get(fact.node_id.as_str()) {
            Some(existing)
                if directory_fact_sort_key(existing) <= directory_fact_sort_key(fact) => {}
            _ => {
                facts.insert(fact.node_id.as_str(), fact);
            }
        }
    }
    facts
}

fn directory_fact_sort_key(
    fact: &DirectoryNodeFact,
) -> (u8, &str, &str, Option<&str>, Option<&str>, bool, i64) {
    (
        directory_role_sort_key(fact.role),
        fact.path_key.as_str(),
        fact.path.as_str(),
        fact.profile_id.as_deref(),
        fact.agent_client_id.as_deref(),
        fact.exists,
        fact.observed_at,
    )
}

fn directory_role_sort_key(role: DirectoryRole) -> u8 {
    match role {
        DirectoryRole::CentralLibrary => 0,
        DirectoryRole::AgentNative => 1,
        DirectoryRole::SharedDirectory => 2,
        DirectoryRole::Project => 3,
    }
}

fn conflict_skill_ids(case: &ConflictCaseFact) -> Vec<SkillId> {
    let mut skill_ids = case
        .member_skill_ids
        .iter()
        .copied()
        .chain(case.members.iter().filter_map(|member| member.skill_id))
        .collect::<Vec<_>>();
    skill_ids.sort_by_key(|skill_id| skill_id.to_string());
    skill_ids.dedup();
    skill_ids
}

fn skill_node(skill_id: SkillId) -> SkillRelationshipNode {
    SkillRelationshipNode {
        node_id: skill_id.to_string(),
        kind: RelationshipGraphNodeKind::Skill,
        skill_id: Some(skill_id),
        display_name: None,
        reference_only: false,
        relation_id: None,
        provenance_id: None,
        conflict_id: None,
        agent_client_id: None,
        directory_node_id: None,
        path: None,
        role: None,
        profile_id: None,
        collapsed_kind: None,
        relationship: None,
        match_state: None,
        active: None,
        source: None,
        collapsed_count: 0,
        last_verified_at: None,
    }
}

enum ContextData {
    Agent {
        agent_client_id: String,
    },
    Source {
        provenance_id: Option<String>,
        source: SourceDescriptor,
        path: Option<String>,
    },
    Directory {
        directory_node_id: String,
        path: Option<String>,
        role: Option<DirectoryRole>,
        profile_id: Option<String>,
    },
    Conflict {
        conflict_id: String,
    },
    Collapsed {
        collapsed_kind: RelationshipGraphNodeKind,
    },
}

fn ensure_directory_node(
    graph: &mut SkillRelationshipGraph,
    collapsed_context_node_ids: &mut HashSet<(RelationshipGraphNodeKind, String)>,
    directory_id: &str,
    directory_facts: &BTreeMap<&str, &DirectoryNodeFact>,
) -> String {
    let fact = directory_facts.get(directory_id).copied();
    let kind = fact.map_or(RelationshipGraphNodeKind::Directory, |fact| {
        if fact.role == DirectoryRole::Project {
            RelationshipGraphNodeKind::Project
        } else {
            RelationshipGraphNodeKind::Directory
        }
    });
    let node_id = match kind {
        RelationshipGraphNodeKind::Project => format!("project:{directory_id}"),
        _ => format!("directory:{directory_id}"),
    };
    ensure_context_node(
        graph,
        collapsed_context_node_ids,
        kind,
        node_id,
        fact.map_or(
            ContextData::Directory {
                directory_node_id: directory_id.to_owned(),
                path: None,
                role: None,
                profile_id: None,
            },
            |fact| ContextData::Directory {
                directory_node_id: fact.node_id.clone(),
                path: Some(fact.path.clone()),
                role: Some(fact.role),
                profile_id: fact.profile_id.clone(),
            },
        ),
    )
}

fn ensure_context_node(
    graph: &mut SkillRelationshipGraph,
    collapsed_context_node_ids: &mut HashSet<(RelationshipGraphNodeKind, String)>,
    kind: RelationshipGraphNodeKind,
    node_id: String,
    data: ContextData,
) -> String {
    if graph.has_node(&node_id) {
        return node_id;
    }
    let kind_count = graph.nodes.iter().filter(|node| node.kind == kind).count();
    if kind_count >= MAX_CONTEXT_NODES_PER_KIND {
        let collapsed_id = format!("collapsed:{}", node_kind_key(kind));
        if collapsed_context_node_ids.insert((kind, node_id)) {
            if let Some(node) = graph
                .nodes
                .iter_mut()
                .find(|node| node.node_id == collapsed_id)
            {
                node.collapsed_count = node.collapsed_count.saturating_add(1);
            } else {
                graph.nodes.push(context_node(
                    collapsed_id.clone(),
                    ContextData::Collapsed {
                        collapsed_kind: kind,
                    },
                ));
            }
            graph.collapsed_count = graph.collapsed_count.saturating_add(1);
        }
        return collapsed_id;
    }
    let mut node = context_node(node_id.clone(), data);
    node.kind = kind;
    graph.nodes.push(node);
    node_id
}

fn context_node(node_id: String, data: ContextData) -> SkillRelationshipNode {
    let mut node = SkillRelationshipNode {
        node_id,
        kind: RelationshipGraphNodeKind::Collapsed,
        skill_id: None,
        display_name: None,
        reference_only: false,
        relation_id: None,
        provenance_id: None,
        conflict_id: None,
        agent_client_id: None,
        directory_node_id: None,
        path: None,
        role: None,
        profile_id: None,
        collapsed_kind: None,
        relationship: None,
        match_state: None,
        active: None,
        source: None,
        collapsed_count: 0,
        last_verified_at: None,
    };
    match data {
        ContextData::Agent { agent_client_id } => {
            node.kind = RelationshipGraphNodeKind::Agent;
            node.agent_client_id = Some(agent_client_id);
        }
        ContextData::Source {
            provenance_id,
            source,
            path,
        } => {
            node.kind = RelationshipGraphNodeKind::Source;
            node.provenance_id = provenance_id;
            node.source = Some(source);
            node.path = path;
        }
        ContextData::Directory {
            directory_node_id,
            path,
            role,
            profile_id,
        } => {
            node.kind = RelationshipGraphNodeKind::Directory;
            node.directory_node_id = Some(directory_node_id);
            node.path = path;
            node.role = role;
            node.profile_id = profile_id;
        }
        ContextData::Conflict { conflict_id } => {
            node.kind = RelationshipGraphNodeKind::Conflict;
            node.conflict_id = Some(conflict_id);
        }
        ContextData::Collapsed { collapsed_kind } => {
            node.kind = RelationshipGraphNodeKind::Collapsed;
            node.collapsed_kind = Some(collapsed_kind);
            node.collapsed_count = 1;
        }
    }
    node
}

fn node_kind_key(kind: RelationshipGraphNodeKind) -> &'static str {
    match kind {
        RelationshipGraphNodeKind::Source => "source",
        RelationshipGraphNodeKind::Agent => "agent",
        RelationshipGraphNodeKind::Project => "project",
        RelationshipGraphNodeKind::Directory => "directory",
        RelationshipGraphNodeKind::Conflict => "conflict",
        RelationshipGraphNodeKind::Skill => "skill",
        RelationshipGraphNodeKind::Collapsed => "collapsed",
    }
}

fn node_sort_key(node: &SkillRelationshipNode, center_skill_id: SkillId) -> (u8, bool, &str) {
    let kind_order = match node.kind {
        RelationshipGraphNodeKind::Skill => 0,
        RelationshipGraphNodeKind::Source => 1,
        RelationshipGraphNodeKind::Agent => 2,
        RelationshipGraphNodeKind::Project => 3,
        RelationshipGraphNodeKind::Directory => 4,
        RelationshipGraphNodeKind::Conflict => 5,
        RelationshipGraphNodeKind::Collapsed => 6,
    };
    (
        kind_order,
        node.skill_id != Some(center_skill_id),
        node.node_id.as_str(),
    )
}

struct FactEdgeInput {
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
    relationship_kind: Option<RelationshipKind>,
    relationship: Option<RelationshipType>,
    relation_id: Option<String>,
    provenance_id: Option<String>,
    conflict_id: Option<String>,
    match_state: Option<ObservedMatchState>,
    active: Option<bool>,
    last_verified_at: Option<i64>,
}

fn fact_edge(input: FactEdgeInput) -> SkillRelationshipEdge {
    SkillRelationshipEdge {
        edge_id: input.edge_id,
        from_node_id: input.from_node_id,
        to_node_id: input.to_node_id,
        kind: input.kind,
        relationship_kind: input.relationship_kind,
        relationship: input.relationship,
        relation_id: input.relation_id,
        provenance_id: input.provenance_id,
        conflict_id: input.conflict_id,
        match_state: input.match_state,
        active: input.active,
        last_verified_at: input.last_verified_at,
        governance: None,
        target_identity: None,
        evidence_relation_ids: Vec::new(),
    }
}

fn authoritative_fact_edge(
    input: FactEdgeInput,
    row: &RelationGovernanceRow,
) -> SkillRelationshipEdge {
    let mut edge = fact_edge(input);
    edge.governance = Some(row.governance.clone());
    edge.target_identity = row.target_identity.clone();
    edge.evidence_relation_ids = row.evidence_relation_ids.clone();
    edge
}

fn source_copy_match_state(health: super::SourceCopyHealth) -> ObservedMatchState {
    match health {
        super::SourceCopyHealth::Normal => ObservedMatchState::ContentVerified,
        super::SourceCopyHealth::ContentChanged | super::SourceCopyHealth::OperationFailed => {
            ObservedMatchState::Diverged
        }
        super::SourceCopyHealth::NeedsValidation
        | super::SourceCopyHealth::PermissionLimited
        | super::SourceCopyHealth::ManagedOccupied => ObservedMatchState::NameOnly,
    }
}

fn usage_target_node(
    usage: &UsageRelationView,
    graph: &mut SkillRelationshipGraph,
    collapsed_context_node_ids: &mut HashSet<(RelationshipGraphNodeKind, String)>,
    directory_facts: &BTreeMap<&str, &DirectoryNodeFact>,
) -> Option<(RelationshipGraphEdgeKind, String)> {
    match usage.target.kind {
        RelationGovernanceTargetKind::Agent => {
            let agent_client_id = usage.target.agent_client_id.as_deref()?;
            let node_id = ensure_context_node(
                graph,
                collapsed_context_node_ids,
                RelationshipGraphNodeKind::Agent,
                format!("agent:{agent_client_id}"),
                ContextData::Agent {
                    agent_client_id: agent_client_id.to_owned(),
                },
            );
            Some((RelationshipGraphEdgeKind::Deployment, node_id))
        }
        RelationGovernanceTargetKind::SharedDirectory | RelationGovernanceTargetKind::Project => {
            let directory_id = usage.target.directory_id.as_deref()?;
            let node_id = ensure_directory_node(
                graph,
                collapsed_context_node_ids,
                directory_id,
                directory_facts,
            );
            let kind = if usage.target.kind == RelationGovernanceTargetKind::SharedDirectory {
                RelationshipGraphEdgeKind::Shared
            } else {
                RelationshipGraphEdgeKind::LocatedIn
            };
            Some((kind, node_id))
        }
    }
}

fn usage_match_state(
    usage: &UsageRelationView,
    deployments: &[DeploymentRelationFact],
) -> ObservedMatchState {
    if let Some(state) = usage.evidence_relation_ids.iter().find_map(|id| {
        deployments
            .iter()
            .find(|relation| relation.relation_id == *id)
            .map(|relation| relation.match_state)
    }) {
        return state;
    }
    if usage.health_reasons.iter().any(|reason| {
        matches!(
            reason,
            super::UsageHealthReason::ContentChanged
                | super::UsageHealthReason::NeedsSync
                | super::UsageHealthReason::SyncFailed
                | super::UsageHealthReason::FileMissing
                | super::UsageHealthReason::LinkAbnormal
        )
    }) {
        ObservedMatchState::Diverged
    } else if usage.health_reasons.iter().any(|reason| {
        matches!(
            reason,
            super::UsageHealthReason::UnableToVerify | super::UsageHealthReason::UserConfirmation
        )
    }) {
        ObservedMatchState::NameOnly
    } else {
        ObservedMatchState::ContentVerified
    }
}

fn append_directory_recognition_edges(
    graph: &mut SkillRelationshipGraph,
    collapsed_context_node_ids: &mut HashSet<(RelationshipGraphNodeKind, String)>,
    expanded_shared_directories: &mut HashSet<String>,
    directory_id: &str,
    directory_node_id: &str,
    directory_capabilities: &[AgentDirectoryCapabilityFact],
    filters: &RelationshipGraphFilters,
) {
    if !relationship_kind_visible(RelationshipKind::DirectoryRecognition, filters)
        || !expanded_shared_directories.insert(directory_id.to_owned())
    {
        return;
    }
    let mut capabilities = directory_capabilities
        .iter()
        .filter(|capability| {
            capability.directory_node_id == directory_id
                && capability.recognition == DirectoryRecognition::Supported
        })
        .collect::<Vec<_>>();
    capabilities.sort_by(|left, right| left.agent_client_id.cmp(&right.agent_client_id));
    for capability in capabilities {
        let agent_node_id = ensure_context_node(
            graph,
            collapsed_context_node_ids,
            RelationshipGraphNodeKind::Agent,
            format!("agent:{}", capability.agent_client_id),
            ContextData::Agent {
                agent_client_id: capability.agent_client_id.clone(),
            },
        );
        graph.edges.push(structural_edge_with_relationship(
            format!(
                "directory-capability:{}:{}",
                directory_id, capability.agent_client_id
            ),
            directory_node_id.to_owned(),
            agent_node_id,
            RelationshipGraphEdgeKind::Shared,
            RelationshipKind::DirectoryRecognition,
        ));
    }
}

fn source_locator_key(source: &SourceDescriptor) -> String {
    let locator = match &source.locator {
        SourceLocator::LocalPath(path) => {
            format!("local:{}", path.to_string_lossy().replace('\\', "/"))
        }
        SourceLocator::HttpsUrl(url) => format!("https:{url}"),
        SourceLocator::GitUrl(url) => format!("git:{url}"),
    };
    format!("{:?}:{locator}", source.kind)
}

fn source_display_path(source: &SourceDescriptor) -> Option<String> {
    match &source.locator {
        SourceLocator::LocalPath(path) => Some(path.to_string_lossy().into_owned()),
        SourceLocator::HttpsUrl(url) | SourceLocator::GitUrl(url) => Some(url.clone()),
    }
}

fn ensure_source_node(
    graph: &mut SkillRelationshipGraph,
    collapsed_context_node_ids: &mut HashSet<(RelationshipGraphNodeKind, String)>,
    source: &SourceDescriptor,
    explicit_path: Option<&str>,
) -> String {
    let path = explicit_path
        .map(str::to_owned)
        .or_else(|| source_display_path(source));
    ensure_context_node(
        graph,
        collapsed_context_node_ids,
        RelationshipGraphNodeKind::Source,
        format!("source:locator:{}", source_locator_key(source)),
        ContextData::Source {
            provenance_id: None,
            source: source.clone(),
            path,
        },
    )
}

fn structural_edge(
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
) -> SkillRelationshipEdge {
    fact_edge(FactEdgeInput {
        edge_id,
        from_node_id,
        to_node_id,
        kind,
        relationship_kind: None,
        relationship: None,
        relation_id: None,
        provenance_id: None,
        conflict_id: None,
        match_state: None,
        active: None,
        last_verified_at: None,
    })
}

fn structural_edge_with_relationship(
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
    relationship_kind: RelationshipKind,
) -> SkillRelationshipEdge {
    fact_edge(FactEdgeInput {
        edge_id,
        from_node_id,
        to_node_id,
        kind,
        relationship_kind: Some(relationship_kind),
        relationship: None,
        relation_id: None,
        provenance_id: None,
        conflict_id: None,
        match_state: None,
        active: None,
        last_verified_at: None,
    })
}

fn structural_fact_edge(
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
    relationship: Option<RelationshipType>,
    provenance_id: Option<String>,
) -> SkillRelationshipEdge {
    fact_edge(FactEdgeInput {
        edge_id,
        from_node_id,
        to_node_id,
        kind,
        relationship_kind: None,
        relationship,
        relation_id: None,
        provenance_id,
        conflict_id: None,
        match_state: None,
        active: None,
        last_verified_at: None,
    })
}

fn structural_conflict_edge(
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
    conflict_id: String,
) -> SkillRelationshipEdge {
    fact_edge(FactEdgeInput {
        edge_id,
        from_node_id,
        to_node_id,
        kind,
        relationship_kind: None,
        relationship: None,
        relation_id: None,
        provenance_id: None,
        conflict_id: Some(conflict_id),
        match_state: None,
        active: None,
        last_verified_at: None,
    })
}

fn fact_visible(
    relationship_kind: RelationshipKind,
    match_state: Option<ObservedMatchState>,
    active: Option<bool>,
    filters: &RelationshipGraphFilters,
) -> bool {
    let relationship_visible = relationship_kind_visible(relationship_kind, filters);
    let status_visible = filters.statuses.is_empty()
        || filters.statuses.iter().any(|status| match status {
            RelationshipGraphStatus::Active => active == Some(true),
            RelationshipGraphStatus::Released => active == Some(false),
            RelationshipGraphStatus::ContentVerified => {
                match_state == Some(ObservedMatchState::ContentVerified)
            }
            RelationshipGraphStatus::NameOnly => match_state == Some(ObservedMatchState::NameOnly),
            RelationshipGraphStatus::Diverged => match_state == Some(ObservedMatchState::Diverged),
        });
    relationship_visible && status_visible
}

fn source_visible(relationship_kind: RelationshipKind, filters: &RelationshipGraphFilters) -> bool {
    relationship_kind_visible(relationship_kind, filters)
}

fn relationship_kind_visible(
    relationship_kind: RelationshipKind,
    filters: &RelationshipGraphFilters,
) -> bool {
    filters.relationship_kinds.is_empty() || filters.relationship_kinds.contains(&relationship_kind)
}
