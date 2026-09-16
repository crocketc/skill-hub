use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::deployment::ObservedMatchState;
use crate::source::SourceDescriptor;
use crate::SkillId;

use super::{
    AgentDirectoryCapabilityFact, ConflictCaseFact, ConflictClassification,
    DeploymentRelationFact, DirectoryNodeFact, RelationshipType, SourceRelationFact,
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
    pub relationship: Option<RelationshipType>,
    pub relation_id: Option<String>,
    pub provenance_id: Option<String>,
    pub conflict_id: Option<String>,
    pub match_state: Option<ObservedMatchState>,
    pub active: Option<bool>,
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
        self.nodes
            .iter()
            .any(|node| node.kind == RelationshipGraphNodeKind::Skill && node.skill_id == Some(*skill_id))
    }
}

pub fn project_skill_relationship_graph(
    center_skill_id: SkillId,
    deployments: &[DeploymentRelationFact],
    source_relations: &[SourceRelationFact],
    _directory_nodes: &[DirectoryNodeFact],
    _directory_capabilities: &[AgentDirectoryCapabilityFact],
    conflict_cases: &[ConflictCaseFact],
    filters: &RelationshipGraphFilters,
) -> SkillRelationshipGraph {
    let relevant_conflicts = conflict_cases
        .iter()
        .filter(|case| {
            case.classification == ConflictClassification::Uncertain
                && case.user_decision.is_none()
                && conflict_skill_ids(case).contains(&center_skill_id)
        })
        .collect::<Vec<_>>();
    let mut skill_ids = HashSet::from([center_skill_id]);
    for case in &relevant_conflicts {
        skill_ids.extend(conflict_skill_ids(case));
    }

    let fact_counts = RelationshipGraphFactCounts {
        deployment_relations: deployments
            .iter()
            .filter(|relation| relation.skill_id.is_some_and(|id| skill_ids.contains(&id)))
            .count()
            .try_into()
            .unwrap_or(u32::MAX),
        source_relations: source_relations
            .iter()
            .filter(|relation| skill_ids.contains(&relation.skill_id))
            .count()
            .try_into()
            .unwrap_or(u32::MAX),
        conflict_cases: relevant_conflicts.len().try_into().unwrap_or(u32::MAX),
    };
    let last_verified_at = deployments
        .iter()
        .filter(|relation| relation.skill_id.is_some_and(|id| skill_ids.contains(&id)))
        .map(|relation| relation.observed_at)
        .chain(
            source_relations
                .iter()
                .filter(|relation| skill_ids.contains(&relation.skill_id))
                .map(|relation| relation.imported_at),
        )
        .max();

    let mut graph = SkillRelationshipGraph {
        center_skill_id,
        nodes: vec![skill_node(center_skill_id)],
        edges: Vec::new(),
        fact_counts,
        collapsed_count: 0,
        last_verified_at,
    };

    for skill_id in skill_ids.iter().copied().filter(|id| *id != center_skill_id) {
        graph.nodes.push(skill_node(skill_id));
        graph.edges.push(SkillRelationshipEdge {
            edge_id: format!("related:{center_skill_id}:{skill_id}"),
            from_node_id: center_skill_id.to_string(),
            to_node_id: skill_id.to_string(),
            kind: RelationshipGraphEdgeKind::RelatedSkill,
            relationship: None,
            relation_id: None,
            provenance_id: None,
            conflict_id: None,
            match_state: None,
            active: None,
        });
    }

    for relation in deployments
        .iter()
        .filter(|relation| relation.skill_id.is_some_and(|id| skill_ids.contains(&id)))
    {
        if !fact_visible(relation.relationship, relation.match_state, relation.active, filters) {
            continue;
        }
        let Some(skill_id) = relation.skill_id else {
            continue;
        };
        let skill_node_id = skill_id.to_string();
        add_context_node(
            &mut graph,
            RelationshipGraphNodeKind::Agent,
            format!("agent:{}", relation.agent_client_id),
            skill_id,
            relation.relationship,
            relation.match_state,
            relation.active,
            relation.observed_at,
            None,
        );
        graph.edges.push(edge(
            format!("deployment:{}", relation.relation_id),
            skill_node_id.clone(),
            format!("agent:{}", relation.agent_client_id),
            RelationshipGraphEdgeKind::Deployment,
            Some(relation.relationship),
            Some(relation.relation_id.clone()),
            None,
            None,
            Some(relation.match_state),
            Some(relation.active),
        ));
        if let Some(directory_id) = &relation.directory_node_id {
            add_context_node(
                &mut graph,
                RelationshipGraphNodeKind::Directory,
                format!("directory:{directory_id}"),
                skill_id,
                relation.relationship,
                relation.match_state,
                relation.active,
                relation.observed_at,
                Some(directory_id.clone()),
            );
            graph.edges.push(edge(
                format!("located:{}", relation.relation_id),
                skill_node_id,
                format!("directory:{directory_id}"),
                RelationshipGraphEdgeKind::LocatedIn,
                Some(relation.relationship),
                Some(relation.relation_id.clone()),
                None,
                None,
                Some(relation.match_state),
                Some(relation.active),
            ));
        }
    }

    for relation in source_relations
        .iter()
        .filter(|relation| skill_ids.contains(&relation.skill_id))
        .filter(|relation| fact_visible(relation.relationship, ObservedMatchState::ContentVerified, true, filters))
    {
        let skill_node_id = relation.skill_id.to_string();
        let source_node_id = format!("source:{}", relation.provenance_id);
        graph.nodes.push(SkillRelationshipNode {
            node_id: source_node_id.clone(),
            kind: RelationshipGraphNodeKind::Source,
            skill_id: Some(relation.skill_id),
            relation_id: None,
            provenance_id: Some(relation.provenance_id.clone()),
            conflict_id: None,
            agent_client_id: relation.agent_client_id.clone(),
            directory_node_id: relation.directory_node_id.clone(),
            relationship: Some(relation.relationship),
            match_state: Some(ObservedMatchState::ContentVerified),
            active: Some(true),
            source: Some(relation.source.clone()),
            collapsed_count: 0,
            last_verified_at: Some(relation.imported_at),
        });
        graph.edges.push(edge(
            format!("source:{}", relation.provenance_id),
            skill_node_id,
            source_node_id,
            RelationshipGraphEdgeKind::Source,
            Some(relation.relationship),
            None,
            Some(relation.provenance_id.clone()),
            None,
            Some(ObservedMatchState::ContentVerified),
            Some(true),
        ));
    }

    for case in relevant_conflicts {
        let conflict_node_id = format!("conflict:{}", case.conflict_id);
        graph.nodes.push(SkillRelationshipNode {
            node_id: conflict_node_id.clone(),
            kind: RelationshipGraphNodeKind::Conflict,
            skill_id: None,
            relation_id: None,
            provenance_id: None,
            conflict_id: Some(case.conflict_id.clone()),
            agent_client_id: None,
            directory_node_id: None,
            relationship: None,
            match_state: None,
            active: None,
            source: None,
            collapsed_count: 0,
            last_verified_at: case.decided_at,
        });
        for skill_id in conflict_skill_ids(case) {
            if skill_ids.contains(&skill_id) {
                graph.edges.push(edge(
                    format!("conflict:{}:{skill_id}", case.conflict_id),
                    skill_id.to_string(),
                    conflict_node_id.clone(),
                    RelationshipGraphEdgeKind::Conflict,
                    None,
                    None,
                    None,
                    Some(case.conflict_id.clone()),
                    None,
                    None,
                ));
            }
        }
    }

    graph
}

