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

/// Non-portable command result that locates a newly created package while
/// keeping the persisted manifest portable.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupCreated {
    pub path: String,
    pub manifest: BackupManifest,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RestoreConflictKind {
    ExistingSkill,
    InvalidPortableData,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RestoreConflict {
    pub skill_id: Option<SkillId>,
    pub kind: RestoreConflictKind,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RestoreConflictDecision {
    Overwrite,
    KeepBoth,
    Skip,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RestorePlan {
    pub format_version: u32,
    pub skills: u32,
    pub deployments_requiring_rediscovery: u32,
    pub conflicts: Vec<RestoreConflict>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct RestoreResult {
    pub skills_restored: u32,
    pub skills_skipped: u32,
    pub deployments_requiring_rediscovery: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupRetentionPolicy {
    pub max_backups: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BackupRetentionResult {
    pub retained: u32,
    pub removed: u32,
}
