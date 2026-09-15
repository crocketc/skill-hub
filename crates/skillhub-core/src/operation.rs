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
