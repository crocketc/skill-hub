use serde::{Deserialize, Serialize};

use super::{AgentProfile, ClientKind, OperatingSystem, TargetScope};
use crate::AppResult;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ClientInstance {
    pub profile_id: String,
    pub client_id: String,
    pub kind: ClientKind,
    /// Official product name from the profile; empty for snapshots persisted
    /// before OPT-20260914-07 (consumers fall back to `client_id`).
    #[serde(default)]
    pub display_name: String,
    pub supported_os: Vec<OperatingSystem>,
    pub client_presence: ClientPresence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub enum ClientPresence {
    Unknown,
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
    /// `true` for cross-brand shared references (`.agents/skills`): the
    /// directory stays usable for the brand, but ownership belongs to the
    /// generic Agent Skills entry. Defaults to `false` for snapshots persisted
    /// before OPT-20260914-07.
    #[serde(default)]
    pub shared_reference: bool,
    /// `true` for platform-managed built-in skill directories declared by the
    /// profile（内置目录：只读观察，不进部署目标）。Defaults to `false` for
    /// snapshots persisted before the builtin rollout.
    #[serde(default)]
    pub builtin: bool,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub available: bool,
    pub physical_id: String,
}

impl LogicalTarget {
    pub fn directory_role(&self) -> crate::relationship::DirectoryRole {
        if self.shared_reference {
            crate::relationship::DirectoryRole::SharedDirectory
        } else if matches!(self.scope, TargetScope::Project) {
            crate::relationship::DirectoryRole::Project
        } else {
            crate::relationship::DirectoryRole::AgentNative
        }
    }

    pub fn directory_recognition(
        &self,
        profile: &AgentProfile,
    ) -> crate::relationship::DirectoryRecognition {
        profile.directory_recognition(&self.path)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct PhysicalTarget {
    pub id: String,
    pub path: String,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub case_behavior: String,
    pub logical_target_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DiscoverySnapshot {
    pub generation: String,
    pub observed_at: String,
    pub instances: Vec<ClientInstance>,
    pub logical_targets: Vec<LogicalTarget>,
    pub physical_targets: Vec<PhysicalTarget>,
}

pub trait AgentRepository {
    fn load_discovery(&self) -> AppResult<Option<DiscoverySnapshot>>;
    fn replace_discovery(&self, snapshot: &DiscoverySnapshot) -> AppResult<DiscoverySnapshot>;
}
