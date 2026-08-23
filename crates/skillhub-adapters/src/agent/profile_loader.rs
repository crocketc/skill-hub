use serde_json::Value;
use skillhub_core::agent::{validate_profile_strict, AgentProfile, ProfileCatalog};
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
    validate_json_schema(&value)?;
    let profile: AgentProfile = serde_json::from_value(value)
        .map_err(|error| ProfileLoadError::invalid(error.to_string()))?;
    validate_profile(&profile)?;
    Ok(profile)
}

fn validate_json_schema(value: &Value) -> Result<(), ProfileLoadError> {
    let schema: Value =
        serde_json::from_str(include_str!("../../profiles/schema.json")).map_err(|error| {
            ProfileLoadError::invalid(format!("invalid bundled profile schema: {error}"))
        })?;
    validate_schema_node(value, &schema, &schema, "$")
}

fn validate_schema_node(
    value: &Value,
    schema: &Value,
    root: &Value,
    location: &str,
) -> Result<(), ProfileLoadError> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let definition = reference
            .strip_prefix("#/$defs/")
            .and_then(|name| root.get("$defs").and_then(|defs| defs.get(name)))
            .ok_or_else(|| {
                ProfileLoadError::invalid(format!("unknown schema reference: {reference}"))
            })?;
        return validate_schema_node(value, definition, root, location);
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let matches = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.as_i64().is_some(),
            _ => true,
        };
        if !matches {
            return Err(ProfileLoadError::invalid(format!(
                "{location} has invalid type"
            )));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.iter().any(|candidate| candidate == value) {
            return Err(ProfileLoadError::invalid(format!(
                "{location} is not an allowed value"
            )));
        }
    }
    if let Some(minimum) = schema.get("minimum").and_then(Value::as_i64) {
        if value.as_i64().is_none_or(|number| number < minimum) {
            return Err(ProfileLoadError::invalid(format!(
                "{location} is below minimum"
            )));
        }
    }
    if let Some(min_items) = schema.get("minItems").and_then(Value::as_u64) {
        if value
            .as_array()
            .is_none_or(|items| items.len() < min_items as usize)
        {
            return Err(ProfileLoadError::invalid(format!(
                "{location} has too few items"
            )));
        }
    }
    if let Some(min_length) = schema.get("minLength").and_then(Value::as_u64) {
        if value
            .as_str()
            .is_none_or(|text| text.chars().count() < min_length as usize)
        {
            return Err(ProfileLoadError::invalid(format!(
                "{location} is too short"
            )));
        }
    }
    if let Some(format) = schema.get("format").and_then(Value::as_str) {
        let valid = match format {
            "date" => value.as_str().is_some_and(valid_date),
            "uri" => value.as_str().is_some_and(valid_url),
            _ => true,
        };
        if !valid {
            return Err(ProfileLoadError::invalid(format!(
                "{location} has invalid format"
            )));
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for field in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(field) {
                    return Err(ProfileLoadError::invalid(format!(
                        "{location} missing {field}"
                    )));
                }
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
            if let Some(properties) = properties {
                if object.keys().any(|key| !properties.contains_key(key)) {
                    return Err(ProfileLoadError::invalid(format!(
                        "{location} has unknown field"
                    )));
                }
            }
        }
        if let Some(properties) = properties {
            for (key, child) in object {
                if let Some(child_schema) = properties.get(key) {
                    validate_schema_node(child, child_schema, root, &format!("{location}.{key}"))?;
                }
            }
        }
    }
    if let Some(items_schema) = schema.get("items") {
        if let Some(items) = value.as_array() {
            for (index, item) in items.iter().enumerate() {
                validate_schema_node(item, items_schema, root, &format!("{location}[{index}]"))?;
            }
        }
    }
    Ok(())
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
    validate_profile_strict(profile).map_err(ProfileLoadError::invalid)
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
    let Some((_, authority_and_path)) = value.split_once("://") else {
        return false;
    };
    if authority_and_path.starts_with('/') {
        return false;
    }
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit())
        {
            return false;
        }
    }
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some_and(|host| !host.is_empty())
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