fn conflict_skill_ids(case: &ConflictCaseFact) -> HashSet<SkillId> {
    case.member_skill_ids
        .iter()
        .copied()
        .chain(case.members.iter().filter_map(|member| member.skill_id))
        .collect()
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
        relationship: None,
        match_state: None,
        active: None,
        source: None,
        collapsed_count: 0,
        last_verified_at: None,
    }
}

fn add_context_node(
    graph: &mut SkillRelationshipGraph,
    kind: RelationshipGraphNodeKind,
    node_id: String,
    skill_id: SkillId,
    relationship: RelationshipType,
    match_state: ObservedMatchState,
    active: bool,
    last_verified_at: i64,
    directory_node_id: Option<String>,
) {
    if graph.nodes.iter().any(|node| node.node_id == node_id) {
        return;
    }
    let kind_count = graph.nodes.iter().filter(|node| node.kind == kind).count();
    if kind_count >= MAX_CONTEXT_NODES_PER_KIND {
        graph.collapsed_count = graph.collapsed_count.saturating_add(1);
        return;
    }
    let agent_client_id = (kind == RelationshipGraphNodeKind::Agent)
        .then(|| node_id.trim_start_matches("agent:").to_owned());
    graph.nodes.push(SkillRelationshipNode {
        node_id,
        kind,
        skill_id: Some(skill_id),
        relation_id: None,
        provenance_id: None,
        conflict_id: None,
        agent_client_id,
        directory_node_id,
        relationship: Some(relationship),
        match_state: Some(match_state),
        active: Some(active),
        source: None,
        collapsed_count: 0,
        last_verified_at: Some(last_verified_at),
    });
}

#[allow(clippy::too_many_arguments)]
fn edge(
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
    }
}

fn fact_visible(
    relationship: RelationshipType,
    match_state: ObservedMatchState,
    active: bool,
    filters: &RelationshipGraphFilters,
) -> bool {
    let relationship_visible = filters.relationship_types.is_empty()
        || filters.relationship_types.contains(&relationship);
    let status_visible = filters.statuses.is_empty()
        || filters.statuses.iter().any(|status| match status {
            RelationshipGraphStatus::Active => active,
            RelationshipGraphStatus::Released => !active,
            RelationshipGraphStatus::ContentVerified => {
                match_state == ObservedMatchState::ContentVerified
            }
            RelationshipGraphStatus::NameOnly => match_state == ObservedMatchState::NameOnly,
            RelationshipGraphStatus::Diverged => match_state == ObservedMatchState::Diverged,
        });
    relationship_visible && status_visible
}
