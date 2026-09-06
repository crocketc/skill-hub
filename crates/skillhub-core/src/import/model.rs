use serde::{Deserialize, Serialize};

use crate::source::SourceDescriptor;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CandidateOwnership {
    Unclassified,
    CentralLibrary,
    KnownAgentTarget,
    RegisteredProject,
    ReadOnlyBuiltinOrPlugin,
    ArbitraryLocalDirectory,
    DownloadedSource,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ImportAction {
    Review,
    UseExistingManagedSkill,
    EstablishManagedRelation,
    CopyIntoLibrary,
    CopyAsIndependentManagedSkill,
    Skip,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ImportCandidate {
    pub source: SourceDescriptor,
    pub absolute_root: String,
    pub relative_root: String,
    pub marker: String,
    pub runtime_name: String,
    pub ownership: CandidateOwnership,
    pub default_action: ImportAction,
    pub ownership_detail: Option<String>,
    /// 仓库发现导入盖章的长期上游坐标；本地导入为 None。
    #[serde(default)]
    pub upstream: Option<crate::source::UpstreamOrigin>,
}

impl ImportCandidate {
    pub fn detected(
        source: SourceDescriptor,
        absolute_root: impl Into<String>,
        relative_root: impl Into<String>,
        marker: impl Into<String>,
        runtime_name: impl Into<String>,
    ) -> Self {
        Self {
            source,
            absolute_root: absolute_root.into(),
            relative_root: relative_root.into(),
            marker: marker.into(),
            runtime_name: runtime_name.into(),
            ownership: CandidateOwnership::Unclassified,
            default_action: ImportAction::Review,
            ownership_detail: None,
            upstream: None,
        }
    }

    /// 仓库发现导入路径盖章长期上游坐标。
    pub fn with_upstream(mut self, upstream: crate::source::UpstreamOrigin) -> Self {
        self.upstream = Some(upstream);
        self
    }

    pub fn with_ownership(
        mut self,
        ownership: CandidateOwnership,
        default_action: ImportAction,
        detail: Option<String>,
    ) -> Self {
        self.ownership = ownership;
        self.default_action = default_action;
        self.ownership_detail = detail;
        self
    }
}
