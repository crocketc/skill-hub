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
        .filter(|path| {
            path.extension().and_then(|e| e.to_str()) == Some("json")
                && !path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("schema.json"))
        })
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
    if profile.profile_version == 0
        || profile.brand.trim().is_empty()
        || profile.clients.is_empty()
        || profile.official_references.is_empty()
        || !valid_date(&profile.research_date)
        || profile
            .official_references
            .iter()
            .any(|url| !valid_url(url))
    {
        return Err(ProfileLoadError::invalid("incomplete profile"));
    }
    for client in &profile.clients {
        if client.id.trim().is_empty()
            || client.path_candidates.is_empty()
            || client.skill_marker.trim().is_empty()
            || client.supported_os.is_empty()
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
    let components = trimmed
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    let home_root = matches!(components.as_slice(), ["Users", _] | ["home", _]);
    let windows_home_root = components.len() == 3
        && components[0].len() == 2
        && components[0].as_bytes()[1] == b':'
        && components[1].eq_ignore_ascii_case("Users");
    let unc_root = normalized.starts_with("//") && components.len() <= 2;
    trimmed.is_empty()
        || trimmed == "~"
        || trimmed == "."
        || trimmed.eq_ignore_ascii_case("%USERPROFILE%")
        || trimmed.eq_ignore_ascii_case("$HOME")
        || trimmed.eq_ignore_ascii_case("{user_home}")
        || trimmed.ends_with(':')
        || (trimmed.len() == 2 && trimmed.as_bytes()[1] == b':')
        || home_root
        || windows_home_root
        || unc_root
}

fn valid_date(value: &str) -> bool {
    let mut parts = value.split('-');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        year.parse::<u32>(),
        month.parse::<u32>(),
        day.parse::<u32>(),
    ) else {
        return false;
    };
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let days = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= days
}

fn valid_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && value
            .split_once("://")
            .is_some_and(|(_, host)| !host.trim_matches('/').is_empty() && !host.starts_with('/'))
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
