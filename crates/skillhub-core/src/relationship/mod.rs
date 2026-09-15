use serde::{Deserialize, Serialize};

use crate::agent::DirectoryPrecedence;
use crate::deployment::{ObservedMatchState, ObservedOrigin};
use crate::SkillId;
use crate::VersionId;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryRole {
    CentralLibrary,
    AgentNative,
    SharedDirectory,
    Project,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryRecognition {
    Supported,
    Unknown,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipType {
    ImportCopy,
    SharedDirectoryRead,
    SharedDirectoryReference,
    ManagedCopy,
    ManagedLink,
    ObservedCopy,
    ObservedLink,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FileRepresentation {
    Directory,
    SymbolicLink,
    DirectoryJunction,
    Copy,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OwnershipState {
    SkillhubManaged,
    ObservedUnmanaged,
    SharedReference,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ConflictClassification {
    SameSkillVersion,
    DistinctSkill,
    Uncertain,
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum IdentityDirection {
    SameSkill,
    DifferentSkill,
    #[default]
    Unknown,
}

#[derive(
    Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    DuplicateSameContent,
    SameNameDifferentContent,
    SameSourceFork,
    SharedDirectoryDuplicate,
    #[default]
    UnknownDirectoryRecognition,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GovernanceTaskKind {
    SelectAuthoritativeVersion,
    ClassifySameNameSkill,
    ConfirmSharedDirectoryImpact,
    ConvertCopyToManagedLink,
    ConvertSharedReferenceToManagedLink,
    UnknownDirectoryRecognition,
    OperationFailureRecovery,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictEvidence {
    pub fingerprints_match: Option<bool>,
    pub names_match: Option<bool>,
    #[serde(default)]
    pub identity_direction: Option<IdentityDirection>,
    pub sufficient_identity_evidence: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DirectoryNodeFact {
    pub node_id: String,
    pub path: String,
    pub path_key: String,
    pub role: DirectoryRole,
    pub profile_id: Option<String>,
    pub agent_client_id: Option<String>,
    pub exists: bool,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub observed_at: i64,
    pub scan_source: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentDirectoryCapabilityFact {
    pub agent_client_id: String,
    pub directory_node_id: String,
    pub recognition: DirectoryRecognition,
    pub precedence: DirectoryPrecedence,
    pub evidence_reference: Option<String>,
    pub researched_at: Option<String>,
    pub applicable_platforms: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceRelationFact {
    pub provenance_id: String,
    pub skill_id: SkillId,
    pub directory_node_id: Option<String>,
    pub agent_client_id: Option<String>,
    pub source_path: String,
    pub source_path_key: String,
    pub relationship: RelationshipType,
    pub file_representation: FileRepresentation,
    pub ownership: OwnershipState,
    pub link_target_path: Option<String>,
    pub link_target_directory_id: Option<String>,
    pub content_fingerprint: String,
    pub source: crate::source::SourceDescriptor,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub imported_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRelationFact {
    pub relation_id: String,
    pub skill_id: Option<SkillId>,
    pub agent_client_id: String,
    pub path: String,
    pub path_key: String,
    pub directory_node_id: Option<String>,
    pub relationship: RelationshipType,
    pub file_representation: FileRepresentation,
    pub ownership: OwnershipState,
    pub link_target_path: Option<String>,
    pub link_target_path_key: Option<String>,
    pub content_fingerprint: String,
    pub origin: ObservedOrigin,
    pub match_state: ObservedMatchState,
    pub active: bool,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub observed_at: i64,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub released_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictCaseFact {
    pub conflict_id: String,
    #[serde(default)]
    pub kind: ConflictKind,
    pub classification: ConflictClassification,
    pub member_skill_ids: Vec<SkillId>,
    #[serde(default)]
    pub members: Vec<ConflictMemberFact>,
    pub evidence: ConflictEvidence,
    #[serde(default)]
    pub user_decision: Option<ConflictClassification>,
    #[serde(default)]
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub decided_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConflictMemberFact {
    pub skill_id: Option<SkillId>,
    pub version_id: Option<VersionId>,
    pub provenance_id: Option<String>,
    pub directory_node_id: Option<String>,
    pub path: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GovernanceTaskFact {
    pub task_id: String,
    pub kind: GovernanceTaskKind,
    pub subject_id: String,
    pub detail: String,
    pub resolved: bool,
    #[serde(with = "crate::i64_string")]
    #[specta(type = String)]
    pub created_at: i64,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub resolved_at: Option<i64>,
}

pub fn classify_conflict_evidence(evidence: &ConflictEvidence) -> ConflictClassification {
    if evidence.fingerprints_match == Some(true) {
        ConflictClassification::SameSkillVersion
    } else {
        match (
            evidence.fingerprints_match,
            evidence.names_match,
            evidence.identity_direction,
        ) {
            (Some(false), Some(true), Some(IdentityDirection::DifferentSkill)) => {
                ConflictClassification::DistinctSkill
            }
            (Some(false), Some(true), Some(IdentityDirection::SameSkill)) => {
                ConflictClassification::SameSkillVersion
            }
            _ => ConflictClassification::Uncertain,
        }
    }
}

pub const fn relation_display_label(relationship: RelationshipType) -> &'static str {
    match relationship {
        RelationshipType::ImportCopy => "导入副本",
        RelationshipType::SharedDirectoryRead => "通用目录直接读取",
        RelationshipType::SharedDirectoryReference => "通用目录链接引用",
        RelationshipType::ManagedCopy | RelationshipType::ObservedCopy => "复制部署",
        RelationshipType::ManagedLink | RelationshipType::ObservedLink => "链接部署",
        RelationshipType::Unknown => "未知关系",
    }
}

pub const fn file_representation_display_label(representation: FileRepresentation) -> &'static str {
    match representation {
        FileRepresentation::Directory => "目录",
        FileRepresentation::SymbolicLink => "符号链接",
        FileRepresentation::DirectoryJunction => "目录联结",
        FileRepresentation::Copy => "复制副本",
        FileRepresentation::Unknown => "未知表示",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::{
        ObservedDeployment, ObservedMatchState, ObservedOrigin, ObservedStatus,
    };
    use crate::import::CandidateOwnership;
    use crate::source::{SourceDescriptor, SourceKind, SourceLocator};
    use crate::{ImportProvenance, ObservedDeploymentId, SkillId};

    #[test]
    fn serializes_relationship_types_with_stable_names() {
        let values = [
            (RelationshipType::ImportCopy, "import_copy"),
            (
                RelationshipType::SharedDirectoryRead,
                "shared_directory_read",
            ),
            (
                RelationshipType::SharedDirectoryReference,
                "shared_directory_reference",
            ),
            (RelationshipType::ManagedCopy, "managed_copy"),
            (RelationshipType::ManagedLink, "managed_link"),
            (RelationshipType::ObservedCopy, "observed_copy"),
            (RelationshipType::ObservedLink, "observed_link"),
            (RelationshipType::Unknown, "unknown"),
        ];

        for (value, expected) in values {
            assert_eq!(
                serde_json::to_string(&value).unwrap(),
                format!("\"{expected}\"")
            );
        }
    }

    #[test]
    fn serializes_file_representations_without_conflating_links() {
        let values = [
            (FileRepresentation::Directory, "directory"),
            (FileRepresentation::SymbolicLink, "symbolic_link"),
            (FileRepresentation::DirectoryJunction, "directory_junction"),
            (FileRepresentation::Copy, "copy"),
            (FileRepresentation::Unknown, "unknown"),
        ];

        for (value, expected) in values {
            assert_eq!(
                serde_json::to_string(&value).unwrap(),
                format!("\"{expected}\"")
            );
        }
    }

    #[test]
    fn serializes_the_remaining_domain_enums_with_stable_names() {
        let values = [
            (
                serde_json::to_string(&DirectoryRole::CentralLibrary).unwrap(),
                "\"central_library\"",
            ),
            (
                serde_json::to_string(&DirectoryRole::AgentNative).unwrap(),
                "\"agent_native\"",
            ),
            (
                serde_json::to_string(&DirectoryRole::SharedDirectory).unwrap(),
                "\"shared_directory\"",
            ),
            (
                serde_json::to_string(&DirectoryRole::Project).unwrap(),
                "\"project\"",
            ),
            (
                serde_json::to_string(&OwnershipState::SkillhubManaged).unwrap(),
                "\"skillhub_managed\"",
            ),
            (
                serde_json::to_string(&OwnershipState::ObservedUnmanaged).unwrap(),
                "\"observed_unmanaged\"",
            ),
            (
                serde_json::to_string(&OwnershipState::SharedReference).unwrap(),
                "\"shared_reference\"",
            ),
            (
                serde_json::to_string(&ConflictClassification::SameSkillVersion).unwrap(),
                "\"same_skill_version\"",
            ),
            (
                serde_json::to_string(&ConflictClassification::DistinctSkill).unwrap(),
                "\"distinct_skill\"",
            ),
            (
                serde_json::to_string(&ConflictClassification::Uncertain).unwrap(),
                "\"uncertain\"",
            ),
            (
                serde_json::to_string(&GovernanceTaskKind::UnknownDirectoryRecognition).unwrap(),
                "\"unknown_directory_recognition\"",
            ),
        ];

        for (actual, expected) in values {
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn represents_shared_directory_recognition_states_explicitly() {
        let values = [
            (DirectoryRecognition::Supported, "supported"),
            (DirectoryRecognition::Unknown, "unknown"),
            (DirectoryRecognition::Unsupported, "unsupported"),
        ];

        for (value, expected) in values {
            assert_eq!(
                serde_json::to_string(&value).unwrap(),
                format!("\"{expected}\"")
            );
        }
    }

    #[test]
    fn serializes_identity_directions_and_conflict_kinds_with_stable_names() {
        let identity_values = [
            (IdentityDirection::SameSkill, "same_skill"),
            (IdentityDirection::DifferentSkill, "different_skill"),
            (IdentityDirection::Unknown, "unknown"),
        ];
        for (value, expected) in identity_values {
            assert_eq!(
                serde_json::to_string(&value).unwrap(),
                format!("\"{expected}\"")
            );
        }

        let kind_values = [
            (ConflictKind::DuplicateSameContent, "duplicate_same_content"),
            (
                ConflictKind::SameNameDifferentContent,
                "same_name_different_content",
            ),
            (ConflictKind::SameSourceFork, "same_source_fork"),
            (
                ConflictKind::SharedDirectoryDuplicate,
                "shared_directory_duplicate",
            ),
            (
                ConflictKind::UnknownDirectoryRecognition,
                "unknown_directory_recognition",
            ),
        ];
        for (value, expected) in kind_values {
            assert_eq!(
                serde_json::to_string(&value).unwrap(),
                format!("\"{expected}\"")
            );
        }
    }

    #[test]
    fn gives_copy_and_link_relationships_the_user_label_link_deployment() {
        assert_eq!(
            relation_display_label(RelationshipType::ManagedLink),
            "链接部署"
        );
        assert_eq!(
            relation_display_label(RelationshipType::ObservedLink),
            "链接部署"
        );
        assert_eq!(
            relation_display_label(RelationshipType::ManagedCopy),
            "复制部署"
        );
        assert_eq!(
            relation_display_label(RelationshipType::ObservedCopy),
            "复制部署"
        );
        assert_eq!(
            file_representation_display_label(FileRepresentation::Copy),
            "复制副本"
        );
    }

    #[test]
    fn classifies_identical_fingerprints_as_the_same_skill_version() {
        let evidence = ConflictEvidence {
            fingerprints_match: Some(true),
            names_match: Some(true),
            identity_direction: Some(IdentityDirection::SameSkill),
            sufficient_identity_evidence: true,
        };

        assert_eq!(
            classify_conflict_evidence(&evidence),
            ConflictClassification::SameSkillVersion
        );
    }

    #[test]
    fn classifies_same_name_with_different_content_only_with_explicit_different_skill_evidence() {
        let evidence = ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: Some(IdentityDirection::DifferentSkill),
            sufficient_identity_evidence: true,
        };

        assert_eq!(
            classify_conflict_evidence(&evidence),
            ConflictClassification::DistinctSkill
        );
    }

    #[test]
    fn does_not_infer_distinct_skill_from_sufficient_identity_boolean_alone() {
        let evidence = ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: None,
            sufficient_identity_evidence: true,
        };

        assert_eq!(
            classify_conflict_evidence(&evidence),
            ConflictClassification::Uncertain
        );
    }

    #[test]
    fn explicit_same_skill_evidence_classifies_different_version() {
        let evidence = ConflictEvidence {
            fingerprints_match: Some(false),
            names_match: Some(true),
            identity_direction: Some(IdentityDirection::SameSkill),
            sufficient_identity_evidence: false,
        };

        assert_eq!(
            classify_conflict_evidence(&evidence),
            ConflictClassification::SameSkillVersion
        );
    }

    #[test]
    fn keeps_missing_conflict_evidence_uncertain() {
        let evidence = ConflictEvidence {
            fingerprints_match: None,
            names_match: None,
            identity_direction: None,
            sufficient_identity_evidence: false,
        };

        assert_eq!(
            classify_conflict_evidence(&evidence),
            ConflictClassification::Uncertain
        );
    }

    #[test]
    fn legacy_import_provenance_becomes_an_import_copy_fact() {
        let provenance = ImportProvenance::new(
            SkillId::new(),
            "/tmp/agents/shared/skills/demo",
            SourceDescriptor::new(
                SourceKind::Local,
                SourceLocator::local_path("/tmp/agents/shared/skills/demo"),
            ),
            CandidateOwnership::KnownAgentTarget,
            "sha256:aaaa",
            1_700_000_000,
        )
        .with_agent_client_id("trae.code");

        let fact = provenance.to_source_relation_fact();

        assert_eq!(fact.relationship, RelationshipType::ImportCopy);
        assert_eq!(fact.file_representation, FileRepresentation::Directory);
        assert_eq!(fact.agent_client_id.as_deref(), Some("trae.code"));
        assert_eq!(fact.content_fingerprint, "sha256:aaaa");
        assert!(!fact.provenance_id.is_empty());
        assert_eq!(fact.link_target_directory_id, None);
    }

    #[test]
    fn legacy_observed_deployment_does_not_guess_copy_or_link() {
        let observed = ObservedDeployment {
            id: ObservedDeploymentId::new(),
            skill_id: SkillId::new(),
            client_id: "trae.code".into(),
            original_path: "/tmp/agents/trae/skills/demo".into(),
            content_fingerprint: "sha256:aaaa".into(),
            match_state: ObservedMatchState::ContentVerified,
            origin: ObservedOrigin::Scan,
            status: ObservedStatus::Active,
            observed_at: 1_700_000_000,
            released_at: None,
        };

        let fact = observed.to_deployment_relation_fact();

        assert_eq!(fact.relationship, RelationshipType::Unknown);
        assert_eq!(fact.file_representation, FileRepresentation::Unknown);
        assert_eq!(fact.ownership, OwnershipState::ObservedUnmanaged);
        assert_eq!(fact.origin, ObservedOrigin::Scan);
        assert_eq!(fact.match_state, ObservedMatchState::ContentVerified);
        assert_eq!(fact.skill_id, Some(observed.skill_id));
    }

    #[test]
    fn normalized_conflict_case_carries_typed_group_members_and_decision() {
        let skill_id = SkillId::new();
        let conflict = ConflictCaseFact {
            conflict_id: "conflict-1".into(),
            kind: ConflictKind::SameNameDifferentContent,
            classification: ConflictClassification::Uncertain,
            member_skill_ids: vec![skill_id],
            members: vec![ConflictMemberFact {
                skill_id: Some(skill_id),
                version_id: None,
                provenance_id: Some("provenance-1".into()),
                directory_node_id: Some("directory-1".into()),
                path: Some("/tmp/skills/demo".into()),
                fingerprint: Some("sha256:aaaa".into()),
            }],
            evidence: ConflictEvidence::default(),
            user_decision: Some(ConflictClassification::SameSkillVersion),
            decided_at: Some(1_700_000_000),
        };

        let value = serde_json::to_value(conflict).unwrap();
        assert_eq!(value["kind"], "same_name_different_content");
        assert_eq!(value["members"][0]["provenance_id"], "provenance-1");
        assert_eq!(value["user_decision"], "same_skill_version");
        assert_eq!(value["decided_at"], "1700000000");
    }

    #[test]
    fn governance_and_conflict_facts_are_serializable_contracts() {
        let conflict = ConflictCaseFact {
            conflict_id: "conflict-1".into(),
            kind: ConflictKind::UnknownDirectoryRecognition,
            classification: ConflictClassification::Uncertain,
            member_skill_ids: vec![SkillId::new()],
            members: Vec::new(),
            evidence: ConflictEvidence::default(),
            user_decision: None,
            decided_at: None,
        };
        let task = GovernanceTaskFact {
            task_id: "task-1".into(),
            kind: GovernanceTaskKind::OperationFailureRecovery,
            subject_id: "conflict-1".into(),
            detail: "恢复失败操作".into(),
            resolved: false,
            created_at: 1_700_000_000,
            resolved_at: None,
        };

        let conflict_json = serde_json::to_value(conflict).unwrap();
        let task_json = serde_json::to_value(task).unwrap();
        assert_eq!(conflict_json["classification"], "uncertain");
        assert_eq!(task_json["kind"], "operation_failure_recovery");
        assert_eq!(task_json["created_at"], "1700000000");
    }
}
