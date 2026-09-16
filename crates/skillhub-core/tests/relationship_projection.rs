use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    project_skill_relationship_graph, ConflictCaseFact, ConflictClassification, ConflictEvidence,
    ConflictKind, DeploymentRelationFact, FileRepresentation, RelationshipGraphFilters,
    RelationshipType, SourceRelationFact,
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
        source: SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path(path),
        ),
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

#[test]
fn projects_one_center_and_one_hop_skill_context_without_reverse_traversal() {
    let center = SkillId::new();
    let related = SkillId::new();
    let unrelated = SkillId::new();
    let deployments = vec![
        deployment("center:agent", Some(center), "agent.center", "center", RelationshipType::ManagedLink),
        deployment("related:agent", Some(related), "agent.related", "related", RelationshipType::ObservedCopy),
        deployment("unrelated:agent", Some(unrelated), "agent.center", "unrelated", RelationshipType::ObservedCopy),
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
