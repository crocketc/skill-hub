use crate::{AppResult, ProjectId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

/// A registered project. `device_path` is deliberately device-local and is
/// never part of the portable `.skillhub/project.json` representation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub device_path: String,
    pub physical_id: String,
    pub logical: ProjectMetadata,
    pub tags: Vec<ProjectTag>,
    #[serde(default)]
    pub agent_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Project {
    pub fn new(id: ProjectId, name: impl Into<String>, path: impl AsRef<Path>) -> Self {
        let now = now();
        Self {
            id,
            name: name.into(),
            device_path: path.as_ref().to_string_lossy().into_owned(),
            physical_id: String::new(),
            logical: ProjectMetadata::default(),
            tags: Vec::new(),
            agent_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn path(&self) -> &str {
        &self.device_path
    }

    pub fn with_identity_hint(mut self, identity_hint: impl Into<String>) -> Self {
        self.logical.identity_hint = Some(identity_hint.into());
        self
    }

    pub fn set_tags<T>(&mut self, tags: impl IntoIterator<Item = T>)
    where
        T: Into<ProjectTag>,
    {
        let mut unique = BTreeSet::new();
        self.tags = tags
            .into_iter()
            .map(Into::into)
            .filter(|tag| !tag.name.is_empty())
            .filter(|tag| unique.insert(tag.name.clone()))
            .collect();
        self.tags.sort_by(|left, right| left.name.cmp(&right.name));
        self.updated_at = now();
    }
}

/// Resolves a persisted project record by identity. Adapters must use this
/// boundary instead of accepting caller-supplied project paths.
pub trait ProjectRepository {
    fn get(&self, id: ProjectId) -> AppResult<Project>;
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ProjectMetadata {
    pub identity_hint: Option<String>,
    pub note: Option<String>,
}

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, specta::Type,
)]
#[serde(deny_unknown_fields)]
pub struct ProjectTag {
    pub name: String,
}

impl ProjectTag {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into().trim().to_ascii_lowercase(),
        }
    }
}

impl From<String> for ProjectTag {
    fn from(name: String) -> Self {
        Self::new(name)
    }
}

impl From<&str> for ProjectTag {
    fn from(name: &str) -> Self {
        Self::new(name)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SavedProjectView {
    pub id: String,
    pub name: String,
    pub all_tags: Vec<String>,
    pub any_tags: Vec<String>,
}

impl SavedProjectView {
    pub fn all_tags<I, S>(name: impl Into<String>, tags: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let name = name.into();
        Self {
            id: slug(&name),
            name,
            all_tags: normalize_tags(tags),
            any_tags: Vec::new(),
        }
    }

    pub fn matches(&self, project: &Project) -> bool {
        let project_tags = project
            .tags
            .iter()
            .map(|tag| tag.name.as_str())
            .collect::<BTreeSet<_>>();
        self.all_tags
            .iter()
            .all(|tag| project_tags.contains(tag.as_str()))
            && (self.any_tags.is_empty()
                || self
                    .any_tags
                    .iter()
                    .any(|tag| project_tags.contains(tag.as_str())))
    }

    pub fn normalize(&mut self) {
        self.name = self.name.trim().to_owned();
        self.all_tags = normalize_tags(std::mem::take(&mut self.all_tags));
        self.any_tags = normalize_tags(std::mem::take(&mut self.any_tags));
    }

    pub fn with_any_tags<I, S>(mut self, tags: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.any_tags = normalize_tags(tags);
        self
    }
}

fn normalize_tags<I, S>(tags: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut result = tags
        .into_iter()
        .map(Into::into)
        .map(|tag| tag.trim().to_ascii_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    result
}

fn slug(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}

fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}
