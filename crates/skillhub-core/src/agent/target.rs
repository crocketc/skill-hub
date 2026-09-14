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
    /// OPT-20260914-07: `true` marks a cross-brand shared reference (the
    /// `.agents/skills` convention). Shared references keep their deployment
    /// and scan semantics, but the ownership card is only produced once by the
    /// brand-agnostic Agent Skills profile. Defaults to `false` so existing
    /// persisted profiles and custom agents keep loading unchanged.
    #[serde(default)]
    pub shared_reference: bool,
}
