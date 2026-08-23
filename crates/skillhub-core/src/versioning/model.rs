use serde::{Deserialize, Serialize};

use crate::{SkillId, VersionId};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub object_id: String,
    pub size: u64,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VersionManifest {
    pub format_version: u32,
    pub skill_id: SkillId,
    pub tree_hash: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VersionRecord {
    pub id: VersionId,
    pub manifest: VersionManifest,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct VersionDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
}
