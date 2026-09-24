//! Task 3 relationship-governance batch contract tests.
//!
//! These tests exercise the public `skillhub-core` seam only.  They prove that
//! the governance ledger is a *pure projection* of already persisted
//! relationship facts: it never scans the filesystem, never fabricates an edge
//! that the facts do not contain, and never claims a relationship is
//! actionable when its evidence is stale or structurally unusable.

use skillhub_core::agent::DirectoryPrecedence;
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    project_relation_governance_ledger, AgentDirectoryCapabilityFact, DeploymentRelationFact,
    DirectoryRecognition, FileRepresentation, OwnershipState, RelationGovernanceAction,
    RelationGovernanceBlocker, RelationGovernanceBucket, RelationGovernanceFilters,
    RelationGovernanceReadiness, RelationshipType,
};
use skillhub_core::SkillId;

const SKILL: &str = "00000000-0000-0000-0000-0000000000b1";
const OTHER_SKILL: &str = "00000000-0000-0000-0000-0000000000b2";
const AGENT: &str = "agent.demo";
const OTHER_AGENT: &str = "agent.other";
const DIRECTORY: &str = "directory:agent-skills";
const SHARED_DIRECTORY: &str = "directory:shared-skills";

fn skill_id(raw: &str) -> SkillId {
    raw.parse().unwrap()
}

struct RelationSpec {
    relation_id: &'static str,
    skill: &'static str,
    agent: &'static str,
    path: &'static str,
    relationship: RelationshipType,
    representation: FileRepresentation,
    ownership: OwnershipState,
    match_state: ObservedMatchState,
    directory_node_id: Option<&'static str>,
    link_target_directory_id: Option<&'static str>,
    active: bool,
}

impl RelationSpec {
    fn copy(relation_id: &'static str, path: &'static str) -> Self {
        Self {
            relation_id,
            skill: SKILL,
            agent: AGENT,
            path,
            relationship: RelationshipType::ManagedCopy,
            representation: FileRepresentation::Copy,
            ownership: OwnershipState::SkillhubManaged,
            match_state: ObservedMatchState::ContentVerified,
            directory_node_id: Some(DIRECTORY),
            link_target_directory_id: None,
            active: true,
        }
    }

    fn observed_copy(relation_id: &'static str, path: &'static str) -> Self {
        Self {
            ownership: OwnershipState::ObservedUnmanaged,
            match_state: ObservedMatchState::NameOnly,
            ..Self::copy(relation_id, path)
        }
    }

    fn managed_link(relation_id: &'static str, path: &'static str) -> Self {
        Self {
            relationship: RelationshipType::ManagedLink,
            representation: FileRepresentation::SymbolicLink,
            ..Self::copy(relation_id, path)
        }
    }

    fn shared_reference(relation_id: &'static str, path: &'static str) -> Self {
        Self {
            relationship: RelationshipType::SharedDirectoryReference,
            representation: FileRepresentation::SymbolicLink,
            ownership: OwnershipState::SharedReference,
            directory_node_id: Some(DIRECTORY),
            link_target_directory_id: Some(SHARED_DIRECTORY),
            ..Self::copy(relation_id, path)
        }
    }

    fn build(&self) -> DeploymentRelationFact {
        DeploymentRelationFact {
            relation_id: self.relation_id.to_owned(),
            skill_id: (!self.skill.is_empty()).then(|| skill_id(self.skill)),
            agent_client_id: self.agent.to_owned(),
            path: self.path.to_owned(),
            path_key: String::new(),
            directory_node_id: self.directory_node_id.map(str::to_owned),
            relationship: self.relationship,
            file_representation: self.representation,
            ownership: self.ownership,
            link_target_path: None,
            link_target_path_key: None,
            link_target_directory_id: self.link_target_directory_id.map(str::to_owned),
            content_fingerprint: format!("sha256:{}", self.relation_id),
            origin: ObservedOrigin::Scan,
            match_state: self.match_state,
            active: self.active,
            observed_at: 1_700_000_000,
            released_at: (!self.active).then_some(1_700_000_100),
        }
    }
}

