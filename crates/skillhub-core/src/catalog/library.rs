use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{SkillId, VersionId};

/// Portable paths and files that make up the central Skill library.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LibraryPaths {
    pub root: std::path::PathBuf,
    pub skills_dir: std::path::PathBuf,
    pub management_dir: std::path::PathBuf,
    pub manifest_path: std::path::PathBuf,
    pub metadata_dir: std::path::PathBuf,
    pub versions_dir: std::path::PathBuf,
    pub objects_dir: std::path::PathBuf,
    pub backups_dir: std::path::PathBuf,
    pub tmp_dir: std::path::PathBuf,
}

impl LibraryPaths {
    pub fn from_root(root: impl Into<std::path::PathBuf>) -> Self {
        let root = root.into();
        let management_dir = root.join(".skillhub");
        Self {
            skills_dir: root.join("skills"),
            manifest_path: management_dir.join("library.json"),
            metadata_dir: management_dir.join("skills"),
            versions_dir: management_dir.join("versions"),
            objects_dir: management_dir.join("objects"),
            backups_dir: management_dir.join("backups"),
            tmp_dir: management_dir.join("tmp"),
            root,
            management_dir,
        }
    }
}

/// Portable catalog metadata stored in `.skillhub/library.json`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LibraryManifest {
    pub format_version: u32,
    #[serde(default)]
    pub skills: Vec<PortableSkillRecord>,
}

impl LibraryManifest {
    pub fn current() -> Self {
        Self {
            format_version: 1,
            skills: Vec::new(),
        }
    }
}

impl Default for LibraryManifest {
    fn default() -> Self {
        Self::current()
    }
}

/// User-owned Skill facts that can safely travel with a library backup.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PortableSkillRecord {
    pub id: SkillId,
    pub display_name: String,
    #[serde(default)]
    pub runtime_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub translated_description: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub declared_requirements: BTreeMap<String, String>,
    #[serde(default)]
    pub current_version: Option<VersionId>,
}

impl PortableSkillRecord {
    pub fn new(id: SkillId, display_name: impl Into<String>) -> Self {
        let display_name = display_name.into();
        Self {
            runtime_name: display_name.clone(),
            id,
            display_name,
            description: String::new(),
            translated_description: None,
            note: None,
            tags: Vec::new(),
            author: None,
            license: None,
            declared_requirements: BTreeMap::new(),
            current_version: None,
        }
    }
}
