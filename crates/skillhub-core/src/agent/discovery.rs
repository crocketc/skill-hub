use serde::{Deserialize, Serialize};

use super::{AgentProfile, ClientKind, OperatingSystem, TargetScope};
use crate::deployment::DeploymentMode;
use crate::AppResult;
use crate::DeploymentCapability;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryObservationStatus {
    Existing,
    Missing,
    NonDirectory,
    Inaccessible,
    BrokenLink,
    IdentityChanged,
}

impl Default for DirectoryObservationStatus {
    fn default() -> Self {
        Self::Existing
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct AgentRootObservation {
    pub id: String,
    pub profile_id: String,
    pub client_id: String,
    pub scope: TargetScope,
    pub path: String,
    pub status: DirectoryObservationStatus,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub physical_id: Option<String>,
    pub physical_identity_verified: bool,
}

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
    #[serde(default)]
    pub agent_root_id: String,
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
    #[serde(default)]
    pub status: DirectoryObservationStatus,
    #[serde(default)]
    pub physical_identity_verified: bool,
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
    #[serde(default)]
    pub agent_roots: Vec<AgentRootObservation>,
    pub logical_targets: Vec<LogicalTarget>,
    pub physical_targets: Vec<PhysicalTarget>,
}

/// Stable identity for a directory in the Agent presentation read model.
/// Unverified candidates are never represented as physical filesystem facts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum AgentDirectoryIdentity {
    VerifiedPhysical(String),
    Candidate(String),
}

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(rename_all = "snake_case")]
pub enum AgentDirectoryRole {
    /// User-level Agent Skill directory.
    AgentUser,
    /// Skill directory owned by the Agent's active workspace; discovery may
    /// encode this with the historical `project` target scope.
    AgentWorkspace,
    /// Legacy role accepted for older generated fixtures and snapshots.
    AgentNative,
    /// Legacy role: current projections express this independently with
    /// `AgentDirectoryFact::is_shared_directory`.
    SharedDirectory,
    /// Platform-managed Agent directory; read-only in the current release.
    Builtin,
    /// Directory owned by the separate registered-project model.
    Project,
}

impl AgentDirectoryIdentity {
    pub fn is_verified(&self) -> bool {
        matches!(self, Self::VerifiedPhysical(_))
    }
}

/// Availability facts observed for one logical directory member.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct AgentDirectoryAvailability {
    pub status: DirectoryObservationStatus,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub available: bool,
}

/// Deployment facts stay scoped to the logical target that was observed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct AgentDirectoryMemberCapabilities {
    pub deployment: DeploymentCapability,
    pub modes: Vec<DeploymentMode>,
    pub preferred_mode: Option<DeploymentMode>,
}

/// Managed deployment state observed for one logical directory member.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentDirectoryDeploymentStatus {
    #[default]
    NotDeployed,
    Deployed,
    PartiallyDeployed,
}

/// One logical target represented by a directory entity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct AgentDirectoryMemberFact {
    pub logical_target_id: String,
    pub brand: Option<String>,
    pub client_id: Option<String>,
    pub kind: Option<ClientKind>,
    /// Whether this Agent client can read from the shared Skills directory.
    #[serde(default)]
    pub supports_shared_directory: bool,
    pub availability: AgentDirectoryAvailability,
    pub capabilities: AgentDirectoryMemberCapabilities,
    pub deployment_status: AgentDirectoryDeploymentStatus,
    pub managed_deployment_relation_count: u32,
    pub managed_deployment_count: u32,
}

/// Canonical directory entity used by Agent card consumers.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct AgentDirectoryFact {
    pub role: AgentDirectoryRole,
    /// Identifies the shared directory entity independently from its path role.
    #[serde(default)]
    pub is_shared_directory: bool,
    pub identity: AgentDirectoryIdentity,
    pub path: String,
    pub status: DirectoryObservationStatus,
    pub exists: bool,
    pub readable: bool,
    pub writable: bool,
    pub available: bool,
    pub members: Vec<AgentDirectoryMemberFact>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct AgentDirectoryProjection {
    pub directories: Vec<AgentDirectoryFact>,
}

pub trait AgentRepository {
    fn load_discovery(&self) -> AppResult<Option<DiscoverySnapshot>>;
    fn replace_discovery(&self, snapshot: &DiscoverySnapshot) -> AppResult<DiscoverySnapshot>;
}
