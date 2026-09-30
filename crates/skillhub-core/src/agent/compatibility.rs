use crate::{DeploymentCapability, DeploymentMode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityStatus {
    Supported,
    #[default]
    Unverified,
    Unsupported,
}

/// Agent reading compatibility, independent of host creation capabilities.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct ImportCompatibility {
    pub copy: CompatibilityStatus,
    pub symlink: CompatibilityStatus,
    pub junction: CompatibilityStatus,
}

impl ImportCompatibility {
    pub fn from_declaration(declared: Option<&DeploymentCapability>) -> Self {
        let Some(declared) = declared else {
            return Self::default();
        };
        let state = |supported: bool, mode: &str| {
            if supported {
                CompatibilityStatus::Supported
            } else if declared.limitations.iter().any(|reason| {
                reason == &format!("{mode}_support_unconfirmed")
                    || reason == "runtime_loading_unknown"
            }) {
                CompatibilityStatus::Unverified
            } else {
                CompatibilityStatus::Unsupported
            }
        };
        Self {
            copy: state(declared.copy, "copy"),
            symlink: state(declared.symlink, "symlink"),
            junction: if !declared.junction
                && declared
                    .limitations
                    .iter()
                    .any(|s| s == "symlink_support_unconfirmed")
            {
                CompatibilityStatus::Unverified
            } else {
                state(declared.junction, "junction")
            },
        }
    }

    pub fn status(&self, mode: DeploymentMode) -> CompatibilityStatus {
        match mode {
            DeploymentMode::ManagedCopy => self.copy,
            DeploymentMode::SymbolicLink => self.symlink,
            DeploymentMode::DirectoryJunction => self.junction,
        }
    }

    pub fn set(&mut self, mode: DeploymentMode, status: CompatibilityStatus) {
        match mode {
            DeploymentMode::ManagedCopy => self.copy = status,
            DeploymentMode::SymbolicLink => self.symlink = status,
            DeploymentMode::DirectoryJunction => self.junction = status,
        }
    }

    pub fn deployment(&self) -> DeploymentCapability {
        let mut capability = DeploymentCapability::new(
            self.symlink == CompatibilityStatus::Supported,
            self.junction == CompatibilityStatus::Supported,
            self.copy == CompatibilityStatus::Supported,
        );
        for (mode, status) in [
            (DeploymentMode::ManagedCopy, self.copy),
            (DeploymentMode::SymbolicLink, self.symlink),
            (DeploymentMode::DirectoryJunction, self.junction),
        ] {
            if status == CompatibilityStatus::Unverified {
                capability.limitations.push(format!(
                    "agent_compatibility_unverified:{}",
                    serde_json::to_value(mode).unwrap().as_str().unwrap()
                ));
            }
        }
        capability
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RecordAgentCompatibility {
    pub target_id: String,
    pub mode: DeploymentMode,
    pub status: CompatibilityStatus,
    /// User-provided installed Agent version, never inferred from a Skill.
    pub agent_version: String,
    /// What was tested; creation failures alone are not compatibility evidence.
    pub evidence: String,
    /// Explicit human confirmation of Agent loading, separate from creation.
    pub agent_reading_checked: bool,
}