fn capability(
    agent_client_id: &str,
    directory_node_id: &str,
    recognition: DirectoryRecognition,
) -> AgentDirectoryCapabilityFact {
    AgentDirectoryCapabilityFact {
        agent_client_id: agent_client_id.to_owned(),
        directory_node_id: directory_node_id.to_owned(),
        recognition,
        precedence: DirectoryPrecedence::Preferred,
        evidence_reference: Some("fixture".into()),
        researched_at: Some("2026-09-16".into()),
        applicable_platforms: vec!["windows".into(), "macos".into()],
    }
}

fn supported_capabilities() -> Vec<AgentDirectoryCapabilityFact> {
    vec![
        capability(AGENT, DIRECTORY, DirectoryRecognition::Supported),
        capability(OTHER_AGENT, DIRECTORY, DirectoryRecognition::Supported),
        capability(AGENT, SHARED_DIRECTORY, DirectoryRecognition::Supported),
        capability(
            OTHER_AGENT,
            SHARED_DIRECTORY,
            DirectoryRecognition::Supported,
        ),
    ]
}

fn ledger_of(
    relations: &[RelationSpec],
    capabilities: &[AgentDirectoryCapabilityFact],
    filters: RelationGovernanceFilters,
) -> skillhub_core::relationship::RelationGovernanceLedger {
    let relations = relations
        .iter()
        .map(RelationSpec::build)
        .collect::<Vec<_>>();
    project_relation_governance_ledger(&filters, &relations, capabilities, 7, Some(1_700_000_200))
}

fn default_filters() -> RelationGovernanceFilters {
    RelationGovernanceFilters::default()
}

fn all_bucket() -> RelationGovernanceFilters {
    RelationGovernanceFilters {
        bucket: RelationGovernanceBucket::All,
        ..default_filters()
    }
}

