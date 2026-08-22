use serde::{Deserialize, Serialize};

use crate::{OperationId, OperationSummary};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppCommand {
    #[serde(rename = "cancel_operation")]
    CancelOperation { operation_id: OperationId },
    #[serde(rename = "acknowledge_recovery")]
    AcknowledgeRecovery { operation_id: OperationId },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppCommandResult {
    #[serde(rename = "operation_summary")]
    OperationSummary(OperationSummary),
}

