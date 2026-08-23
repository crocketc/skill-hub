use crate::operation::OperationPhase;
use crate::pending::{PendingItem, PendingKind};
use crate::OperationId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Deserialize,
    Eq,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum StartupRecoveryState {
    #[default]
    Clean,
    InProgress,
    NeedsRecovery,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PendingSummary {
    pub total: u32,
    pub by_kind: BTreeMap<PendingKind, u32>,
}

impl PendingSummary {
    pub fn from_items(items: &[PendingItem]) -> Self {
        let mut by_kind = BTreeMap::new();
        for item in items {
            *by_kind.entry(item.kind).or_insert(0) += 1;
        }
        Self {
            total: items.len() as u32,
            by_kind,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct RecentOperationSummary {
    pub operation_id: OperationId,
    pub kind: String,
    pub state: String,
    pub phase: OperationPhase,
    pub error_code: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct BootstrapSnapshot {
    pub skill_count: u32,
    pub project_count: u32,
    pub agent_count: u32,
    pub deployed_count: u32,
    pub deployment_categories: BTreeMap<String, u32>,
    pub recent_operations: Vec<RecentOperationSummary>,
    pub pending: PendingSummary,
    pub last_scan_at: Option<String>,
    pub recovery_state: StartupRecoveryState,
}

impl BootstrapSnapshot {
    pub fn empty() -> Self {
        Self {
            recovery_state: StartupRecoveryState::Clean,
            ..Self::default()
        }
    }
}