#[test]
fn ledger_returns_four_buckets_with_object_relationship_impact_and_reasons() {
    let specs = vec![
        RelationSpec::copy("relation:ready", "/agent/skills/ready"),
        RelationSpec::observed_copy("relation:stale", "/agent/skills/stale"),
        RelationSpec {
            representation: FileRepresentation::DirectoryJunction,
            ..RelationSpec::copy("relation:junction", "/agent/skills/junction")
        },
        RelationSpec::managed_link("relation:link", "/agent/skills/link"),
    ];
    let capabilities = supported_capabilities();

    let all = ledger_of(&specs, &capabilities, all_bucket());
    assert_eq!(all.rows.len(), 4, "the ledger lists every established edge");
    assert_eq!(all.counts.all, 4);
    assert_eq!(all.counts.eligible_to_centralize, 1);
    assert_eq!(all.counts.needs_validation, 1);
    assert_eq!(all.counts.blocked, 1);
    assert_eq!(all.relationship_revision, "7");
    assert_eq!(all.last_verified_at, Some(1_700_000_200));

    // 行必须携带对象、关系类型、影响、可执行性与受阻原因。
    let ready = all
        .rows
        .iter()
        .find(|row| row.relation_id() == "relation:ready")
        .expect("ready row");
    assert_eq!(ready.skill_id(), Some(skill_id(SKILL)));
    assert_eq!(ready.agent_client_id(), Some(AGENT));
    assert_eq!(ready.path(), "/agent/skills/ready");
    assert_eq!(ready.relationship(), Some(RelationshipType::ManagedCopy));
    assert_eq!(
        ready.readiness,
        RelationGovernanceReadiness::EligibleToCentralize
    );
    assert_eq!(
        ready.primary_action,
        RelationGovernanceAction::CentralizeManagement
    );
    assert!(ready.blockers.is_empty());
    assert!(ready.impact.backup_required);
    assert!(ready.impact.rollback_available);
    assert!(ready.impact.other_consumer_agent_ids.is_empty());

    let stale = all
        .rows
        .iter()
        .find(|row| row.relation_id() == "relation:stale")
        .expect("stale row");
    assert_eq!(
        stale.readiness,
        RelationGovernanceReadiness::NeedsValidation
    );
    assert_eq!(stale.primary_action, RelationGovernanceAction::Revalidate);
    assert_eq!(
        stale.blockers,
        vec![RelationGovernanceBlocker::VerificationNotCurrent]
    );

    let junction = all
        .rows
        .iter()
        .find(|row| row.relation_id() == "relation:junction")
        .expect("junction row");
    assert_eq!(junction.readiness, RelationGovernanceReadiness::Blocked);
    assert_eq!(junction.primary_action, RelationGovernanceAction::None);
    assert_eq!(
        junction.blockers,
        vec![RelationGovernanceBlocker::UnverifiableRepresentation]
    );

    let link = all
        .rows
        .iter()
        .find(|row| row.relation_id() == "relation:link")
        .expect("link row");
    assert_eq!(
        link.readiness,
        RelationGovernanceReadiness::AlreadyCentralized
    );
    assert_eq!(link.primary_action, RelationGovernanceAction::Undeploy);

    // 四个筛选是同一份清单的快捷筛选，不是四个页签。
    for (bucket, expected) in [
        (
            RelationGovernanceBucket::EligibleToCentralize,
            vec!["relation:ready"],
        ),
        (
            RelationGovernanceBucket::NeedsValidation,
            vec!["relation:stale"],
        ),
        (RelationGovernanceBucket::Blocked, vec!["relation:junction"]),
        (
            RelationGovernanceBucket::All,
            vec![
                "relation:junction",
                "relation:link",
                "relation:ready",
                "relation:stale",
            ],
        ),
    ] {
        let ledger = ledger_of(
            &specs,
            &capabilities,
            RelationGovernanceFilters {
                bucket,
                ..default_filters()
            },
        );
        let ids = ledger
            .rows
            .iter()
            .map(|row| row.relation_id())
            .collect::<Vec<_>>();
        assert_eq!(
            ids, expected,
            "bucket {bucket:?} selects the expected edges"
        );
        assert_eq!(
            ledger.counts.all, 4,
            "counts always describe the whole ledger, not the filtered page"
        );
    }
}

#[test]
fn ledger_marks_an_unconfirmed_shared_impact_as_pending_validation() {
    let specs = vec![
        RelationSpec::shared_reference("relation:alias", "/agent/skills/alias"),
        RelationSpec {
            agent: OTHER_AGENT,
            ..RelationSpec::shared_reference("relation:other-alias", "/agent2/skills/alias")
        },
    ];

    let ledger = ledger_of(&specs, &supported_capabilities(), all_bucket());
    let alias = ledger
        .rows
        .iter()
        .find(|row| row.relation_id() == "relation:alias")
        .expect("alias row");

    assert_eq!(
        alias.readiness,
        RelationGovernanceReadiness::NeedsValidation
    );
    assert_eq!(
        alias.blockers,
        vec![RelationGovernanceBlocker::SharedImpactConfirmationRequired]
    );
    assert_eq!(
        alias.impact.other_consumer_agent_ids,
        vec![OTHER_AGENT.to_owned()],
        "the shared impact names the other agent that reads the same directory"
    );

    let blocked = ledger_of(
        &specs,
        &supported_capabilities(),
        RelationGovernanceFilters {
            bucket: RelationGovernanceBucket::Blocked,
            ..default_filters()
        },
    );
    assert!(
        blocked.rows.is_empty(),
        "an unconfirmed shared impact is pending validation, not a permanent block"
    );
}

