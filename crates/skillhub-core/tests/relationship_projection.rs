use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    project_skill_relationship_graph, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, DeploymentRelationFact, DirectoryNodeFact, DirectoryRole, FileRepresentation,
    RelationshipGraphEdgeKind, RelationshipGraphFilters, RelationshipGraphNodeKind,
    RelationshipGraphStatus, RelationshipType, SourceRelationFact,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::SkillId;

fn deployment(
    relation_id: &str,
    skill_id: Option<SkillId>,
    agent: &str,
    path: &str,
    relationship: RelationshipType,
) -> DeploymentRelationFact {
    DeploymentRelationFact {
        relation_id: relation_id.into(),
        skill_id,
        agent_client_id: agent.into(),
        path: path.into(),
        path_key: path.into(),
        directory_node_id: Some(format!("directory:{agent}")),
        relationship,
        file_representation: FileRepresentation::Copy,
        ownership: skillhub_core::OwnershipState::ObservedUnmanaged,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: format!("sha256:{relation_id}"),
        origin: ObservedOrigin::Scan,
        match_state: ObservedMatchState::ContentVerified,
        active: true,
        observed_at: 10,
        released_at: None,
    }
}

fn source(provenance_id: &str, skill_id: SkillId, path: &str) -> SourceRelationFact {
    SourceRelationFact {
        provenance_id: provenance_id.into(),
        skill_id,
        directory_node_id: Some("directory:source".into()),
        agent_client_id: Some("source.agent".into()),
        source_path: path.into(),
        source_path_key: path.into(),
        relationship: RelationshipType::ImportCopy,
        file_representation: FileRepresentation::Directory,
        ownership: skillhub_core::OwnershipState::ObservedUnmanaged,
        link_target_path: None,
        link_target_directory_id: None,
        content_fingerprint: format!("sha256:{provenance_id}"),
        source: SourceDescriptor::new(SourceKind::Local, SourceLocator::local_path(path)),
        imported_at: 20,
    }
}

fn uncertain_case(center: SkillId, related: SkillId) -> ConflictCaseFact {
    ConflictCaseFact {
        conflict_id: "conflict:uncertain".into(),
        kind: ConflictKind::SameNameDifferentContent,
        classification: ConflictClassification::Uncertain,
        member_skill_ids: vec![center, related],
        members: Vec::new(),
        evidence: ConflictEvidence::default(),
        user_decision: None,
        decided_at: None,
    }
}

fn directory(node_id: &str, role: DirectoryRole) -> DirectoryNodeFact {
    DirectoryNodeFact {
        node_id: node_id.into(),
        path: format!("C:/{node_id}"),
        path_key: node_id.into(),
        role,
        profile_id: Some("profile".into()),
        agent_client_id: Some("agent.center".into()),
        exists: true,
        observed_at: 11,
        scan_source: Some("test".into()),
    }
}

#[test]
fn projects_one_center_and_one_hop_skill_context_without_reverse_traversal() {
    let center = SkillId::new();
    let related = SkillId::new();
    let unrelated = SkillId::new();
    let deployments = vec![
        deployment(
            "center:agent",
            Some(center),
            "agent.center",
            "center",
            RelationshipType::ManagedLink,
        ),
        deployment(
            "related:agent",
            Some(related),
            "agent.related",
            "related",
            RelationshipType::ObservedCopy,
        ),
        deployment(
            "unrelated:agent",
            Some(unrelated),
            "agent.center",
            "unrelated",
            RelationshipType::ObservedCopy,
        ),
    ];
    let sources = vec![source("source:center", center, "center-source")];

    let graph = project_skill_relationship_graph(
        center,
        &deployments,
        &sources,
        &[],
        &[],
        &[uncertain_case(center, related)],
        &RelationshipGraphFilters::default(),
    );

    assert!(graph.has_node(&center.to_string()));
    assert!(graph.has_skill_node(&related));
    assert!(!graph.has_skill_node(&unrelated));
    assert!(graph.has_node("agent:agent.center"));
    assert!(graph.has_node("agent:agent.related"));
    assert!(graph.has_node("source:source:center"));
    assert!(graph.has_node("conflict:conflict:uncertain"));
    assert!(!graph.has_node("agent:agent.unrelated"));
}

