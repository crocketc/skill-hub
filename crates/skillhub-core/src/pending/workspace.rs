use serde::{Deserialize, Serialize};

/// Work is derived from durable domain facts, never from notification history.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    Recovery,
    Conflict,
    Governance,
    GovernanceFollowup,
    SecurityFinding,
    TrialDue,
    BasicCheck,
    ImportSkills,
    AiSetup,
    BackupSetup,
    SourceUpdate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct WorkItem {
    /// Includes the version/occurrence where relevant. Never rendered as text.
    pub id: String,
    pub kind: WorkKind,
    pub subject: String,
    pub display_name: Option<String>,
    pub message_code: String,
    pub recommended: bool,
    pub can_defer: bool,
    pub can_ignore: bool,
    pub can_confirm: bool,
    pub version_id: Option<String>,
    pub finding_id: Option<String>,
    pub check_kind: Option<String>,
    pub path: Option<String>,
    pub due_date: Option<String>,
    pub risk: Option<super::PendingRisk>,
    pub source_roots: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PendingWorkspace {
    pub items: Vec<WorkItem>,
    /// Failed sources are explicit: a partial result must never mean all clear.
    pub unavailable_sources: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DismissPendingWork {
    pub item_id: String,
    /// None skips an optional suggestion; otherwise uses the ignore rule date contract.
    pub defer_until: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ConfirmPendingWork {
    pub item_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PendingConfirmation {
    pub item_id: String,
    pub reason: String,
    pub confirmed_at: String,
}