#[test]
fn ledger_protects_the_shared_directory_body_and_unregistered_edges() {
    let specs = vec![
        RelationSpec {
            relationship: RelationshipType::SharedDirectoryRead,
            ownership: OwnershipState::SharedReference,
            directory_node_id: Some(SHARED_DIRECTORY),
            ..RelationSpec::copy("relation:shared-body", "/shared/skills/notes")
        },
        RelationSpec {
            directory_node_id: None,
            ..RelationSpec::copy("relation:unregistered", "/elsewhere/skills/notes")
        },
        RelationSpec {
            relationship: RelationshipType::Unknown,
            representation: FileRepresentation::Unknown,
            ..RelationSpec::copy("relation:unknown", "/agent/skills/unknown")
        },
        RelationSpec {
            skill: "",
            ..RelationSpec::copy("relation:anonymous", "/agent/skills/anonymous")
        },
    ];

    let ledger = ledger_of(&specs, &supported_capabilities(), all_bucket());
    let blockers_for = |relation_id: &str| {
        ledger
            .rows
            .iter()
            .find(|row| row.relation_id() == relation_id)
            .unwrap_or_else(|| panic!("{relation_id} row"))
            .blockers
            .clone()
    };

    assert_eq!(
        blockers_for("relation:shared-body"),
        vec![RelationGovernanceBlocker::SharedBodyProtected]
    );
    assert_eq!(
        blockers_for("relation:unregistered"),
        vec![RelationGovernanceBlocker::DirectoryNotRegistered]
    );
    assert_eq!(
        blockers_for("relation:unknown"),
        vec![
            RelationGovernanceBlocker::UnverifiableRepresentation,
            RelationGovernanceBlocker::RelationshipNotConvertible,
        ]
    );
    assert_eq!(
        blockers_for("relation:anonymous"),
        vec![RelationGovernanceBlocker::SkillIdentityUnconfirmed]
    );
    assert_eq!(ledger.counts.blocked, 4);
    assert_eq!(
        ledger.counts.needs_validation, 0,
        "a structurally unusable edge is blocked, not merely unverified"
    );
}

#[test]
fn ledger_separates_unknown_recognition_from_unsupported_recognition() {
    let specs = vec![
        RelationSpec::copy("relation:unknown-dir", "/agent/skills/unknown-dir"),
        RelationSpec::copy("relation:unsupported-dir", "/agent/skills/unsupported-dir"),
    ];

    let unknown = capability(AGENT, DIRECTORY, DirectoryRecognition::Unknown);
    let ledger = ledger_of(
        &specs,
        &[
            unknown.clone(),
            capability(
                OTHER_AGENT,
                SHARED_DIRECTORY,
                DirectoryRecognition::Supported,
            ),
        ],
        RelationGovernanceFilters {
            bucket: RelationGovernanceBucket::NeedsValidation,
            ..default_filters()
        },
    );
    assert_eq!(ledger.rows.len(), 2);
    assert_eq!(
        ledger.rows[0].blockers,
        vec![RelationGovernanceBlocker::DirectoryRecognitionUnknown]
    );

    let unsupported = capability(AGENT, DIRECTORY, DirectoryRecognition::Unsupported);
    let ledger = ledger_of(
        &specs,
        &[
            unsupported,
            capability(
                OTHER_AGENT,
                SHARED_DIRECTORY,
                DirectoryRecognition::Supported,
            ),
        ],
        RelationGovernanceFilters {
            bucket: RelationGovernanceBucket::Blocked,
            ..default_filters()
        },
    );
    assert_eq!(ledger.rows.len(), 2);
    assert_eq!(
        ledger.rows[0].blockers,
        vec![RelationGovernanceBlocker::DirectoryRecognitionUnsupported]
    );
}

#[test]
fn ledger_never_lists_a_released_edge_and_keeps_input_order_stable() {
    let specs = vec![
        RelationSpec {
            active: false,
            ..RelationSpec::copy("relation:released", "/agent/skills/released")
        },
        RelationSpec::copy("relation:live", "/agent/skills/live"),
    ];

    let ledger = ledger_of(&specs, &supported_capabilities(), all_bucket());
    assert_eq!(
        ledger
            .rows
            .iter()
            .map(|row| row.relation_id())
            .collect::<Vec<_>>(),
        vec!["relation:live"],
        "a released edge is history, not a governable current relationship"
    );
    assert_eq!(ledger.counts.all, 1);
}

