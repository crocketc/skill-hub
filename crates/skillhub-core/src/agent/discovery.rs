use serde::{Deserialize, Serialize};

use super::{ClientKind, OperatingSystem, TargetScope};
use crate::AppResult;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ClientInstance {
    pub profile_id: String,
    pub client_id: String,
    pub kind: ClientKind,
    pub supported_os: Vec<OperatingSystem>,
    pub available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct LogicalTarget {
    pub id: String,
    pub profile_id: String,
    pub client_id: String,
    pub scope: TargetScope,
    pub path: String,
    pub marker: String,
    pub precedence: super::DirectoryPrecedence,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub available: bool,
    pub physical_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PhysicalTarget {
    pub id: String,
    pub path: String,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub logical_target_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiscoverySnapshot {
    pub generation: u64,
    pub observed_at: u64,
    pub instances: Vec<ClientInstance>,
    pub logical_targets: Vec<LogicalTarget>,
    pub physical_targets: Vec<PhysicalTarget>,
}

pub trait AgentRepository {
    fn load_discovery(&self) -> AppResult<Option<DiscoverySnapshot>>;
    fn replace_discovery(&self, snapshot: &DiscoverySnapshot) -> AppResult<DiscoverySnapshot>;
}