#[test]
fn only_unconfirmed_conflicts_are_projected_and_filters_only_hide_edges() {
    let center = SkillId::new();
    let related = SkillId::new();
    let mut resolved = uncertain_case(center, related);
    resolved.conflict_id = "conflict:resolved".into();
    resolved.user_decision = Some(ConflictClassification::DistinctSkill);

    let deployments = vec![deployment(
        "center:deployment",
        Some(center),
        "agent.center",
        "center",
        RelationshipType::ManagedLink,
    )];
    let graph = project_skill_relationship_graph(
        center,
        &deployments,
        &[],
        &[],
        &[],
        &[resolved],
        &RelationshipGraphFilters {
            relationship_types: vec![RelationshipType::ImportCopy],
            statuses: Vec::new(),
        },
    );

    assert!(!graph.has_node("conflict:conflict:resolved"));
    assert!(graph.has_node(&center.to_string()));
    assert_eq!(graph.edges.len(), 0);
    assert_eq!(graph.fact_counts.deployment_relations, 1);
}

#[test]
fn directory_facts_choose_project_or_directory_context_kind() {
    let center = SkillId::new();
    let mut project_relation = deployment(
        "project:deployment",
        Some(center),
        "agent.center",
        "project-entry",
        RelationshipType::ManagedCopy,
    );
    project_relation.directory_node_id = Some("directory:project".into());
    let mut agent_relation = deployment(
        "agent:deployment",
        Some(center),
        "agent.center",
        "agent-entry",
        RelationshipType::ObservedCopy,
    );
    agent_relation.directory_node_id = Some("directory:agent".into());

    let graph = project_skill_relationship_graph(
        center,
        &[project_relation, agent_relation],
        &[],
        &[
            directory("directory:project", DirectoryRole::Project),
            directory("directory:agent", DirectoryRole::AgentNative),
        ],
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );

    assert_eq!(
        graph
            .nodes
            .iter()
            .find(|node| node.directory_node_id.as_deref() == Some("directory:project"))
            .map(|node| node.kind),
        Some(RelationshipGraphNodeKind::Project)
    );
    assert_eq!(
        graph
            .nodes
            .iter()
            .find(|node| node.directory_node_id.as_deref() == Some("directory:agent"))
            .map(|node| node.kind),
        Some(RelationshipGraphNodeKind::Directory)
    );
}

#[test]
fn folded_contexts_use_collapsed_nodes_and_never_leave_dangling_edges() {
    let center = SkillId::new();
    let deployments = (0..9)
        .map(|index| {
            deployment(
                &format!("deployment:{index}"),
                Some(center),
                &format!("agent.{index}"),
                &format!("entry:{index}"),
                RelationshipType::ObservedCopy,
            )
        })
        .collect::<Vec<_>>();
    let graph = project_skill_relationship_graph(
        center,
        &deployments,
        &[],
        &[],
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );

    let collapsed = graph
        .nodes
        .iter()
        .find(|node| {
            node.kind == RelationshipGraphNodeKind::Collapsed
                && node.collapsed_kind == Some(RelationshipGraphNodeKind::Agent)
        })
        .expect("agent overflow is represented by a collapsed node");
    assert_eq!(collapsed.collapsed_count, 1);
    assert!(graph.collapsed_count >= 1);
    for edge in &graph.edges {
        assert!(
            graph.has_node(&edge.from_node_id),
            "missing edge source: {edge:?}"
        );
        assert!(
            graph.has_node(&edge.to_node_id),
            "missing edge target: {edge:?}"
        );
    }
}