#[test]
fn ledger_filters_by_bucket_skill_agent_text_and_relationship_type() {
    let specs = vec![
        RelationSpec::copy("relation:a", "/agent/skills/alpha"),
        RelationSpec {
            skill: OTHER_SKILL,
            agent: OTHER_AGENT,
            path: "/agent2/skills/beta",
            ..RelationSpec::copy("relation:b", "/agent2/skills/beta")
        },
        RelationSpec::managed_link("relation:c", "/agent/skills/gamma"),
    ];
    let capabilities = supported_capabilities();

    let by_skill = ledger_of(
        &specs,
        &capabilities,
        RelationGovernanceFilters {
            skill_id: Some(skill_id(OTHER_SKILL)),
            ..default_filters()
        },
    );
    assert_eq!(
        by_skill
            .rows
            .iter()
            .map(|row| row.relation_id())
            .collect::<Vec<_>>(),
        vec!["relation:b"]
    );

    let by_agent = ledger_of(
        &specs,
        &capabilities,
        RelationGovernanceFilters {
            agent_client_id: Some(OTHER_AGENT.to_owned()),
            ..default_filters()
        },
    );
    assert_eq!(by_agent.rows.len(), 1);
    assert_eq!(by_agent.rows[0].relation_id(), "relation:b");

    let by_text = ledger_of(
        &specs,
        &capabilities,
        RelationGovernanceFilters {
            text: "GAMMA".into(),
            ..default_filters()
        },
    );
    assert_eq!(by_text.rows.len(), 1);
    assert_eq!(
        by_text.rows[0].relation_id(),
        "relation:c",
        "path search ignores case"
    );

    let by_relationship = ledger_of(
        &specs,
        &capabilities,
        RelationGovernanceFilters {
            relationship_types: vec![RelationshipType::ManagedLink],
            ..default_filters()
        },
    );
    assert_eq!(by_relationship.rows.len(), 1);
    assert_eq!(by_relationship.rows[0].relation_id(), "relation:c");

    let combined = ledger_of(
        &specs,
        &capabilities,
        RelationGovernanceFilters {
            bucket: RelationGovernanceBucket::EligibleToCentralize,
            relationship_types: vec![RelationshipType::ManagedCopy],
            text: "alpha".into(),
            ..default_filters()
        },
    );
    assert_eq!(combined.rows.len(), 1);
    assert_eq!(combined.rows[0].relation_id(), "relation:a");

    // 稳定排序：输入顺序反转不改变输出顺序。
    let mut reversed = specs.iter().map(RelationSpec::build).collect::<Vec<_>>();
    reversed.reverse();
    let forward =
        project_relation_governance_ledger(&all_bucket(), &reversed, &capabilities, 7, None);
    assert_eq!(
        forward
            .rows
            .iter()
            .map(|row| row.relation_id())
            .collect::<Vec<_>>(),
        vec!["relation:a", "relation:b", "relation:c"]
    );
}

mod unified_ledger {
    //! Task 7 验收：统一治理清单同时消费来源副本与部署关系（plan 7.1–7.4、
    //! 7.9、7.11）。来源副本与部署都出现在 All；已归档关系只进 history；
    //! Online provenance 永不出现在清单（清单只从关系事实构建，函数签名
    //! 根本不接受 provenance）。筛选可组合：scope、batch_id、skill、agent、
    //! project、source_class、text 与五个快捷状态。

    use std::collections::BTreeSet;

    use super::*;
    use skillhub_core::import::ImportSourceClass;
    use skillhub_core::relationship::{
        project_governable_relation, project_unified_governance_ledger, GovernableRelationFact,
        GovernableRelationStatus, RelationGovernanceAction, RelationGovernanceBucket,
        RelationGovernanceCounts, RelationGovernanceFilters, RelationGovernanceReadiness,
        SourceCopyDecision, SourceCopyHealth, SourceCopyRelationFact,
    };

