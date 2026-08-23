use serde::{Deserialize, Serialize};

use super::AgentProfile;

/// An opaque capability issued by the native file picker for one directory.
/// The path is never accepted as a raw, un-granted custom-Agent input.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PathGrant {
    pub grant_id: String,
    pub path: String,
}

impl PathGrant {
    pub fn from_file_picker(grant_id: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            grant_id: grant_id.into(),
            path: path.into(),
        }
    }

    pub fn validate(&self) -> Result<(), CustomAgentValidationError> {
        if self.grant_id.trim().is_empty() || self.path.trim().is_empty() {
            return Err(CustomAgentValidationError::MissingPathGrant);
        }
        if self.path.contains('\0') || is_unbounded_root(&self.path) {
            return Err(CustomAgentValidationError::InvalidPathGrant);
        }
        Ok(())
    }
}

fn is_unbounded_root(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    let components = trimmed
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    let has_traversal = components
        .iter()
        .any(|component| *component == "." || *component == "..");
    let home_root = components.len() == 2
        && (components[0].eq_ignore_ascii_case("users")
            || components[0].eq_ignore_ascii_case("home"));
    let windows_home_root = components.len() == 3
        && components[0].len() == 2
        && components[0].as_bytes().get(1) == Some(&b':')
        && components[1].eq_ignore_ascii_case("Users");
    let unc_root = normalized.starts_with("//") && components.len() <= 2;
    trimmed.is_empty()
        || has_traversal
        || trimmed == "~"
        || trimmed == "."
        || trimmed.eq_ignore_ascii_case("%USERPROFILE%")
        || trimmed.eq_ignore_ascii_case("$HOME")
        || home_root
        || windows_home_root
        || unc_root
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CustomAgentValidationError {
    MissingId,
    MissingName,
    MissingPathGrant,
    InvalidPathGrant,
    InvalidProfile,
    UnboundedPath,
}

/// User-owned Agent metadata and its strict, command-free profile override.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CustomAgent {
    pub id: String,
    pub display_name: String,
    pub directory: PathGrant,
    pub profile: AgentProfile,
}

impl CustomAgent {
    pub fn new(
        id: impl Into<String>,
        display_name: impl Into<String>,
        directory: PathGrant,
        profile: AgentProfile,
    ) -> Result<Self, CustomAgentValidationError> {
        let agent = Self {
            id: id.into(),
            display_name: display_name.into(),
            directory,
            profile,
        };
        agent.validate()?;
        Ok(agent)
    }

    pub fn validate(&self) -> Result<(), CustomAgentValidationError> {
        if self.id.trim().is_empty() {
            return Err(CustomAgentValidationError::MissingId);
        }
        if self.display_name.trim().is_empty() {
            return Err(CustomAgentValidationError::MissingName);
        }
        self.directory.validate()?;
        if super::validate_profile_strict(&self.profile).is_err() {
            return Err(CustomAgentValidationError::InvalidProfile);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CustomAgentOverride {
    pub profile_id: String,
    pub profile: AgentProfile,
}
