use serde::{Deserialize, Serialize};

/// A filesystem root explicitly registered for scanning.
/// The marker is intentionally part of the scope: different Agent profiles
/// may use different marker spelling, and matching is case-aware.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ScanScope {
    pub id: String,
    pub root: String,
    pub marker: String,
}

impl ScanScope {
    pub fn new(root: impl AsRef<std::path::Path>) -> Self {
        Self {
            id: root.as_ref().to_string_lossy().into_owned(),
            root: root.as_ref().to_string_lossy().into_owned(),
            marker: "SKILL.md".into(),
        }
    }

    pub fn registered(id: impl Into<String>, root: impl AsRef<std::path::Path>) -> Self {
        Self {
            id: id.into(),
            root: root.as_ref().to_string_lossy().into_owned(),
            marker: "SKILL.md".into(),
        }
    }

    pub fn with_marker(mut self, marker: impl Into<String>) -> Self {
        self.marker = marker.into();
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ScanGeneration {
    pub generation: u32,
    pub observed_at: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DiscoveredSkill {
    pub root: String,
    pub relative_path: String,
    pub path: String,
    pub marker: String,
    pub marker_size: u32,
    pub marker_modified_at: u32,
    pub size: u32,
    pub latest_modified_at: u32,
    pub fingerprint: String,
    pub metadata_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ScanIssue {
    pub path: String,
    pub code: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ScanResult {
    pub generation: ScanGeneration,
    pub roots: Vec<String>,
    pub discovered: Vec<DiscoveredSkill>,
    pub visited_paths: Vec<String>,
    pub reparsed_count: u32,
    pub unchanged_count: u32,
    pub errors: Vec<ScanIssue>,
}

impl ScanResult {
    pub fn reparsed_count(&self) -> usize {
        self.reparsed_count as usize
    }

    pub fn unchanged_count(&self) -> usize {
        self.unchanged_count as usize
    }
}

pub trait ScanService: Send + Sync {
    fn scan(&mut self, scopes: &[ScanScope]) -> crate::AppResult<ScanResult>;
}

pub trait ScanRepository {
    fn load(&self) -> crate::AppResult<Option<ScanResult>>;
    fn replace(&self, snapshot: &ScanResult) -> crate::AppResult<ScanResult>;
}
