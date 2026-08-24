use crate::{SkillId, VersionId};
use serde::{Deserialize, Serialize};
use std::path::Path;
use url::Url;

pub const SHARED_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Portable project metadata. It intentionally has no path, content,
/// deployment, credential, or device-specific fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SharedProjectConfig {
    pub schema_version: u32,
    pub project_identity_hint: String,
    pub required_skills: Vec<SharedSkillRequirement>,
}

impl Serialize for SharedProjectConfig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.validate().map_err(serde::ser::Error::custom)?;
        #[derive(Serialize)]
        struct Wire<'a> {
            schema_version: u32,
            project_identity_hint: &'a str,
            required_skills: &'a [SharedSkillRequirement],
        }
        Wire {
            schema_version: self.schema_version,
            project_identity_hint: &self.project_identity_hint,
            required_skills: &self.required_skills,
        }
        .serialize(serializer)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
pub struct PortableSource(String);

impl PortableSource {
    pub fn catalog(value: impl Into<String>) -> Result<Self, &'static str> {
        Self::try_from(value.into())
    }

    pub fn url(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        let parsed = Url::parse(&value).map_err(|_| "source URL is invalid")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("source URL must not contain credentials");
        }
        validate_portable_text(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for PortableSource {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.contains("://") {
            return Self::url(value);
        }
        validate_portable_text(&value)?;
        if value.trim().is_empty() || Path::new(&value).is_absolute() || windows_absolute(&value) {
            return Err("source must be a portable locator, not a device path");
        }
        Ok(Self(value))
    }
}

impl TryFrom<&str> for PortableSource {
    type Error = &'static str;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl<'de> Deserialize<'de> for PortableSource {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::try_from(value).map_err(serde::de::Error::custom)
    }
}

impl SharedProjectConfig {
    pub fn new(
        project_identity_hint: impl Into<String>,
        required_skills: Vec<SharedSkillRequirement>,
    ) -> Self {
        Self {
            schema_version: SHARED_CONFIG_SCHEMA_VERSION,
            project_identity_hint: project_identity_hint.into(),
            required_skills,
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != SHARED_CONFIG_SCHEMA_VERSION {
            return Err("unsupported shared project config schema version");
        }
        validate_portable_text(&self.project_identity_hint)?;
        if self.project_identity_hint.trim().is_empty() {
            return Err("project identity hint is required");
        }
        for skill in &self.required_skills {
            skill.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SharedSkillRequirement {
    pub skill_id: SkillId,
    pub source: PortableSource,
    pub name: String,
    pub version_constraint: Option<String>,
    pub version_id: Option<VersionId>,
    pub content_identity: Option<String>,
    pub logical_agent_id: Option<String>,
    pub project_subdirectory: Option<String>,
    pub note: Option<String>,
}

impl Serialize for SharedSkillRequirement {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.validate().map_err(serde::ser::Error::custom)?;
        #[derive(Serialize)]
        struct Wire<'a> {
            skill_id: &'a SkillId,
            source: &'a PortableSource,
            name: &'a str,
            version_constraint: &'a Option<String>,
            version_id: &'a Option<VersionId>,
            content_identity: &'a Option<String>,
            logical_agent_id: &'a Option<String>,
            project_subdirectory: &'a Option<String>,
            note: &'a Option<String>,
        }
        Wire {
            skill_id: &self.skill_id,
            source: &self.source,
            name: &self.name,
            version_constraint: &self.version_constraint,
            version_id: &self.version_id,
            content_identity: &self.content_identity,
            logical_agent_id: &self.logical_agent_id,
            project_subdirectory: &self.project_subdirectory,
            note: &self.note,
        }
        .serialize(serializer)
    }
}

impl SharedSkillRequirement {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.name.trim().is_empty() {
            return Err("shared Skill requirement needs a name");
        }
        if let Some(version) = &self.version_constraint {
            validate_portable_text(version)?;
        }
        if let Some(identity) = &self.content_identity {
            let digest = identity
                .strip_prefix("sha256:")
                .ok_or("content identity must use sha256")?;
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("content identity must be a sha256 digest");
            }
        }
        if let Some(agent) = &self.logical_agent_id {
            validate_portable_text(agent)?;
            if agent.trim().is_empty() {
                return Err("logical Agent id is required");
            }
        }
        if let Some(scope) = &self.project_subdirectory {
            if !is_safe_relative_path(scope) {
                return Err("project subdirectory must be a safe relative path");
            }
        }
        if let Some(note) = &self.note {
            validate_portable_text(note)?;
        }
        Ok(())
    }
}

fn validate_portable_text(value: &str) -> Result<(), &'static str> {
    let lower = value.to_ascii_lowercase();
    if value.chars().any(char::is_control)
        || Path::new(value).is_absolute()
        || windows_absolute(value)
        || lower.contains("-----begin")
        || lower.contains("authorization:")
        || lower.contains("bearer ")
        || lower.contains("api_key")
        || lower.contains("password")
        || lower.contains("secret")
        || lower.contains("token=")
    {
        return Err("portable metadata contains a path, credential, or secret");
    }
    if value.contains("://") {
        let parsed = Url::parse(value).map_err(|_| "portable URL is invalid")?;
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("portable URL must not contain credentials");
        }
    }
    Ok(())
}

fn is_safe_relative_path(value: &str) -> bool {
    !value.trim().is_empty()
        && !Path::new(value).is_absolute()
        && !windows_absolute(value)
        && !value
            .replace('\\', "/")
            .split('/')
            .any(|part| part == ".." || part.is_empty())
}

fn windows_absolute(value: &str) -> bool {
    value.starts_with('\\')
        || value.starts_with('/')
        || (value.as_bytes().get(1) == Some(&b':')
            && value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic))
}
