use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct BootstrapSnapshot {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQuery {
    #[serde(rename = "get_bootstrap_snapshot")]
    GetBootstrapSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppQueryResult {
    #[serde(rename = "bootstrap_snapshot")]
    BootstrapSnapshot(BootstrapSnapshot),
}

