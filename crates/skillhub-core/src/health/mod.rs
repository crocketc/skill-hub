use crate::{OperationId, RecoveryAction, Severity};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RepairAction {
    RemoveOrphanMetadata,
    RestoreMissingTarget,
    CleanStaleTemporaryFile,
    RebuildMissingManifest,
    MarkOperationNeedsRecovery,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct HealthFinding {
    pub code: String,
    pub severity: Severity,
    pub repair: RepairAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct HealthReport {
    pub id: OperationId,
    pub findings: Vec<HealthFinding>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RepairPlan {
    pub id: OperationId,
    pub report_id: OperationId,
    pub finding_index: u32,
    pub finding: HealthFinding,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RecoveryCandidate {
    pub operation_id: OperationId,
    pub actions: Vec<RecoveryAction>,
}