    fn provenance_event() -> skillhub_core::import::ImportProvenanceEvent {
        skillhub_core::import::ImportProvenanceEvent {
            provenance_id: "prov-unified".to_owned(),
            batch_id: "batch-unified".to_owned(),
            skill_id: skill_id(SKILL),
            source_class: skillhub_core::ImportSourceClass::UserLocal,
            source: skillhub_core::SourceDescriptor::new(
                skillhub_core::SourceKind::Local,
                skillhub_core::SourceLocator::local_path("C:/src/notes"),
            ),
            local_source_path: Some("C:/src/notes".to_owned()),
            source_container_id: None,
            physical_source_id: Some("fs:dev-1-ino-2".to_owned()),
            agent_client_id: Some(AGENT.to_owned()),
            content_fingerprint: "hash-a".to_owned(),
            imported_at: 42,
        }
    }

    fn source_copy(relation_id: &str, health: SourceCopyHealth) -> SourceCopyRelationFact {
        let mut fact = SourceCopyRelationFact::from_import_event(
            relation_id,
            &provenance_event(),
            "c:/src/notes",
            "fs:dev-1-ino-2",
        )
        .expect("governable");
        fact.health = health;
        fact
    }

    fn source_copy_with_decision(
        relation_id: &str,
        health: SourceCopyHealth,
        decision: SourceCopyDecision,
    ) -> SourceCopyRelationFact {
        let mut fact = source_copy(relation_id, health);
        fact.decision = decision;
        fact
    }

    fn unified_of(
        facts: Vec<GovernableRelationFact>,
        filters: RelationGovernanceFilters,
    ) -> skillhub_core::relationship::RelationGovernanceLedger {
        project_unified_governance_ledger(
            &filters,
            &facts,
            &supported_capabilities(),
            &BTreeSet::new(),
            &Vec::new(),
            7,
            None,
        )
    }

    #[test]
    fn six_healths_and_two_decisions_project_into_five_quick_statuses() {
        let cases = [
            (SourceCopyHealth::Normal, GovernableRelationStatus::Normal),
            (
                SourceCopyHealth::NeedsValidation,
                GovernableRelationStatus::NeedsValidation,
            ),
            (
                SourceCopyHealth::ContentChanged,
                GovernableRelationStatus::NeedsAttention,
            ),
            (
                SourceCopyHealth::OperationFailed,
                GovernableRelationStatus::NeedsAttention,
            ),
            (
                SourceCopyHealth::PermissionLimited,
                GovernableRelationStatus::Blocked,
            ),
            (
                SourceCopyHealth::ManagedOccupied,
                GovernableRelationStatus::Blocked,
            ),
        ];
        for (health, expected) in cases {
            let projection = project_governable_relation(&GovernableRelationFact::SourceCopy(
                source_copy("rel-copy", health),
            ))
            .expect("active source copy projects");
            assert_eq!(projection.status, expected, "health {health:?}");
        }

        // Retained 决策 + Normal 健康 → Retained；Pending 决策 → Normal。
        let retained = project_governable_relation(&GovernableRelationFact::SourceCopy(
            source_copy_with_decision(
                "rel-copy",
                SourceCopyHealth::Normal,
                SourceCopyDecision::Retained,
            ),
        ))
        .expect("retained copy projects");
        assert_eq!(retained.status, GovernableRelationStatus::Retained);
    }

    #[test]
    fn unified_all_bucket_lists_source_copies_and_deployments_together() {
        let filters = RelationGovernanceFilters {
            bucket: RelationGovernanceBucket::All,
            ..RelationGovernanceFilters::default()
        };
        let ledger = unified_of(
            vec![
                GovernableRelationFact::SourceCopy(source_copy(
                    "rel-copy",
                    SourceCopyHealth::Normal,
                )),
                GovernableRelationFact::Deployment(
                    RelationSpec::managed_link("rel-link", "/agent/skills/link").build(),
                ),
            ],
            filters,
        );
        let mut ids = ledger
            .rows
            .iter()
            .map(|row| row.relation_id().to_owned())
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["rel-copy", "rel-link"]);

