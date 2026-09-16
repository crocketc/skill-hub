use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::deployment::ObservedMatchState;
use crate::source::SourceDescriptor;
use crate::SkillId;

use super::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification, DeploymentRelationFact,
    DirectoryNodeFact, DirectoryRole, RelationshipType, SourceRelationFact,
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
    pub relationship_types: Vec<RelationshipType>,
    #[serde(default)]
    pub statuses: Vec<RelationshipGraphStatus>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationshipGraphFactCounts {
    pub deployment_relations: u32,
    pub source_relations: u32,
    pub conflict_cases: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillRelationshipNode {
    pub node_id: String,
    pub kind: RelationshipGraphNodeKind,
    pub skill_id: Option<SkillId>,
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
    _directory_capabilities: &[AgentDirectoryCapabilityFact],
    conflict_cases: &[ConflictCaseFact],
    filters: &RelationshipGraphFilters,
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

    let mut skill_ids = vec![center_skill_id];
    let mut skill_id_set = HashSet::from([center_skill_id]);
    for case in &relevant_conflicts {
        for skill_id in conflict_skill_ids(case) {
            if skill_id_set.insert(skill_id) {
                skill_ids.push(skill_id);
            }
        }
    }
    skill_ids[1..].sort_by_key(|skill_id| skill_id.to_string());

    let fact_counts = RelationshipGraphFactCounts {
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
        nodes: skill_ids.iter().copied().map(skill_node).collect(),
        edges: Vec::new(),
        fact_counts,
        collapsed_count: 0,
        last_verified_at,
    };

    for skill_id in skill_ids
        .iter()
        .copied()
        .filter(|id| *id != center_skill_id)
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
        if !fact_visible(
            relation.relationship,
            Some(relation.match_state),
            Some(relation.active),
            filters,
        ) {
            continue;
        }
        let Some(skill_id) = relation.skill_id else {
            continue;
        };
        let skill_node_id = skill_id.to_string();
        let agent_node_id = ensure_context_node(
            &mut graph,
            RelationshipGraphNodeKind::Agent,
            format!("agent:{}", relation.agent_client_id),
            ContextData::Agent {
                agent_client_id: relation.agent_client_id.clone(),
            },
        );
        graph.edges.push(fact_edge(
            format!("deployment:{}", relation.relation_id),
            skill_node_id.clone(),
            agent_node_id,
            RelationshipGraphEdgeKind::Deployment,
            Some(relation.relationship),
            Some(relation.relation_id.clone()),
            None,
            None,
            Some(relation.match_state),
            Some(relation.active),
            Some(relation.observed_at),
        ));
        if let Some(directory_id) = &relation.directory_node_id {
            let directory_node_id =
                ensure_directory_node(&mut graph, directory_id, &directory_facts);
            graph.edges.push(fact_edge(
                format!("located:{}", relation.relation_id),
                skill_node_id.clone(),
                directory_node_id,
                RelationshipGraphEdgeKind::LocatedIn,
                Some(relation.relationship),
                Some(relation.relation_id.clone()),
                None,
                None,
                Some(relation.match_state),
                Some(relation.active),
                Some(relation.observed_at),
            ));
        }
        if let Some(directory_id) = &relation.link_target_directory_id {
            let directory_node_id =
                ensure_directory_node(&mut graph, directory_id, &directory_facts);
            graph.edges.push(fact_edge(
                format!("shared:{}", relation.relation_id),
                skill_node_id,
                directory_node_id,
                RelationshipGraphEdgeKind::Shared,
                Some(relation.relationship),
                Some(relation.relation_id.clone()),
                None,
                None,
                Some(relation.match_state),
                Some(relation.active),
                Some(relation.observed_at),
            ));
        }
    }

    let mut sorted_sources = source_relations
        .iter()
        .filter(|relation| skill_id_set.contains(&relation.skill_id))
        .collect::<Vec<_>>();
    sorted_sources.sort_by(|left, right| left.provenance_id.cmp(&right.provenance_id));
    for relation in sorted_sources {
        if !source_visible(relation.relationship, filters) {
            continue;
        }
        let skill_node_id = relation.skill_id.to_string();
        let source_node_id = ensure_context_node(
            &mut graph,
            RelationshipGraphNodeKind::Source,
            format!("source:{}", relation.provenance_id),
            ContextData::Source {
                provenance_id: relation.provenance_id.clone(),
                source: relation.source.clone(),
                path: relation.source_path.clone(),
            },
        );
        graph.edges.push(fact_edge(
            format!("source:{}:{}", relation.skill_id, relation.provenance_id),
            skill_node_id.clone(),
            source_node_id.clone(),
            RelationshipGraphEdgeKind::Source,
            Some(relation.relationship),
            None,
            Some(relation.provenance_id.clone()),
            None,
            None,
            None,
            None,
        ));
        if let Some(agent_client_id) = &relation.agent_client_id {
            let agent_node_id = ensure_context_node(
                &mut graph,
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
            let directory_node_id =
                ensure_directory_node(&mut graph, directory_id, &directory_facts);
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
            let directory_node_id =
                ensure_directory_node(&mut graph, directory_id, &directory_facts);
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

    for case in relevant_conflicts {
        let conflict_node_id = ensure_context_node(
            &mut graph,
            RelationshipGraphNodeKind::Conflict,
            format!("conflict:{}", case.conflict_id),
            ContextData::Conflict {
                conflict_id: case.conflict_id.clone(),
            },
        );
        for skill_id in conflict_skill_ids(case) {
            if skill_id_set.contains(&skill_id) {
                graph.edges.push(structural_edge(
                    format!("conflict:{}:{skill_id}", case.conflict_id),
                    skill_id.to_string(),
                    conflict_node_id.clone(),
                    RelationshipGraphEdgeKind::Conflict,
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
        provenance_id: String,
        source: SourceDescriptor,
        path: String,
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
            node.provenance_id = Some(provenance_id);
            node.source = Some(source);
            node.path = Some(path);
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

fn fact_edge(
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
    relationship: Option<RelationshipType>,
    relation_id: Option<String>,
    provenance_id: Option<String>,
    conflict_id: Option<String>,
    match_state: Option<ObservedMatchState>,
    active: Option<bool>,
    last_verified_at: Option<i64>,
) -> SkillRelationshipEdge {
    SkillRelationshipEdge {
        edge_id,
        from_node_id,
        to_node_id,
        kind,
        relationship,
        relation_id,
        provenance_id,
        conflict_id,
        match_state,
        active,
        last_verified_at,
    }
}

fn structural_edge(
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
) -> SkillRelationshipEdge {
    fact_edge(
        edge_id,
        from_node_id,
        to_node_id,
        kind,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
}

fn structural_fact_edge(
    edge_id: String,
    from_node_id: String,
    to_node_id: String,
    kind: RelationshipGraphEdgeKind,
    relationship: Option<RelationshipType>,
    provenance_id: Option<String>,
) -> SkillRelationshipEdge {
    fact_edge(
        edge_id,
        from_node_id,
        to_node_id,
        kind,
        relationship,
        None,
        provenance_id,
        None,
        None,
        None,
        None,
    )
}

fn fact_visible(
    relationship: RelationshipType,
    match_state: Option<ObservedMatchState>,
    active: Option<bool>,
    filters: &RelationshipGraphFilters,
) -> bool {
    let relationship_visible =
        filters.relationship_types.is_empty() || filters.relationship_types.contains(&relationship);
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

fn source_visible(relationship: RelationshipType, filters: &RelationshipGraphFilters) -> bool {
    (filters.relationship_types.is_empty() || filters.relationship_types.contains(&relationship))
        && filters.statuses.is_empty()
}
