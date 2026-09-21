use skillhub_core::agent::DirectoryPrecedence;
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    project_skill_relationship_graph, AgentDirectoryCapabilityFact, ConflictCaseFact,
    ConflictClassification, ConflictEvidence, ConflictKind, DeploymentRelationFact,
    DirectoryNodeFact, DirectoryRecognition, DirectoryRole, FileRepresentation,
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
fn repeated_overflow_context_counts_one_hidden_node_and_keeps_all_edges() {
    let center = SkillId::new();
    let mut deployments = (0..8)
        .map(|index| {
            let mut relation = deployment(
                &format!("deployment:{index}"),
                Some(center),
                &format!("agent.{index}"),
                &format!("entry:{index}"),
                RelationshipType::ObservedCopy,
            );
            relation.directory_node_id = None;
            relation
        })
        .collect::<Vec<_>>();
    for relation_id in ["deployment:overflow:first", "deployment:overflow:repeat"] {
        let mut relation = deployment(
            relation_id,
            Some(center),
            "agent.overflow",
            "overflow-entry",
            RelationshipType::ObservedCopy,
        );
        relation.directory_node_id = None;
        deployments.push(relation);
    }

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
        .expect("agent overflow is collapsed");
    assert_eq!(collapsed.collapsed_count, 1);
    assert_eq!(graph.collapsed_count, 1);
    assert_eq!(
        graph
            .edges
            .iter()
            .filter(|edge| edge.to_node_id == collapsed.node_id)
            .count(),
        2
    );
    assert!(graph
        .edges
        .iter()
        .all(|edge| graph.has_node(&edge.from_node_id) && graph.has_node(&edge.to_node_id)));
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
fn source_relationship_filter_applies_but_unknown_status_does_not_hide_source() {
    let center = SkillId::new();
    let source_fact = source("provenance:filter", center, "source-filter");
    let status_filtered = project_skill_relationship_graph(
        center,
        &[],
        std::slice::from_ref(&source_fact),
        &[],
        &[],
        &[],
        &RelationshipGraphFilters {
            relationship_types: Vec::new(),
            statuses: vec![RelationshipGraphStatus::Diverged],
        },
    );
    assert!(status_filtered.has_node("source:provenance:filter"));
    assert!(status_filtered
        .edges
        .iter()
        .any(|edge| edge.kind == RelationshipGraphEdgeKind::Source));

    let relationship_filtered = project_skill_relationship_graph(
        center,
        &[],
        &[source_fact],
        &[],
        &[],
        &[],
        &RelationshipGraphFilters {
            relationship_types: vec![RelationshipType::ObservedCopy],
            statuses: Vec::new(),
        },
    );
    assert!(!relationship_filtered.has_node("source:provenance:filter"));
    assert!(!relationship_filtered
        .edges
        .iter()
        .any(|edge| edge.kind == RelationshipGraphEdgeKind::Source));
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
    assert!(graph
        .edges
        .iter()
        .filter(|edge| edge.kind == RelationshipGraphEdgeKind::Conflict)
        .all(|edge| edge.conflict_id.as_deref() == Some("conflict:uncertain")));
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

#[test]
fn every_context_kind_collapses_without_dangling_edges() {
    let center = SkillId::new();

    let sources = (0..9)
        .map(|index| {
            source(
                &format!("provenance:{index}"),
                center,
                &format!("source:{index}"),
            )
        })
        .collect::<Vec<_>>();
    let source_graph = project_skill_relationship_graph(
        center,
        &[],
        &sources,
        &[],
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );

    let project_relations = (0..9)
        .map(|index| {
            let mut relation = deployment(
                &format!("project:{index}"),
                Some(center),
                "agent.project",
                &format!("project-entry:{index}"),
                RelationshipType::ObservedCopy,
            );
            relation.directory_node_id = Some(format!("project:{index}"));
            relation
        })
        .collect::<Vec<_>>();
    let project_facts = (0..9)
        .map(|index| directory(&format!("project:{index}"), DirectoryRole::Project))
        .collect::<Vec<_>>();
    let project_graph = project_skill_relationship_graph(
        center,
        &project_relations,
        &[],
        &project_facts,
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );

    let directory_relations = (0..9)
        .map(|index| {
            let mut relation = deployment(
                &format!("directory:{index}"),
                Some(center),
                "agent.directory",
                &format!("directory-entry:{index}"),
                RelationshipType::ObservedCopy,
            );
            relation.directory_node_id = Some(format!("directory:{index}"));
            relation
        })
        .collect::<Vec<_>>();
    let directory_facts = (0..9)
        .map(|index| directory(&format!("directory:{index}"), DirectoryRole::AgentNative))
        .collect::<Vec<_>>();
    let directory_graph = project_skill_relationship_graph(
        center,
        &directory_relations,
        &[],
        &directory_facts,
        &[],
        &[],
        &RelationshipGraphFilters::default(),
    );

    let conflicts = (0..9)
        .map(|index| {
            let related = SkillId::new();
            let mut case = uncertain_case(center, related);
            case.conflict_id = format!("conflict:{index}");
            case
        })
        .collect::<Vec<_>>();
    let conflict_graph = project_skill_relationship_graph(
        center,
        &[],
        &[],
        &[],
        &[],
        &conflicts,
        &RelationshipGraphFilters::default(),
    );

    for (graph, kind) in [
        (source_graph, RelationshipGraphNodeKind::Source),
        (project_graph, RelationshipGraphNodeKind::Project),
        (directory_graph, RelationshipGraphNodeKind::Directory),
        (conflict_graph, RelationshipGraphNodeKind::Conflict),
    ] {
        assert!(graph.nodes.iter().any(|node| {
            node.kind == RelationshipGraphNodeKind::Collapsed && node.collapsed_kind == Some(kind)
        }));
        assert!(graph
            .edges
            .iter()
            .all(|edge| graph.has_node(&edge.from_node_id) && graph.has_node(&edge.to_node_id)));
    }
}

#[test]
fn project_and_capability_contexts_do_not_reverse_expand_skills() {
    let center = SkillId::new();
    let unrelated = SkillId::new();
    let mut relation = deployment(
        "project:center",
        Some(center),
        "agent.project",
        "project-entry",
        RelationshipType::ObservedCopy,
    );
    relation.directory_node_id = Some("directory:project".into());
    let capability = AgentDirectoryCapabilityFact {
        agent_client_id: "agent.project".into(),
        directory_node_id: "directory:project".into(),
        recognition: DirectoryRecognition::Supported,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: Some(unrelated.to_string()),
        researched_at: None,
        applicable_platforms: vec!["windows".into()],
    };
    let graph = project_skill_relationship_graph(
        center,
        &[relation],
        &[],
        &[directory("directory:project", DirectoryRole::Project)],
        &[capability],
        &[],
        &RelationshipGraphFilters::default(),
    );
    assert!(graph.has_skill_node(&center));
    assert!(!graph.has_skill_node(&unrelated));
}

#[test]
fn shared_directory_deployments_expand_through_supported_agent_capabilities() {
    let center = SkillId::new();
    let mut relation = deployment(
        "shared:deployment",
        Some(center),
        "agent.codex",
        "shared-entry",
        RelationshipType::SharedDirectoryRead,
    );
    relation.directory_node_id = Some("directory:shared".into());
    let graph = project_skill_relationship_graph(
        center,
        &[relation],
        &[],
        &[directory("directory:shared", DirectoryRole::SharedDirectory)],
        &[
            AgentDirectoryCapabilityFact {
                agent_client_id: "agent.codex".into(),
                directory_node_id: "directory:shared".into(),
                recognition: DirectoryRecognition::Supported,
                precedence: DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec!["windows".into()],
            },
            AgentDirectoryCapabilityFact {
                agent_client_id: "agent.claude".into(),
                directory_node_id: "directory:shared".into(),
                recognition: DirectoryRecognition::Supported,
                precedence: DirectoryPrecedence::Preferred,
                evidence_reference: None,
                researched_at: None,
                applicable_platforms: vec!["windows".into()],
            },
        ],
        &[],
        &RelationshipGraphFilters::default(),
    );

    assert!(graph.has_node("directory:directory:shared"));
    assert!(graph.has_node("agent:agent.codex"));
    assert!(graph.has_node("agent:agent.claude"));
    assert!(graph.edges.iter().any(|edge| {
        edge.from_node_id == center.to_string()
            && edge.to_node_id == "directory:directory:shared"
            && edge.kind == RelationshipGraphEdgeKind::Shared
    }));
    assert!(graph.edges.iter().any(|edge| {
        edge.from_node_id == "directory:directory:shared"
            && edge.to_node_id == "agent:agent.codex"
            && edge.kind == RelationshipGraphEdgeKind::Shared
    }));
    assert!(graph.edges.iter().any(|edge| {
        edge.from_node_id == "directory:directory:shared"
            && edge.to_node_id == "agent:agent.claude"
            && edge.kind == RelationshipGraphEdgeKind::Shared
    }));
    assert!(!graph.edges.iter().any(|edge| {
        edge.from_node_id == center.to_string() && edge.kind == RelationshipGraphEdgeKind::Deployment
    }));
}

#[test]
fn reversed_source_and_conflict_inputs_have_stable_output_order() {
    let center = SkillId::new();
    let related_a = SkillId::new();
    let related_b = SkillId::new();
    let mut sources = vec![
        source("provenance:b", center, "source-b"),
        source("provenance:a", center, "source-a"),
    ];
    let mut conflicts = vec![
        uncertain_case(center, related_b),
        uncertain_case(center, related_a),
    ];
    conflicts[0].conflict_id = "conflict:b".into();
    conflicts[1].conflict_id = "conflict:a".into();

    let first = project_skill_relationship_graph(
        center,
        &[],
        &sources,
        &[],
        &[],
        &conflicts,
        &RelationshipGraphFilters::default(),
    );
    sources.reverse();
    conflicts.reverse();
    let second = project_skill_relationship_graph(
        center,
        &[],
        &sources,
        &[],
        &[],
        &conflicts,
        &RelationshipGraphFilters::default(),
    );
    assert_eq!(first.nodes, second.nodes);
    assert_eq!(first.edges, second.edges);
}
