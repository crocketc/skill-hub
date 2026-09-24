//! Pure source-copy facts and validation transitions.

use serde::{Deserialize, Serialize};

use crate::import::{ImportProvenanceEvent, ImportSourceClass};
use crate::SkillId;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceCopyDecision {
    Pending,
    Retained,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceCopyHealth {
    Normal,
    NeedsValidation,
    ContentChanged,
    PermissionLimited,
    ManagedOccupied,
    OperationFailed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceCopyArchiveReason {
    ExternalRemoved,
    Replaced,
    Cleaned,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SourceCopyRelationFact {
    pub relation_id: String,
    pub skill_id: SkillId,
    pub latest_provenance_id: String,
    pub source_class: ImportSourceClass,
    pub source_path: String,
    pub source_path_key: String,
    pub physical_source_id: String,
    pub source_container_id: Option<String>,
    pub directory_node_id: Option<String>,
    pub agent_client_id: Option<String>,
    pub expected_fingerprint: String,
    pub current_fingerprint: Option<String>,
    pub decision: SourceCopyDecision,
    pub health: SourceCopyHealth,
    pub active: bool,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub last_verified_at: Option<i64>,
    #[serde(with = "crate::i64_option_string")]
    #[specta(type = Option<String>)]
    pub archived_at: Option<i64>,
    pub archive_reason: Option<SourceCopyArchiveReason>,
}

impl SourceCopyRelationFact {
    /// Caller supplies a fresh relation ID and a filesystem-verified physical ID.
    pub fn from_import_event(
        relation_id: impl Into<String>,
        event: &ImportProvenanceEvent,
        source_path_key: impl Into<String>,
        physical_source_id: impl Into<String>,
    ) -> Option<Self> {
        if !matches!(
            event.source_class,
            ImportSourceClass::AgentLocal | ImportSourceClass::UserLocal
        ) {
            return None;
        }
        let source_path = event.local_source_path.clone()?;
        Some(Self {
            relation_id: relation_id.into(),
            skill_id: event.skill_id,
            latest_provenance_id: event.provenance_id.clone(),
            source_class: event.source_class,
            source_path,
            source_path_key: source_path_key.into(),
            physical_source_id: physical_source_id.into(),
            source_container_id: event.source_container_id.clone(),
            directory_node_id: None,
            agent_client_id: event.agent_client_id.clone(),
            expected_fingerprint: event.content_fingerprint.clone(),
            current_fingerprint: None,
            decision: SourceCopyDecision::Pending,
            health: SourceCopyHealth::NeedsValidation,
            active: true,
            last_verified_at: None,
            archived_at: None,
            archive_reason: None,
        })
    }

    /// Pure preflight; the repository enforces uniqueness transactionally.
    pub fn active_physical_conflict(existing: &[Self], candidate: &Self) -> bool {
        candidate.active
            && existing.iter().any(|relation| {
                relation.active
                    && relation.physical_source_id == candidate.physical_source_id
                    && relation.skill_id != candidate.skill_id
            })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceCopyProbe {
    AccessibleDirectory,
    MissingWithAccessibleParent,
    ParentMissing,
    PermissionDenied,
    DriveOrVolumeUnavailable,
    TimeoutOrUnknown,
    WrongRepresentation,
    PhysicalIdentityChanged,
    FingerprintChanged,
    ManagedOccupied,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourceCopyTransition {
    Update(SourceCopyRelationFact),
    Archive {
        fact: SourceCopyRelationFact,
        reason: SourceCopyArchiveReason,
    },
}

pub fn validate_source_copy_transition(
    relation: &SourceCopyRelationFact,
    probe: SourceCopyProbe,
    verified_at: i64,
) -> SourceCopyTransition {
    let mut updated = relation.clone();
    updated.last_verified_at = Some(verified_at);
    match probe {
        SourceCopyProbe::MissingWithAccessibleParent => {
            updated.active = false;
            updated.archived_at = Some(verified_at);
            updated.archive_reason = Some(SourceCopyArchiveReason::ExternalRemoved);
            SourceCopyTransition::Archive {
                fact: updated,
                reason: SourceCopyArchiveReason::ExternalRemoved,
            }
        }
        _ => {
            updated.health = match probe {
                SourceCopyProbe::AccessibleDirectory => SourceCopyHealth::Normal,
                SourceCopyProbe::FingerprintChanged | SourceCopyProbe::PhysicalIdentityChanged => {
                    SourceCopyHealth::ContentChanged
                }
                SourceCopyProbe::PermissionDenied => SourceCopyHealth::PermissionLimited,
                SourceCopyProbe::ManagedOccupied => SourceCopyHealth::ManagedOccupied,
                SourceCopyProbe::ParentMissing
                | SourceCopyProbe::DriveOrVolumeUnavailable
                | SourceCopyProbe::TimeoutOrUnknown
                | SourceCopyProbe::WrongRepresentation => SourceCopyHealth::NeedsValidation,
                SourceCopyProbe::MissingWithAccessibleParent => unreachable!(),
            };
            SourceCopyTransition::Update(updated)
        }
    }
}