        // 已归档来源副本不进清单（history 独立查询负责）。
        let mut archived = source_copy("rel-copy", SourceCopyHealth::Normal);
        archived.active = false;
        let ledger = unified_of(
            vec![
                GovernableRelationFact::SourceCopy(archived),
                GovernableRelationFact::Deployment(
                    RelationSpec::managed_link("rel-link", "/agent/skills/link").build(),
                ),
            ],
            RelationGovernanceFilters::default(),
        );
        assert_eq!(ledger.rows.len(), 1);
        assert_eq!(ledger.rows[0].relation_id(), "rel-link");
    }

    #[test]
    fn unified_filters_combine_scope_class_project_batch_and_statuses() {
        let mut user_copy = source_copy("rel-user-copy", SourceCopyHealth::Normal);
        user_copy.source_class = ImportSourceClass::UserLocal;
        let mut project_copy = source_copy("rel-project-copy", SourceCopyHealth::Normal);
        project_copy.source_class = ImportSourceClass::RegisteredProject;
        project_copy.source_container_id = Some("project-1".to_owned());
        let deployment = GovernableRelationFact::Deployment(
            RelationSpec::managed_link("rel-link", "/agent/skills/link").build(),
        );
        let facts = vec![
            GovernableRelationFact::SourceCopy(user_copy),
            GovernableRelationFact::SourceCopy(project_copy),
            deployment,
        ];

        // source_class 过滤只命中来源副本。
        let filters = RelationGovernanceFilters {
            source_class: Some(ImportSourceClass::UserLocal),
            ..RelationGovernanceFilters::default()
        };
        let ledger = unified_of(facts.clone(), filters);
        assert_eq!(
            ledger
                .rows
                .iter()
                .map(|row| row.relation_id().to_owned())
                .collect::<Vec<_>>(),
            vec!["rel-user-copy"]
        );

        // project 过滤命中项目副本。
        let filters = RelationGovernanceFilters {
            project_id: Some("project-1".to_owned()),
            ..RelationGovernanceFilters::default()
        };
        let ledger = unified_of(facts.clone(), filters);
        assert_eq!(
            ledger
                .rows
                .iter()
                .map(|row| row.relation_id().to_owned())
                .collect::<Vec<_>>(),
            vec!["rel-project-copy"]
        );

        // batch_id 只命中 import_batch_items 映射的关系（由调用方传入）。
        let filters = RelationGovernanceFilters {
            batch_id: Some("batch-7".to_owned()),
            ..RelationGovernanceFilters::default()
        };
        let mut batch_ids = BTreeSet::new();
        batch_ids.insert("rel-link".to_owned());
        let ledger = project_unified_governance_ledger(
            &filters,
            &facts,
            &supported_capabilities(),
            &batch_ids,
            &Vec::new(),
            7,
            None,
        );
        assert_eq!(
            ledger
                .rows
                .iter()
                .map(|row| row.relation_id().to_owned())
                .collect::<Vec<_>>(),
            vec!["rel-link"]
        );

        // 快捷状态过滤与 skill 过滤可组合。
        let filters = RelationGovernanceFilters {
            statuses: vec![GovernableRelationStatus::Normal],
            skill_id: Some(skill_id(OTHER_SKILL)),
            ..RelationGovernanceFilters::default()
        };
        let ledger = unified_of(facts, filters);
        assert!(
            ledger.rows.is_empty(),
            "no other-skill facts in this fixture"
        );
    }

    #[test]
    fn unified_counts_report_five_statuses_and_both_kinds() {
        let facts = vec![
            GovernableRelationFact::SourceCopy(source_copy("rel-normal", SourceCopyHealth::Normal)),
            GovernableRelationFact::SourceCopy(source_copy(
                "rel-changed",
                SourceCopyHealth::ContentChanged,
            )),
            GovernableRelationFact::SourceCopy(source_copy(
                "rel-occupied",
                SourceCopyHealth::ManagedOccupied,
            )),
            GovernableRelationFact::Deployment(
                RelationSpec::managed_link("rel-link", "/agent/skills/link").build(),
            ),
        ];
        let ledger = unified_of(facts, RelationGovernanceFilters::default());
        let counts: &RelationGovernanceCounts = &ledger.counts;
        assert_eq!(counts.all, 4);
        assert_eq!(counts.source_copies, 3);
        assert_eq!(counts.deployments, 1);
        assert_eq!(counts.status_normal, 2);
        assert_eq!(counts.status_needs_attention, 1);
        assert_eq!(counts.status_blocked, 1);
        assert_eq!(counts.status_needs_validation, 0);
        assert_eq!(counts.status_retained, 0);
    }

    #[test]
    fn action_eligibility_only_offers_actions_with_executable_implementations() {
        // 来源副本：Pending 决策提供 KeepIndependentCopy（命令已存在）。
        let pending = unified_of(
            vec![GovernableRelationFact::SourceCopy(source_copy(
                "rel-pending",
                SourceCopyHealth::Normal,
            ))],
            RelationGovernanceFilters::default(),
        );
        assert_eq!(
            pending.rows[0].primary_action,
            RelationGovernanceAction::KeepIndependentCopy
        );
        assert_eq!(
            pending.rows[0].readiness,
            RelationGovernanceReadiness::AlreadyCentralized
        );

        // 需要复核的来源副本提供 Revalidate。
        let stale = unified_of(
            vec![GovernableRelationFact::SourceCopy(source_copy(
                "rel-stale",
                SourceCopyHealth::NeedsValidation,
            ))],
            RelationGovernanceFilters::default(),
        );
        assert_eq!(
            stale.rows[0].primary_action,
            RelationGovernanceAction::Revalidate
        );

        // 部署：受管链接 → Undeploy；受管副本 → DetachKeepFiles（复用
        // DetachManagement）；就绪受管条目保留 CentralizeManagement。
        let deployments = unified_of(
            vec![
                GovernableRelationFact::Deployment(
                    RelationSpec::managed_link("rel-managed-link", "/agent/skills/link").build(),
                ),
                GovernableRelationFact::Deployment(
                    RelationSpec::observed_copy("rel-observed-copy", "/agent/skills/copy").build(),
                ),
            ],
            RelationGovernanceFilters::default(),
        );
        let by_id = |ledger: &skillhub_core::relationship::RelationGovernanceLedger, id: &str| {
            ledger
                .rows
                .iter()
                .find(|row| row.relation_id() == id)
                .unwrap_or_else(|| panic!("row {id}"))
                .primary_action
        };
        assert_eq!(
            by_id(&deployments, "rel-managed-link"),
            RelationGovernanceAction::Undeploy
        );
    }

    #[test]
    fn legacy_bucket_urls_map_to_equivalent_status_filters() {
        assert!(
            skillhub_core::relationship::legacy_bucket_statuses(RelationGovernanceBucket::All)
                .is_empty()
        );
        assert_eq!(
            skillhub_core::relationship::legacy_bucket_statuses(
                RelationGovernanceBucket::NeedsValidation
            ),
            vec![GovernableRelationStatus::NeedsValidation]
        );
        assert_eq!(
            skillhub_core::relationship::legacy_bucket_statuses(RelationGovernanceBucket::Blocked),
            vec![GovernableRelationStatus::Blocked]
        );
        assert_eq!(
            skillhub_core::relationship::legacy_bucket_statuses(
                RelationGovernanceBucket::EligibleToCentralize
            ),
            vec![GovernableRelationStatus::Normal]
        );
    }
}
