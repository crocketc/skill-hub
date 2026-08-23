use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TargetScope {
    Global,
    Project,
    Extra,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct PathCandidate {
    pub path: String,
    pub scope: TargetScope,
    pub precedence: super::DirectoryPrecedence,
    pub marker: String,
}
