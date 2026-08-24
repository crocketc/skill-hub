use crate::SkillId;
use serde::{Deserialize, Serialize};

pub const SHARED_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Portable project metadata. It intentionally has no path, content,
/// deployment, credential, or device-specific fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SharedProjectConfig {
    pub schema_version: u32,
    pub project_identity_hint: String,
    pub required_skills: Vec<SharedSkillRequirement>,
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
        if self.project_identity_hint.trim().is_empty() {
            return Err("project identity hint is required");
        }
        if self
            .required_skills
            .iter()
            .any(|skill| skill.name.trim().is_empty() || skill.source.trim().is_empty())
        {
            return Err("shared Skill requirements need source and name");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SharedSkillRequirement {
    pub skill_id: SkillId,
    pub source: String,
    pub name: String,
    pub version_constraint: Option<String>,
    pub note: Option<String>,
}
