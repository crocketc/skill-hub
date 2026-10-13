use serde::{Deserialize, Serialize};

use crate::deployment::{DeploymentMode, DeploymentRelationFact};
use crate::relationship::{GovernanceTaskFact, OwnershipState, RelationshipType};
use crate::{ErrorCode, OperationId};

pub mod journal;

pub use journal::{
    InverseOperation, OperationContext, OperationJournal, OperationObjectResult, OperationRecord,
    OperationRepository, OperationStatus, UndoPlan,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum OperationPhase {
    Planned,
    Prepared,
    Applying,
    Verifying,
    Committed,
    NeedsRecovery,
    RolledBack,
}

/// Operation kinds whose prepared phase contains only a preview, an in-memory
/// plan, or immutable unreferenced version capture. Their first mutation of
/// active consumer state is checkpointed as Applying, so an abandoned Prepared
/// record can be safely settled without a recovery decision.
pub const SAFE_TO_ABANDON_PREPARED_OPERATION_KINDS: &[&str] = &[
    "import_skill",
    "deploy_skill",
    "delete_skill",
    "undeploy_skill",
    "migrate_original",
    "prepare_source_update",
    "set_current_version",
    "save_as_copy_replacement_preview",
    "standard_export",
    "usage_release",
    "subject_runtime_rename",
    "usage_derived_rename",
    "managed_usage_change",
    "usage_manage",
    "usage_manage_batch",
    "usage_duplicate_cleanup",
    "shared_usage_migration",
    "migrate_relation",
    "relation_governance_batch",
    "create_skill",
    "commit_source_update",
    "usage_original_entry_adoption",
    "save_skill_content",
    "save_markdown_content",
    "reconcile_restore_deployment",
    "reconcile_collect_changes",
    "reconcile_ignore_external_change",
];

/// Operation kinds written by the current application. Recovery UI must not
/// offer generic completion or rollback for rows that came from an unknown
/// producer; newer or corrupted journal kinds need an explicit recovery path.
pub const KNOWN_OPERATION_KINDS: &[&str] = &[
    "import_skill",
    "deploy_skill",
    "delete_skill",
    "undeploy_skill",
    "migrate_original",
    "prepare_source_update",
    "set_current_version",
    "save_as_copy_replacement_preview",
    "standard_export",
    "usage_release",
    "subject_runtime_rename",
    "usage_derived_rename",
    "managed_usage_change",
    "usage_manage",
    "usage_manage_batch",
    "usage_duplicate_cleanup",
    "shared_usage_migration",
    "migrate_relation",
    "relation_governance_batch",
    "save_search_candidates",
    "confirm_search_candidate",
    "dismiss_search_candidate",
    "uninstall_skill",
    "create_skill",
    "create_combination",
    "update_combination",
    "rename_combination",
    "delete_combination",
    "unlink_update_source",
    "commit_source_update",
    "usage_original_entry_adoption",
    "save_skill_content",
    "save_markdown_content",
    "save_markdown_as_copy",
    "relink_source_copy",
    "remove_ignore_rule",
    "reconcile_collect_changes",
    "reconcile_restore_deployment",
    "reconcile_ignore_external_change",
    "retain_source_copy",
    "conflict_resolution",
    // Retained for journal rows written by older versions.
    "rename_skill",
    "remove_skill",
];

pub fn is_known_operation_kind(kind: &str) -> bool {
    KNOWN_OPERATION_KINDS.contains(&kind)
}

pub fn operation_requires_recovery_gate(kind: &str, phase: OperationPhase) -> bool {
    match phase {
        OperationPhase::Committed | OperationPhase::RolledBack => false,
        OperationPhase::Prepared => !SAFE_TO_ABANDON_PREPARED_OPERATION_KINDS.contains(&kind),
        OperationPhase::Planned
        | OperationPhase::Applying
        | OperationPhase::Verifying
        | OperationPhase::NeedsRecovery => true,
    }
}

#[cfg(test)]
mod recovery_policy_tests {
    use super::{is_known_operation_kind, operation_requires_recovery_gate, OperationPhase};

    #[test]
    fn prepared_policy_is_conservative_for_unknown_kinds() {
        for kind in super::SAFE_TO_ABANDON_PREPARED_OPERATION_KINDS {
            assert!(
                !operation_requires_recovery_gate(kind, OperationPhase::Prepared),
                "known preview kind {kind} must not gate the app"
            );
        }
        assert!(operation_requires_recovery_gate(
            "future_operation_kind",
            OperationPhase::Prepared
        ));
        assert!(is_known_operation_kind("relation_governance_batch"));
        assert!(!is_known_operation_kind("future_operation_kind"));
        assert!(operation_requires_recovery_gate(
            "deploy_skill",
            OperationPhase::Applying
        ));
        for kind in ["save_skill_content", "save_markdown_content"] {
            assert!(
                !operation_requires_recovery_gate(kind, OperationPhase::Prepared),
                "immutable capture for {kind} must not gate before active consumers change"
            );
            assert!(operation_requires_recovery_gate(
                kind,
                OperationPhase::Applying
            ));
        }
        assert!(!operation_requires_recovery_gate(
            "future_operation_kind",
            OperationPhase::RolledBack
        ));
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct OperationProgress {
    pub operation_id: OperationId,
    pub phase: OperationPhase,
    pub completed: u32,
    pub total: u32,
    pub message_code: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct OperationSummary {
    pub operation_id: OperationId,
    pub phase: OperationPhase,
    pub message_code: String,
    pub error_code: Option<ErrorCode>,
}

/// Public lifecycle for relationship conversion.  The operation journal maps
/// `Failed` to its recovery phase and `Cancelled` to a rolled-back journal
/// phase while retaining this precise user-facing state in the operation
/// result/recovery payload.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RelationMigrationState {
    Prepared,
    Committed,
    RolledBack,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PreparedRelationMigration {
    pub operation_id: OperationId,
    pub relation_id: String,
    /// Whether the registered target was a shared directory at preview time.
    #[serde(default)]
    pub target_is_shared: bool,
    pub relation: DeploymentRelationFact,
    pub current_content_fingerprint: String,
    pub target_path: String,
    pub target_mode: DeploymentMode,
    pub backup_path: String,
    pub affected_paths: Vec<String>,
    pub rollback_available: bool,
    pub governance_tasks: Vec<GovernanceTaskFact>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RelationMigrationResult {
    pub operation_id: OperationId,
    pub relation_id: String,
    pub state: RelationMigrationState,
    pub relation_type: RelationshipType,
    pub ownership: OwnershipState,
    pub old_path: String,
    pub target_path: String,
    pub backup_path: Option<String>,
    pub affected_paths: Vec<String>,
    pub rollback_available: bool,
    pub governance_tasks: Vec<GovernanceTaskFact>,
    pub error_code: Option<ErrorCode>,
    pub detail: Option<String>,
}
