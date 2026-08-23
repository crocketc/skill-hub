use serde_json::Value;
use skillhub_core::agent::{AgentProfile, ProfileCatalog};
use skillhub_core::{AppError, ErrorCode, Severity};
use std::fs;
use std::path::Path;

#[derive(Debug)]
pub struct ProfileLoadError {
    pub code: ErrorCode,
    pub source: Option<String>,
}

impl std::fmt::Display for ProfileLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code.as_str())
    }
}
impl std::error::Error for ProfileLoadError {}

impl ProfileLoadError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::AgentProfileInvalidCapability,
            source: Some(message.into()),
        }
    }
}

pub fn load_profile(path: impl AsRef<Path>) -> Result<AgentProfile, ProfileLoadError> {
    let content =
        fs::read_to_string(path).map_err(|error| ProfileLoadError::invalid(error.to_string()))?;
    parse_custom_profile(&content)
}

pub fn parse_custom_profile(content: &str) -> Result<AgentProfile, ProfileLoadError> {
    let value: Value = serde_json::from_str(content)
        .map_err(|error| ProfileLoadError::invalid(error.to_string()))?;
    reject_unsafe_keys(&value)?;
    let profile: AgentProfile = serde_json::from_value(value)
        .map_err(|error| ProfileLoadError::invalid(error.to_string()))?;
    validate_profile(&profile)?;
    Ok(profile)
}

pub fn load_catalog(dir: impl AsRef<Path>) -> Result<ProfileCatalog, ProfileLoadError> {
    let mut profiles = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|error| ProfileLoadError::invalid(error.to_string()))?;
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        profiles.push(load_profile(path)?);
    }
    Ok(ProfileCatalog { profiles })
}

fn reject_unsafe_keys(value: &Value) -> Result<(), ProfileLoadError> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let lower = key.to_ascii_lowercase();
                if lower == "command"
                    || lower == "commands"
                    || lower == "script"
                    || lower == "scripts"
                    || lower == "shell"
                {
                    return Err(ProfileLoadError::invalid(format!("unsafe field: {key}")));
                }
                reject_unsafe_keys(child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_unsafe_keys(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_profile(profile: &AgentProfile) -> Result<(), ProfileLoadError> {
    if profile.profile_version == 0 || profile.brand.trim().is_empty() || profile.clients.is_empty()
    {
        return Err(ProfileLoadError::invalid("incomplete profile"));
    }
    for client in &profile.clients {
        if client.id.trim().is_empty()
            || client.path_candidates.is_empty()
            || client.skill_marker.trim().is_empty()
        {
            return Err(ProfileLoadError::invalid("incomplete client profile"));
        }
        for candidate in &client.path_candidates {
            let path = candidate.path.trim();
            if path.is_empty() || is_unbounded_root(path) || path.contains("**") {
                return Err(ProfileLoadError::invalid("unbounded scan root"));
            }
            if candidate.marker.trim().is_empty() {
                return Err(ProfileLoadError::invalid("empty skill marker"));
            }
        }
    }
    Ok(())
}

fn is_unbounded_root(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    trimmed.is_empty()
        || trimmed == "~"
        || trimmed == "."
        || trimmed.ends_with(':')
        || (trimmed.len() == 2 && trimmed.as_bytes()[1] == b':')
}

impl From<ProfileLoadError> for AppError {
    fn from(error: ProfileLoadError) -> Self {
        let mut result = AppError::new(error.code, Severity::Error);
        if let Some(source) = error.source {
            result = result.with_param("detail", source);
        }
        result
    }
}
