use crate::{DeploymentCapability, DeploymentId, SkillId, VersionId};
use serde::{Deserialize, Serialize};

/// The filesystem representation selected for one physical deployment target.
/// It is selected from the target's declared capabilities.
/// A symbolic link is preferred because it keeps a deployment connected to the
/// selected library version.  Junctions are a Windows directory fallback and
/// managed copies are the portable last resort.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentMode {
    SymbolicLink,
    DirectoryJunction,
    ManagedCopy,
}

impl DeploymentMode {
    pub fn select(capabilities: &DeploymentCapability) -> Option<Self> {
        if capabilities.symlink {
            Some(Self::SymbolicLink)
        } else if capabilities.junction {
            Some(Self::DirectoryJunction)
        } else if capabilities.copy {
            Some(Self::ManagedCopy)
        } else {
            None
        }
    }

    pub fn is_supported_by(self, capabilities: &DeploymentCapability) -> bool {
        match self {
            Self::SymbolicLink => capabilities.symlink,
            Self::DirectoryJunction => capabilities.junction,
            Self::ManagedCopy => capabilities.copy,
        }
    }
}

impl DeploymentCapability {
    /// Construct target capabilities without coupling planner callers to the
    /// Agent profile JSON field order.
    pub fn new(symlink: bool, junction: bool, copy: bool) -> Self {
        Self {
            copy,
            symlink,
            junction,
            limitations: Vec::new(),
        }
    }
}

/// A logical Agent/client relationship selected by the user.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct LogicalTargetSelection {
    pub id: String,
    pub physical_target_id: String,
}

impl LogicalTargetSelection {
    pub fn new(id: impl Into<String>, physical_target_id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            physical_target_id: physical_target_id.into(),
        }
    }
}

/// Facts observed for a runtime name already present in a physical target.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExistingOwnership {
    Managed,
    Unknown,
    AgentBuiltin,
    Plugin,
    OtherTool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ExistingDeployment {
    pub runtime_name: String,
    pub ownership: ExistingOwnership,
    pub deployment_id: Option<DeploymentId>,
    pub skill_id: Option<SkillId>,
    pub version_id: Option<VersionId>,
}

impl ExistingDeployment {
    pub fn new(runtime_name: impl Into<String>, ownership: ExistingOwnership) -> Self {
        Self {
            runtime_name: runtime_name.into(),
            ownership,
            deployment_id: None,
            skill_id: None,
            version_id: None,
        }
    }

    pub fn managed(
        runtime_name: impl Into<String>,
        deployment_id: DeploymentId,
        skill_id: SkillId,
        version_id: VersionId,
    ) -> Self {
        Self {
            runtime_name: runtime_name.into(),
            ownership: ExistingOwnership::Managed,
            deployment_id: Some(deployment_id),
            skill_id: Some(skill_id),
            version_id: Some(version_id),
        }
    }
}

/// A merged physical target.  Several logical targets may refer to one of
/// these and must consequently be written only once by the executor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PhysicalTargetInput {
    pub id: String,
    pub path: String,
    pub capabilities: DeploymentCapability,
    pub existing: Vec<ExistingDeployment>,
    /// Whether runtime names are compared case-sensitively for this target.
    pub case_sensitive: bool,
}

impl PhysicalTargetInput {
    pub fn new(
        id: impl Into<String>,
        path: impl Into<String>,
        capabilities: DeploymentCapability,
    ) -> Self {
        Self {
            id: id.into(),
            path: path.into(),
            capabilities,
            existing: Vec::new(),
            case_sensitive: !cfg!(windows),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentPlanInput {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
    /// Path to the immutable central-library version tree.  The planner only
    /// copies this value into its output and never reads it.
    pub source_path: String,
    pub logical_targets: Vec<LogicalTargetSelection>,
    pub physical_targets: Vec<PhysicalTargetInput>,
    pub mode_override: Option<DeploymentMode>,
}

impl DeploymentPlanInput {
    pub fn new(
        skill_id: SkillId,
        version_id: VersionId,
        runtime_name: impl Into<String>,
        logical_targets: Vec<LogicalTargetSelection>,
        physical_targets: Vec<PhysicalTargetInput>,
    ) -> Self {
        Self {
            skill_id,
            version_id,
            runtime_name: runtime_name.into(),
            source_path: String::new(),
            logical_targets,
            physical_targets,
            mode_override: None,
        }
    }

    pub fn with_source_path(mut self, source_path: impl Into<String>) -> Self {
        self.source_path = source_path.into();
        self
    }

    pub fn with_mode(mut self, mode: DeploymentMode) -> Self {
        self.mode_override = Some(mode);
        self
    }
}

/// Names used by the operation executor to summarize the filesystem change.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetChange {
    Create,
    NoOp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetConflictReason {
    RuntimeNameAlreadyExists,
    OwnershipUnknown,
    ManagedByAnotherSkill,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TargetConflict {
    pub physical_target_id: String,
    pub target_path: String,
    pub runtime_name: String,
    pub reason: TargetConflictReason,
    pub existing_ownership: ExistingOwnership,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TargetPlan {
    pub physical_target_id: String,
    pub logical_target_ids: Vec<String>,
    pub target_path: String,
    pub destination_path: String,
    pub source_path: String,
    pub runtime_name: String,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub mode: DeploymentMode,
    pub change: TargetChange,
    pub warnings: Vec<String>,
    pub conflicts: Vec<TargetConflict>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentPlan {
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub runtime_name: String,
    /// For a single physical target this is its selected mode.  For a batch
    /// with different capabilities, inspect each `TargetPlan::mode`.
    pub mode: DeploymentMode,
    pub targets: Vec<TargetPlan>,
    pub warnings: Vec<String>,
    pub conflicts: Vec<TargetConflict>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentState {
    Planned,
    Deployed,
    Removed,
    NeedsRecovery,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DeploymentRecord {
    pub id: DeploymentId,
    pub skill_id: SkillId,
    pub version_id: VersionId,
    pub target_id: String,
    pub state: DeploymentState,
    pub mode: DeploymentMode,
    pub managed: bool,
    pub runtime_name: String,
    pub expected_hash: String,
    pub observed_hash: Option<String>,
}

/// Compatibility aliases used by application services that call the planner
/// input a request or a planner input.
pub type DeploymentRequest = DeploymentPlanInput;
pub type PlannerInput = DeploymentPlanInput;
pub type TargetCapabilities = DeploymentCapability;
pub type DeploymentCapabilities = DeploymentCapability;
