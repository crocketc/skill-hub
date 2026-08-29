use crate::{DeploymentId, DeploymentRecord, VersionId};
use serde::{Deserialize, Serialize};

/// Deterministic comparison result for a managed deployment target.
/// The comparison is intentionally performed by the platform backend.  The
/// backend must compare the target's filesystem identity and tree hash with
/// the ownership facts recorded in the deployment relation and the selected
/// version manifest; this model does not infer Agent runtime behaviour.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExternalChangeState {
    Unchanged,
    Modified,
    Missing,
    Ignored,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExternalChangeObservation {
    pub state: ExternalChangeState,
    pub observed_hash: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileAction {
    CollectChanges,
    Restore,
    KeepIndependentCopy,
    Ignore,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ReconcilePlan {
    pub deployment_id: DeploymentId,
    pub state: ExternalChangeState,
    pub expected_hash: String,
    pub observed_hash: Option<String>,
    pub allowed_actions: Vec<ReconcileAction>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ReconcileResult {
    pub deployment_id: DeploymentId,
    pub state_before: ExternalChangeState,
    pub action: ReconcileAction,
    pub version_id: Option<VersionId>,
    pub management_retained: bool,
}

impl ReconcilePlan {
    pub fn from_observation(
        deployment: &DeploymentRecord,
        observation: ExternalChangeObservation,
    ) -> Self {
        let allowed_actions = match observation.state {
            ExternalChangeState::Modified => vec![
                ReconcileAction::CollectChanges,
                ReconcileAction::Restore,
                ReconcileAction::KeepIndependentCopy,
                ReconcileAction::Ignore,
            ],
            ExternalChangeState::Missing => vec![
                ReconcileAction::Restore,
                ReconcileAction::KeepIndependentCopy,
                ReconcileAction::Ignore,
            ],
            ExternalChangeState::Unchanged | ExternalChangeState::Ignored => Vec::new(),
        };
        Self {
            deployment_id: deployment.id,
            state: observation.state,
            expected_hash: deployment.expected_hash.clone(),
            observed_hash: observation.observed_hash,
            allowed_actions,
        }
    }
}
