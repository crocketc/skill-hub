use serde::{Deserialize, Serialize};

use super::{AgentProfile, OperatingSystem, TargetScope};

/// Opaque identifier issued by the native file picker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PathGrant {
    pub grant_id: String,
}

impl PathGrant {
    pub fn from_file_picker(grant_id: impl Into<String>) -> Self {
        Self {
            grant_id: grant_id.into(),
        }
    }
    pub fn validate(&self) -> Result<(), CustomAgentValidationError> {
        if self.grant_id.trim().is_empty() {
            Err(CustomAgentValidationError::MissingPathGrant)
        } else {
            Ok(())
        }
    }
}

/// Native file-picker authority boundary. It resolves an opaque ID only after
/// checking the OS grant registry.
pub trait PathGrantResolver {
    fn resolve(&self, grant: &PathGrant) -> Result<ResolvedPathGrant, CustomAgentValidationError>;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ResolvedPathGrant {
    pub grant_id: String,
    pub path: String,
    pub operating_system: OperatingSystem,
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
    GrantNotAuthorized,
    GrantPathMismatch,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CustomAgentDraft {
    pub id: String,
    pub display_name: String,
    pub directory: PathGrant,
    pub profile: AgentProfile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CustomAgent {
    pub id: String,
    pub display_name: String,
    pub directory: ResolvedPathGrant,
    pub profile: AgentProfile,
}

impl CustomAgent {
    pub fn from_draft(
        draft: CustomAgentDraft,
        resolver: &impl PathGrantResolver,
    ) -> Result<Self, CustomAgentValidationError> {
        draft.directory.validate()?;
        let resolved = resolver.resolve(&draft.directory)?;
        let agent = Self {
            id: draft.id,
            display_name: draft.display_name,
            directory: resolved,
            profile: draft.profile,
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
        if self.directory.grant_id.trim().is_empty() || self.directory.path.trim().is_empty() {
            return Err(CustomAgentValidationError::InvalidPathGrant);
        }
        if super::validate_profile_strict(&self.profile).is_err() {
            return Err(CustomAgentValidationError::InvalidProfile);
        }
        if !global_path_matches(&self.profile, &self.directory) {
            return Err(CustomAgentValidationError::GrantPathMismatch);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CustomAgentOverride {
    pub profile_id: String,
    pub directory: ResolvedPathGrant,
    pub profile: AgentProfile,
}

impl CustomAgentOverride {
    pub fn validate(&self) -> Result<(), CustomAgentValidationError> {
        if self.profile_id.trim().is_empty() || self.directory.grant_id.trim().is_empty() {
            return Err(CustomAgentValidationError::MissingPathGrant);
        }
        if super::validate_profile_strict(&self.profile).is_err() {
            return Err(CustomAgentValidationError::InvalidProfile);
        }
        if !global_path_matches(&self.profile, &self.directory) {
            return Err(CustomAgentValidationError::GrantPathMismatch);
        }
        Ok(())
    }
}

fn global_path_matches(profile: &AgentProfile, grant: &ResolvedPathGrant) -> bool {
    let expected = normalize_path(&grant.path, &grant.operating_system);
    let globals = profile
        .clients
        .iter()
        .flat_map(|client| client.path_candidates.iter())
        .filter(|candidate| matches!(candidate.scope, TargetScope::Global))
        .collect::<Vec<_>>();
    !globals.is_empty()
        && globals
            .iter()
            .all(|candidate| normalize_path(&candidate.path, &grant.operating_system) == expected)
}

fn normalize_path(path: &str, operating_system: &OperatingSystem) -> String {
    let mut normalized = path.replace('\\', "/");
    while normalized.ends_with('/') {
        normalized.pop();
    }
    if matches!(operating_system, OperatingSystem::Windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}
