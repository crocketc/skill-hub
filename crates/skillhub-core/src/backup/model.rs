use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::SkillId;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum BackupScope {
    Full,
    SelectedSkills,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveContentDecision {
    ResolveFirst,
    ExcludeSkill,
    IncludeAndMark,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SensitiveItem {
    pub skill_id: SkillId,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupPlan {
    pub scope: BackupScope,
    pub sensitive_items: Vec<SensitiveItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupEntry {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupManifest {
    pub format_version: u32,
    pub entries: Vec<BackupEntry>,
    pub contains_sensitive_skill_content: bool,
}

#[derive(Clone, Debug)]
pub struct BackupInput {
    pub scope: BackupScope,
    pub portable_metadata: String,
    pub skills: Vec<(SkillId, String)>,
    pub device_path: Option<String>,
}

impl BackupInput {
    pub fn new(
        scope: BackupScope,
        portable_metadata: impl Into<String>,
        skills: Vec<(SkillId, String)>,
    ) -> Self {
        Self {
            scope,
            portable_metadata: portable_metadata.into(),
            skills,
            device_path: None,
        }
    }

    pub fn with_device_path(mut self, path: impl Into<String>) -> Self {
        self.device_path = Some(path.into());
        self
    }
}

#[derive(Clone, Debug)]
pub struct BackupPackage {
    pub root: PathBuf,
}