#[test]
fn projection_order_is_stable_when_fact_inputs_are_reversed() {
    let center = SkillId::new();
    let mut deployments = vec![
        deployment(
            "deployment:b",
            Some(center),
            "agent.b",
            "b",
            RelationshipType::ObservedCopy,
        ),
        deployment(
            "deployment:a",
            Some(center),
            "agent.a",
            "a",
            RelationshipType::ManagedLink,
        ),
    ];
    let first = project_skill_relationship_graph(
        center,
        &deployments,
        &[],
        &[],
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );
    deployments.reverse();
    let second = project_skill_relationship_graph(
        center,
        &deployments,
        &[],
        &[],
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );
    assert_eq!(first.nodes, second.nodes);
    assert_eq!(first.edges, second.edges);
}

#[test]
fn shared_context_nodes_do_not_copy_relationship_fact_fields() {
    let center = SkillId::new();
    let graph = project_skill_relationship_graph(
        center,
        &[deployment(
            "deployment:shared",
            Some(center),
            "agent.shared",
            "shared",
            RelationshipType::ObservedCopy,
        )],
        &[],
        &[],
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );
    let agent = graph.has_node("agent:agent.shared").then(|| {
        graph
            .nodes
            .iter()
            .find(|node| node.node_id == "agent:agent.shared")
            .unwrap()
    });
    let agent = agent.expect("agent context");
    assert_eq!(agent.relationship, None);
    assert_eq!(agent.match_state, None);
    assert_eq!(agent.active, None);
    assert_eq!(agent.last_verified_at, None);
}

#[test]
fn source_facts_do_not_claim_verification_from_import_time() {
    let center = SkillId::new();
    let graph = project_skill_relationship_graph(
        center,
        &[],
        &[source("provenance:unknown", center, "unknown-source")],
        &[],
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );
    let source_node = graph
        .nodes
        .iter()
        .find(|node| node.kind == RelationshipGraphNodeKind::Source)
        .expect("source node");
    assert_eq!(source_node.match_state, None);
    assert_eq!(source_node.active, None);
    assert_eq!(source_node.last_verified_at, None);
    assert_eq!(graph.last_verified_at, None);
    let source_edge = graph
        .edges
        .iter()
        .find(|edge| edge.kind == RelationshipGraphEdgeKind::Source)
        .expect("source edge");
    assert_eq!(source_edge.match_state, None);
    assert_eq!(source_edge.active, None);
    assert_eq!(source_edge.last_verified_at, None);
}

#[test]
fn fact_filters_keep_structural_skill_and_conflict_edges() {
    let center = SkillId::new();
    let related = SkillId::new();
    let graph = project_skill_relationship_graph(
        center,
        &[deployment(
            "deployment:hidden",
            Some(center),
            "agent.hidden",
            "hidden",
            RelationshipType::ManagedLink,
        )],
        &[],
        &[],
        &[],
        &[uncertain_case(center, related)],
        &RelationshipGraphFilters {
            relationship_types: vec![RelationshipType::ImportCopy],
            statuses: vec![RelationshipGraphStatus::Diverged],
        },
    );

    assert!(graph.has_skill_node(&related));
    assert!(graph
        .edges
        .iter()
        .any(|edge| edge.kind == RelationshipGraphEdgeKind::RelatedSkill));
    assert!(graph
        .edges
        .iter()
        .any(|edge| edge.kind == RelationshipGraphEdgeKind::Conflict));
    assert!(!graph
        .edges
        .iter()
        .any(|edge| edge.kind == RelationshipGraphEdgeKind::Deployment));
    assert!(graph
        .edges
        .iter()
        .filter(|edge| {
            matches!(
                edge.kind,
                RelationshipGraphEdgeKind::RelatedSkill | RelationshipGraphEdgeKind::Conflict
            )
        })
        .all(|edge| edge.relationship.is_none()
            && edge.match_state.is_none()
            && edge.active.is_none()));
}
