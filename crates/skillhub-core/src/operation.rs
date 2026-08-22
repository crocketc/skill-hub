use serde::{Deserialize, Serialize};

use crate::{ErrorCode, OperationId};

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
