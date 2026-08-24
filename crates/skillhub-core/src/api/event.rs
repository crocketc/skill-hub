use serde::{Deserialize, Serialize};

use crate::{OperationProgress, OperationSummary};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct FactsChanged {}

impl FactsChanged {
    pub const fn new() -> Self {
        Self {}
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppEvent {
    #[serde(rename = "operation_progress")]
    OperationProgress(OperationProgress),
    #[serde(rename = "operation_finished")]
    OperationFinished(OperationSummary),
    #[serde(rename = "facts_changed")]
    FactsChanged(FactsChanged),
}
